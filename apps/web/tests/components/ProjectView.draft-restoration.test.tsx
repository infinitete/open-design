// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectView } from '../../src/components/ProjectView';

const chatPaneSpy = vi.hoisted(() => vi.fn());
const listConversations = vi.hoisted(() => vi.fn());
const listMessages = vi.hoisted(() => vi.fn());
const loadTabs = vi.hoisted(() => vi.fn());
const fetchPreviewComments = vi.hoisted(() => vi.fn());
const fetchProjectFiles = vi.hoisted(() => vi.fn());
const fetchProjectDesignSystemPackageAudit = vi.hoisted(() => vi.fn());
const fetchLiveArtifacts = vi.hoisted(() => vi.fn());
const fetchConnectorStatuses = vi.hoisted(() => vi.fn());
const fetchSkill = vi.hoisted(() => vi.fn());
const fetchDesignSystem = vi.hoisted(() => vi.fn());
const getTemplate = vi.hoisted(() => vi.fn());
const listActiveChatRuns = vi.hoisted(() => vi.fn());
const streamViaDaemon = vi.hoisted(() => vi.fn());
const originalFetch = globalThis.fetch;

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (value: string) => value }),
  useT: () => ((value: string) => value),
}));

vi.mock('../../src/providers/anthropic', () => ({ streamMessage: vi.fn() }));

vi.mock('../../src/providers/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/daemon')>();
  return {
    ...actual,
    fetchChatRunStatus: vi.fn(async () => null),
    listActiveChatRuns: (...args: unknown[]) => listActiveChatRuns(...args),
    listProjectRuns: vi.fn(async () => []),
    reattachDaemonRun: vi.fn(),
    streamViaDaemon: (...args: unknown[]) => streamViaDaemon(...args),
  };
});

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    invalidateProjectFilesCache: vi.fn(),
    fetchPreviewComments: (...args: unknown[]) => fetchPreviewComments(...args),
    fetchDesignSystem: (...args: unknown[]) => fetchDesignSystem(...args),
    fetchConnectorStatuses: (...args: unknown[]) => fetchConnectorStatuses(...args),
    fetchProjectDesignSystemPackageAudit: (...args: unknown[]) => fetchProjectDesignSystemPackageAudit(...args),
    fetchLiveArtifacts: (...args: unknown[]) => fetchLiveArtifacts(...args),
    fetchProjectFiles: (...args: unknown[]) => fetchProjectFiles(...args),
    fetchProjectFileText: vi.fn(),
    fetchSkill: (...args: unknown[]) => fetchSkill(...args),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
  subscribeProjectEvents: vi.fn(() => () => {}),
}));

vi.mock('../../src/router', () => ({ navigate: vi.fn() }));

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getTemplate: (...args: unknown[]) => getTemplate(...args),
    listConversations: (...args: unknown[]) => listConversations(...args),
    listMessages: (...args: unknown[]) => listMessages(...args),
    loadTabs: (...args: unknown[]) => loadTabs(...args),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
    cacheTabsLocally: (_projectId: string, state: unknown) => state,
    persistTabsToDaemonNow: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({ AppChromeHeader: () => null }));
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: () => null,
}));
vi.mock('../../src/components/Loading', () => ({ CenteredLoader: () => null }));

vi.mock('../../src/components/ChatPane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ChatPane')>();
  return {
    ...actual,
    ChatPane: (props: ComponentProps<typeof actual.ChatPane>) => {
      chatPaneSpy(props);
      const RealChatPane = actual.ChatPane;
      return <RealChatPane {...props} />;
    },
  };
});

describe('ProjectView restored Home draft', () => {
  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    window.sessionStorage.clear();
  });

  it('keeps the complete draft in the real composer across a BYOK rejection', async () => {
    const projectId = 'project-real-composer-restored-draft';
    const attachment = { path: 'brief.pdf', name: 'brief.pdf', kind: 'file', size: 5 };
    const workspaceItem = {
      id: 'browser:reference-a',
      kind: 'browser',
      label: 'Reference A',
      tabId: 'reference-a',
      url: 'https://example.com/reference-a',
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/projects/${projectId}`) {
        return new Response(JSON.stringify({
          project: { id: projectId, name: 'Project', skillId: null, designSystemId: null },
          resolvedDir: '/project',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    listConversations.mockResolvedValue([{ id: 'conv-current', title: 'Conversation' }]);
    listMessages.mockResolvedValue([]);
    fetchPreviewComments.mockResolvedValue([]);
    loadTabs.mockResolvedValue({ tabs: [], activeTabId: null });
    fetchProjectFiles.mockResolvedValue([]);
    fetchProjectDesignSystemPackageAudit.mockResolvedValue(null);
    fetchLiveArtifacts.mockResolvedValue([]);
    fetchConnectorStatuses.mockResolvedValue({});
    fetchSkill.mockResolvedValue(null);
    fetchDesignSystem.mockResolvedValue(null);
    getTemplate.mockResolvedValue(null);
    listActiveChatRuns.mockResolvedValue([]);
    window.sessionStorage.setItem(`od:auto-send-first:${projectId}`, '1');
    window.sessionStorage.setItem(`od:auto-send-prompt:${projectId}`, 'Keep the complete Home draft');
    window.sessionStorage.setItem(`od:auto-send-attachments:${projectId}`, JSON.stringify([attachment]));
    window.sessionStorage.setItem(
      `od:auto-send-context:${projectId}`,
      JSON.stringify({ workspaceItems: [workspaceItem] }),
    );
    const onClearPendingPrompt = vi.fn(async () => true);

    render(
      <ProjectView
        project={{ id: projectId, name: 'Project', skillId: null, designSystemId: null } as never}
        routeFileName={null}
        config={{
          mode: 'api',
          agentId: 'byok-opencode',
          agentModels: {},
          notifications: undefined,
          apiProtocol: 'openai',
          apiKey: '',
          baseUrl: '',
          model: '',
        } as never}
        agents={[{ id: 'byok-opencode', name: 'BYOK OpenCode', available: false, models: [] } as never]}
        skills={[]}
        designTemplates={[]}
        designSystems={[]}
        daemonLive
        onModeChange={() => {}}
        onAgentChange={() => {}}
        onAgentModelChange={() => {}}
        onRefreshAgents={() => {}}
        onOpenSettings={() => {}}
        onBack={() => {}}
        onClearPendingPrompt={onClearPendingPrompt}
        onTouchProject={() => {}}
        onProjectChange={() => {}}
        onProjectsRefresh={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Keep the complete Home draft'));
    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('staged-contexts')).toHaveTextContent('Reference A'));
    await waitFor(() => expect(screen.getByText('chat.runError.title.generic')).toBeTruthy());
    const restoredSignal = chatPaneSpy.mock.calls
      .map(([props]) => props.composerDraftSignal)
      .find((signal) => signal?.source === 'auto-send');
    expect(restoredSignal).toMatchObject({ source: 'auto-send' });
    expect(onClearPendingPrompt).not.toHaveBeenCalled();
    expect(streamViaDaemon).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(`od:auto-send-first:${projectId}`)).toBe('1');
  });
});
