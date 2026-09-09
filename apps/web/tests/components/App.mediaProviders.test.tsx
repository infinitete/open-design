// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig } from '../../src/types';
import {
  fetchComposioConfigFromDaemon,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
  syncConfigToDaemon,
  syncMediaProvidersToDaemon,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import {
  duplicatePluginAsProject,
  listProjects,
  listTemplates,
} from '../../src/state/projects';

// Settings is now a full-page route (`/settings`): App.openSettings navigates
// instead of toggling a modal flag, so the router mock must feed navigate()
// calls back into useRoute() (like the production useSyncExternalStore router)
// for the settings surface to render at all.
const homeRouteMock = { kind: 'home' as const, view: 'home' as const };
const routeListeners = new Set<() => void>();
const navigateMock = vi.fn();
const useRouteMock = vi.fn(() => homeRouteMock);

vi.mock('../../src/router', () => ({
  navigate: (...args: unknown[]) => {
    navigateMock(...args);
    useRouteMock.mockReturnValue(args[0] as never);
    routeListeners.forEach((notify) => notify());
  },
  useRoute: () =>
    useSyncExternalStore(
      (onChange) => {
        routeListeners.add(onChange);
        return () => routeListeners.delete(onChange);
      },
      useRouteMock,
    ),
}));

vi.mock('../../src/components/EntryView', async () => {
  const { RecentProjectsStrip } = await vi.importActual<
    typeof import('../../src/components/RecentProjectsStrip')
  >('../../src/components/RecentProjectsStrip');
  return {
  EntryView: ({
    onOpenSettings,
    onRenameProject,
    onDeleteProject,
    projects,
  }: {
    onOpenSettings: (section?: 'execution' | 'media') => void;
    onRenameProject: (id: string, name: string) => void;
    onDeleteProject: (id: string) => Promise<true | false | 'stale'>;
    projects: Array<{ id: string; name: string }>;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenSettings('media')}>
        Open media settings
      </button>
      <span>{projects[0]?.name}</span>
      <button type="button" onClick={() => onRenameProject('project-rename', 'Renamed project')}>
        Rename Home project
      </button>
      <RecentProjectsStrip
        projects={projects as never}
        heading="All projects"
        onOpen={() => undefined}
        onDelete={onDeleteProject}
        onRename={onRenameProject}
        canManageProjectCollection
      />
    </div>
  ),
  };
});

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({
    project,
  }: {
    project: { pendingPrompt?: string; updatedAt: number };
  }) => (
    <div>
      Project view
      <span>{project.pendingPrompt}</span>
      <span>Updated at {project.updatedAt}</span>
    </div>
  ),
}));

vi.mock('../../src/components/CommunityView', () => ({
  CommunityView: ({
    onRemixTemplate,
  }: {
    onRemixTemplate: (input: { templateId: string; prompt: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRemixTemplate({ templateId: 'template-1', prompt: 'Seed this remix' })}
    >
      Remix community template
    </button>
  ),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: ({
    initial,
    initialSection,
    onPersist,
    onClose,
  }: {
    initial: AppConfig;
    initialSection?: string;
    onPersist: (next: AppConfig) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Settings dialog">
      <div>Section: {initialSection}</div>
      <button
        type="button"
        onClick={() =>
          onPersist({
            ...initial,
            mediaProviders: {
              openai: {
                apiKey: 'media-key',
                baseUrl: 'https://api.openai.com/v1',
                model: '',
              },
            },
          })
        }
      >
        Save media provider
      </button>
      <button type="button" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
    duplicatePluginAsProject: vi.fn(),
    patchProject: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedDuplicatePluginAsProject = vi.mocked(duplicatePluginAsProject);
const mockedFetchComposioConfigFromDaemon = vi.mocked(fetchComposioConfigFromDaemon);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedMergeDaemonConfig = vi.mocked(mergeDaemonConfig);
const mockedSaveConfig = vi.mocked(saveConfig);
const mockedSyncConfigToDaemon = vi.mocked(syncConfigToDaemon);
const mockedSyncMediaProvidersToDaemon = vi.mocked(syncMediaProvidersToDaemon);

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

describe('App media provider sync flows', () => {
  beforeEach(() => {
    useRouteMock.mockReturnValue(homeRouteMock);
    mockedDaemonIsLive.mockResolvedValue(true);
    mockedFetchAgentsStream.mockResolvedValue([]);
    mockedFetchSkills.mockResolvedValue([]);
    mockedFetchDesignSystems.mockResolvedValue([]);
    mockedFetchPromptTemplates.mockResolvedValue([]);
    mockedFetchAppVersionInfo.mockResolvedValue(null);
    mockedListProjects.mockResolvedValue([]);
    mockedListTemplates.mockResolvedValue([]);
    mockedFetchComposioConfigFromDaemon.mockResolvedValue(null);
    mockedMergeDaemonConfig.mockImplementation((local) => local);
    mockedLoadConfig.mockReturnValue({ ...baseConfig });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );
  });

  it('seeds a pending prompt before navigating a newly duplicated Community remix', async () => {
    useRouteMock.mockReturnValue({ kind: 'community' } as never);
    mockedDuplicatePluginAsProject.mockResolvedValue({
      projectId: 'community-copy',
      conversationId: 'community-conversation',
      relPath: 'index.html',
    } as never);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects/community-copy' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ project: {
          id: 'community-copy', name: 'Community copy', skillId: null, designSystemId: null,
          pendingPrompt: 'Seed this remix', createdAt: 1, updatedAt: 2,
          status: { value: 'not_started' },
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remix community template' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === '/api/projects/community-copy' && init?.method === 'PATCH'
    ))).toBe(true));
    const [, patchInit] = fetchMock.mock.calls.find(([input, init]) => (
      String(input) === '/api/projects/community-copy' && init?.method === 'PATCH'
    ))!;
    expect(patchInit?.body).toBe(JSON.stringify({ pendingPrompt: 'Seed this remix' }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({
      kind: 'project', projectId: 'community-copy', conversationId: 'community-conversation',
      fileName: 'index.html',
    }));
  });

  it('drives the production App to the Recent bulk delete boundary', async () => {
    const projects = [
      {
        id: 'project-bulk-ok', name: 'Bulk success', skillId: null, designSystemId: null,
        createdAt: 1, updatedAt: 3, status: { value: 'not_started' as const },
      },
      {
        id: 'project-bulk-stale', name: 'Bulk stale', skillId: null, designSystemId: null,
        createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
      },
    ];
    mockedListProjects.mockResolvedValue(projects);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await screen.findAllByText('Bulk success');
    fireEvent.click(screen.getByRole('button', { name: 'Multi-select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk success' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk stale' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete selected' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(2));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([
      ['/api/projects/project-bulk-ok', expect.objectContaining({ method: 'DELETE' })],
      ['/api/projects/project-bulk-stale', expect.objectContaining({ method: 'DELETE' })],
    ]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Bulk success' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bulk stale' })).toBeNull();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('syncs configured media providers to the daemon during bootstrap when the daemon is live', async () => {
    const configuredProviders = {
      openai: {
        apiKey: 'media-key',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
      },
    };
    mockedLoadConfig.mockReturnValue({
      ...baseConfig,
      mediaProviders: configuredProviders,
    });

    render(<App />);

    await waitFor(() => {
      expect(mockedSyncMediaProvidersToDaemon).toHaveBeenCalledWith(configuredProviders, {
        daemonProviders: {},
      });
    });
  });

  it('forces a media provider sync when settings are saved', async () => {
    mockedLoadConfig.mockReturnValue({
      ...baseConfig,
      onboardingCompleted: true,
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open media settings' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Settings dialog' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save media provider' }));

    await waitFor(() => {
      expect(mockedSyncMediaProvidersToDaemon).toHaveBeenCalledWith(
        {
          openai: {
            apiKey: 'media-key',
            baseUrl: 'https://api.openai.com/v1',
            model: '',
          },
        },
        { daemonProviders: {}, force: undefined, throwOnError: undefined },
      );
    });

    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingCompleted: true,
        mediaProviders: {
          openai: {
            apiKey: 'media-key',
            baseUrl: 'https://api.openai.com/v1',
            model: '',
          },
        },
      }),
    );
    expect(mockedSyncConfigToDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingCompleted: true,
        mediaProviders: {
          openai: {
            apiKey: 'media-key',
            baseUrl: 'https://api.openai.com/v1',
            model: '',
          },
        },
      }),
      expect.objectContaining({ throwOnError: true }),
    );
  });
});
