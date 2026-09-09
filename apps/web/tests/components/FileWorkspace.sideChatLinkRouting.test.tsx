// @vitest-environment jsdom

// Host-level regression for chat file-link routing on the side-chat tab
// (0.14.1 acceptance bug, review round 4 on PR #5611): FileWorkspace must
// thread `resolvedDir` + the known-file set through SideChatTab into the
// REAL ChatPane → AssistantMessage chain, otherwise absolute managed disk
// links can't be classified on this production surface even though the
// AssistantMessage unit specs pass.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileWorkspace } from '../../src/components/FileWorkspace';
import { I18nProvider } from '../../src/i18n';
import { deleteDesignSystemDraft, updateDesignSystemDraft } from '../../src/providers/registry';
import type { AppConfig, ChatMessage, Conversation, ProjectFile } from '../../src/types';

const launcherCapture = vi.hoisted(() => ({ context: null as null | {
  createTerminal?: () => Promise<string | null>;
} }));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectFileText: vi.fn(),
    uploadProjectFiles: vi.fn(),
    writeProjectBase64File: vi.fn(),
    writeProjectTextFile: vi.fn(),
    fetchProjectFolders: vi.fn().mockResolvedValue([]),
    deleteDesignSystemDraft: vi.fn(),
    updateDesignSystemDraft: vi.fn(),
  };
});

vi.mock('../../src/runtime/design-kit', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/design-kit')>(
    '../../src/runtime/design-kit',
  );
  return {
    ...actual,
    useDesignKit: vi.fn(() => ({ kit: { title: 'Design system' } })),
  };
});

vi.mock('../../src/runtime/kit-upload', () => ({
  useKitModuleUpload: vi.fn(() => ({ uploading: false, uploadModule: vi.fn() })),
}));

vi.mock('../../src/components/DesignKitView', () => ({
  DesignKitView: ({
    actionsSlot,
    headerMenuActions,
    topSlot,
  }: {
    actionsSlot?: ReactNode;
    headerMenuActions?: Array<{ id: string; disabled?: boolean; onClick: () => void }>;
    topSlot?: ReactNode;
  }) => (
    <div>
      {actionsSlot}
      {headerMenuActions?.map((action) => (
        <button key={action.id} type="button" disabled={action.disabled} onClick={action.onClick}>{action.id}</button>
      ))}
      {topSlot}
    </div>
  ),
}));

vi.mock('../../src/components/Toast', () => ({
  Toast: ({ message, tone }: { message: string; tone: string }) => (
    <div data-testid="kit-toast" data-tone={tone}>{message}</div>
  ),
}));

// The composer is not on the link-click path; mocking it keeps this test on
// the routing chain instead of composer internals.
vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((_props, _ref) => <div data-testid="composer" />),
}));

// The side chat's own fetch loop is bypassed: the test drives messages
// through the controlled `activeConversationChat` state instead.
vi.mock('../../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [],
    streaming: false,
    loading: false,
    error: null,
    onSend: vi.fn(),
    onStop: vi.fn(),
  }),
}));

vi.mock('../../src/components/workspace/tab-launcher', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/workspace/tab-launcher')>(
    '../../src/components/workspace/tab-launcher',
  );
  return {
    ...actual,
    buildLauncherActions: vi.fn((context) => {
      launcherCapture.context = context;
      return [];
    }),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, createTerminal: vi.fn(), killTerminal: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Cross-project link clicks navigate via history.pushState; reset the
  // jsdom URL so expectations don't leak between tests.
  window.history.replaceState(null, '', '/');
});

function assistantMessage(text: string): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: text,
    events: [{ kind: 'text', text }],
    startedAt: 1_000,
    endedAt: 3_000,
    runStatus: 'succeeded',
  };
}

function workspaceFile(name: string): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 100,
    mtime: 1_700_000_000,
    kind: name.endsWith('.html') ? 'html' : 'text',
    mime: name.endsWith('.html') ? 'text/html' : 'text/plain',
  };
}

function renderSideChatWorkspace(messageText: string) {
  const onTabsStateChange = vi.fn();
  const conversations = [
    {
      id: 'conv-1',
      projectId: 'project-1',
      title: 'Side chat',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 1,
      sessionMode: 'design',
    },
  ] as unknown as Conversation[];
  const utils = render(
    <I18nProvider>
      <FileWorkspace
        projectId="project-1"
        projectKind="prototype"
        files={[workspaceFile('other.html')]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        resolvedDir="/data/projects/project-1"
        tabsState={{ tabs: ['chat:conv-1'], active: 'chat:conv-1' }}
        conversations={conversations}
        onTabsStateChange={onTabsStateChange}
        chatConfig={{ mode: 'daemon' } as unknown as AppConfig}
        chatAgentsById={new Map()}
        chatLocale="en"
        activeConversationChat={{
          conversationId: 'conv-1',
          messages: [assistantMessage(messageText)],
          streaming: false,
          error: null,
          onSend: vi.fn(),
          onStop: vi.fn(),
        }}
      />
    </I18nProvider>,
  );
  return { ...utils, onTabsStateChange };
}

function renderDesignSystemWorkspace(
  onDeleteDesignSystemProject: () => Promise<true | false | 'stale'>,
) {
  return render(
    <I18nProvider>
      <FileWorkspace
        projectId="project-1"
        projectKind="brand"
        files={[]}
        liveArtifacts={[]}
        onRefreshFiles={vi.fn()}
        isDeck={false}
        tabsState={{ tabs: ['__design_system__'], active: '__design_system__' }}
        onTabsStateChange={vi.fn()}
        designSystemProject={{ id: 'system-1', title: 'Design system', status: 'draft' } as never}
        designSystemEditable
        onDeleteDesignSystemProject={onDeleteDesignSystemProject}
      />
    </I18nProvider>,
  );
}

describe('FileWorkspace side-chat file-link routing (host-level)', () => {
  it('navigates managed cross-project disk links from the side chat in the same window', () => {
    const { container } = renderSideChatWorkspace(
      '参考项目里只有一个文件：[deck-outline.md](/data/projects/other-project/deck-outline.md)。',
    );

    const anchor = container.querySelector('.msg.assistant a.md-link, a.md-link');
    expect(anchor).not.toBeNull();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe('/projects/other-project/files/deck-outline.md');
  });

  it('opens current-project disk links as workspace tabs even when the file list is stale', () => {
    const { container, onTabsStateChange } = renderSideChatWorkspace(
      '新文件在 [new-file.md](/data/projects/project-1/new-file.md)。',
    );

    const anchor = container.querySelector('a.md-link');
    expect(anchor).not.toBeNull();

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    // Stayed in the workspace (no cross-project navigation) and the click
    // reached FileWorkspace's tab opener with the resolved relative path.
    expect(window.location.pathname).toBe('/');
    expect(onTabsStateChange).toHaveBeenCalled();
    const lastState = onTabsStateChange.mock.calls.at(-1)?.[0] as { active?: string };
    expect(lastState?.active).toBe('new-file.md');
  });

  it('does not consume a stale backing-project delete as success', async () => {
    let resolveDelete!: (result: 'stale') => void;
    const onDeleteDesignSystemProject = vi.fn(() => new Promise<'stale'>((resolve) => {
      resolveDelete = resolve;
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderDesignSystemWorkspace(onDeleteDesignSystemProject);
      const deleteButton = await screen.findByRole('button', { name: 'delete' });
      fireEvent.click(deleteButton);

      await waitFor(() => expect(onDeleteDesignSystemProject).toHaveBeenCalledWith('project-1'));
      expect(deleteButton).toBeDisabled();
      resolveDelete('stale');
      await waitFor(() => expect(deleteButton).toBeEnabled());
      expect(deleteDesignSystemDraft).not.toHaveBeenCalled();
      expect(screen.getByTestId('kit-toast')).toHaveAttribute('data-tone', 'error');
      expect(screen.getByTestId('kit-toast')).toHaveTextContent(/history changed.*reload/i);
    } finally {
      confirm.mockRestore();
    }
  });

  it('keeps an ordinary backing-project delete failure actionable', async () => {
    const onDeleteDesignSystemProject = vi.fn(async () => false as const);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderDesignSystemWorkspace(onDeleteDesignSystemProject);
      const deleteButton = await screen.findByRole('button', { name: 'delete' });
      fireEvent.click(deleteButton);

      await waitFor(() => expect(deleteButton).toBeEnabled());
      expect(deleteDesignSystemDraft).not.toHaveBeenCalled();
      expect(screen.getByTestId('kit-toast')).toHaveAttribute('data-tone', 'error');
    } finally {
      confirm.mockRestore();
    }
  });

  it('publishes through the real design-kit child', async () => {
    vi.mocked(updateDesignSystemDraft).mockResolvedValue({
      id: 'system-1',
      title: 'Design system',
      status: 'published',
    } as never);
    renderDesignSystemWorkspace(vi.fn(async () => true as const));
    fireEvent.click(await screen.findByTestId('design-system-publish'));

    await waitFor(() => expect(updateDesignSystemDraft).toHaveBeenCalledWith(
      'system-1',
      { status: 'published' },
    ));
    await waitFor(() => expect(screen.getByTestId('kit-toast')).toHaveAttribute('data-tone', 'success'));
  });

});
