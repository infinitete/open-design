// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { listProjects, listTemplates, patchProject } from '../../src/state/projects';

const projectAuthorityHarness = vi.hoisted(() => ({ ready: true, current: true }));
const projectMutationContext = {
  projectId: 'project-rename',
  expectedProjectRevision: 7,
  signal: new AbortController().signal,
};
let activeDeleteResult: unknown;

vi.mock('../../src/providers/project-git', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/project-git')>(
    '../../src/providers/project-git',
  );
  return {
    ...actual,
    useProjectGitAuthoritySet: () => ({
      snapshots: {},
      isReady: () => projectAuthorityHarness.ready,
    }),
  };
});

vi.mock('../../src/state/project-git', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/project-git')>(
    '../../src/state/project-git',
  );
  return {
    ...actual,
    captureProjectMutation: vi.fn(() => (
      projectAuthorityHarness.ready ? projectMutationContext : undefined
    )),
    isProjectMutationCurrent: vi.fn(() => projectAuthorityHarness.current),
  };
});

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
    projectMutationReady,
    projects,
  }: {
    onOpenSettings: (section?: 'execution' | 'media') => void;
    onRenameProject: (id: string, name: string) => void;
    onDeleteProject: (id: string) => Promise<true | false | 'stale'>;
    projectMutationReady: (id: string) => boolean;
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
        projectMutationReady={projectMutationReady}
        canManageProjectCollection
      />
    </div>
  ),
  };
});

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: ({
    onDeleteProject,
    onClearPendingPrompt,
    onTouchProject,
    project,
  }: {
    onDeleteProject?: (id: string, context?: typeof projectMutationContext) => Promise<unknown>;
    onClearPendingPrompt: () => void;
    onTouchProject: () => void;
    project: { pendingPrompt?: string; updatedAt: number };
  }) => (
    <div>
      Project view
      <span>{project.pendingPrompt}</span>
      <span>Updated at {project.updatedAt}</span>
      <button type="button" onClick={onClearPendingPrompt}>Acknowledge restored draft</button>
      <button type="button" onClick={onTouchProject}>Touch active project</button>
      <button
        type="button"
        onClick={() => void onDeleteProject?.('project-rename', projectMutationContext)
          .then((result) => { activeDeleteResult = result; })}
      >
        Delete active backing project
      </button>
    </div>
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
const mockedPatchProject = vi.mocked(patchProject);
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
    projectAuthorityHarness.ready = true;
    projectAuthorityHarness.current = true;
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

  it('keeps Home rename inert until authority is ready and fences a stale completion', async () => {
    const originalProject = {
      id: 'project-rename', name: 'Original project', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    mockedListProjects.mockResolvedValue([originalProject]);
    projectAuthorityHarness.ready = false;
    render(<App />);
    await screen.findAllByText('Original project');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Home project' }));
    expect(mockedPatchProject).not.toHaveBeenCalled();

    projectAuthorityHarness.ready = true;
    let resolveRename!: (value: typeof originalProject) => void;
    mockedPatchProject.mockImplementation(() => new Promise((resolve) => {
      resolveRename = resolve;
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Home project' }));
    await waitFor(() => expect(mockedPatchProject).toHaveBeenCalledWith(
      'project-rename',
      { name: 'Renamed project' },
      projectMutationContext,
    ));
    const readsBeforeStaleCompletion = mockedListProjects.mock.calls.length;
    projectAuthorityHarness.current = false;
    await act(async () => resolveRename({ ...originalProject, name: 'Late stale rename' }));

    expect(mockedListProjects).toHaveBeenCalledTimes(readsBeforeStaleCompletion);
    expect(screen.queryByText('Late stale rename')).toBeNull();
  });

  it('accepts the active ProjectView authority and sends one exact-revision delete', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/projects/${project.id}` && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ project, resolvedDir: '/project' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete active backing project' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${project.id}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-OD-Project-Revision': '7' },
        signal: projectMutationContext.signal,
      }),
    ));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });

  it('does not delete when the supplied active-project context is stale', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    projectAuthorityHarness.current = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ project, resolvedDir: '/project' }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete active backing project' }));
    await act(async () => undefined);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('does not use a retained supplied delete context after authority read failure', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    projectAuthorityHarness.ready = false;
    projectAuthorityHarness.current = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ project, resolvedDir: '/project' }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete active backing project' }));
    await act(async () => undefined);

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    expect(activeDeleteResult).toBe(false);
  });

  it('keeps a pending prompt when its restore acknowledgement has no ready authority', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      pendingPrompt: 'Keep this draft',
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    projectAuthorityHarness.ready = false;
    render(<App />);

    expect(await screen.findByText('Keep this draft')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge restored draft' }));

    expect(mockedPatchProject).not.toHaveBeenCalled();
    expect(screen.getByText('Keep this draft')).toBeTruthy();
  });

  it('keeps an implicit active-project touch inert when fresh authority is unavailable', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    projectAuthorityHarness.ready = false;
    render(<App />);

    expect(await screen.findByText('Updated at 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Touch active project' }));

    expect(screen.getByText('Updated at 2')).toBeTruthy();
    expect(mockedPatchProject).not.toHaveBeenCalled();
  });

  it('maps a real structured project revision 409 to a stale delete result', async () => {
    const project = {
      id: 'project-rename', name: 'Project view', skillId: null, designSystemId: null,
      createdAt: 1, updatedAt: 2, status: { value: 'not_started' as const },
    };
    useRouteMock.mockReturnValue({ kind: 'project', projectId: project.id, fileName: null } as never);
    mockedListProjects.mockResolvedValue([project]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/projects/${project.id}` && init?.method === 'DELETE') {
        return new Response(JSON.stringify({
          error: { code: 'PROJECT_STATE_CHANGED', message: 'Restored elsewhere', retryable: false },
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ project, resolvedDir: '/project' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete active backing project' }));

    await waitFor(() => expect(activeDeleteResult).toBe('stale'));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(navigateMock).not.toHaveBeenCalledWith({ kind: 'home', view: 'home' });
  });

  it('preserves stale selection through the production App to Recent bulk delete boundary', async () => {
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
      if (init?.method === 'DELETE' && String(input) === '/api/projects/project-bulk-ok') {
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'DELETE' && String(input) === '/api/projects/project-bulk-stale') {
        return new Response(JSON.stringify({
          error: { code: 'PROJECT_STATE_CHANGED', message: 'Restored elsewhere', retryable: false },
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
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
      ['/api/projects/project-bulk-ok', expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-OD-Project-Revision': '7' },
      })],
      ['/api/projects/project-bulk-stale', expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-OD-Project-Revision': '7' },
      })],
    ]);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/history changed|reload/i);
    expect(screen.queryByRole('button', { name: 'Bulk success' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Bulk stale' })).toHaveAttribute('aria-pressed', 'true');
  });

  afterEach(() => {
    cleanup();
    activeDeleteResult = undefined;
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
      privacyDecisionAt: 1778244000000,
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
