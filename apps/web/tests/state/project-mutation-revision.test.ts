import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitState } from '@open-design/contracts';
import { patchProject } from '../../src/state/projects';
import { uploadProjectFiles, writeProjectTextFileDetailed } from '../../src/providers/registry';
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
});
