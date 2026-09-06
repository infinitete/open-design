import { EventEmitter } from 'node:events';

import type { Express, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { registerLiveArtifactRoutes } from '../../src/routes/live-artifact.js';
import { GitDomainError } from '../../src/services/project-git/errors.js';

type Handler = (req: Request, res: Response) => unknown;

function captureApp() {
  const handlers = new Map<string, Handler>();
  const register = (method: string) => (route: string, ...routeHandlers: Handler[]) => {
    handlers.set(`${method} ${route}`, routeHandlers.at(-1)!);
  };
  return {
    app: {
      get: register('GET'),
      post: register('POST'),
      patch: register('PATCH'),
      delete: register('DELETE'),
      options: register('OPTIONS'),
    } as unknown as Express,
    handler(method: string, route: string): Handler {
      const handler = handlers.get(`${method} ${route}`);
      if (!handler) throw new Error(`missing route ${method} ${route}`);
      return handler;
    },
  };
}

function response(req: Request) {
  const res = new EventEmitter() as EventEmitter & Response;
  Object.assign(res, {
    req,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    send: vi.fn(() => res),
  });
  return res;
}

function request(input: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: string;
} = {}): Request {
  return {
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    path: '/api/live-artifacts/artifact',
    get: vi.fn((name: string) =>
      name.toLowerCase() === 'x-od-project-revision' ? input.header : undefined),
  } as unknown as Request;
}

function fixture(input: {
  authorizeProjectRequest?: (req: Request, res: Response) => Promise<boolean>;
  withProjectMutation?: (input: unknown, work: () => Promise<unknown>) => Promise<unknown>;
  withProjectRead?: (projectId: string, work: () => Promise<unknown>) => Promise<unknown>;
} = {}) {
  const routes = captureApp();
  const updateLiveArtifact = vi.fn(async () => ({ artifact: { id: 'artifact' } }));
  const listLiveArtifacts = vi.fn(async () => []);
  const readLiveArtifactCode = vi.fn(async () => '<main>artifact</main>');
  const withProjectMutation = vi.fn(input.withProjectMutation ?? (async (_scope, work) => work()));
  const withProjectRead = vi.fn(input.withProjectRead ?? (async (_projectId, work) => work()));
  const sendApiError = vi.fn((res: Response, status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } }));
  registerLiveArtifactRoutes(routes.app, {
    db: {} as never,
    http: {
      sendApiError,
      sendLiveArtifactRouteError: vi.fn((res: Response, error: unknown) =>
        res.status(500).json({ error: String(error) })),
      requireLocalDaemonRequest: vi.fn(),
    } as never,
    paths: { PROJECTS_DIR: '/projects' } as never,
    auth: {
      authorizeToolRequest: vi.fn(),
      requestProjectOverride: vi.fn(() => false),
      requestRunOverride: vi.fn(() => false),
    } as never,
    liveArtifacts: {
      createLiveArtifact: vi.fn(),
      listLiveArtifacts,
      updateLiveArtifact,
      refreshLiveArtifact: vi.fn(),
      emitLiveArtifactEvent: vi.fn(),
      emitLiveArtifactRefreshEvent: vi.fn(),
      readLiveArtifactCode,
      setLiveArtifactCodeHeaders: vi.fn(),
      readLiveArtifactPreview: vi.fn(),
      setLiveArtifactPreviewHeaders: vi.fn(),
      getLiveArtifact: vi.fn(),
      listLiveArtifactRefreshLogEntries: vi.fn(),
      deleteLiveArtifact: vi.fn(),
    } as never,
    projectStore: { getProject: vi.fn(() => ({ metadata: { baseDir: '/external/project' } })), updateProject: vi.fn() } as never,
    projectGitCoordination: {
      withProjectMutation,
      withProjectRead,
      runtime: {} as never,
    } as never,
    authorizeProjectRequest: input.authorizeProjectRequest ?? vi.fn(async () => true),
    authorizeProjectToolRequest: vi.fn(async () => true),
  });
  return {
    routes,
    updateLiveArtifact,
    listLiveArtifacts,
    readLiveArtifactCode,
    withProjectMutation,
    withProjectRead,
    sendApiError,
  };
}

describe('live artifact project Git coordination', () => {
  it('preserves project authorization failure without invoking coordination', async () => {
    const authorizeProjectRequest = vi.fn(async (_req: Request, res: Response) => {
      res.status(403).json({ error: 'forbidden' });
      return false;
    });
    const test = fixture({ authorizeProjectRequest });
    const req = request({ params: { artifactId: 'artifact' }, query: { projectId: 'managed' } });
    const res = response(req);

    await test.routes.handler('PATCH', '/api/live-artifacts/:artifactId')(req, res);

    expect(authorizeProjectRequest).toHaveBeenCalledWith(
      req,
      res,
      'managed',
      { mode: 'write', capability: 'writeFiles' },
    );
    expect(test.withProjectMutation).not.toHaveBeenCalled();
    expect(test.updateLiveArtifact).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
  });

  it('normalizes the caller epoch and maps stale rejection before artifact effects', async () => {
    const test = fixture({
      withProjectMutation: async () => {
        throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
      },
    });
    const req = request({
      params: { artifactId: 'artifact' },
      query: { projectId: 'managed' },
      body: { title: 'updated', expectedProjectRevision: 7 },
      header: '7',
    });
    const res = response(req);

    await test.routes.handler('PATCH', '/api/live-artifacts/:artifactId')(req, res);

    expect(test.withProjectMutation).toHaveBeenCalledWith(
      {
        projectId: 'managed',
        expectedProjectRevision: 7,
        source: 'live-artifact.update',
      },
      expect.any(Function),
    );
    expect(test.updateLiveArtifact).not.toHaveBeenCalled();
    expect(test.sendApiError).toHaveBeenCalledWith(
      res,
      409,
      'PROJECT_STATE_CHANGED',
      'Reload the project before editing.',
    );
  });

  it('holds a project-backed preview read until the response finishes', async () => {
    const order: string[] = [];
    const test = fixture({
      withProjectRead: async (_projectId, work) => {
        order.push('acquire');
        const value = await work();
        order.push('release');
        return value;
      },
    });
    test.readLiveArtifactCode.mockImplementation(async () => {
      order.push('read');
      return '<main>artifact</main>';
    });
    const req = request({
      params: { artifactId: 'artifact' },
      query: { projectId: 'managed', variant: 'template' },
    });
    const res = response(req);

    const pending = test.routes.handler('GET', '/api/live-artifacts/:artifactId/preview')(req, res);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual(['acquire', 'read']);
    res.emit('finish');
    await pending;
    expect(order).toEqual(['acquire', 'read', 'release']);
    expect(test.withProjectRead).toHaveBeenCalledWith('managed', expect.any(Function));
    expect(test.readLiveArtifactCode).toHaveBeenCalledWith(expect.objectContaining({
      projectMetadata: { baseDir: '/external/project' },
    }));
  });
});
