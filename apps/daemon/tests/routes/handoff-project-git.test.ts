import type { Express, Request, Response } from 'express';
import { expect, it, vi } from 'vitest';

import { registerHandoffRoutes } from '../../src/routes/handoff.js';

it('snapshots the authorized conversation under one read gate and releases before BYOK network', async () => {
  let handler!: (req: Request, res: Response) => Promise<unknown>;
  const app = {
    post: (_route: string, routeHandler: typeof handler) => { handler = routeHandler; },
  } as unknown as Express;
  const order: string[] = [];
  const transcript = { jsonl: '{"kind":"header"}\n', conversationCount: 1, messageCount: 1, bytesWritten: 18 };
  const renderProjectTranscript = vi.fn(() => { order.push('render'); return transcript; });
  const synthesizeHandoffPrompt = vi.fn(async (_db, projectsRoot, projectId, options) => {
    order.push('network');
    expect(projectsRoot).toBe('/shadow-projects');
    expect(projectId).toBe('project');
    expect(options.transcript).toBe(transcript);
    return { prompt: 'resume', model: 'model', inputTokens: 1, outputTokens: 1, transcriptMessageCount: 1 };
  });
  const withProjectRead = vi.fn(async (_projectId: string, work: () => unknown) => {
    order.push('read:enter');
    try { return await work(); } finally { order.push('read:release'); }
  });
  const authorizeProjectRequest = vi.fn(async () => { order.push('auth'); return true; });
  const sendApiError = vi.fn();
  registerHandoffRoutes(app, {
    db: {} as never,
    http: { sendApiError } as never,
    paths: { PROJECTS_DIR: '/shadow-projects' } as never,
    projectStore: { getProject: vi.fn(() => ({ id: 'project', metadata: { baseDir: '/imported/project' } })) } as never,
    conversations: { getConversation: vi.fn(() => ({ id: 'conversation', projectId: 'project' })) } as never,
    validation: { isSafeId: vi.fn(() => true), validateExternalApiBaseUrl: vi.fn() } as never,
    projectGitCoordination: { withProjectRead } as never,
    authorizeProjectRequest,
    handoff: {
      synthesizeHandoffPrompt,
      FinalizeUpstreamError: class extends Error {},
      EmptyTranscriptError: class extends Error {},
      redactSecrets: vi.fn(),
      renderProjectTranscript,
    } as never,
  });
  const req = {
    params: { id: 'project' },
    body: { conversationId: 'conversation', apiKey: 'secret', model: 'model' },
  } as unknown as Request;
  const res = { on: vi.fn(), off: vi.fn(), json: vi.fn() } as unknown as Response;

  await handler(req, res);

  expect(order).toEqual(['auth', 'read:enter', 'render', 'read:release', 'network']);
  expect(withProjectRead).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'resume' }));
  expect(sendApiError).not.toHaveBeenCalled();
});
