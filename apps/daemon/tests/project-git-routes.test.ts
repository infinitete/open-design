import type http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ProjectGitAccepted, ProjectGitBasis, ProjectGitOperation, ProjectGitState } from '@open-design/contracts';
import { sendApiError } from '../src/http/api-errors.js';
import { registerProjectGitRoutes } from '../src/routes/project-git.js';
import { finalizeDaemonServices, startServer } from '../src/server.js';
import { GitDomainError } from '../src/services/project-git/errors.js';
import type { ProjectGitService } from '../src/services/project-git/service.js';
import type { ProjectGitJournalRecord, ProjectGitStore } from '../src/storage/project-git.js';
import { fixtureGitEnv } from './helpers/project-git-crash-worker.js';

describe('project Git routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true, projectGitEnv: fixtureGitEnv }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function createProject(): Promise<string> {
    const id = `project-git-${randomUUID()}`;
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'Project Git route project' }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    projectsToClean.push(id);
    return id;
  }

  async function waitForOperation(operationId: string): Promise<ProjectGitOperation> {
    const deadline = Date.now() + 10_000;
    let operation: ProjectGitOperation | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/project-git-operations/${operationId}`);
      expect(response.status, await response.clone().text()).toBe(200);
      operation = await response.json() as ProjectGitOperation;
      if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'waiting') return operation;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for project Git operation ${operationId}: ${JSON.stringify(operation)}`);
  }

  async function enableProject(projectId: string) {
    const previewResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ mode: 'preview' }),
    });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(202);
    const previewAccepted = await previewResponse.json() as ProjectGitAccepted;
    const preview = await waitForOperation(previewAccepted.operationId);
    expect(preview.result?.preview?.dependencies, JSON.stringify(preview)).toEqual([]);
    const confirmResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ mode: 'confirm', previewId: previewAccepted.operationId, expectedProjectRevision: preview.basis.projectRevision }),
    });
    expect(confirmResponse.status, await confirmResponse.clone().text()).toBe(202);
    const confirmed = await confirmResponse.json() as ProjectGitAccepted;
    const operation = await waitForOperation(confirmed.operationId);
    expect(operation).toMatchObject({ kind: 'enable', status: 'succeeded', projectId });
    return operation;
  }

  it('rejects a listen failure after draining project Git startup work', async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const address = occupied.address();
    expect(address && typeof address === 'object').toBe(true);
    try {
      await expect(startServer({
        port: (address as { port: number }).port,
        host: '127.0.0.1',
        returnServer: true,
        projectGitEnv: fixtureGitEnv,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect((await fetch(`${baseUrl}/api/ready`)).status).toBe(200);
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  });

  it('reports an existing project as pending explicit Git enablement', async () => {
    const projectId = await createProject();

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/git`);

    expect(response.status).toBe(200);
    const state = await response.json() as ProjectGitState;
    expect(state.enabled).toBe(false);
    expect(state.phase).toBe('enable_pending');
  });

  it('does not disclose Git state for a missing project', async () => {
    const response = await fetch(`${baseUrl}/api/projects/missing-${randomUUID()}/git`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });

  it('applies global local-daemon admission before project, operation, or import disclosure', async () => {
    const denied = { origin: 'https://outside.invalid' };
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/projects/missing-${randomUUID()}/git`, { headers: denied }),
      fetch(`${baseUrl}/api/project-git-operations/${randomUUID()}`, { headers: denied }),
      fetch(`${baseUrl}/api/import/git`, { method: 'POST', headers: { ...denied, 'content-type': 'application/json' }, body: '{}' }),
    ]);
    for (const response of responses) expect(response.status).toBe(403);
  });

  it('requires strict input and an idempotency key before accepting an action', async () => {
    const projectId = await createProject();
    const missingKey = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

    const malformed = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ mode: 'preview', actorId: 'request-selected-actor' }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('returns the same durable operation for an exact idempotent preview repeat', async () => {
    const projectId = await createProject();
    const key = randomUUID();
    const request = () => fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ mode: 'preview' }),
    });
    const first = await request();
    expect(first.status, await first.clone().text()).toBe(202);
    const accepted = await first.json() as ProjectGitAccepted;
    const repeated = await request();
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual(accepted);

    const operation = await waitForOperation(accepted.operationId);
    expect(operation).toMatchObject({ id: accepted.operationId, kind: 'enable_preview', status: 'succeeded', projectId });
    const reusedForDifferentRequest = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ mode: 'preview', expectedProjectRevision: 1 }),
    });
    expect(reusedForDifferentRequest.status).toBe(409);
    expect(await reusedForDifferentRequest.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('serves enabled history, commit files, conversations, restore, and one-operation sync', async () => {
    const projectId = await createProject(); await enableProject(projectId);
    const state = await fetch(`${baseUrl}/api/projects/${projectId}/git`).then(response => response.json()) as ProjectGitState;
    expect(state).toMatchObject({ enabled: true, projectRevision: 0 });
    const historyResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/history`);
    expect(historyResponse.status, await historyResponse.clone().text()).toBe(200);
    const history = await historyResponse.json() as { commits: Array<{ oid: string }>; nextCursor: string | null };
    expect(history.commits.length).toBeGreaterThan(0); const oid = history.commits[0]!.oid;
    const commit = await fetch(`${baseUrl}/api/projects/${projectId}/git/commits/${oid}`);
    expect(commit.status).toBe(200); expect(await commit.json()).toMatchObject({ oid });
    const file = await fetch(`${baseUrl}/api/projects/${projectId}/git/commits/${oid}/files/.open-design/project.json`);
    expect(file.status, await file.clone().text()).toBe(200);
    expect(await file.json()).toMatchObject({ encoding: 'base64', mediaType: 'application/json; charset=utf-8' });
    const conversations = await fetch(`${baseUrl}/api/projects/${projectId}/git/commits/${oid}/conversations`);
    expect(conversations.status).toBe(200); const conversationSnapshot = await conversations.json() as { conversations: unknown[]; messages: unknown[] };
    expect(conversationSnapshot.conversations.length).toBeGreaterThan(0); expect(conversationSnapshot.messages).toEqual([]);

    const restorePreviewResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/restore-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ oid, expectedProjectRevision: state.projectRevision }),
    });
    expect(restorePreviewResponse.status, await restorePreviewResponse.clone().text()).toBe(202);
    const restorePreview = await restorePreviewResponse.json() as ProjectGitAccepted;
    expect(await waitForOperation(restorePreview.operationId)).toMatchObject({ kind: 'restore_preview', status: 'succeeded' });
    const restoreResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ previewId: restorePreview.operationId, expectedProjectRevision: state.projectRevision }),
    });
    expect(restoreResponse.status, await restoreResponse.clone().text()).toBe(202);
    const restored = await restoreResponse.json() as ProjectGitAccepted;
    expect(await waitForOperation(restored.operationId)).toMatchObject({ kind: 'restore', status: 'succeeded' });

    const afterRestore = await fetch(`${baseUrl}/api/projects/${projectId}/git`).then(response => response.json()) as ProjectGitState;
    const syncResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ expectedProjectRevision: afterRestore.projectRevision }),
    });
    expect(syncResponse.status, await syncResponse.clone().text()).toBe(202);
    const sync = await syncResponse.json() as ProjectGitAccepted;
    expect(await waitForOperation(sync.operationId)).toMatchObject({ id: sync.operationId, kind: 'sync', status: 'succeeded' });
  });

  it('strictly rejects repeated history queries, traversal, and contradictory retry IDs', async () => {
    const projectId = await createProject(); const enabled = await enableProject(projectId);
    for (const [suffix, code] of [
      ['?cursor=one&cursor=two', 'BAD_REQUEST'],
      ['?path=one&path=two', 'BAD_REQUEST'],
      ['?path=../private', 'VALIDATION_FAILED'],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/history${suffix}`);
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
    const retry = await fetch(`${baseUrl}/api/project-git-operations/${enabled.id}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ operationId: randomUUID() }),
    });
    expect(retry.status).toBe(400); expect(await retry.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('emits operation and state SSE events and keeps GET as reconnect truth', async () => {
    const projectId = await createProject(); const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/projects/${projectId}/events`, { signal: controller.signal });
    expect(stream.status).toBe(200); const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    try {
      while (!text.includes('event: ready')) text += decoder.decode((await reader.read()).value, { stream: true });
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/enable`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ mode: 'preview' }),
      });
      expect(response.status, await response.clone().text()).toBe(202);
      while (!text.includes('event: project-git-operation') || !text.includes('event: project-git-state')) {
        const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true });
      }
      expect(text).toContain('event: project-git-operation'); expect(text).toContain('event: project-git-state');
      expect(await fetch(`${baseUrl}/api/projects/${projectId}/git`).then(result => result.json())).toMatchObject({ enabled: false, phase: 'enable_pending' });
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  });

});

describe('project Git daemon finalization order', () => {
  it('drains project Git after run resources and before analytics', async () => {
    const order: string[] = [];
    await finalizeDaemonServices({
      runs: async () => { order.push('runs'); },
      terminals: async () => { order.push('terminals'); },
      browsers: async () => { order.push('browsers'); },
      projectGit: async () => { order.push('project-git'); },
      analytics: async () => { order.push('analytics'); },
    });
    expect(order).toEqual(['runs', 'terminals', 'browsers', 'project-git', 'analytics']);
  });

  it('attempts project Git and later cleanup after an earlier finalizer fails', async () => {
    const order: string[] = []; const failure = new Error('run finalizer failed');
    const step = (name: string, error?: Error) => vi.fn(async () => { order.push(name); if (error) throw error; });
    await expect(finalizeDaemonServices({
      runs: step('runs', failure), terminals: step('terminals'), browsers: step('browsers'),
      projectGit: step('project-git'), analytics: step('analytics'),
    })).rejects.toBe(failure);
    expect(order).toEqual(['runs', 'terminals', 'browsers', 'project-git', 'analytics']);
  });
});

describe('project Git route registrar matrix', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;
  let service: ProjectGitService;
  const basis: ProjectGitBasis = {
    projectRevision: 7,
    contentRevision: 3,
    localHead: '1'.repeat(40),
    remoteHead: '2'.repeat(40),
    bindingGeneration: 4,
  };
  const operation = (id: string, projectId: string | null, actorId = 'route-actor'): ProjectGitJournalRecord => ({
    id, kind: 'sync', status: 'failed', phase: 'failed', projectId, basis,
    result: null, error: { code: 'GIT_AUTH_REQUIRED', message: 'authenticate' },
    actorId, scope: projectId ? `project:${projectId}` : 'import', idempotencyKey: `key-${id}`,
    requestDigest: 'a'.repeat(64), payload: {}, journalPhase: null, phaseCompleted: false,
    recoveryData: null, completedProjectRevision: null, ownerOperationId: null,
    recordsTransition: null, protection: null, createdAt: 1, updatedAt: 1,
  });

  beforeAll(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT, design_system_id TEXT,
        pending_prompt TEXT, metadata_json TEXT, applied_plugin_snapshot_id TEXT,
        custom_instructions TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE project_git_registrations (project_id TEXT, hidden INTEGER, state TEXT);
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', 'Route project', 1, 1);
    `);
    const invalid = () => { throw new GitDomainError('BAD_REQUEST', 400, 'Invalid Git route value.'); };
    service = {
      getState: vi.fn(async projectId => projectId === 'bad' ? invalid() : ({ enabled: false, phase: 'enable_pending' }) as ProjectGitState),
      execute: vi.fn(async () => ({ operationId: 'accepted' })),
      getOperation: vi.fn(async id => id === 'invalid' ? invalid() : operation(id, 'project')),
      history: vi.fn(async (_projectId, cursor, path) => cursor === 'invalid' || path === '../private' ? invalid() : ({ commits: [], nextCursor: null })),
      commit: vi.fn(async (_projectId, oid) => oid === 'invalid' ? invalid() : ({ oid })),
      file: vi.fn(async (_projectId, _oid, path) => path.includes('..') ? invalid() : ({ encoding: 'base64', content: '', mediaType: 'text/plain' })),
      conversations: vi.fn(async (_projectId, oid) => oid === 'invalid' ? invalid() : null),
      conflicts: vi.fn(async projectId => projectId === 'bad' ? invalid() : []),
      start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    } as unknown as ProjectGitService;
    const journals = new Map([
      ['op', operation('op', 'project')],
      ['other-actor', operation('other-actor', 'project', 'different-actor')],
      ['background-project', operation('background-project', 'project', 'project-git-background')],
      ['other-import', operation('other-import', null, 'different-actor')],
    ]);
    const store = { getJournal: (id: string) => journals.get(id) ?? null } as unknown as ProjectGitStore;
    const app = express(); app.use(express.json());
    registerProjectGitRoutes(app, {
      db, projectGit: service, projectGitStore: store,
      resolveProjectGitActor: req => req.get('x-test-actor') ?? 'route-actor',
      authorizeProjectRequest: async (req, res) => {
        if (req.get('x-deny-project') === '1') {
          sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found'); return false;
        }
        return true;
      },
      http: {
        sendApiError,
        requireLocalDaemonRequest: (req, res, next) => {
          if (req.get('x-deny-local') === '1') return sendApiError(res, 403, 'FORBIDDEN', 'Local daemon access required.');
          next();
        },
      },
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1'); server.once('listening', resolve); server.once('error', reject);
    });
    const address = server.address(); baseUrl = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); db.close();
  });

  const request = (path: string, init: RequestInit = {}) => fetch(baseUrl + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'route-key', ...init.headers },
  });

  it('maps every successful route to the exact service read or action and trusted context', async () => {
    const mutationCases: Array<{ method: string; path: string; body: unknown; action: unknown; projectId?: string | null }> = [
      { method: 'POST', path: '/api/projects/project/git/enable', body: { mode: 'preview', expectedProjectRevision: 7 }, action: { kind: 'enable_preview' } },
      { method: 'POST', path: '/api/projects/project/git/enable', body: { mode: 'confirm', previewId: 'preview', expectedProjectRevision: 7 }, action: { kind: 'enable', previewId: 'preview' } },
      { method: 'POST', path: '/api/projects/project/git/binding-preview', body: { url: 'ssh://example/repo', branch: 'main', expectedProjectRevision: 7 }, action: { kind: 'binding_preview', url: 'ssh://example/repo', branch: 'main' } },
      { method: 'POST', path: '/api/projects/project/git/bind', body: { previewId: 'preview', expectedProjectRevision: 7 }, action: { kind: 'bind', previewId: 'preview' } },
      { method: 'POST', path: '/api/projects/project/git/unbind', body: { expectedProjectRevision: 7 }, action: { kind: 'unbind' } },
      { method: 'PATCH', path: '/api/projects/project/git', body: { action: 'pause', expectedProjectRevision: 7 }, action: { kind: 'pause' } },
      { method: 'PATCH', path: '/api/projects/project/git', body: { action: 'resume', expectedProjectRevision: 7 }, action: { kind: 'resume' } },
      { method: 'POST', path: '/api/projects/project/git/sync', body: { expectedProjectRevision: 7 }, action: { kind: 'sync' } },
      { method: 'POST', path: '/api/import/git', body: { url: 'ssh://example/repo', branch: 'main' }, action: { kind: 'open', url: 'ssh://example/repo', branch: 'main' }, projectId: null },
      { method: 'POST', path: '/api/projects/project/git/restore-preview', body: { oid: '1'.repeat(40), expectedProjectRevision: 7 }, action: { kind: 'restore_preview', oid: '1'.repeat(40) } },
      { method: 'POST', path: '/api/projects/project/git/restore', body: { previewId: 'preview', expectedProjectRevision: 7 }, action: { kind: 'restore', previewId: 'preview' } },
      { method: 'POST', path: '/api/projects/project/git/conflicts/resolve', body: { operationId: 'op', basis, resolutions: [], expectedProjectRevision: 7 }, action: { kind: 'resolve', operationId: 'op', basis, resolutions: [] } },
      { method: 'POST', path: '/api/project-git-operations/op/retry', body: { operationId: 'op', expectedProjectRevision: 7 }, action: { kind: 'retry', operationId: 'op' } },
    ];
    for (const testCase of mutationCases) {
      vi.mocked(service.execute).mockClear();
      const response = await request(testCase.path, { method: testCase.method, body: JSON.stringify(testCase.body) });
      expect(response.status, `${testCase.method} ${testCase.path}: ${await response.clone().text()}`).toBe(202);
      expect(service.execute).toHaveBeenCalledWith(testCase.action, {
        actorId: 'route-actor', projectId: testCase.projectId === undefined ? 'project' : testCase.projectId,
        idempotencyKey: 'route-key', ...(testCase.projectId === null ? {} : { expectedProjectRevision: 7 }),
      });
    }

    const reads = [
      ['/api/projects/project/git', 'getState', ['project']],
      ['/api/projects/project/git/history?cursor=cursor&path=index.html', 'history', ['project', 'cursor', 'index.html']],
      [`/api/projects/project/git/commits/${'1'.repeat(40)}`, 'commit', ['project', '1'.repeat(40)]],
      [`/api/projects/project/git/commits/${'1'.repeat(40)}/files/index.html`, 'file', ['project', '1'.repeat(40), 'index.html']],
      [`/api/projects/project/git/commits/${'1'.repeat(40)}/conversations`, 'conversations', ['project', '1'.repeat(40)]],
      ['/api/projects/project/git/conflicts', 'conflicts', ['project']],
      ['/api/project-git-operations/op', 'getOperation', ['op']],
    ] as const;
    for (const [path, method, args] of reads) {
      const target = service[method]; vi.mocked(target).mockClear();
      const response = await request(path); expect(response.status, path).toBe(200);
      expect(target).toHaveBeenCalledWith(...args);
    }
  });

  it('returns safe errors for invalid input on every route', async () => {
    const invalidCases: Array<{ method?: string; path: string; body?: unknown; status?: number }> = [
      { path: '/api/projects/missing/git', status: 404 },
      { method: 'POST', path: '/api/projects/project/git/enable', body: {} },
      { method: 'POST', path: '/api/projects/project/git/binding-preview', body: { url: '' } },
      { method: 'POST', path: '/api/projects/project/git/bind', body: {} },
      { method: 'POST', path: '/api/projects/project/git/unbind', body: { unknown: true } },
      { method: 'PATCH', path: '/api/projects/project/git', body: { action: 'invalid' } },
      { method: 'POST', path: '/api/projects/project/git/sync', body: { unknown: true } },
      { method: 'POST', path: '/api/import/git', body: { url: 'ssh://example/repo' } },
      { path: '/api/projects/project/git/history?cursor=one&cursor=two' },
      { path: '/api/projects/project/git/commits/invalid' },
      { path: `/api/projects/project/git/commits/${'1'.repeat(40)}/files/%2E%2E%2Fprivate` },
      { path: '/api/projects/project/git/commits/invalid/conversations' },
      { method: 'POST', path: '/api/projects/project/git/restore-preview', body: {} },
      { method: 'POST', path: '/api/projects/project/git/restore', body: {} },
      { path: '/api/projects/missing/git/conflicts', status: 404 },
      { method: 'POST', path: '/api/projects/project/git/conflicts/resolve', body: {} },
      { path: '/api/project-git-operations/missing', status: 404 },
      { method: 'POST', path: '/api/project-git-operations/op/retry', body: { operationId: 'different' } },
    ];
    for (const testCase of invalidCases) {
      const response = await request(testCase.path, {
        method: testCase.method ?? 'GET', ...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
      });
      expect(response.status, `${testCase.method ?? 'GET'} ${testCase.path}: ${await response.clone().text()}`).toBe(testCase.status ?? 400);
      expect(await response.json()).toHaveProperty('error.code');
    }
  });

  it('authorizes before project existence or parsing and never discloses another actor operation', async () => {
    const projectRoutes = [
      ['GET', '/api/projects/project/git'], ['POST', '/api/projects/project/git/enable'],
      ['POST', '/api/projects/project/git/binding-preview'], ['POST', '/api/projects/project/git/bind'],
      ['POST', '/api/projects/project/git/unbind'], ['PATCH', '/api/projects/project/git'],
      ['POST', '/api/projects/project/git/sync'], ['GET', '/api/projects/project/git/history'],
      ['GET', `/api/projects/project/git/commits/${'1'.repeat(40)}`],
      ['GET', `/api/projects/project/git/commits/${'1'.repeat(40)}/files/index.html`],
      ['GET', `/api/projects/project/git/commits/${'1'.repeat(40)}/conversations`],
      ['POST', '/api/projects/project/git/restore-preview'], ['POST', '/api/projects/project/git/restore'],
      ['GET', '/api/projects/project/git/conflicts'], ['POST', '/api/projects/project/git/conflicts/resolve'],
    ] as const;
    vi.mocked(service.execute).mockClear();
    for (const [method, path] of projectRoutes) {
      const response = await request(path, { method, headers: { 'x-deny-project': '1' }, ...(method === 'GET' ? {} : { body: '{}' }) });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(service.execute).not.toHaveBeenCalled();

    const operationRead = await request('/api/project-git-operations/other-actor');
    const operationRetry = await request('/api/project-git-operations/other-actor/retry', { method: 'POST', body: '{}' });
    expect(operationRead.status).toBe(200); expect(operationRetry.status).toBe(202);
    const open = await request('/api/import/git', { method: 'POST', headers: { 'x-deny-local': '1' }, body: '{}' });
    expect(open.status).toBe(403);
  });

  it('uses current project authority for background operations but keeps imports actor-scoped', async () => {
    const projectRead = await request('/api/project-git-operations/background-project');
    expect(projectRead.status, await projectRead.clone().text()).toBe(200);

    vi.mocked(service.execute).mockClear();
    const projectRetry = await request('/api/project-git-operations/background-project/retry', {
      method: 'POST',
      body: JSON.stringify({ operationId: 'background-project', expectedProjectRevision: 7 }),
    });
    expect(projectRetry.status, await projectRetry.clone().text()).toBe(202);
    expect(service.execute).toHaveBeenCalledWith(
      { kind: 'retry', operationId: 'background-project' },
      { actorId: 'route-actor', projectId: 'project', idempotencyKey: 'route-key', expectedProjectRevision: 7 },
    );

    expect((await request('/api/project-git-operations/other-import')).status).toBe(404);
    expect((await request('/api/project-git-operations/other-import/retry', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
