// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectGitConflict, ProjectGitOperation, ProjectGitState } from '@open-design/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import type { ProjectGitClient } from '../../src/providers/project-git';
import { ProjectGitConflicts } from '../../src/components/project-git/ProjectGitConflicts';
const basis = { projectRevision: 4, contentRevision: 8, localHead: 'local', remoteHead: 'remote', bindingGeneration: 2 };
const state: ProjectGitState = { enabled: true, phase: 'conflict', projectRevision: 4, contentRevision: 8, localHead: 'local', bindingGeneration: 2, observedRemoteHead: 'remote', confirmedRemoteHead: 'remote', dirty: false, pendingPush: false, autoSync: true, operationId: 'op', error: null, binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' }, dependencies: [] };
const operation: ProjectGitOperation = { id: 'op', kind: 'sync', projectId: 'p', basis, status: 'waiting', phase: 'conflict', result: null, error: null };
function api(conflicts: ProjectGitConflict[]): ProjectGitClient { return { state: vi.fn().mockResolvedValue(state), execute: vi.fn().mockResolvedValue({ ...operation, kind: 'resolve', status: 'succeeded' }), operation: vi.fn().mockResolvedValue(operation), history: vi.fn(), commit: vi.fn(), file: vi.fn(), conversations: vi.fn(), conflicts: vi.fn().mockResolvedValue({ conflicts }) }; }
afterEach(cleanup);
it('rejects omitted and repeated turn ids and sends the complete order with original basis', async () => {
  const member = (id: string) => ({ schemaVersion: 1, id, conversationId: 'chat', role: 'user', content: id, createdAt: 1, predecessorId: null, turnId: id, terminal: 'historical', resourceRefs: [], displayEvents: [], context: {} });
  const client = api([{ id: 'order', kind: 'conversation_order', recordId: 'chat', base: { kind: 'json', value: [member('a'), member('deleted')] }, local: { kind: 'json', value: [member('a'), member('b')] }, remote: { kind: 'json', value: [member('a'), member('c'), member('deleted')] } }]);
  const completed = vi.fn();
  render(<I18nProvider initial="en"><ProjectGitConflicts projectId="p" operationId="op" client={client} onCompleted={completed} /></I18nProvider>);
  const input = await screen.findByLabelText('Complete turn order');
  const submit = screen.getByRole('button', { name: 'Submit resolution' });
  fireEvent.change(input, { target: { value: '["a","b"]' } }); expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: '["a","b","b","c"]' } }); expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: '["c","a","b"]' } }); expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(completed).toHaveBeenCalled());
  expect(client.execute).toHaveBeenCalledWith('p', { kind: 'resolve', operationId: 'op', basis, resolutions: [{ conflictId: 'order', kind: 'order', orderedTurnIds: ['c', 'a', 'b'] }] }, 4, expect.any(Object));
});
it('shows three sides, permits field edits and requires binary side selection', async () => {
  const client = api([
    { id: 'field', kind: 'field', recordId: 'name', base: { kind: 'json', value: 'ancestor' }, local: { kind: 'json', value: 'mine' }, remote: { kind: 'json', value: 'theirs' } },
    { id: 'image', kind: 'file', path: 'image.png', base: { kind: 'missing' }, local: { kind: 'file', file: { encoding: 'base64', mediaType: 'image/png', content: 'eA==' } }, remote: { kind: 'missing' } },
  ]);
  render(<I18nProvider initial="en"><ProjectGitConflicts projectId="p" operationId="op" client={client} onCompleted={vi.fn()} /></I18nProvider>);
  expect(await screen.findByText('"ancestor"')).toBeVisible(); expect(screen.getByText('"mine"')).toBeVisible(); expect(screen.getByText('"theirs"')).toBeVisible();
  fireEvent.change(screen.getByLabelText('name'), { target: { value: 'edit' } });
  fireEvent.change(screen.getByLabelText('Edit name'), { target: { value: '"merged"' } });
  expect(screen.getByRole('button', { name: 'Submit resolution' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('image.png'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit resolution' }));
  await waitFor(() => expect(client.execute).toHaveBeenCalled());
  expect(vi.mocked(client.execute).mock.calls[0]?.[1]).toEqual({ kind: 'resolve', operationId: 'op', basis, resolutions: [{ conflictId: 'field', kind: 'edit', value: 'merged' }, { conflictId: 'image', kind: 'select', selectedSide: 'local' }] });
});
