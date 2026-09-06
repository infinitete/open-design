import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTerminalRoutes } from '../../src/routes/terminal.js';
import { GitDomainError } from '../../src/services/project-git/errors.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

function fixture(options: { rejectAdmission?: boolean; rejectSpawn?: boolean } = {}) {
  const release = vi.fn();
  const permit = Object.freeze({ permit: true });
  const create = vi.fn(async (meta: any) => {
    if (options.rejectSpawn) throw new Error('spawn failed');
    return {
      id: 'terminal', projectId: meta.projectId, cwd: meta.cwd, status: 'running',
      mutationSession: meta.projectMutationSession,
    };
  });
  const session = { projectId: 'project', expectedProjectRevision: 4, permit, release };
  const projectGitCoordination = {
    recoveryReady: Promise.resolve(),
    runtime: {
      admitSession: vi.fn(async () => {
        if (options.rejectAdmission) {
          throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
        }
        return session;
      }),
    },
    withProjectMutation: vi.fn(async (_scope, work: () => Promise<unknown>) => work()),
    withProjectRead: vi.fn(),
  };
  const terminals = {
    create,
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    statusBody: vi.fn((value: any) => value),
    stream: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(), shutdownActive: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  registerTerminalRoutes(app, {
    db: {},
    http: {
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
      createSseResponse: vi.fn(),
    },
    paths: { PROJECTS_DIR: '/managed' },
    projectStore: { getProject: () => ({ id: 'project', metadata: { baseDir: '/imported/project' } }) },
    projectFiles: { resolveProjectDir: (_root: string, _id: string, metadata: any) => metadata.baseDir },
    terminals,
    projectGitCoordination,
    authorizeProjectRequest: vi.fn(async () => true),
  } as never);
  return { app, create, permit, projectGitCoordination, release, session };
}

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('terminal project Git session', () => {
  it('admits and marks dirty before spawning in the imported project root', async () => {
    const f = fixture();
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-od-project-revision': '4' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(f.projectGitCoordination.runtime.admitSession).toHaveBeenCalledWith('project', 4);
    expect(f.projectGitCoordination.withProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project', expectedProjectRevision: 4, permit: f.permit }),
      expect.any(Function),
    );
    expect(f.projectGitCoordination.withProjectMutation.mock.invocationCallOrder[0])
      .toBeLessThan(f.create.mock.invocationCallOrder[0]!);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/imported/project', projectMutationSession: f.session,
    }));
    expect(f.release).not.toHaveBeenCalled();
  });

  it('rejects stale admission before spawning and maps the standard error', async () => {
    const f = fixture({ rejectAdmission: true });
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedProjectRevision: 3 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project before editing.' },
    });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('releases the session immediately when PTY spawn fails', async () => {
    const f = fixture({ rejectSpawn: true });
    const base = await listen(f.app);
    const response = await fetch(`${base}/api/projects/project/terminals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedProjectRevision: 4 }),
    });
    expect(response.status).toBe(500);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
