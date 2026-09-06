import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProjectPluginRoutes } from '../../src/routes/plugins/index.js';
import { GitDomainError } from '../../src/services/project-git/errors.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const app = express();
  app.use(express.json());
  const order: string[] = [];
  const background = deferred();
  const handleProjectPluginCli = vi.fn(async (_req, res: express.Response) => {
    res.json({ ok: true });
  });
  const taskStart = vi.fn(async (_req, res: express.Response) => {
    res.status(202).json({ taskId: 'task' });
    return { accepted: undefined, settled: background.promise };
  });
  const coordination = {
    recoveryReady: Promise.resolve(),
    runtime: {} as never,
    withProjectMutation: vi.fn(async (_scope, work: () => Promise<unknown>) => {
      order.push('mutation:acquire');
      try { return await work(); } finally { order.push('mutation:release'); }
    }),
    withProjectRead: vi.fn(async (_projectId, work: () => Promise<unknown>) => {
      order.push('read:acquire');
      try { return await work(); } finally { order.push('read:release'); }
    }),
  };
  const middleware: express.RequestHandler = (_req, _res, next) => next();
  registerProjectPluginRoutes(app, {
    db: {
      prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
      transaction: (work: () => unknown) => work,
    },
    paths: { PROJECTS_DIR: '/projects', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
    ids: { randomId: () => 'id' },
    projectStore: {},
    conversations: {},
    authorizeProjectRequest: vi.fn(async () => true),
    projectGitCoordination: coordination,
    plugins: {
      listSkillPluginCandidates: () => [{ id: 'candidate' }],
    },
    helpers: {
      requireLocalDaemonRequest: middleware,
      resolvedPortRef: { current: null },
      isLocalSameOrigin: () => true,
      getProject: () => ({ id: 'project' }),
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
      handleProjectPluginCli,
      handleCandidateShareTask: taskStart,
      handleProjectShareTask: taskStart,
    },
  } as never);
  return { app, background, coordination, handleProjectPluginCli, order, taskStart };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('plugin share project Git coordination', () => {
  it('coordinates synchronous publish as a mutation and contribute as a read', async () => {
    const f = fixture();
    const base = await listen(f.app);
    const publish = await fetch(`${base}/api/projects/project/plugins/publish-github`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(publish.status).toBe(200);
    expect(f.order).toEqual(['mutation:acquire', 'mutation:release']);

    f.order.length = 0;
    const contribute = await fetch(`${base}/api/projects/project/plugins/contribute-open-design`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(contribute.status).toBe(200);
    expect(f.order).toEqual(['read:acquire', 'read:release']);
  });

  for (const action of ['publish-github', 'contribute-open-design'] as const) {
    const gate = action === 'publish-github' ? 'mutation' : 'read';
    it(`retains the ${gate} permit for a general ${action} task until settlement`, async () => {
      const f = fixture();
      const base = await listen(f.app);
      const response = await fetch(`${base}/api/projects/project/plugins/share-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(202);
      expect(f.order).toEqual([`${gate}:acquire`]);
      f.background.resolve();
      for (let attempt = 0; attempt < 20 && f.order.length < 2; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(f.order).toEqual([`${gate}:acquire`, `${gate}:release`]);
    });
  }

  it('retains a mutation permit for candidate share through the full CLI task', async () => {
    const f = fixture();
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/plugin-candidates/candidate/share-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'contribute-open-design' }),
    });
    expect(response.status).toBe(202);
    expect(f.order).toEqual(['mutation:acquire']);
    f.background.resolve();
    for (let attempt = 0; attempt < 20 && f.order.length < 2; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(f.order).toEqual(['mutation:acquire', 'mutation:release']);
  });

  it('rejects stale publish admission before starting a CLI task', async () => {
    const f = fixture();
    f.coordination.withProjectMutation.mockRejectedValueOnce(
      new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.'),
    );
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/plugins/share-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish-github', expectedProjectRevision: 4 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project before editing.' },
    });
    expect(f.taskStart).not.toHaveBeenCalled();
  });

  it('releases the permit when an accepted share task settles with failure', async () => {
    const f = fixture();
    f.taskStart.mockImplementationOnce(async (_req, res: express.Response) => {
      res.status(202).json({ taskId: 'failed-task' });
      return { accepted: undefined, settled: Promise.reject(new Error('CLI failed')) };
    });
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/plugins/share-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish-github' }),
    });
    expect(response.status).toBe(202);
    for (let attempt = 0; attempt < 20 && f.order.length < 2; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(f.order).toEqual(['mutation:acquire', 'mutation:release']);
  });
});
