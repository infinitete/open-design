import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Application, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBrandRoutes } from '../src/brand-routes.js';
import { createBrandDir } from '../src/brands/store.js';
import { closeDatabase, openDatabase } from '../src/db.js';
import { createProjectGate } from '../src/services/project-git/gate.js';
import {
  createProjectGitMutationAdapter,
  type ProjectGitCoordination,
} from '../src/services/project-git/mutation-adapter.js';
import { GitDomainError } from '../src/services/project-git/errors.js';

const SKILLS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../skills',
);

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
      delete: register('DELETE'),
    } as unknown as Application,
    handler(method: string, route: string): Handler {
      const handler = handlers.get(`${method} ${route}`);
      if (!handler) throw new Error(`missing route ${method} ${route}`);
      return handler;
    },
  };
}

function response(req: Request) {
  const res = {
    req,
    headersSent: false,
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function request(input: {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: string;
} = {}): Request {
  return {
    params: input.params ?? {},
    body: input.body ?? {},
    get: vi.fn((name: string) =>
      name.toLowerCase() === 'x-od-project-revision' ? input.header : undefined),
  } as unknown as Request;
}

describe('brand backing-project Git coordination', () => {
  let tempDir: string;
  let brandsRoot: string;
  let projectsRoot: string;
  let userDesignSystemsRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-brand-git-route-'));
    brandsRoot = path.join(tempDir, 'brands');
    projectsRoot = path.join(tempDir, 'projects');
    userDesignSystemsRoot = path.join(tempDir, 'design-systems');
    fs.mkdirSync(brandsRoot, { recursive: true });
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(userDesignSystemsRoot, { recursive: true });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('authorizes the exact persisted project before coordination and preserves the auth response', async () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    createBrandDir(brandsRoot, 'acme', {
      id: 'acme',
      sourceUrl: 'https://acme.example/',
      createdAt: 1,
      updatedAt: 1,
      status: 'extracting',
      projectId: 'persisted-project',
    });
    const withProjectMutation = vi.fn();
    const authorizeProjectRequest = vi.fn(async (_req, res: Response) => {
      res.status(403).json({ error: 'forbidden' });
      return false;
    });
    const routes = captureApp();
    registerBrandRoutes(routes.app, {
      projectGitCoordination: {
        recoveryReady: Promise.resolve(),
        startup: {} as never,
        withProjectMutation,
        withProjectRead: vi.fn(),
        runtime: {} as never,
      },
      brandsRoot,
      userDesignSystemsRoot,
      projectsRoot,
      skillsRoot: SKILLS_ROOT,
      dataDir: tempDir,
      db,
      authorizeProjectRequest,
    });
    const req = request({ params: { id: 'acme' }, body: { projectId: 'other-project' } });
    const res = response(req);

    await routes.handler('POST', '/api/brands/:id/preview')(req, res);

    expect(authorizeProjectRequest).toHaveBeenCalledWith(
      req,
      res,
      'persisted-project',
      { mode: 'write', capability: 'writeFiles' },
    );
    expect(withProjectMutation).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
  });

  it('uses the established backing-project identity for legacy metadata without projectId', async () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    createBrandDir(brandsRoot, 'legacy', {
      id: 'legacy',
      sourceUrl: 'https://legacy.example/',
      createdAt: 1,
      updatedAt: 1,
      status: 'extracting',
    });
    const authorizeProjectRequest = vi.fn(async () => false);
    const routes = captureApp();
    registerBrandRoutes(routes.app, {
      projectGitCoordination: {
        recoveryReady: Promise.resolve(),
        startup: {} as never,
        withProjectMutation: vi.fn(),
        withProjectRead: vi.fn(),
        runtime: {} as never,
      },
      brandsRoot,
      userDesignSystemsRoot,
      projectsRoot,
      skillsRoot: SKILLS_ROOT,
      dataDir: tempDir,
      db,
      authorizeProjectRequest,
    });
    const req = request({ params: { id: 'legacy' } });

    await routes.handler('POST', '/api/brands/:id/preview')(req, response(req));

    expect(authorizeProjectRequest).toHaveBeenCalledWith(
      req,
      expect.anything(),
      'brand-legacy',
      { mode: 'write', capability: 'writeFiles' },
    );
  });

  it('returns the standard 409 envelope and performs no preview work for a stale epoch', async () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    createBrandDir(brandsRoot, 'acme', {
      id: 'acme',
      sourceUrl: 'https://acme.example/',
      createdAt: 1,
      updatedAt: 1,
      status: 'extracting',
      projectId: 'persisted-project',
    });
    const withProjectMutation = vi.fn(async () => {
      throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
    });
    const routes = captureApp();
    registerBrandRoutes(routes.app, {
      projectGitCoordination: {
        recoveryReady: Promise.resolve(),
        startup: {} as never,
        withProjectMutation,
        withProjectRead: vi.fn(),
        runtime: {} as never,
      },
      brandsRoot,
      userDesignSystemsRoot,
      projectsRoot,
      skillsRoot: SKILLS_ROOT,
      dataDir: tempDir,
      db,
      authorizeProjectRequest: vi.fn(async () => true),
    });
    const req = request({ params: { id: 'acme' }, body: { expectedProjectRevision: 6 }, header: '6' });
    const res = response(req);

    await routes.handler('POST', '/api/brands/:id/preview')(req, res);

    expect(withProjectMutation).toHaveBeenCalledWith(
      { projectId: 'persisted-project', expectedProjectRevision: 6, source: 'brand.preview' },
      expect.any(Function),
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'PROJECT_STATE_CHANGED',
        message: 'Reload the project before editing.',
      },
    });
    expect(fs.existsSync(path.join(projectsRoot, 'persisted-project', 'brand.html'))).toBe(false);
  });

  it('waits for the coordinated background unit to settle before cancel reacquires mutation', async () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const gate = createProjectGate();
    const mutation = createProjectGitMutationAdapter({
      recoveryReady: Promise.resolve(),
      store: { getBinding: () => null, bumpContent: () => 0 },
      gateFor: () => gate,
      notify: () => {},
    });
    const phases: string[] = [];
    const withProjectMutation: ProjectGitCoordination['withProjectMutation'] = async (input, work) =>
      mutation.withProjectMutation(input, async () => {
        phases.push(`enter:${input.source}`);
        try {
          return await work();
        } finally {
          phases.push(`exit:${input.source}`);
        }
      });
    const coordination = {
      recoveryReady: Promise.resolve(),
      startup: {} as never,
      withProjectMutation,
      withProjectRead: vi.fn(async (_projectId, work) => work()),
      runtime: {} as never,
    } satisfies ProjectGitCoordination;
    const routes = captureApp();
    registerBrandRoutes(routes.app, {
      projectGitCoordination: coordination,
      brandsRoot,
      userDesignSystemsRoot,
      projectsRoot,
      skillsRoot: SKILLS_ROOT,
      dataDir: tempDir,
      db,
      authorizeProjectRequest: vi.fn(async () => true),
      prefetch: async (_url, _brandDir, options) => new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(null), { once: true });
      }),
      logoFallback: async () => ({ changed: false }),
      imageryFallback: async () => ({ changed: false }),
    });
    const startReq = request({ body: { url: 'acme.example' } });
    const startRes = response(startReq);
    await routes.handler('POST', '/api/brands')(startReq, startRes);
    const started = vi.mocked(startRes.json).mock.calls[0]?.[0] as { id: string };
    for (let i = 0; i < 20 && !phases.includes('enter:brand.background'); i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(phases).toEqual([
      'enter:brand.startup',
      'exit:brand.startup',
      'enter:brand.background',
    ]);

    const cancelReq = request({ params: { id: started.id } });
    const cancelRes = response(cancelReq);
    await routes.handler('POST', '/api/brands/:id/cancel-extraction')(cancelReq, cancelRes);

    expect(phases).toEqual([
      'enter:brand.startup',
      'exit:brand.startup',
      'enter:brand.background',
      'exit:brand.background',
      'enter:brand.cancel',
      'exit:brand.cancel',
    ]);
    expect(cancelRes.json).toHaveBeenCalledWith({ ok: true, status: 'failed' });
    expect(gate.activeRuns()).toBe(0);
  });
});
