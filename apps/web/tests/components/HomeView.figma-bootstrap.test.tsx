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

describe('HomeView Figma project bootstrap', () => {
  it('refetches the imported project and seeds it before opening it', async () => {
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
      if (url === '/api/projects/figma-new' && !init?.method) {
        return new Response(JSON.stringify({ project: {
          id: 'figma-new',
          name: 'Imported from Figma',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
          status: { value: 'not_started' },
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    const freshRead = requests.findIndex((request) => (
      request.url === '/api/projects/figma-new' && !request.init?.method
    ));
    const patchIndex = requests.findIndex((request) => (
      request.url === '/api/projects/figma-new' && request.init?.method === 'PATCH'
    ));
    expect(freshRead).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    // The seed patch must land on a freshly-read project row, never a stale one.
    expect(freshRead).toBeLessThan(patchIndex);
    expect(JSON.parse(String(requests[patchIndex]?.init?.body))).toEqual({
      pendingPrompt: 'Rebuild the imported Figma',
    });
  });
});
