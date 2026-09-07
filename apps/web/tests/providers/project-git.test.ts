import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';
import {
  ProjectGitHttpError,
  createProjectGitClient,
  createProjectGitHub,
  withFreshProjectMutation,
} from '../../src/providers/project-git';
import { captureProjectMutation } from '../../src/state/project-git';

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it.each([
    { label: 'HTTP 200', response: () => json({ operationId: 'op-wrong-status' }, 200) },
    { label: 'HTTP 204', response: () => new Response(null, { status: 204 }) },
    { label: 'an extra accepted field', response: () => json({ operationId: 'op-extra', extra: true }, 202) },
  ])('rejects $label instead of admitting an operation', async ({ response }) => {
    const fetchFn = vi.fn().mockResolvedValue(response());
    const client = createProjectGitClient({ fetchFn });
    await expect(client.execute('project', { kind: 'sync' }, 7, { idempotencyKey: 'strict-accepted' }))
      .rejects.toThrow(/invalid|202/i);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    { error: { code: 'UNKNOWN_CODE', message: 'Nope' } },
    { error: { code: 'PROJECT_STATE_CHANGED', message: 'History changed', extra: true } },
  ])('rejects malformed shared API errors without unsafe casts', async (body) => {
    const fetchFn = vi.fn().mockResolvedValue(json(body, 409));
    const client = createProjectGitClient({ fetchFn });
    await expect(client.execute('project', { kind: 'sync' }, 7, { idempotencyKey: 'strict-error' }))
      .rejects.toMatchObject({ status: 409, apiError: { code: 'INTERNAL_ERROR' } });
  });

  it.each([
    {
      label: 'operation id',
      operation: { id: 'different-operation', kind: 'sync', projectId: 'project' },
    },
    {
      label: 'project id',
      operation: { id: 'op-correlation', kind: 'sync', projectId: 'other-project' },
    },
    {
      label: 'action kind',
      operation: { id: 'op-correlation', kind: 'restore', projectId: 'project' },
    },
  ])('fails closed when a polled $label does not match the admitted request', async ({ operation }) => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ operationId: 'op-correlation' }, 202))
      .mockResolvedValueOnce(json({
        ...operation,
        status: 'succeeded', phase: 'synced', basis, result: null, error: null,
      }));
    const client = createProjectGitClient({ fetchFn });
    await expect(client.execute('project', { kind: 'sync' }, 7, { idempotencyKey: 'correlation' }))
      .rejects.toThrow(/match|mismatch|invalid/i);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('accepts the original compatible operation kind when retrying it', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(json({ operationId: 'op-retry' }, 202))
      .mockResolvedValueOnce(json({
        id: 'op-retry', kind: 'sync', status: 'succeeded', phase: 'synced',
        projectId: 'project', basis, result: null, error: null,
      }));
    const client = createProjectGitClient({ fetchFn });
    await expect(client.execute('project', { kind: 'retry', operationId: 'op-retry' }, 7, {
      idempotencyKey: 'retry-correlation',
    })).resolves.toMatchObject({ id: 'op-retry', kind: 'sync' });
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
  it('loads and owns exact fresh authority for a post-create mutation, then releases it', async () => {
    const fetchMock = vi.fn(async () => json(legalState));
    vi.stubGlobal('fetch', fetchMock);
    const mutation = vi.fn(async (context: ReturnType<typeof captureProjectMutation>) => {
      expect(context).toMatchObject({ expectedProjectRevision: 7, generation: 0 });
      expect(captureProjectMutation('post-create-project')).toEqual(context);
      return 'persisted';
    });

    await expect(withFreshProjectMutation('post-create-project', mutation)).resolves.toBe('persisted');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/post-create-project/git',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mutation).toHaveBeenCalledOnce();
    expect(captureProjectMutation('post-create-project')).toBeUndefined();
  });

  it('releases post-create authority leases on callback and fresh-read failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(legalState)));
    await expect(withFreshProjectMutation('callback-failure-project', async () => {
      throw new Error('seed write failed');
    })).rejects.toThrow('seed write failed');
    expect(captureProjectMutation('callback-failure-project')).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unavailable' }, 503)));
    const mutation = vi.fn();
    await expect(withFreshProjectMutation('read-failure-project', mutation)).rejects.toThrow();
    expect(mutation).not.toHaveBeenCalled();
    expect(captureProjectMutation('read-failure-project')).toBeUndefined();
  });

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
    expect(subscribeEvents.mock.results[0]?.value).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(subscribeEvents.mock.results[0]?.value).toHaveBeenCalledOnce());
  });

  it('aborts the shared state read after the last-subscriber StrictMode grace', async () => {
    vi.useFakeTimers();
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

    expect(readSignal?.aborted).toBe(false);
    await vi.runOnlyPendingTimersAsync();
    expect(readSignal?.aborted).toBe(true);
  });

  it('revokes captured mutation authority when the true last subscriber is disposed', async () => {
    vi.useFakeTimers();
    const client = { state: vi.fn(async () => legalState) };
    const hub = createProjectGitHub(client, { subscribeEvents: vi.fn(() => vi.fn()) });
    const unsubscribe = hub.subscribe('revoked-project', vi.fn());
    await vi.waitFor(() => expect(captureProjectMutation('revoked-project')).toBeDefined());
    const captured = captureProjectMutation('revoked-project');
    expect(captured?.signal.aborted).toBe(false);

    unsubscribe();
    await vi.runOnlyPendingTimersAsync();

    expect(captured?.signal.aborted).toBe(true);
    expect(captureProjectMutation('revoked-project')).toBeUndefined();
  });

  it('reuses one connection when StrictMode resubscribes inside the cleanup grace', async () => {
    vi.useFakeTimers();
    const client = { state: vi.fn(() => new Promise<ProjectGitState>(() => {})) };
    const stopEvents = vi.fn();
    const subscribeEvents = vi.fn(() => stopEvents);
    const hub = createProjectGitHub(client, { subscribeEvents });

    const offFirst = hub.subscribe('strict-project', vi.fn());
    offFirst();
    const offSecond = hub.subscribe('strict-project', vi.fn());
    await vi.runOnlyPendingTimersAsync();

    expect(client.state).toHaveBeenCalledOnce();
    expect(subscribeEvents).toHaveBeenCalledOnce();
    expect(stopEvents).not.toHaveBeenCalled();
    offSecond();
    await vi.runOnlyPendingTimersAsync();
  });

  it('deletes an idle hub entry and global mutation store before a later subscription', async () => {
    vi.useFakeTimers();
    const client = { state: vi.fn(async () => legalState) };
    const subscribeEvents = vi.fn(() => vi.fn());
    const hub = createProjectGitHub(client, { subscribeEvents });
    const offFirst = hub.subscribe('bounded-project', vi.fn());
    const firstStore = hub.store('bounded-project');
    await hub.refresh('bounded-project');
    expect(captureProjectMutation('bounded-project')).toBeDefined();

    offFirst();
    await vi.runOnlyPendingTimersAsync();
    expect(captureProjectMutation('bounded-project')).toBeUndefined();

    const offSecond = hub.subscribe('bounded-project', vi.fn());
    expect(hub.store('bounded-project')).not.toBe(firstStore);
    expect(client.state).toHaveBeenCalledTimes(2);
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    offSecond();
    await vi.runOnlyPendingTimersAsync();
  });

  it('does not let a stale cleanup closure delete a replacement hub entry', async () => {
    vi.useFakeTimers();
    const client = { state: vi.fn(async () => legalState) };
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const subscribeEvents = vi.fn()
      .mockReturnValueOnce(firstStop)
      .mockReturnValueOnce(secondStop);
    const hub = createProjectGitHub(client, { subscribeEvents });
    const offFirst = hub.subscribe('replacement-project', vi.fn());
    offFirst();
    await vi.runOnlyPendingTimersAsync();
    const offSecond = hub.subscribe('replacement-project', vi.fn());
    const replacement = hub.store('replacement-project');

    offFirst();
    await vi.runOnlyPendingTimersAsync();
    expect(hub.store('replacement-project')).toBe(replacement);
    expect(secondStop).not.toHaveBeenCalled();
    expect(captureProjectMutation('replacement-project')).toBeDefined();

    offSecond();
    await vi.runOnlyPendingTimersAsync();
  });

  it('supersedes a pre-restore state read and accepts only the fresh generation response', async () => {
    const reads: Array<{ signal?: AbortSignal; resolve: (state: ProjectGitState) => void }> = [];
    const client = {
      state: vi.fn((_projectId: string, signal?: AbortSignal) => new Promise<ProjectGitState>((resolve) => {
        reads.push({ signal, resolve });
      })),
    };
    let eventListener: ((event: { type: 'project-git-state'; projectId: string; state: ProjectGitState }) => void) | undefined;
    const hub = createProjectGitHub(client, {
      subscribeEvents: vi.fn((_projectId, listener) => {
        eventListener = listener as typeof eventListener;
        return vi.fn();
      }),
    });
    const unsubscribe = hub.subscribe('project', vi.fn());
    expect(reads).toHaveLength(1);
    eventListener?.({ type: 'project-git-state', projectId: 'project', state: legalState });
    eventListener?.({
      type: 'project-git-state', projectId: 'project',
      state: { ...legalState, projectRevision: 8, contentRevision: 10 },
    });

    const fresh = hub.refresh('project', { fresh: true, generation: 1 });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[0]?.signal?.aborted).toBe(true);
    reads[1]!.resolve({ ...legalState, projectRevision: 8, contentRevision: 10 });
    await fresh;
    expect(hub.store('project').snapshot().state?.projectRevision).toBe(8);

    reads[0]!.resolve(legalState);
    await Promise.resolve();
    expect(hub.store('project').snapshot().state?.projectRevision).toBe(8);
    unsubscribe();
  });

  it('starts a later epoch state read even when the superseded request never settles', async () => {
    const reads: Array<{ resolve: (state: ProjectGitState) => void }> = [];
    const client = {
      state: vi.fn(() => new Promise<ProjectGitState>((resolve) => { reads.push({ resolve }); })),
    };
    let eventListener: ((event: { type: 'project-git-state'; projectId: string; state: ProjectGitState }) => void) | undefined;
    const hub = createProjectGitHub(client, {
      subscribeEvents: vi.fn((_projectId, listener) => {
        eventListener = listener as typeof eventListener;
        return vi.fn();
      }),
    });
    const unsubscribe = hub.subscribe('project-never', vi.fn());
    eventListener?.({ type: 'project-git-state', projectId: 'project-never', state: legalState });
    eventListener?.({
      type: 'project-git-state', projectId: 'project-never',
      state: { ...legalState, projectRevision: 8, contentRevision: 10 },
    });
    const generationOne = hub.refresh('project-never', { fresh: true, generation: 1 });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.resolve({ ...legalState, projectRevision: 8, contentRevision: 10 });
    await generationOne;

    eventListener?.({
      type: 'project-git-state', projectId: 'project-never',
      state: { ...legalState, projectRevision: 9, contentRevision: 11 },
    });
    const generationTwo = hub.refresh('project-never', { fresh: true, generation: 2 });
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    reads[2]!.resolve({ ...legalState, projectRevision: 9, contentRevision: 11 });
    await generationTwo;
    expect(hub.store('project-never').snapshot().state?.projectRevision).toBe(9);
    unsubscribe();
  });

  it('rejects a stale fresh generation before touching the current authoritative read', async () => {
    const reads: Array<{ signal?: AbortSignal; resolve: (state: ProjectGitState) => void }> = [];
    const client = {
      state: vi.fn((_projectId: string, signal?: AbortSignal) => new Promise<ProjectGitState>((resolve) => {
        reads.push({ signal, resolve });
      })),
    };
    let eventListener: ((event: { type: 'project-git-state'; projectId: string; state: ProjectGitState }) => void) | undefined;
    const hub = createProjectGitHub(client, {
      subscribeEvents: vi.fn((_projectId, listener) => {
        eventListener = listener as typeof eventListener;
        return vi.fn();
      }),
    });
    const unsubscribe = hub.subscribe('generation-order', vi.fn());
    eventListener?.({ type: 'project-git-state', projectId: 'generation-order', state: legalState });
    eventListener?.({
      type: 'project-git-state', projectId: 'generation-order',
      state: { ...legalState, projectRevision: 8, contentRevision: 10 },
    });
    const generationOne = hub.refresh('generation-order', { fresh: true, generation: 1 });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    eventListener?.({
      type: 'project-git-state', projectId: 'generation-order',
      state: { ...legalState, projectRevision: 9, contentRevision: 11 },
    });
    void generationOne.catch(() => {});
    const generationTwo = hub.refresh('generation-order', { fresh: true, generation: 2 });
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    const currentSignal = reads[2]!.signal;
    await expect(hub.refresh('generation-order', { fresh: true, generation: 1 }))
      .rejects.toThrow(/generation/i);
    expect(currentSignal?.aborted).toBe(false);

    reads[2]!.resolve({ ...legalState, projectRevision: 9, contentRevision: 11 });
    await generationTwo;
    expect(hub.store('generation-order').snapshot().state?.projectRevision).toBe(9);
    unsubscribe();
  });

  it('does not register authority for an abandoned store lookup', () => {
    const client = { state: vi.fn(async () => legalState) };
    const subscribeEvents = vi.fn(() => vi.fn());
    const hub = createProjectGitHub(client, { subscribeEvents });

    const abandoned = hub.store('abandoned-project');

    expect(abandoned.snapshot().state).toBeNull();
    expect(captureProjectMutation('abandoned-project')).toBeUndefined();
    expect(client.state).not.toHaveBeenCalled();
    expect(subscribeEvents).not.toHaveBeenCalled();
  });
});
