// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectGitOperation, ProjectGitState } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenGitProjectDialog } from '../../src/components/project-git/OpenGitProjectDialog';
import { ProjectGitSettings } from '../../src/components/project-git/ProjectGitSettings';
import { ProjectGitMenu, ProjectGitStatus, useProjectGitStatusActions } from '../../src/components/project-git/ProjectGitStatus';
import { I18nProvider } from '../../src/i18n';
import { ProjectGitHttpError, type ProjectGitClient } from '../../src/providers/project-git';

const baseState = {
  enabled: true,
  phase: 'synced',
  localHead: null,
  observedRemoteHead: null,
  confirmedRemoteHead: null,
  projectRevision: 0,
  contentRevision: 0,
  bindingGeneration: 0,
  dirty: false,
  pendingPush: false,
  autoSync: true,
  operationId: null,
  error: null,
  binding: { remoteConfigured: false, remoteLabel: null, branch: null },
  dependencies: [],
} satisfies ProjectGitState;

const basis = { projectRevision: 0, contentRevision: 0, localHead: null, remoteHead: null, bindingGeneration: 0 };
const preview = {
  id: 'preview-1', kind: 'enable', basis, targetOid: null, expiresAt: Date.now() + 60_000,
  changes: { addedPaths: ['index.html'], modifiedPaths: [], deletedPaths: [], settingsChanged: 1, conversationsChanged: 0, ignoredPaths: ['node_modules'], privatePaths: ['.env'], missingPaths: [], historyMode: 'complete', collisions: [] },
  dependencies: [],
} satisfies import('@open-design/contracts').ProjectGitPreview;

function operation(overrides: Partial<ProjectGitOperation>): ProjectGitOperation {
  return { id: 'op-1', kind: 'enable_preview', status: 'succeeded', phase: 'enable_pending', projectId: 'project-1', basis, result: null, error: null, ...overrides };
}

function client(execute: ProjectGitClient['execute']): ProjectGitClient {
  return { execute, check: vi.fn().mockResolvedValue(baseState), state: vi.fn().mockResolvedValue(baseState), operation: vi.fn(), history: vi.fn(), commit: vi.fn(), file: vi.fn(), conversations: vi.fn(), conflicts: vi.fn() };
}

afterEach(cleanup);

describe('ProjectGitStatus', () => {
  function Controls({ execute }: { execute: (action: { kind: 'sync' | 'pause' | 'resume' }) => Promise<ProjectGitOperation> }) {
    const actions = useProjectGitStatusActions(execute, true);
    return <ProjectGitStatus state={baseState} onHistory={vi.fn()} {...actions} />;
  }

  it.each(['network', 'stale', 'failed'] as const)('handles %s toolbar failures and blocks repeated actions before daemon updates', async kind => {
    let finish!: () => void;
    const execute = vi.fn().mockImplementation(() => new Promise<ProjectGitOperation>((resolve, reject) => {
      finish = () => kind === 'failed' ? resolve(operation({ kind: 'sync', status: 'failed' })) : reject(kind === 'stale'
        ? new ProjectGitHttpError(409, { code: 'PROJECT_STATE_CHANGED', message: 'internal revision error' }) : new Error('internal network error'));
    }));
    render(<I18nProvider initial="en"><Controls execute={execute} /></I18nProvider>);
    const sync = screen.getByRole('button', { name: 'Sync now' });
    const pause = screen.getByRole('button', { name: 'Pause automatic sync' });
    act(() => { fireEvent.click(sync); fireEvent.click(sync); fireEvent.click(pause); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sync).toBeDisabled(); expect(pause).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole('alert')).toHaveTextContent(kind === 'stale' ? 'preview is stale' : 'Version operation failed');
    expect(screen.queryByText(/internal .* error/)).not.toBeInTheDocument();
    expect(sync).not.toBeDisabled();
    fireEvent.click(pause);
    expect(execute.mock.calls[1]?.[0]).toEqual({ kind: 'pause' });
    await act(async () => finish());
  });
  it('does not infer synced when a local save is waiting to push', () => {
    render(<I18nProvider initial="zh-CN"><ProjectGitStatus state={{ ...baseState, phase: 'pending_push', localHead: 'a'.repeat(40), pendingPush: true }} onHistory={vi.fn()} onSync={vi.fn()} onToggleAutoSync={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('待推送');
    expect(screen.queryByText('已同步')).not.toBeInTheDocument();
  });

  it.each([
    ['enable_pending', 'Versioning needs setup'], ['waiting_idle', 'Waiting for project to be idle'], ['dirty', 'Changes not versioned'],
    ['checkpointing', 'Saving version'], ['local_saved', 'Saved locally'], ['pending_push', 'Waiting to push'], ['syncing', 'Syncing'],
    ['synced', 'Synced'], ['paused', 'Automatic sync paused'], ['conflict', 'Conflicts need resolution'],
    ['auth_required', 'Authentication required'], ['external_git_busy', 'External Git operation in progress'], ['recovering', 'Recovering'], ['failed', 'Version operation failed'],
  ] as const)('renders phase %s from the contract', (phase, label) => {
    render(<I18nProvider initial="en"><ProjectGitStatus state={{ ...baseState, phase }} onHistory={vi.fn()} onSync={vi.fn()} onToggleAutoSync={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('status')).toHaveTextContent(label);
    cleanup();
  });
});

describe('ProjectGitMenu', () => {
  it('keeps version actions behind the current status submenu', () => {
    const onHistory = vi.fn(); const onSync = vi.fn(); const onToggleAutoSync = vi.fn(); const onSettings = vi.fn();
    render(<I18nProvider initial="en"><ProjectGitMenu state={baseState} onHistory={onHistory} onSync={onSync} onToggleAutoSync={onToggleAutoSync} onSettings={onSettings} /></I18nProvider>);

    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Version settings' }));
    expect(screen.getByRole('menuitem', { name: 'Synced' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Synced' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync now' }));
    expect(onSync).toHaveBeenCalledOnce();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause automatic sync' }));
    expect(onToggleAutoSync).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Version settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Synced' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version settings' }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});

describe('ProjectGitSettings', () => {
  it('previews and confirms local setup before testing a remote for a legacy project', async () => {
    const execute = vi.fn().mockResolvedValueOnce(operation({ result: { preview } }))
      .mockResolvedValueOnce(operation({ kind: 'enable', phase: 'local_saved' }))
      .mockResolvedValueOnce(operation({ kind: 'binding_preview', result: { preview: { ...preview, kind: 'bind' } } }));
    const api = client(execute);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, enabled: false, autoSync: false, phase: 'enable_pending' });
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={api} onClose={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'git@git.kuaikan.art:one2one/admin-web-design.git' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'master' } });
    expect(screen.getByText('Versioning needs setup')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test connection' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(execute.mock.calls[0]?.[1]).toEqual({ kind: 'enable_preview' });
    expect(execute).toHaveBeenCalledTimes(1);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, projectRevision: 1 });
    fireEvent.click(confirm);
    const connect = await screen.findByRole('button', { name: 'Test connection' });
    expect(execute.mock.calls[1]?.[1]).toEqual({ kind: 'enable', previewId: 'preview-1' });
    expect(screen.getByLabelText('Repository URL')).toHaveValue('git@git.kuaikan.art:one2one/admin-web-design.git');
    expect(screen.getByLabelText('Branch')).toHaveValue('master');
    fireEvent.click(connect);
    await screen.findByRole('button', { name: 'Confirm' });
    expect(execute.mock.calls[2]?.slice(1, 3)).toEqual([{ kind: 'binding_preview', url: 'git@git.kuaikan.art:one2one/admin-web-design.git', branch: 'master' }, 1]);
  });

  it('can request a preview when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    try {
      const execute = vi.fn().mockResolvedValue(operation({ result: { preview } }));
      render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={client(execute)} onClose={vi.fn()} /></I18nProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      expect(await screen.findByRole('button', { name: 'Confirm' })).toBeInTheDocument();
      expect(execute.mock.calls[0]?.[3].idempotencyKey).toEqual(expect.any(String));
    } finally { vi.unstubAllGlobals(); }
  });
  it('gets a fresh revision for a new preview after stale confirmation while preserving each confirmation basis', async () => {
    const oldPreview = { ...preview, basis: { ...basis, projectRevision: 7 } };
    const freshPreview = { ...preview, id: 'preview-2', basis: { ...basis, projectRevision: 12 } };
    const execute = vi.fn().mockResolvedValueOnce(operation({ result: { preview: oldPreview } }))
      .mockRejectedValueOnce(new ProjectGitHttpError(409, { code: 'PREVIEW_STALE', message: 'stale' }))
      .mockResolvedValueOnce(operation({ result: { preview: freshPreview } }));
    const api = client(execute);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, projectRevision: 4 });
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={api} onClose={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preview is stale');
    expect(execute.mock.calls[1]?.[2]).toBe(7);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, projectRevision: 11 });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('button', { name: 'Confirm' });
    expect(execute.mock.calls[2]?.[2]).toBe(11);
  });
  it('invalidates rejected confirmation without exposing internal error details', async () => {
    const execute = vi.fn().mockResolvedValueOnce(operation({ result: { preview } })).mockRejectedValueOnce(new ProjectGitHttpError(409, { code: 'PREVIEW_STALE', message: 'internal detail' }));
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={client(execute)} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preview is stale');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
  });
  it('pauses a configured binding before preview and requires every binding choice', async () => {
    const bindPreview = { ...preview, kind: 'bind', binding: { classification: 'independent_history', metadataSources: ['local', 'remote'], requiredPaths: ['index.html'] } } satisfies import('@open-design/contracts').ProjectGitPreview;
    const execute = vi.fn().mockResolvedValueOnce(operation({ kind: 'pause' })).mockResolvedValueOnce(operation({ kind: 'binding_preview', result: { preview: bindPreview } })).mockResolvedValueOnce(operation({ kind: 'bind' }));
    const api = client(execute);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, projectRevision: 3, binding: { remoteConfigured: true, remoteLabel: 'old', branch: 'main' } });
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={api} onClose={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(/Changing the binding pauses/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.com/new.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByLabelText('Project records')).toBeInTheDocument();
    expect(execute.mock.calls[0]?.slice(1, 3)).toEqual([{ kind: 'pause' }, 3]);
    expect(execute.mock.calls[1]?.[1]).toEqual({ kind: 'binding_preview', url: 'https://example.com/new.git', branch: 'main' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Project records'), { target: { value: 'remote' } });
    fireEvent.change(screen.getByLabelText('index.html'), { target: { value: 'local' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute.mock.calls[2]?.[1]).toEqual({ kind: 'bind', previewId: 'preview-1', confirmation: { metadataSource: 'remote', paths: [{ path: 'index.html', selectedSide: 'local' }] } });
    expect(execute.mock.calls[2]?.[2]).toBe(0);
  });

  it('shows the in-flight operation and waits for unbind completion', async () => {
    let resolve!: (value: ProjectGitOperation) => void;
    const execute = vi.fn().mockImplementation(() => new Promise<ProjectGitOperation>(done => { resolve = done; }));
    const api = client(execute);
    vi.mocked(api.state).mockResolvedValue({ ...baseState, phase: 'syncing', operationId: 'push-1', binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' } });
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={api} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect repository' }));
    expect(screen.getByText(/push-1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Waiting for active/);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    resolve(operation({ kind: 'unbind' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument());
  });

  it('lists included, ignored and private paths and rejects expiry at confirmation', async () => {
    const execute = vi.fn().mockResolvedValue(operation({ result: { preview } }));
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={client(execute)} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('node_modules')).toBeInTheDocument();
    expect(screen.getByText('.env')).toBeInTheDocument();
    const now = vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preview is stale');
    expect(execute).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('keeps project editing available when Git identity is missing and returns keyboard focus', async () => {
    const api = client(vi.fn());
    vi.mocked(api.state).mockResolvedValue({ ...baseState, phase: 'enable_pending', dependencies: [{ kind: 'identity', label: 'Git identity', requiredForContent: false, nextStep: { action: 'configure_identity', label: 'Configure identity' } }] });
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const onClose = vi.fn();
    const view = render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={api} onClose={onClose} /></I18nProvider>);
    expect(await screen.findByText(/You can continue editing/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });
  it('uses one preview basis and prevents duplicate confirmation while pending', async () => {
    let resolve!: (value: ProjectGitOperation) => void;
    const execute = vi.fn()
      .mockResolvedValueOnce(operation({ result: { preview } }))
      .mockImplementationOnce(() => new Promise<ProjectGitOperation>(done => { resolve = done; }));
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={client(execute)} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('index.html')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toEqual({ kind: 'enable', previewId: 'preview-1' });
    resolve(operation({ kind: 'enable', phase: 'local_saved' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument());
  });

  it('rejects a stale preview before confirmation', async () => {
    const execute = vi.fn().mockResolvedValue(operation({ result: { preview: { ...preview, expiresAt: 0 } } }));
    render(<I18nProvider initial="en"><ProjectGitSettings projectId="project-1" client={client(execute)} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('preview is stale');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });
});

describe('OpenGitProjectDialog', () => {
  it.each(['close', 'escape', 'unmount'] as const)('ignores late import success after %s and stops browser polling', async closeMethod => {
    let resolve!: (value: ProjectGitOperation) => void;
    const execute = vi.fn().mockImplementation(() => new Promise<ProjectGitOperation>(done => { resolve = done; }));
    const onOpened = vi.fn();
    const view = render(<I18nProvider initial="en"><OpenGitProjectDialog client={client(execute)} onOpened={onOpened} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.com/design.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
    if (closeMethod === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    else if (closeMethod === 'escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    else view.unmount();
    await act(async () => resolve(operation({ kind: 'open', result: { projectId: 'late-project' } })));
    expect(onOpened).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[3].signal?.aborted).toBe(true);
  });
  it('keeps failed imports out of navigation and separates missing bytes from runtime dependencies', async () => {
    const execute = vi.fn().mockResolvedValue(operation({ kind: 'open', status: 'failed', error: { code: 'INTERNAL_ERROR', message: 'internal detail' }, result: { projectId: 'must-not-open', dependencies: [
      { kind: 'resource', label: 'image.png', requiredForContent: true, nextStep: null },
      { kind: 'agent', label: 'Agent CLI', requiredForContent: false, nextStep: null },
    ] } }));
    const onOpened = vi.fn();
    render(<I18nProvider initial="en"><OpenGitProjectDialog client={client(execute)} onOpened={onOpened} onClose={vi.fn()} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.com/design.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not added to recent projects');
    expect(screen.getByRole('heading', { name: 'Missing content resources' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Missing runtime dependencies' })).toBeInTheDocument();
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus inside the dialog and blocks repeated pending requests', async () => {
    let resolve!: (value: ProjectGitOperation) => void;
    const execute = vi.fn().mockImplementation(() => new Promise<ProjectGitOperation>(done => { resolve = done; }));
    render(<I18nProvider initial="en"><OpenGitProjectDialog client={client(execute)} onOpened={vi.fn()} onClose={vi.fn()} /></I18nProvider>);
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.com/design.git' } });
    const open = screen.getByRole('button', { name: 'Open repository' });
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(open).toHaveFocus();
    fireEvent.keyDown(open, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.click(open); fireEvent.click(open);
    expect(screen.getByRole('status')).toHaveTextContent('Syncing');
    expect(execute).toHaveBeenCalledTimes(1);
    resolve(operation({ kind: 'open', status: 'succeeded', result: null }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
  it('opens only after a successful operation with a project id and restores focus', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const onOpened = vi.fn(); const onClose = vi.fn();
    const execute = vi.fn().mockResolvedValue(operation({ kind: 'open', projectId: null, result: { projectId: 'opened-project' } }));
    const view = render(<I18nProvider initial="en"><OpenGitProjectDialog client={client(execute)} onOpened={onOpened} onClose={onClose} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://example.com/design.git' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith('opened-project'));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
