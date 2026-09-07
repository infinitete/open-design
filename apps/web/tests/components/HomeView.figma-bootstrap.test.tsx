// @vitest-environment jsdom

import { forwardRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeView } from '../../src/components/HomeView';

vi.mock('../../src/components/HomeHero', () => ({
  HomeHero: forwardRef(function HomeHeroFixture(
    { onImportFigma }: { onImportFigma: () => void },
    _ref,
  ) {
    return <button type="button" onClick={onImportFigma}>Import Figma fixture</button>;
  }),
}));

vi.mock('../../src/components/FigmaImportModal', () => ({
  FigmaImportModal: ({
    resolveProjectId,
    onImported,
  }: {
    resolveProjectId: () => Promise<string | null>;
    onImported: (result: { suggestedPrompt: string }, projectId: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        void resolveProjectId().then((projectId) => {
          if (projectId) onImported({ suggestedPrompt: 'Rebuild the imported Figma' }, projectId);
        });
      }}
    >
      Finish Figma fixture
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('HomeView Figma project bootstrap authority', () => {
  it('loads fresh authority and seeds the imported project before opening it', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/projects' && init?.method === 'POST') {
        return new Response(JSON.stringify({ project: {
          id: 'figma-new',
          name: 'Imported from Figma',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
          status: { value: 'not_started' },
        } }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/figma-new/git') {
        return new Response(JSON.stringify({
          enabled: true,
          phase: 'synced',
          localHead: 'b'.repeat(40),
          observedRemoteHead: 'b'.repeat(40),
          confirmedRemoteHead: 'b'.repeat(40),
          projectRevision: 41,
          contentRevision: 41,
          bindingGeneration: 2,
          dirty: false,
          pendingPush: false,
          autoSync: true,
          operationId: null,
          error: null,
          binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
          dependencies: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/figma-new' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ project: {
          id: 'figma-new',
          name: 'Imported from Figma',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
          status: { value: 'not_started' },
          pendingPrompt: 'Rebuild the imported Figma',
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const onOpenProject = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={vi.fn()}
        onOpenProject={onOpenProject}
        onViewAllProjects={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Import Figma fixture' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish Figma fixture' }));

    await waitFor(() => {
      expect(onOpenProject).toHaveBeenCalledWith('figma-new');
    });
    const patch = requests.find((request) => (
      request.url === '/api/projects/figma-new' && request.init?.method === 'PATCH'
    ));
    expect(patch?.init?.headers).toMatchObject({ 'X-OD-Project-Revision': '41' });
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      pendingPrompt: 'Rebuild the imported Figma',
    });
  });
});
