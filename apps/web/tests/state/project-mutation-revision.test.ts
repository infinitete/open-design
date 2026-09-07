import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';
import {
  createTerminal,
  installGeneratedPluginFolder,
  listConversations,
  listProjects,
  patchProject,
  patchProjectWithFreshAuthority,
  startGeneratedPluginShareTask,
} from '../../src/state/projects';
import {
  applyLibraryAsset,
  deleteLiveArtifact,
  refreshLiveArtifact,
  uploadProjectFiles,
  updateLiveArtifact,
  writeProjectTextFileDetailed,
} from '../../src/providers/registry';
import {
  ProjectStateChangedError,
  captureProjectMutation,
  createProjectGitStateStore,
  registerProjectMutationStore,
  unregisterProjectMutationStore,
} from '../../src/state/project-git';

const ownedStores = new Map<string, ReturnType<typeof createProjectGitStateStore>>();

function readyStore(projectId: string, revision: number) {
  const store = createProjectGitStateStore(state(revision));
  registerProjectMutationStore(projectId, store);
  ownedStores.set(projectId, store);
  return store;
}

function state(revision: number): ProjectGitState {
  return {
    enabled: true, phase: 'synced', localHead: 'a'.repeat(40), observedRemoteHead: null,
    confirmedRemoteHead: null, projectRevision: revision, contentRevision: 1, bindingGeneration: 1,
    dirty: false, pendingPush: false, autoSync: true, operationId: null, error: null,
    binding: { remoteConfigured: false, remoteLabel: null, branch: null }, dependencies: [],
  };
}

afterEach(() => {
  for (const [projectId, store] of ownedStores) {
    unregisterProjectMutationStore(projectId, store);
    store.dispose();
  }
  ownedStores.clear();
  vi.unstubAllGlobals();
});

describe('project mutation transport', () => {
  it('loads post-create authority and sends the seed patch with its exact revision', async () => {
    const projectId = 'post-create-seed';
    const project = {
      id: projectId, name: 'Seeded', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/projects/${projectId}/git`) {
        return new Response(JSON.stringify(state(12)), { status: 200 });
      }
      if (String(input) === `/api/projects/${projectId}` && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ project }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(patchProjectWithFreshAuthority(projectId, { pendingPrompt: 'Persist me' }))
      .resolves.toEqual(project);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([
      `/api/projects/${projectId}`,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'X-OD-Project-Revision': '12' }),
        body: JSON.stringify({ pendingPrompt: 'Persist me' }),
      }),
    ]);
    expect(captureProjectMutation(projectId)).toBeUndefined();
  });

  it('fails a project patch closed when no ready mutation authority exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(patchProject('unmanaged-project', { name: 'Must not escape' })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an old prepared write bound to its captured revision and abort signal', async () => {
    const projectId = 'mutation-project';
    const store = readyStore(projectId, 4);
    const captured = store.capture();
    store.accept(state(5), 'event');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      file: { name: 'index.html', path: 'index.html', size: 4, mime: 'text/html', mtime: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await writeProjectTextFileDetailed(projectId, 'index.html', 'old', { mutationContext: captured });

    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('4');
    expect(init.signal).toBe(captured.signal);
    expect(captured.signal.aborted).toBe(true);
  });

  it('captures once for a multipart batch and preserves PROJECT_STATE_CHANGED', async () => {
    const projectId = 'upload-project';
    const store = readyStore(projectId, 8);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Restored elsewhere', retryable: false },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadProjectFiles(projectId, [new File(['x'], 'x.txt')]))
      .rejects.toBeInstanceOf(ProjectStateChangedError);
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('8');
  });

  it('does not collapse a project patch 409 to null', async () => {
    const projectId = 'settings-project';
    readyStore(projectId, 3);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project' },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));

    await expect(patchProject(projectId, { name: 'Draft name' }))
      .rejects.toMatchObject({ apiError: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project' } });
  });

  it('binds terminal creation to the captured revision and preserves a stale-state rejection', async () => {
    const projectId = 'terminal-project';
    const store = readyStore(projectId, 6);
    const captured = store.capture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Terminal intent is stale' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTerminal(projectId, undefined, captured))
      .rejects.toBeInstanceOf(ProjectStateChangedError);
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('6');
    expect(JSON.parse(String(init.body))).toEqual({ expectedProjectRevision: 6 });
    expect(init.signal).toBe(captured.signal);
  });

  it('uses one captured revision for a library apply and rethrows stale-state rejection', async () => {
    const projectId = 'library-apply-project';
    const store = readyStore(projectId, 9);
    const captured = store.capture();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Library selection is stale' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(applyLibraryAsset('asset-1', projectId, 'references', {
      includeElement: true,
      mutationContext: captured,
    })).rejects.toBeInstanceOf(ProjectStateChangedError);
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('9');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId,
      dir: 'references',
      includeElement: true,
      expectedProjectRevision: 9,
    });
    expect(init.signal).toBe(captured.signal);
  });

  it('preserves exact authority for every generated-plugin provider conflict', async () => {
    const projectId = 'plugin-provider-conflict';
    const store = readyStore(projectId, 13);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Plugin intent is stale' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    for (const run of [
      () => installGeneratedPluginFolder(projectId, 'plugins/generated', store.capture()),
      () => startGeneratedPluginShareTask(projectId, 'plugins/generated', 'publish-github', store.capture()),
      () => startGeneratedPluginShareTask(projectId, 'plugins/generated', 'contribute-open-design', store.capture()),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(ProjectStateChangedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) {
      expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('13');
    }
  });

  it('does not collapse an aborted generated-plugin provider into an ordinary failure', async () => {
    const projectId = 'plugin-provider-abort';
    const store = readyStore(projectId, 14);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('History changed', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const contexts = [store.capture(), store.capture(), store.capture()];
    const pending = [
      installGeneratedPluginFolder(projectId, 'plugins/generated', contexts[0]),
      startGeneratedPluginShareTask(projectId, 'plugins/generated', 'publish-github', contexts[1]),
      startGeneratedPluginShareTask(projectId, 'plugins/generated', 'contribute-open-design', contexts[2]),
    ];
    const assertions = pending.map((result) => expect(result).rejects.toMatchObject({ name: 'AbortError' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    store.accept(state(15), 'event');
    await Promise.all(assertions);
  });

  it('preserves revision authority and stale-state errors for all live-artifact mutations', async () => {
    const projectId = 'live-artifact-project';
    const store = readyStore(projectId, 11);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Live artifact action is stale' },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    for (const run of [
      () => refreshLiveArtifact(projectId, 'artifact-1', store.capture()),
      () => updateLiveArtifact(projectId, 'artifact-1', {
        title: 'Updated', status: 'active', pinned: false, preview: null,
      } as never, store.capture()),
      () => deleteLiveArtifact(projectId, 'artifact-1', store.capture()),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(ProjectStateChangedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) {
      expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('11');
      expect(init.signal).toBeDefined();
    }
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({
      expectedProjectRevision: 11,
    });
  });

  it('does not join a pre-restore cached project-list read during an authoritative refresh', async () => {
    const replies: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { replies.push(resolve); }));
    vi.stubGlobal('fetch', fetchMock);
    const stale = listProjects();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const controller = new AbortController();
    const fresh = listProjects({ fresh: true, signal: controller.signal, throwOnError: true });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]!(new Response(JSON.stringify({ projects: [{ id: 'fresh' }] }), { status: 200 }));
    await expect(fresh).resolves.toEqual([{ id: 'fresh' }]);
    replies[0]!(new Response(JSON.stringify({ projects: [{ id: 'stale' }] }), { status: 200 }));
    await expect(stale).resolves.toEqual([{ id: 'stale' }]);
    const later = listProjects();
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    replies[2]!(new Response(JSON.stringify({ projects: [{ id: 'later' }] }), { status: 200 }));
    await expect(later).resolves.toEqual([{ id: 'later' }]);
  });

  it('does not join a pre-restore conversation-list read during an authoritative refresh', async () => {
    const replies: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { replies.push(resolve); }));
    vi.stubGlobal('fetch', fetchMock);
    const stale = listConversations('conversation-fresh-project');
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    const fresh = listConversations('conversation-fresh-project', {
      fresh: true,
      signal: new AbortController().signal,
      throwOnError: true,
    });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[1]!(new Response(JSON.stringify({ conversations: [{ id: 'fresh' }] }), { status: 200 }));
    await expect(fresh).resolves.toEqual([{ id: 'fresh' }]);
    replies[0]!(new Response(JSON.stringify({ conversations: [{ id: 'stale' }] }), { status: 200 }));
    await expect(stale).resolves.toEqual([{ id: 'stale' }]);
    const later = listConversations('conversation-fresh-project');
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    replies[2]!(new Response(JSON.stringify({ conversations: [{ id: 'later' }] }), { status: 200 }));
    await expect(later).resolves.toEqual([{ id: 'later' }]);
  });

  it('does not turn an aborted upload into ordinary failed attachment rows', async () => {
    const controller = new AbortController();
    const mutationContext = {
      expectedProjectRevision: 12,
      generation: 3,
      signal: controller.signal,
    };
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException('History changed', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadProjectFiles(
      'aborted-upload-project',
      [new File(['old'], 'old.png')],
      undefined,
      mutationContext,
    )).rejects.toMatchObject({ name: 'AbortError' });
  });
});
