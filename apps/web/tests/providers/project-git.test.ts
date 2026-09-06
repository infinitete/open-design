import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';
import {
  ProjectGitHttpError,
  createProjectGitClient,
  createProjectGitHub,
} from '../../src/providers/project-git';

const legalState: ProjectGitState = {
  enabled: true, phase: 'pending_push', localHead: 'a'.repeat(40), observedRemoteHead: null,
  confirmedRemoteHead: null, projectRevision: 7, contentRevision: 9, bindingGeneration: 2,
  dirty: false, pendingPush: true, autoSync: true, operationId: null, error: null,
  binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' }, dependencies: [],
};
const basis = { projectRevision: 7, contentRevision: 9, localHead: 'a'.repeat(40), remoteHead: null, bindingGeneration: 2 };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.useRealTimers());

describe('ProjectGitClient', () => {
  it('validates state and sends the captured revision through the exact mutation transport', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ operationId: 'op-1' }, 202))
      .mockResolvedValueOnce(json({ id: 'op-1', kind: 'sync', status: 'waiting', phase: 'auth_required',
        projectId: 'project one', basis, result: null, error: { code: 'GIT_AUTH_REQUIRED', message: 'Sign in' } }));
    const client = createProjectGitClient({ fetchFn, sleep: async () => {} });
    const operation = await client.execute('project one', { kind: 'sync' }, 7, { idempotencyKey: 'intent-1' });
    expect(operation.status).toBe('waiting');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const mutation = fetchFn.mock.calls[0]!;
    expect(mutation[0]).toBe('/api/projects/project%20one/git/sync');
    expect(mutation[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': 'intent-1', 'X-OD-Project-Revision': '7' }),
      body: JSON.stringify({ expectedProjectRevision: 7 }),
    });
  });

  it('declares the history path query and rejects malformed daemon state', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ commits: [], nextCursor: null }))
      .mockResolvedValueOnce(json({ ...legalState, pendingPush: true, localHead: null }));
    const client = createProjectGitClient({ fetchFn });
    await expect(client.history('project', 'next cursor', 'src/index.ts')).resolves.toEqual({ commits: [], nextCursor: null });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/projects/project/git/history?cursor=next+cursor&path=src%2Findex.ts');
    await expect(client.state('project')).rejects.toThrow(/invalid/i);
  });

  it('surfaces the shared 409 ApiError without collapsing it to null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: {
      code: 'PROJECT_STATE_CHANGED', message: 'Project was restored', retryable: false,
    } }, 409));
    const client = createProjectGitClient({ fetchFn });
    await expect(client.execute('project', { kind: 'pause' }, 4, { idempotencyKey: 'old-draft' }))
      .rejects.toMatchObject({
        status: 409,
        apiError: { code: 'PROJECT_STATE_CHANGED', message: 'Project was restored', retryable: false },
      });
  });

  it('cancels operation polling as soon as the captured epoch signal aborts', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ operationId: 'op-poll' }, 202))
      .mockResolvedValueOnce(json({
        id: 'op-poll', kind: 'sync', status: 'running', phase: 'syncing',
        projectId: 'project', basis, result: null, error: null,
      }));
    const controller = new AbortController();
    const client = createProjectGitClient({
      fetchFn,
      sleep: () => new Promise<void>(() => {}),
    });

    const operation = client.execute('project', { kind: 'sync' }, 7, {
      idempotencyKey: 'abort-poll',
      signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException('History changed', 'AbortError'));
    await rejected;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('shared project Git hub', () => {
  it('shares one state GET and one project event subscription per project', async () => {
    let resolveState!: (value: ProjectGitState) => void;
    const statePromise = new Promise<ProjectGitState>((resolve) => { resolveState = resolve; });
    const client = { state: vi.fn(() => statePromise) };
    const subscribeEvents = vi.fn(() => vi.fn());
    const hub = createProjectGitHub(client as never, { subscribeEvents });
    const first = vi.fn(); const second = vi.fn();
    const offFirst = hub.subscribe('project', first);
    const offSecond = hub.subscribe('project', second);
    expect(client.state).toHaveBeenCalledOnce();
    expect(subscribeEvents).toHaveBeenCalledOnce();
    resolveState(legalState);
    await statePromise;
    await Promise.resolve();
    expect(first.mock.calls.at(-1)?.[0].state).toEqual(legalState);
    expect(second.mock.calls.at(-1)?.[0].state).toEqual(legalState);
    const [, , eventOptions] = subscribeEvents.mock.calls[0] as unknown as [
      string,
      (event: unknown) => void,
      { onReady?: () => void },
    ];
    const ready = eventOptions.onReady;
    ready?.();
    await vi.waitFor(() => expect(client.state).toHaveBeenCalledTimes(2));
    offFirst();
    expect(subscribeEvents.mock.results[0]?.value).not.toHaveBeenCalled();
    offSecond();
    expect(subscribeEvents.mock.results[0]?.value).toHaveBeenCalledOnce();
  });

  it('aborts the shared state read when the last subscriber leaves', async () => {
    let readSignal: AbortSignal | undefined;
    const client = {
      state: vi.fn((_projectId: string, signal?: AbortSignal) => {
        readSignal = signal;
        return new Promise<ProjectGitState>(() => {});
      }),
    };
    const hub = createProjectGitHub(client, { subscribeEvents: vi.fn(() => vi.fn()) });

    const unsubscribe = hub.subscribe('detached-project', vi.fn());
    expect(readSignal?.aborted).toBe(false);
    unsubscribe();

    expect(readSignal?.aborted).toBe(true);
  });
});
