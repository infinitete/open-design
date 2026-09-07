// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

const projectStateMocks = vi.hoisted(() => ({
  duplicatePluginAsProject: vi.fn(),
}));

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    duplicatePluginAsProject: projectStateMocks.duplicatePluginAsProject,
  };
});

vi.mock('../../src/components/CommunityView', () => ({
  CommunityView: ({
    onRemixTemplate,
  }: {
    onRemixTemplate: (input: { templateId: string; prompt: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRemixTemplate({ templateId: 'template-1', prompt: 'Seed the remix' })}
    >
      Remix fixture
    </button>
  ),
}));

function config(): AppConfig {
  return {
    mode: 'daemon',
    agentId: 'codex',
    agentModels: {},
    apiProtocol: 'openai',
    apiKey: '',
    baseUrl: '',
    model: '',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('EntryShell Community remix bootstrap authority', () => {
  it('loads fresh authority and seeds the duplicated project before opening it', async () => {
    window.history.replaceState(null, '', '/community');
    projectStateMocks.duplicatePluginAsProject.mockResolvedValue({
      projectId: 'entry-remix',
      relPath: 'index.html',
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/projects/entry-remix/git') {
        return new Response(JSON.stringify({
          enabled: true,
          phase: 'synced',
          localHead: 'a'.repeat(40),
          observedRemoteHead: 'a'.repeat(40),
          confirmedRemoteHead: 'a'.repeat(40),
          projectRevision: 31,
          contentRevision: 31,
          bindingGeneration: 1,
          dirty: false,
          pendingPush: false,
          autoSync: true,
          operationId: null,
          error: null,
          binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
          dependencies: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/entry-remix' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          project: {
            id: 'entry-remix',
            name: 'Entry remix',
            skillId: null,
            designSystemId: null,
            createdAt: 1,
            updatedAt: 2,
            status: { value: 'not_started' },
            pendingPrompt: 'Seed the remix',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const onOpenProject = vi.fn();

    render(
      <I18nProvider initial="en">
        <EntryShell
          skills={[]}
          designTemplates={[]}
          designSystems={[]}
          projects={[]}
          templates={[]}
          promptTemplates={[]}
          defaultDesignSystemId={null}
          connectors={[]}
          connectorsLoading={false}
          config={config()}
          agents={[]}
          daemonLive
          onModeChange={vi.fn()}
          onAgentChange={vi.fn()}
          onAgentModelChange={vi.fn()}
          onApiProtocolChange={vi.fn()}
          onApiModelChange={vi.fn()}
          onConfigPersist={vi.fn()}
          onRefreshAgents={vi.fn(() => [])}
          onCreateProject={vi.fn()}
          onCreatePluginShareProject={vi.fn()}
          onImportClaudeDesign={vi.fn()}
          onOpenProject={onOpenProject}
          onOpenLiveArtifact={vi.fn()}
          onDeleteProject={vi.fn(() => false)}
          onRenameProject={vi.fn()}
          onChangeDefaultDesignSystem={vi.fn()}
          onPersistComposioKey={vi.fn()}
          onOpenSettings={vi.fn()}
          onCompleteOnboarding={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remix fixture' }));

    await waitFor(() => {
      expect(onOpenProject).toHaveBeenCalledWith('entry-remix', 'index.html');
    });
    const patch = requests.find((request) => (
      request.url === '/api/projects/entry-remix' && request.init?.method === 'PATCH'
    ));
    expect(patch?.init?.headers).toMatchObject({ 'X-OD-Project-Revision': '31' });
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ pendingPrompt: 'Seed the remix' });
  });
});
