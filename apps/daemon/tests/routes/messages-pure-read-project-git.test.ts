import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProjectConversationRoutes } from '../../src/routes/project/conversations.js';
import { portableImportMarker } from '../../src/services/project-git/portable.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

it('keeps GET messages strictly read-only for an empty legacy brand conversation', async () => {
  const app = express();
  const prepare = vi.fn(() => ({ all: () => [] }));
  const listMessages = vi.fn(() => []);
  const withProjectRead = vi.fn(async (_projectId: string, work: () => Promise<unknown>) => work());
  registerProjectConversationRoutes(app, {
    db: { prepare },
    design: { runs: { list: () => [] } },
    http: {
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
    paths: { BRANDS_DIR: '/brands', PROJECTS_DIR: '/projects', RUNTIME_DATA_DIR: '/data' },
    projectStore: {
      getProject: () => ({
        id: 'project',
        metadata: { kind: 'brand', importedFrom: 'brand-extraction', brandId: 'legacy' },
      }),
    },
    conversations: {
      getConversation: () => ({ id: 'conversation', projectId: 'project' }),
      listMessages,
    },
    ids: { randomId: () => 'unused' },
    telemetry: {}, appConfig: {}, agents: {},
    projectGitCoordination: {
      recoveryReady: Promise.resolve(),
      withProjectRead,
      withProjectMutation: vi.fn(),
      runtime: {}, startup: {},
    },
    authorizeProjectRequest: vi.fn(async () => true),
  } as never);
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/api/projects/project/conversations/conversation/messages',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ messages: [] });
  expect(withProjectRead).toHaveBeenCalledOnce();
  expect(listMessages).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
});

it('attaches inert restored presentation once and keeps current database feedback authoritative', async () => {
  const app = express();
  const portableMessage = {
    schemaVersion: 1 as const,
    id: 'portable-message',
    conversationId: 'portable-conversation',
    role: 'assistant' as const,
    content: '<question-form>{"questions":[{"id":"tone","label":"Tone"}]}</question-form>',
    createdAt: 2,
    predecessorId: null,
    turnId: 'portable-turn',
    terminal: 'historical' as const,
    resourceRefs: [],
    displayEvents: [{ kind: 'history-form' as const, title: 'Historical questions', status: 'historical' as const }],
    context: { feedback: { rating: 'negative' as const, createdAt: 2 } },
  };
  const snapshot = {
    manifest: { schemaVersion: 1 as const, repositoryProjectId: 'repository', resources: [] },
    project: { schemaVersion: 1 as const, name: 'Restored', createdAt: 1, kind: 'prototype' as const,
      preferences: {}, contentRefs: [], linkedFolderRequirements: [] },
    conversations: [{ schemaVersion: 1 as const, id: 'portable-conversation', title: 'History', mode: 'design' as const, createdAt: 1 }],
    messages: [portableMessage],
  };
  const rows = [
    { kind: 'manifest', local_id: 'project', record_json: JSON.stringify(snapshot.manifest), snapshot_digest: null, ordinal: 0 },
    { kind: 'project', local_id: 'project', record_json: JSON.stringify(snapshot.project), snapshot_digest: portableImportMarker(snapshot), ordinal: 0 },
    { kind: 'conversation', local_id: 'conversation', record_json: JSON.stringify(snapshot.conversations[0]), snapshot_digest: null, ordinal: 0 },
    { kind: 'message', local_id: 'local-message', record_json: JSON.stringify(portableMessage), snapshot_digest: null, ordinal: 0 },
  ];
  const prepare = vi.fn(() => ({ all: () => rows }));
  const listMessages = vi.fn(() => [{
    id: 'local-message', role: 'assistant', content: portableMessage.content,
    feedback: { rating: 'positive', createdAt: 9 },
  }]);
  const withProjectRead = vi.fn(async (_projectId: string, work: () => Promise<unknown>) => work());
  registerProjectConversationRoutes(app, {
    db: { prepare }, design: { runs: { list: () => [] } },
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } }) },
    paths: { BRANDS_DIR: '/brands', PROJECTS_DIR: '/projects', RUNTIME_DATA_DIR: '/data' },
    projectStore: { getProject: () => ({ id: 'project' }) },
    conversations: { getConversation: () => ({ id: 'conversation', projectId: 'project' }), listMessages },
    ids: { randomId: () => 'unused' }, telemetry: {}, appConfig: {}, agents: {},
    projectGitCoordination: { recoveryReady: Promise.resolve(), withProjectRead,
      withProjectMutation: vi.fn(), runtime: {}, startup: {} },
    authorizeProjectRequest: vi.fn(async () => true),
  } as never);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/api/projects/project/conversations/conversation/messages');
  expect(response.status).toBe(200);
  const body = await response.json() as { messages: Array<Record<string, unknown>> };
  expect(body.messages[0]).toMatchObject({
    id: 'local-message',
    restoredPresentation: {
      portableId: 'portable-message',
      turnId: 'portable-turn',
      feedback: { rating: 'positive', createdAt: 9 },
    },
  });
  expect(prepare).toHaveBeenCalledOnce();
});

it('rejects a conversation fork whose selected prefix contains restored portable provenance', async () => {
  const app = express();
  app.use(express.json());
  const insertConversation = vi.fn();
  const sourceMessages = [
    { id: 'live-user', role: 'user', content: 'Before' },
    { id: 'restored-assistant', role: 'assistant', content: 'Historical answer' },
  ];
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('SELECT 1 FROM project_git_portable_records')) {
      return { get: (_projectId: string, messageId: string) => messageId === 'restored-assistant' ? { 1: 1 } : undefined };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  registerProjectConversationRoutes(app, {
    db: { prepare }, design: { runs: { list: () => [] } },
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } }) },
    paths: { BRANDS_DIR: '/brands', PROJECTS_DIR: '/projects', RUNTIME_DATA_DIR: '/data' },
    projectStore: { getProject: () => ({ id: 'project' }) },
    conversations: {
      getConversation: () => ({ id: 'source', projectId: 'project', sessionMode: 'design' }),
      listMessages: () => sourceMessages,
      insertConversation,
    },
    ids: { randomId: () => 'fork' }, telemetry: {}, appConfig: {}, agents: {},
    projectGitCoordination: { recoveryReady: Promise.resolve(), withProjectRead: vi.fn(),
      withProjectMutation: async (_projectId: string, work: () => Promise<unknown>) => work(), runtime: {}, startup: {} },
    authorizeProjectRequest: vi.fn(async () => true),
  } as never);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/api/projects/project/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seedFromConversationId: 'source', forkAfterMessageId: 'restored-assistant' }),
    });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: {
    code: 'CONFLICT', message: 'Restored historical messages cannot be forked',
  } });
  expect(insertConversation).not.toHaveBeenCalled();
});

it.each([
  {
    label: 'full source-conversation seed',
    sourceMessages: [
      { id: 'live-user', role: 'user', content: 'Before' },
      { id: 'restored-full', role: 'assistant', content: 'Historical answer' },
    ],
    body: { seedFromConversationId: 'source' },
  },
  {
    label: 'legacy client snapshot seed',
    sourceMessages: [],
    body: {
      seedMessages: [
        { id: 'live-user', role: 'user', content: 'Before' },
        { id: 'restored-legacy', role: 'assistant', content: 'Historical answer' },
      ],
    },
  },
  {
    label: 'in-memory fork fallback seed',
    sourceMessages: [{ id: 'live-user', role: 'user', content: 'Before' }],
    body: {
      seedFromConversationId: 'source',
      forkAfterMessageId: 'restored-fallback',
      forkFallbackPredecessorMessageId: 'live-user',
      forkFallbackMessage: {
        id: 'restored-fallback',
        role: 'assistant',
        content: 'Historical answer',
      },
    },
  },
])('rejects restored provenance in a $label before creating rows', async ({ sourceMessages, body }) => {
  const app = express();
  app.use(express.json());
  const insertConversation = vi.fn(() => ({ id: 'fork', projectId: 'project' }));
  const upsertMessage = vi.fn();
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('SELECT 1 FROM project_git_portable_records')) {
      return {
        get: (_projectId: string, messageId: string) =>
          messageId.startsWith('restored-') ? { 1: 1 } : undefined,
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  registerProjectConversationRoutes(app, {
    db: { prepare }, design: { runs: { list: () => [] } },
    http: { sendApiError: (res: express.Response, status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } }) },
    paths: { BRANDS_DIR: '/brands', PROJECTS_DIR: '/projects', RUNTIME_DATA_DIR: '/data' },
    projectStore: { getProject: () => ({ id: 'project' }) },
    conversations: {
      getConversation: () => ({ id: 'source', projectId: 'project', sessionMode: 'design' }),
      listMessages: () => sourceMessages,
      insertConversation,
      upsertMessage,
    },
    ids: { randomId: () => 'fork' }, telemetry: {}, appConfig: {}, agents: {},
    projectGitCoordination: { recoveryReady: Promise.resolve(), withProjectRead: vi.fn(),
      withProjectMutation: async (_projectId: string, work: () => Promise<unknown>) => work(), runtime: {}, startup: {} },
    authorizeProjectRequest: vi.fn(async () => true),
  } as never);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/api/projects/project/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: {
    code: 'CONFLICT', message: 'Restored historical messages cannot be forked',
  } });
  expect(insertConversation).not.toHaveBeenCalled();
  expect(upsertMessage).not.toHaveBeenCalled();
});
