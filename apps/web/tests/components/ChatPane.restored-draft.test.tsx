// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

afterEach(() => cleanup());

describe('ChatPane restored manual draft', () => {
  it('acknowledges one scoped payload only after an async arrival is applied', async () => {
    const acknowledged = vi.fn();
    const pane = (draft?: {
      id: string;
      projectId: string;
      generation: number;
      conversationId: string;
      text: string;
    }) => (
      <ChatPane
        projectKindForTracking="prototype"
        messages={[]}
        streaming={false}
        error={null}
        projectId="project-restored-draft"
        projectFiles={[]}
        onEnsureProject={async () => 'project-restored-draft'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[{ id: 'conv-restored', projectId: 'project-restored-draft', title: 'Restored', createdAt: 1, updatedAt: 1 }]}
        activeConversationId="conv-restored"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={{ kind: 'prototype' }}
        composerDraftSignal={draft}
        onComposerDraftRestored={acknowledged}
      />
    );
    const view = render(pane());

    expect(screen.getByRole('combobox')).not.toHaveTextContent('Async scoped draft');
    expect(acknowledged).not.toHaveBeenCalled();

    view.rerender(pane({
      id: 'draft-1',
      projectId: 'project-restored-draft',
      generation: 7,
      conversationId: 'conv-restored',
      text: 'Async scoped draft',
    }));

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Async scoped draft'));
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledWith('draft-1');
  });

  it('keeps text, attachments, and workspace context editable over a hydrated transcript without sending', async () => {
    const onSend = vi.fn();
    render(
      <ChatPane
        projectKindForTracking="prototype"
        messages={[{ id: 'old-user', role: 'user', content: 'Restored history', createdAt: 1 }]}
        streaming={false}
        error={null}
        projectId="project-restored-draft"
        projectFiles={[]}
        onEnsureProject={async () => 'project-restored-draft'}
        onSend={onSend}
        onStop={vi.fn()}
        conversations={[{
          id: 'conv-restored',
          projectId: 'project-restored-draft',
          title: 'Restored',
          createdAt: 1,
          updatedAt: 1,
        }]}
        activeConversationId="conv-restored"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={{ kind: 'prototype' }}
        workspaceContexts={[{
          id: 'browser:reference-a',
          kind: 'browser',
          label: 'Reference A',
          tabId: 'reference-a',
          url: 'https://example.com/reference-a',
        }]}
        initialWorkspaceContexts={[{
          id: 'browser:reference-a',
          kind: 'browser',
          label: 'Reference A',
          tabId: 'reference-a',
          url: 'https://example.com/reference-a',
        }]}
        composerDraftSignal={{
          id: 'draft-complete',
          projectId: 'project-restored-draft',
          generation: 1,
          conversationId: 'conv-restored',
          text: 'Keep this restored draft',
          attachments: [{ path: 'brief.pdf', name: 'brief.pdf', kind: 'file', size: 5 }],
          meta: {
            context: {
              workspaceItems: [{
                id: 'browser:reference-a',
                kind: 'browser',
                label: 'Reference A',
                tabId: 'reference-a',
                url: 'https://example.com/reference-a',
              }],
            },
          },
        }}
        />
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Keep this restored draft'));
    expect(screen.getByText('brief.pdf')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not retain restored workspace context after removal, a successful send, or a conversation change', async () => {
    const onSend = vi.fn();
    const workspaceItem = {
      id: 'browser:reference-a',
      kind: 'browser' as const,
      label: 'Reference A',
      tabId: 'reference-a',
      url: 'https://example.com/reference-a',
    };
    const renderPane = (conversationId: string, nonce: number | null) => (
      <ChatPane
        projectKindForTracking="prototype"
        messages={[]}
        streaming={false}
        error={null}
        projectId="project-restored-draft"
        projectFiles={[]}
        onEnsureProject={async () => 'project-restored-draft'}
        onSend={onSend}
        onStop={vi.fn()}
        conversations={[{
          id: conversationId,
          projectId: 'project-restored-draft',
          title: 'Restored',
          createdAt: 1,
          updatedAt: 1,
        }]}
        activeConversationId={conversationId}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={{ kind: 'prototype' }}
        workspaceContexts={[workspaceItem]}
        initialWorkspaceContexts={[]}
        composerDraftSignal={nonce === null ? undefined : {
          id: `draft-${nonce}`,
          projectId: 'project-restored-draft',
          generation: 1,
          conversationId,
          text: `Draft ${nonce}`,
          attachments: [],
          meta: { context: { workspaceItems: [workspaceItem] } },
        }}
      />
    );
    const view = render(renderPane('conv-a', 1));

    await waitFor(() => expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A'));
    fireEvent.click(screen.getByRole('button', { name: 'chat.removeAria' }));
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')).toBeNull());

    view.rerender(renderPane('conv-a', 2));
    await waitFor(() => expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A'));
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')).toBeNull());
    expect(onSend).toHaveBeenCalledTimes(1);

    view.rerender(renderPane('conv-a', 3));
    await waitFor(() => expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A'));
    view.rerender(renderPane('conv-b', null));
    await waitFor(() => expect(screen.queryByTestId('staged-contexts')).toBeNull());
  });

  it('acknowledges an owner draft once and does not inject it into another conversation', async () => {
    const acknowledged = vi.fn();
    const pane = (conversationId: string, initialDraft?: string, signalId?: string) => (
      <ChatPane
        projectKindForTracking="prototype"
        messages={[]}
        streaming={false}
        error={null}
        projectId="project-restored-draft"
        projectFiles={[]}
        onEnsureProject={async () => 'project-restored-draft'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        conversations={[{ id: conversationId, projectId: 'project-restored-draft', title: conversationId, createdAt: 1, updatedAt: 1 }]}
        activeConversationId={conversationId}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={{ kind: 'prototype' }}
        initialDraft={initialDraft}
        initialDraftSignalId={signalId}
        onInitialDraftRestored={acknowledged}
      />
    );
    const view = render(pane('conv-a', 'Owned draft', 'signal-a'));

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Owned draft'));
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledWith('signal-a');

    // The owner clearing an acknowledged signal must not erase the editor,
    // but a conversation-scope change must not carry that draft forward.
    view.rerender(pane('conv-a'));
    expect(screen.getByRole('combobox')).toHaveTextContent('Owned draft');
    view.rerender(pane('conv-b'));
    await waitFor(() => expect(screen.getByRole('combobox')).not.toHaveTextContent('Owned draft'));
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });

  it('retains the complete production draft when the send boundary rejects before acceptance', async () => {
    const workspaceItem = {
      id: 'browser:reference-a', kind: 'browser' as const, label: 'Reference A',
      tabId: 'reference-a', url: 'https://example.com/reference-a',
    };
    const onSend = vi.fn(async () => 'restore-draft' as const);
    render(
      <ChatPane
        projectKindForTracking="prototype"
        messages={[]}
        streaming={false}
        error={null}
        projectId="project-restored-draft"
        projectFiles={[]}
        onEnsureProject={async () => 'project-restored-draft'}
        onSend={onSend}
        onStop={vi.fn()}
        conversations={[{ id: 'conv-rejected', projectId: 'project-restored-draft', title: 'Rejected', createdAt: 1, updatedAt: 1 }]}
        activeConversationId="conv-rejected"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        projectMetadata={{ kind: 'prototype' }}
        workspaceContexts={[workspaceItem]}
        composerDraftSignal={{
          id: 'draft-rejected',
          projectId: 'project-restored-draft',
          generation: 1,
          conversationId: 'conv-rejected',
          text: 'Keep rejected draft',
          attachments: [{ path: 'brief.pdf', name: 'brief.pdf', kind: 'file', size: 5 }],
          meta: { context: { workspaceItems: [workspaceItem] } },
        }}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Keep rejected draft'));
    expect(screen.getByText('brief.pdf')).toBeTruthy();
    expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A');
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    expect(screen.getByRole('combobox')).toHaveTextContent('Keep rejected draft');
    expect(screen.getByText('brief.pdf')).toBeTruthy();
    expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A');
  });
});
