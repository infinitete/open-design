import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';
import {
  createTerminal,
  listConversations,
  listProjects,
  patchProject,
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
  createProjectGitStateStore,
  registerProjectMutationStore,
} from '../../src/state/project-git';

function state(revision: number): ProjectGitState {
  return {
    enabled: true, phase: 'synced', localHead: 'a'.repeat(40), observedRemoteHead: null,
    confirmedRemoteHead: null, projectRevision: revision, contentRevision: 1, bindingGeneration: 1,
    dirty: false, pendingPush: false, autoSync: true, operationId: null, error: null,
    binding: { remoteConfigured: false, remoteLabel: null, branch: null }, dependencies: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('project mutation transport', () => {
  it('keeps an old prepared write bound to its captured revision and abort signal', async () => {
    const projectId = 'mutation-project';
    const store = createProjectGitStateStore(state(4));
    registerProjectMutationStore(projectId, store);
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
    const store = createProjectGitStateStore(state(8));
    registerProjectMutationStore(projectId, store);
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
    registerProjectMutationStore(projectId, createProjectGitStateStore(state(3)));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project' },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));

    await expect(patchProject(projectId, { name: 'Draft name' }))
      .rejects.toMatchObject({ apiError: { code: 'PROJECT_STATE_CHANGED', message: 'Reload the project' } });
  });

  it('binds terminal creation to the captured revision and preserves a stale-state rejection', async () => {
    const projectId = 'terminal-project';
    const store = createProjectGitStateStore(state(6));
    registerProjectMutationStore(projectId, store);
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
    const store = createProjectGitStateStore(state(9));
    registerProjectMutationStore(projectId, store);
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

  it('preserves revision authority and stale-state errors for all live-artifact mutations', async () => {
    const projectId = 'live-artifact-project';
    const store = createProjectGitStateStore(state(11));
    registerProjectMutationStore(projectId, store);
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
