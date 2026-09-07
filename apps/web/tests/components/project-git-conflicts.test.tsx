// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectGitConflict, ProjectGitOperation, ProjectGitState } from '@open-design/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import type { ProjectGitClient } from '../../src/providers/project-git';
import { ProjectGitConflicts } from '../../src/components/project-git/ProjectGitConflicts';
const basis = { projectRevision: 4, contentRevision: 8, localHead: 'local', remoteHead: 'remote', bindingGeneration: 2 };
const state: ProjectGitState = { enabled: true, phase: 'conflict', projectRevision: 4, contentRevision: 8, localHead: 'local', bindingGeneration: 2, observedRemoteHead: 'remote', confirmedRemoteHead: 'remote', dirty: false, pendingPush: false, autoSync: true, operationId: 'op', error: null, binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' }, dependencies: [] };
const operation: ProjectGitOperation = { id: 'op', kind: 'sync', projectId: 'p', basis, status: 'waiting', phase: 'conflict', result: null, error: null };
function api(conflicts: ProjectGitConflict[]): ProjectGitClient { return { check: vi.fn().mockResolvedValue(state), state: vi.fn().mockResolvedValue(state), execute: vi.fn().mockResolvedValue({ ...operation, kind: 'resolve', status: 'succeeded' }), operation: vi.fn().mockResolvedValue(operation), history: vi.fn(), commit: vi.fn(), file: vi.fn(), conversations: vi.fn(), conflicts: vi.fn().mockResolvedValue({ conflicts }) }; }
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

it('decodes actual octet-stream text sides and permits editing while retaining binary side selection', async () => {
  const file = (bytes: string) => ({ kind: 'file' as const, file: { encoding: 'base64' as const, mediaType: 'application/octet-stream', content: btoa(bytes) } });
  const client = api([
    { id: 'html', kind: 'file', path: 'index.html', base: file('<h1>Ancestor</h1>'), local: file('<h1>Local</h1>'), remote: file('<h1>Remote</h1>') },
    { id: 'image', kind: 'file', path: 'image.png', base: { kind: 'missing' }, local: file('\x89PNG\r\n\x1a\n\0'), remote: file('\xff\xfe') },
  ]);
  render(<I18nProvider initial="en"><ProjectGitConflicts projectId="p" operationId="op" client={client} onCompleted={vi.fn()} /></I18nProvider>);
  expect(await screen.findByText('<h1>Ancestor</h1>')).toBeVisible();
  expect(screen.getByText('<h1>Local</h1>')).toBeVisible(); expect(screen.getByText('<h1>Remote</h1>')).toBeVisible();
  expect(within(screen.getByLabelText('image.png')).queryByRole('option', { name: 'Edit' })).toBeNull();
  fireEvent.change(screen.getByLabelText('index.html'), { target: { value: 'edit' } });
  fireEvent.change(screen.getByLabelText('Edit index.html'), { target: { value: '<h1>合并</h1>' } });
  fireEvent.change(screen.getByLabelText('image.png'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit resolution' }));
  await waitFor(() => expect(client.execute).toHaveBeenCalled());
  const action = vi.mocked(client.execute).mock.calls[0]![1];
  expect(action).toMatchObject({ kind: 'resolve', resolutions: [{ conflictId: 'html', kind: 'edit', file: { encoding: 'base64', content: 'PGgxPuWQiOW5tjwvaDE+' } }, { conflictId: 'image', kind: 'select', selectedSide: 'local' }] });
});

it.each(['delete', 'base', 'local', 'remote', 'edit'] as const)('derives complete turn order from effective %s message proposal', async choice => {
  const member = (id: string, turnId: string, content = id) => ({ schemaVersion: 1, id, conversationId: 'chat', role: 'user', content, createdAt: 1, predecessorId: null, turnId, terminal: 'historical', resourceRefs: [], displayEvents: [], context: {} });
  const stable = member('stable', 'stable-turn');
  const original = member('message', 'old-turn');
  const localVersion = member('message', 'local-turn', 'edited locally');
  const changed = member('message', 'remote-turn', 'edited remotely');
  const client = api([
    { id: 'message-choice', kind: 'message', recordId: 'message', base: { kind: 'json', value: original }, local: choice === 'delete' ? { kind: 'json', value: localVersion } : { kind: 'missing' }, remote: { kind: 'json', value: changed } },
    { id: 'order', kind: 'conversation_order', recordId: 'chat', base: { kind: 'json', value: [stable, original] }, local: { kind: 'json', value: choice === 'delete' ? [stable, localVersion] : [stable] }, remote: { kind: 'json', value: [stable, changed] } },
  ]);
  render(<I18nProvider initial="en"><ProjectGitConflicts projectId="p" operationId="op" client={client} onCompleted={vi.fn()} /></I18nProvider>);
  fireEvent.change(await screen.findByLabelText('message'), { target: { value: choice } });
  if (choice === 'edit') fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: JSON.stringify(member('message', 'custom-turn', 'custom')) } });
  const ids = choice === 'remote' ? ['remote-turn', 'stable-turn'] : choice === 'edit' ? ['custom-turn', 'stable-turn'] : choice === 'base' ? ['old-turn', 'stable-turn'] : ['stable-turn'];
  const input = screen.getByLabelText('Complete turn order');
  fireEvent.change(input, { target: { value: JSON.stringify([...ids, 'old-turn']) } });
  expect(screen.getByRole('button', { name: 'Submit resolution' })).toBeDisabled();
  fireEvent.change(input, { target: { value: JSON.stringify(ids) } });
  expect(screen.getByRole('button', { name: 'Submit resolution' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Submit resolution' }));
  await waitFor(() => expect(client.execute).toHaveBeenCalled());
  expect(vi.mocked(client.execute).mock.calls[0]![1]).toMatchObject({ kind: 'resolve', resolutions: [expect.objectContaining({ conflictId: 'message-choice', kind: choice === 'edit' ? 'edit' : choice === 'delete' ? 'delete' : 'select' }), { conflictId: 'order', kind: 'order', orderedTurnIds: ids }] });
});

it('retains a shared turn after deleting only one of its messages', async () => {
  const member = (id: string) => ({ schemaVersion: 1, id, conversationId: 'chat', role: 'user', content: id, createdAt: 1, predecessorId: null, turnId: 'shared-turn', terminal: 'historical', resourceRefs: [], displayEvents: [], context: {} });
  const deleted = member('deleted'); const kept = member('kept');
  const side = { kind: 'json' as const, value: [deleted, kept] };
  const client = api([
    { id: 'message-choice', kind: 'message', recordId: 'deleted', base: { kind: 'json', value: deleted }, local: { kind: 'missing' }, remote: { kind: 'json', value: { ...deleted, content: 'changed' } } },
    { id: 'order', kind: 'conversation_order', recordId: 'chat', base: side, local: { kind: 'json', value: [kept] }, remote: { kind: 'json', value: [{ ...deleted, content: 'changed' }, kept] } },
  ]);
  render(<I18nProvider initial="en"><ProjectGitConflicts projectId="p" operationId="op" client={client} onCompleted={vi.fn()} /></I18nProvider>);
  fireEvent.change(await screen.findByLabelText('deleted'), { target: { value: 'delete' } });
  const input = screen.getByLabelText('Complete turn order');
  fireEvent.change(input, { target: { value: '[]' } }); expect(screen.getByRole('button', { name: 'Submit resolution' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '["shared-turn"]' } }); expect(screen.getByRole('button', { name: 'Submit resolution' })).toBeEnabled();
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
