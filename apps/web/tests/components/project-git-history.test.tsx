// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectGitOperation, ProjectGitPreview, ProjectGitState } from '@open-design/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import type { ProjectGitClient } from '../../src/providers/project-git';
import type { ProjectEvent } from '../../src/providers/project-events';
import { ProjectGitRestoreDialog } from '../../src/components/project-git/ProjectGitRestoreDialog';
import { ProjectGitHistory, ProjectGitPanel } from '../../src/components/project-git/ProjectGitHistory';
import { ProjectGitSettings } from '../../src/components/project-git/ProjectGitSettings';

const events = vi.hoisted(() => ({ listener: (_event: ProjectEvent) => {} }));
vi.mock('../../src/providers/project-events', () => ({ subscribeProjectEvents: (_id: string, listener: typeof events.listener) => { events.listener = listener; return () => {}; } }));
const basis = { projectRevision: 4, contentRevision: 8, localHead: 'local', remoteHead: 'remote', bindingGeneration: 2 };
const state: ProjectGitState = { enabled: true, phase: 'synced', projectRevision: 4, contentRevision: 8, localHead: 'local', bindingGeneration: 2, observedRemoteHead: 'remote', confirmedRemoteHead: 'remote', dirty: false, pendingPush: false, autoSync: true, operationId: null, error: null, binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' }, dependencies: [] };
const preview: ProjectGitPreview = { id: 'preview', kind: 'restore', targetOid: 'old', basis, expiresAt: Date.now() + 60_000, changes: { addedPaths: ['a.html'], modifiedPaths: [], deletedPaths: ['b.html'], settingsChanged: 0, conversationsChanged: 0, ignoredPaths: [], privatePaths: [], missingPaths: [], historyMode: 'files_only', collisions: [] }, dependencies: [] };
const operation = (result: ProjectGitOperation['result'] = null): ProjectGitOperation => ({ id: 'op', kind: result ? 'restore_preview' : 'restore', projectId: 'p', basis, phase: 'local_saved', status: 'succeeded', result, error: null });
function api(): ProjectGitClient { return { check: vi.fn().mockResolvedValue(state), state: vi.fn().mockResolvedValue(state), execute: vi.fn().mockResolvedValue(operation({ preview })), operation: vi.fn(), history: vi.fn(), commit: vi.fn(), file: vi.fn(), conversations: vi.fn().mockResolvedValue(null), conflicts: vi.fn() }; }
afterEach(cleanup);

it.each(['settings', 'restore', 'panel'])('mounts %s outside project stacking contexts and preserves dialog focus', async kind => {
  const origin = document.createElement('button'); document.body.append(origin); origin.focus();
  const close = vi.fn(); const client = api();
  const view = render(<I18nProvider initial="en"><div data-testid="project-stacking-context" style={{ isolation: 'isolate' }}>
    {kind === 'settings' ? <ProjectGitSettings projectId="p" client={client} onClose={close} />
      : kind === 'restore' ? <ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={vi.fn()} onClose={close} />
        : <ProjectGitPanel title="History" onClose={close}><button type="button">History action</button></ProjectGitPanel>}
  </div></I18nProvider>);
  try {
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('[data-testid="project-stacking-context"]')).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.querySelector('button')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
    await act(async () => {});
  } finally { view.unmount(); expect(origin).toHaveFocus(); origin.remove(); }
});

it('requires a resolved preview and submits its original id and revision before completion', async () => {
  const client = api(); let resolve!: (value: ProjectGitOperation) => void;
  vi.mocked(client.execute).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(operation());
  const completed = vi.fn();
  render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={completed} onClose={vi.fn()} /></I18nProvider>);
  const confirm = screen.getByRole('button', { name: 'Confirm restore' });
  expect(confirm).toBeDisabled();
  expect(screen.getByText(/Pause external editing until restoration finishes/)).toBeVisible();
  await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
  await act(async () => resolve(operation({ preview })));
  expect(await screen.findByText('Restore files only; keep current settings and conversations.')).toBeVisible();
  expect(confirm).toBeEnabled(); fireEvent.click(confirm);
  await waitFor(() => expect(completed).toHaveBeenCalledWith(state));
  expect(client.execute).toHaveBeenLastCalledWith('p', { kind: 'restore', previewId: 'preview' }, 4, expect.objectContaining({ idempotencyKey: expect.any(String) }));
});

it.each([{ projectRevision: 5 }, { contentRevision: 9 }, { localHead: 'other' }, { observedRemoteHead: 'other' }, { bindingGeneration: 3 }, { phase: 'conflict' as const }])('invalidates preview when live basis changes: %j', async change => {
  const client = api();
  render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
  await screen.findByText('Restore files only; keep current settings and conversations.');
  act(() => events.listener({ type: 'project-git-state', projectId: 'p', state: { ...state, ...change } }));
  expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('preview is stale');
  expect(client.execute).toHaveBeenCalledTimes(1);
});

it('rechecks all basis fields before confirmation even without a delivered event', async () => {
  const client = api();
  render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
  await screen.findByText('Restore files only; keep current settings and conversations.');
  vi.mocked(client.state).mockResolvedValue({ ...state, contentRevision: 9 });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('preview is stale');
  expect(client.execute).toHaveBeenCalledTimes(1);
});

it('shows true commit metadata, path filtering and inert historical HTML', async () => {
  const client = api();
  vi.mocked(client.history).mockResolvedValue({ commits: [{ oid: 'old', parents: ['parent-a', 'parent-b'], author: { name: 'Author', email: null }, authoredAt: 1, message: 'Saved', source: 'external', snapshotKind: 'files_only', changedPaths: { added: ['a.html'], modified: [], deleted: [] } }], nextCursor: null });
  vi.mocked(client.file).mockResolvedValue({ encoding: 'base64', mediaType: 'text/html', content: btoa('<h1>Archive</h1><script>parent.location="https://bad.test"</script>') });
  const restore = vi.fn();
  render(<I18nProvider initial="en"><ProjectGitHistory projectId="p" client={client} onRestore={restore} /></I18nProvider>);
  expect(await screen.findByTestId('git-commit-old')).toHaveTextContent('parent-a');
  expect(screen.getByTestId('git-commit-old')).toHaveTextContent('parent-b');
  fireEvent.change(screen.getByLabelText('Git path history'), { target: { value: 'a.html' } });
  await waitFor(() => expect(client.history).toHaveBeenLastCalledWith('p', undefined, 'a.html', expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button', { name: 'a.html' }));
  const frame = await screen.findByTitle('Historical preview');
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame).not.toHaveAttribute('src');
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  expect(restore).toHaveBeenCalledWith('old');
});

it('renders historical forms, context feedback and resources without active run controls', async () => {
  const client = api(); const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const digest = 'a'.repeat(64);
  vi.mocked(client.history).mockResolvedValue({ commits: [{ oid: 'old', parents: [], author: { name: 'Author', email: null }, authoredAt: 1, message: 'Saved', source: 'open-design', snapshotKind: 'complete', changedPaths: { added: [], modified: [], deleted: [] } }], nextCursor: null });
  vi.mocked(client.conversations).mockResolvedValue({ manifest: { schemaVersion: 1, repositoryProjectId: 'p', resources: [{ digest, locations: [{ path: `.open-design/resources/${digest}/image.png`, purpose: 'attachment' }], references: ['m'] }] }, project: { schemaVersion: 1, name: 'Archive', createdAt: 1, kind: 'prototype', preferences: {}, contentRefs: [], linkedFolderRequirements: [] }, conversations: [{ schemaVersion: 1, id: 'c', title: 'Conversation', mode: 'chat', createdAt: 1 }], messages: [{ schemaVersion: 1, id: 'm', conversationId: 'c', role: 'assistant', content: '<question-form>Continue task</question-form>', createdAt: 1, predecessorId: null, turnId: 't', terminal: 'historical', resourceRefs: [digest], displayEvents: [], context: { feedback: { rating: 'negative', createdAt: 1, reasonCodes: ['other'], customReason: 'Historical reason' }, attachments: [{ resourceRef: digest, kind: 'image', name: 'image.png' }] } }] });
  vi.mocked(client.file).mockResolvedValue({ encoding: 'base64', mediaType: 'image/png', content: 'eA==' });
  render(<I18nProvider initial="en"><ProjectGitHistory projectId="p" client={client} onRestore={vi.fn()} /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Project records' }));
  expect(await screen.findByText('<question-form>Continue task</question-form>')).toBeVisible();
  expect(screen.getByText(/Historical reason/)).toBeVisible();
  expect(await screen.findByAltText('image.png')).toHaveAttribute('src', 'data:image/png;base64,eA==');
  expect(document.querySelector('question-form')).toBeNull();
  expect(screen.queryByRole('button', { name: /Continue task|Submit feedback/ })).not.toBeInTheDocument();
  expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/runs'))).toEqual([]);
  fetchSpy.mockRestore();
});

it('never completes a failed operation', async () => {
  const client = api(); const completed = vi.fn();
  vi.mocked(client.execute).mockResolvedValueOnce(operation({ preview: { ...preview, expiresAt: Date.now() + 30_000 } })).mockResolvedValueOnce({ ...operation(), status: 'failed' });
  render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={completed} onClose={vi.fn()} /></I18nProvider>);
  await screen.findByText('Restore files only; keep current settings and conversations.');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Version operation failed');
  expect(completed).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeDisabled();
});

it('expires confirmation without another click', async () => {
  vi.useFakeTimers();
  try {
    const client = api();
    vi.mocked(client.execute).mockResolvedValue(operation({ preview: { ...preview, expiresAt: Date.now() + 1000 } }));
    await act(async () => { render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={vi.fn()} onClose={vi.fn()} /></I18nProvider>); });
    expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeEnabled();
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('preview is stale');
  } finally { cleanup(); vi.useRealTimers(); }
});

it('rejects a late preview after a newer state event and never silently retries', async () => {
  const client = api(); let resolve!: (value: ProjectGitOperation) => void;
  vi.mocked(client.execute).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<I18nProvider initial="en"><ProjectGitRestoreDialog projectId="p" targetOid="old" client={client} onCompleted={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
  await waitFor(() => expect(client.execute).toHaveBeenCalled());
  act(() => events.listener({ type: 'project-git-state', projectId: 'p', state: { ...state, contentRevision: 9 } }));
  await act(async () => resolve(operation({ preview })));
  expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('preview is stale');
  expect(client.execute).toHaveBeenCalledTimes(1);
});

it('keeps FileViewer Git path entry separate from legacy versions and preserves existing mutation authority', async () => {
  const { FileViewer } = await import('../../src/components/FileViewer');
  const { createProjectGitStateStore, registerProjectMutationStore, unregisterProjectMutationStore, captureProjectMutation } = await import('../../src/state/project-git');
  const authority = createProjectGitStateStore(state);
  registerProjectMutationStore('p', authority);
  const before = captureProjectMutation('p');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    return new Response(JSON.stringify(url.endsWith('/git') ? state : url.includes('/versions') ? { versions: [] } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const historyEvent = vi.fn(); window.addEventListener('open-design:project-git-history', historyEvent);
  try {
    render(<I18nProvider initial="en"><FileViewer projectId="p" projectKind="prototype" file={{ name: 'index.html', path: 'nested/index.html', kind: 'html', size: 10, mtime: 1, mime: 'text/html' }} liveHtml="<h1>Preview</h1>" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Git path history' }));
    expect(historyEvent.mock.calls[0]?.[0].detail).toEqual({ projectId: 'p', path: 'nested/index.html' });
    expect(captureProjectMutation('p')).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Legacy HTML history' }));
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/versions'))).toBe(true));
    expect(historyEvent).toHaveBeenCalledTimes(1);
  } finally { cleanup(); window.removeEventListener('open-design:project-git-history', historyEvent); fetchSpy.mockRestore(); unregisterProjectMutationStore('p', authority); authority.dispose(); }
});
