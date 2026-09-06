import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProjectConversationRoutes } from '../../src/routes/project/conversations.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

it('keeps GET messages strictly read-only for an empty legacy brand conversation', async () => {
  const app = express();
  const prepare = vi.fn(() => { throw new Error('GET attempted an unapproved database query'); });
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
  expect(prepare).not.toHaveBeenCalled();
});
