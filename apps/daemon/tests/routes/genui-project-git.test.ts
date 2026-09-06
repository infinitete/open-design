import type { Express, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitDomainError } from '../../src/services/project-git/errors.js';

const mocks = vi.hoisted(() => ({
  applyDiffReviewDecisionToCwd: vi.fn(async () => ({ ok: true })),
  getProject: vi.fn(() => ({ id: 'project', metadata: { baseDir: '/imported/project' } })),
  resolveProjectDir: vi.fn(() => '/imported/project'),
}));

vi.mock('../../src/plugins/index.js', () => ({
  applyDiffReviewDecisionToCwd: mocks.applyDiffReviewDecisionToCwd,
  getSnapshot: vi.fn(),
  isDiffReviewSurfaceId: (id: string) => id.startsWith('__auto_diff_review_'),
  listIterationsForRun: vi.fn(() => []),
}));
vi.mock('../../src/db.js', () => ({ getProject: mocks.getProject }));
vi.mock('../../src/projects.js', () => ({ resolveProjectDir: mocks.resolveProjectDir }));

import { registerGenuiRoutes } from '../../src/routes/genui.js';

function captureApp() {
  const handlers = new Map<string, (req: Request, res: Response) => unknown>();
  const register = (method: string) => (route: string, handler: (req: Request, res: Response) => unknown) => handlers.set(`${method} ${route}`, handler);
  return {
    app: { get: register('GET'), post: register('POST') } as unknown as Express,
    handler(method: string, route: string) { return handlers.get(`${method} ${route}`)!; },
  };
}

function response() {
  const res = { status: vi.fn(), json: vi.fn(), headersSent: false } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  (res.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('diff-review GenUI project mutation coordination', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE genui_surfaces (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT, run_id TEXT,
      plugin_snapshot_id TEXT NOT NULL, surface_id TEXT NOT NULL, kind TEXT NOT NULL,
      persist TEXT NOT NULL, schema_digest TEXT, value_json TEXT, status TEXT NOT NULL,
      responded_by TEXT, requested_at INTEGER NOT NULL, responded_at INTEGER, expires_at INTEGER
    )`);
    db.prepare(`INSERT INTO genui_surfaces (
      id, project_id, conversation_id, run_id, plugin_snapshot_id, surface_id, kind,
      persist, status, requested_at
    ) VALUES ('row', 'project', 'conversation', 'run', 'snapshot', '__auto_diff_review_final',
      'choice', 'run', 'pending', 1)`).run();
  });
  afterEach(() => { db.close(); vi.clearAllMocks(); });

  function fixture(input: { authorize?: boolean; context?: { expectedProjectRevision: number; permit: object } | null; failStale?: boolean; failMissing?: boolean } = {}) {
    const routes = captureApp();
    const order: string[] = [];
    const permit = input.context?.permit ?? { brand: 'permit' };
    const mutationContext = vi.fn(() => input.context === undefined
      ? { expectedProjectRevision: 7, permit }
      : input.context);
    const withProjectMutation = vi.fn(async (scope, work: () => Promise<unknown>) => {
      order.push('mutation');
      if (input.failStale) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
      if (input.failMissing && !scope.permit) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'Managed run context unavailable.');
      return work();
    });
    const authorizeProjectRequest = vi.fn(async () => { order.push('auth'); return input.authorize ?? true; });
    const sendApiError = vi.fn((res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }));
    registerGenuiRoutes(routes.app, {
      db,
      design: { runs: { get: vi.fn(() => ({ projectId: 'project' })) } },
      paths: { PROJECTS_DIR: '/shadow-projects' },
      authorizeProjectRequest,
      http: { sendApiError },
      projectGitCoordination: {
        withProjectMutation,
        runtime: { mutationContext },
      },
    } as never);
    const req = {
      params: { runId: 'run', surfaceId: '__auto_diff_review_final' },
      body: { value: { decision: 'accept' }, expectedProjectRevision: 7 },
      get: vi.fn(() => undefined),
    } as unknown as Request;
    return { routes, req, order, permit, mutationContext, withProjectMutation, authorizeProjectRequest, sendApiError };
  }

  const status = () => (db.prepare("SELECT status FROM genui_surfaces WHERE id = 'row'").get() as { status: string }).status;

  it('uses the exact live run context and coordinates the response row plus bridge write together', async () => {
    const f = fixture(); const res = response();
    await f.routes.handler('POST', '/api/runs/:runId/genui/:surfaceId/respond')(f.req, res);

    expect(f.order).toEqual(['auth', 'mutation']);
    expect(f.mutationContext).toHaveBeenCalledWith('run', 'project');
    expect(f.withProjectMutation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project', expectedProjectRevision: 7, permit: f.permit,
    }), expect.any(Function));
    expect(status()).toBe('resolved');
    expect(mocks.applyDiffReviewDecisionToCwd).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/imported/project' }));
  });

  it('rejects stale admission before response or bridge effects with the standard API error', async () => {
    const f = fixture({ failStale: true }); const res = response();
    await f.routes.handler('POST', '/api/runs/:runId/genui/:surfaceId/respond')(f.req, res);

    expect(status()).toBe('pending');
    expect(mocks.applyDiffReviewDecisionToCwd).not.toHaveBeenCalled();
    expect(f.sendApiError).toHaveBeenCalledWith(res, 409, 'PROJECT_STATE_CHANGED', 'Reload the project before editing.');
  });

  it('does not invoke coordination or mutate the row when project authorization fails', async () => {
    const f = fixture({ authorize: false }); const res = response();
    await f.routes.handler('POST', '/api/runs/:runId/genui/:surfaceId/respond')(f.req, res);
    expect(f.withProjectMutation).not.toHaveBeenCalled();
    expect(f.mutationContext).not.toHaveBeenCalled();
    expect(status()).toBe('pending');
  });

  it('fails closed without an exact run/project context and performs zero effects', async () => {
    const f = fixture({ context: null, failMissing: true }); const res = response();
    await f.routes.handler('POST', '/api/runs/:runId/genui/:surfaceId/respond')(f.req, res);
    expect(f.withProjectMutation).toHaveBeenCalledWith(expect.not.objectContaining({ permit: expect.anything() }), expect.any(Function));
    expect(status()).toBe('pending');
    expect(mocks.applyDiffReviewDecisionToCwd).not.toHaveBeenCalled();
    expect(f.sendApiError).toHaveBeenCalledWith(res, 409, 'RECOVERY_REQUIRED', 'Managed run context unavailable.');
  });

  it('rejects a transported revision that differs from the trusted run epoch before effects', async () => {
    const f = fixture(); const res = response();
    f.req.body.expectedProjectRevision = 8;
    await f.routes.handler('POST', '/api/runs/:runId/genui/:surfaceId/respond')(f.req, res);
    expect(f.withProjectMutation).not.toHaveBeenCalled();
    expect(status()).toBe('pending');
    expect(mocks.applyDiffReviewDecisionToCwd).not.toHaveBeenCalled();
    expect(f.sendApiError).toHaveBeenCalledWith(res, 400, 'BAD_REQUEST', 'Invalid project revision.');
  });
});
