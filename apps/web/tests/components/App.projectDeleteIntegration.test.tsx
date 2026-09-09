// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEvent } from '../../src/providers/project-events';

const harness = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  projectEventListeners: new Map<string, (event: ProjectEvent) => void>(),
  listProjects: vi.fn(),
  navigate: vi.fn(),
}));

const routeListeners = new Set<() => void>();
const useRouteMock = vi.fn(() => ({
  kind: 'project' as const,
  projectId: String(harness.project?.id ?? ''),
  fileName: null,
}));

vi.mock('../../src/router', () => ({
  navigate: (...args: unknown[]) => {
    harness.navigate(...args);
    useRouteMock.mockReturnValue(args[0] as never);
    routeListeners.forEach((listener) => listener());
  },
  useRoute: () => useSyncExternalStore(
    (listener) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    useRouteMock,
  ),
}));

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: vi.fn(), t: (key: string) => key }),
  useT: () => ((key: string) => key),
}));

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>('../../src/state/config');
  return {
    ...actual,
    loadConfig: () => ({
      mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', apiVersion: '',
      baseUrl: '', model: '', agentId: 'agent-1', skillId: null, designSystemId: null,
      onboardingCompleted: true, mediaProviders: {}, agentModels: {}, agentCliEnv: {},
    }),
    mergeDaemonConfig: (value: unknown) => value,
    syncConfigToDaemon: vi.fn(async () => undefined),
    syncMediaProvidersToDaemon: vi.fn(async () => undefined),
    fetchComposioConfigFromDaemon: vi.fn(async () => null),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>('../../src/state/projects');
  return {
    ...actual,
    listProjects: (...args: unknown[]) => harness.listProjects(...args),
    listTemplates: vi.fn(async () => []),
    listConversations: vi.fn(async () => [{ id: 'conv-1', title: 'Conversation' }]),
    listMessages: vi.fn(async () => []),
    loadTabs: vi.fn(async () => ({ tabs: ['__design_system__'], activeTabId: '__design_system__' })),
    getTemplate: vi.fn(async () => null),
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return {
    ...actual,
    daemonIsLive: vi.fn(async () => true),
    fetchAgentsStream: vi.fn(async () => [{ id: 'agent-1', name: 'Agent', models: [] }]),
    fetchAppVersionInfo: vi.fn(async () => null),
    fetchDesignSystems: vi.fn(async () => [{ id: 'system-1', title: 'System', status: 'draft', source: 'user' }]),
    fetchPromptTemplates: vi.fn(async () => []),
    fetchSkills: vi.fn(async () => []),
    fetchPreviewComments: vi.fn(async () => []),
    fetchConnectorStatuses: vi.fn(async () => []),
    fetchProjectDesignSystemPackageAudit: vi.fn(async () => null),
    fetchLiveArtifacts: vi.fn(async () => []),
    fetchProjectFiles: vi.fn(async () => []),
    fetchSkill: vi.fn(async () => null),
    fetchDesignSystem: vi.fn(async () => ({
      id: 'system-1', title: 'System', status: 'draft', source: 'user',
    })),
  };
});

vi.mock('../../src/providers/daemon', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/daemon')>('../../src/providers/daemon');
  return {
    ...actual,
    listActiveChatRuns: vi.fn(async () => []),
    listProjectRuns: vi.fn(async () => []),
    fetchChatRunStatus: vi.fn(async () => null),
  };
});

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
  subscribeProjectEvents: (
    projectId: string,
    listener: (event: ProjectEvent) => void,
    options?: { onReady?: () => void },
  ) => {
    harness.projectEventListeners.set(projectId, listener);
    options?.onReady?.();
    return () => harness.projectEventListeners.delete(projectId);
  },
}));

vi.mock('../../src/runtime/design-kit', async () => {
  const actual = await vi.importActual<typeof import('../../src/runtime/design-kit')>('../../src/runtime/design-kit');
  return {
    ...actual,
    useDesignKit: () => ({
      loading: false,
      kit: {
        designSystemId: 'system-1', projectId: String(harness.project?.id ?? ''),
        name: 'System', editable: true, canUpload: true, logoSrc: null,
        logoAlternates: [], colors: [], typography: {}, fonts: [],
      },
    }),
  };
});

vi.mock('../../src/components/DesignKitView', () => ({
  DesignKitView: ({ headerMenuActions }: { headerMenuActions?: Array<{ id: string; disabled?: boolean; onClick: () => void }> }) => {
    const action = headerMenuActions?.find((candidate) => candidate.id === 'delete');
    return action ? (
      <button type="button" disabled={action.disabled} onClick={action.onClick}>
        Delete backing project
      </button>
    ) : null;
  },
}));

vi.mock('../../src/components/ChatPane', () => ({ ChatPane: () => <div data-testid="real-project-chat" /> }));
vi.mock('../../src/components/AppChromeHeader', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/AppChromeHeader')>(
    '../../src/components/AppChromeHeader',
  );
  return { ...actual, AppChromeHeader: () => null };
});
vi.mock('../../src/components/AvatarMenu', () => ({ AvatarMenu: () => null }));
vi.mock('../../src/components/EntryView', () => ({ EntryView: () => null }));

import { App } from '../../src/App';

function setupProject(projectId: string) {
  const project = {
    id: projectId, name: 'Design system project', skillId: null, designSystemId: 'system-1',
    metadata: { kind: 'design_system', importedFrom: 'design-system' },
    createdAt: 1, updatedAt: 2, status: { value: 'not_started' },
  };
  harness.project = project;
  harness.listProjects.mockResolvedValue([project]);
  useRouteMock.mockReturnValue({ kind: 'project', projectId, fileName: null });
  return project;
}

describe('App to real ProjectView and FileWorkspace project delete', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    harness.projectEventListeners.clear();
    routeListeners.clear();
  });

  it('sends one backing-project delete through the full component chain', async () => {
    const project = setupProject('integration-delete');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/projects/${project.id}` && init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url === `/api/projects/${project.id}`) return Response.json({ project, resolvedDir: '/project' });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete backing project' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1));
  });
});
