// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deckPreviewSrcDoc,
  RecentProjectsStrip,
} from '../../src/components/RecentProjectsStrip';
import {
  fetchProjectFiles,
  fetchProjectFileText,
  invalidateProjectFilesCache,
} from '../../src/providers/registry';
import { resetThumbnailLoadGateForTests } from '../../src/lib/thumbnail-load-gate';
import type { Project } from '../../src/types';

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async (projectId: string, name: string) => {
    if (projectId === 'project-ds' && name === 'brand.json') {
      return JSON.stringify({
        logo: { primary: 'logos/favicon-1.png' },
        imagery: { samples: [{ file: 'imagery/cover-0.png', kind: 'cover' }] },
      });
    }
    if (projectId === 'project-ds-fallback' && name === 'brand.json') {
      return JSON.stringify({
        logo: {
          primary: 'logos/favicon-1.png',
          alternates: ['logos/wordmark.svg'],
        },
      });
    }
    return null;
  }),
  fetchProjectFiles: vi.fn(async (projectId: string) => {
    if (projectId === 'project-ds') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4, size: 0, mime: 'image/png' },
        { name: 'cover-0.png', path: 'imagery/cover-0.png', kind: 'image', mtime: 3, size: 0, mime: 'image/png' },
      ];
    }
    if (projectId === 'project-ds-fallback') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4, size: 0, mime: 'image/png' },
        { name: 'wordmark.svg', path: 'logos/wordmark.svg', kind: 'image', mtime: 3, size: 0, mime: 'image/svg+xml' },
      ];
    }
    if (projectId === 'project-html') {
      return [{ name: 'index.html', kind: 'html', mtime: 200, size: 0, mime: 'text/html' }];
    }
    if (projectId === 'project-deck') {
      return [{ name: 'index.html', kind: 'html', mtime: 400, size: 0, mime: 'text/html' }];
    }
    return [];
  }),
  invalidateProjectFilesCache: vi.fn(),
  projectFileUrl: (projectId: string, fileName: string) =>
    `/api/projects/${projectId}/files/${fileName}`,
}));

afterEach(() => {
  cleanup();
  resetThumbnailLoadGateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(invalidateProjectFilesCache).mockClear();
  vi.mocked(fetchProjectFiles).mockReset().mockImplementation(async (projectId: string) => {
    if (projectId === 'project-ds') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4, size: 0, mime: 'image/png' },
        { name: 'cover-0.png', path: 'imagery/cover-0.png', kind: 'image', mtime: 3, size: 0, mime: 'image/png' },
      ];
    }
    if (projectId === 'project-ds-fallback') {
      return [
        { name: 'favicon-1.png', path: 'logos/favicon-1.png', kind: 'image', mtime: 4, size: 0, mime: 'image/png' },
        { name: 'wordmark.svg', path: 'logos/wordmark.svg', kind: 'image', mtime: 3, size: 0, mime: 'image/svg+xml' },
      ];
    }
    if (projectId === 'project-html') {
      return [{ name: 'index.html', kind: 'html', mtime: 200, size: 0, mime: 'text/html' }];
    }
    if (projectId === 'project-deck') {
      return [{ name: 'index.html', kind: 'html', mtime: 400, size: 0, mime: 'text/html' }];
    }
    return [];
  });
});

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
    status: { value: 'not_started' },
    ...overrides,
  };
}

function projects(count: number): Project[] {
  return Array.from({ length: count }, (_, index) =>
    project({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      updatedAt: count - index,
    }),
  );
}

function stubCoverProbe(status = 200, statusText = 'OK', body = '<html><body>slide</body></html>') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: async () => body,
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('RecentProjectsStrip', () => {
  it('turns a script-activated deck into a deterministic visible first-page cover', () => {
    const cover = deckPreviewSrcDoc(`<!doctype html>
      <html><head><style>
        .deck-shell { position: fixed; transform: translateX(1400px) }
        .deck-stage { position: relative; width: 1920px; height: 1080px; transform: scale(.6) }
        .slide { display: none; opacity: 0; visibility: hidden }
        .slide.active,
        .slide.is-active { display: flex; opacity: 1; visibility: visible }
        [data-anim] { opacity: 0; transform: translateY(24px) }
      </style></head><body>
        <div class="deck-shell">
          <div class="deck-stage">
            <section class="slide orange"><h1 data-anim="fade-up">Launch</h1></section>
            <section class="slide dark"><h1>Details</h1></section>
          </div>
        </div>
        <script>document.querySelector('.slide').classList.add('is-active')</script>
      </body></html>`);

    expect(cover).not.toContain('<script>');
    expect(cover).toMatch(
      /<section class="slide orange active is-active" data-od-cover-slide(?:="")?>/,
    );
    expect(cover).toContain('[data-od-cover-slide] > *');
    expect(cover).toMatch(
      /\.deck-shell,\s*\.deck-stage,\s*:where\(body \*\):has\(> \[data-od-cover-slide\]\)\s*\{[^}]*display: block !important/s,
    );
    expect(cover).toContain('transform-origin: 0 0 !important');
    expect(cover).toContain('[data-od-cover-slide] [data-anim]');
    expect(cover).toContain('opacity: 1 !important');
    expect(cover).toContain('.slide:not([data-od-cover-slide])');
  });

  it('marks the first real slide when a style comment contains a slide tag example', () => {
    const cover = deckPreviewSrcDoc(`<!doctype html>
      <html><head><style>
        /* Put content inside <section class="slide"> bodies. */
        .slide { display: none }
        .slide.active { display: grid }
      </style></head><body>
        <div class="deck-shell"><div class="deck-stage">
          <section class="slide s-title active"><h1>Real cover</h1></section>
          <section class="slide s-details"><h2>Details</h2></section>
        </div></div>
      </body></html>`);

    expect(cover).toContain('inside <section class="slide"> bodies');
    expect(cover).toMatch(
      /<section class="slide s-title active is-active" data-od-cover-slide(?:="")?>/,
    );
    expect(cover).not.toContain(
      'inside <section class="slide active is-active" data-od-cover-slide> bodies',
    );
  });

  it('lets a 16:9 project cover determine its grid-card height without a taller minimum', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/styles/home/recent-projects.css'),
      'utf8',
    );
    const gridThumb = css.match(
      /\.recent-projects__row--grid \.recent-projects__card-thumb\s*\{([^}]*)\}/u,
    )?.[1];
    expect(gridThumb).toContain('min-height: 0');
    expect(gridThumb).not.toContain('min-height: 108px');
  });

  it('bounds a large cover scan and aborts it before opening a foreground project', async () => {
    const activeSignals = new Set<AbortSignal>();
    const startedSignals: AbortSignal[] = [];
    vi.mocked(fetchProjectFiles).mockImplementation((_projectId, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('cover request must be cancellable');
      activeSignals.add(signal);
      startedSignals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            activeSignals.delete(signal);
            resolve([]);
          },
          { once: true },
        );
      });
    });
    const onOpen = vi.fn(() => {
      expect(activeSignals.size).toBe(0);
      expect(startedSignals.every((signal) => signal.aborted)).toBe(true);
    });

    render(
      <RecentProjectsStrip
        projects={projects(20)}
        limit={1000}
        onOpen={onOpen}
        heading="All projects"
      />,
    );

    await waitFor(() => expect(fetchProjectFiles).toHaveBeenCalled());
    expect(fetchProjectFiles).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTitle('Project 1'));

    expect(onOpen).toHaveBeenCalledWith('project-1');
    expect(activeSignals.size).toBe(0);
    await act(async () => {});
    expect(fetchProjectFiles).toHaveBeenCalledTimes(2);
  });

  it('resumes the bounded cover scan when a shared-project foreground open fails', async () => {
    const activeSignals = new Set<AbortSignal>();
    vi.mocked(fetchProjectFiles).mockImplementation((_projectId, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('cover request must be cancellable');
      activeSignals.add(signal);
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            activeSignals.delete(signal);
            resolve([]);
          },
          { once: true },
        );
      });
    });
    let finishOpen!: (opened: boolean) => void;
    const onOpen = vi.fn(() => new Promise<boolean>((resolve) => {
      finishOpen = resolve;
    }));

    render(
      <RecentProjectsStrip
        projects={projects(20)}
        limit={1000}
        onOpen={onOpen}
        heading="All projects"
      />,
    );
    await waitFor(() => expect(fetchProjectFiles).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTitle('Project 1'));
    expect(activeSignals.size).toBe(0);
    expect(fetchProjectFiles).toHaveBeenCalledTimes(2);

    act(() => finishOpen(false));

    await waitFor(() => expect(fetchProjectFiles).toHaveBeenCalledTimes(4));
    expect(activeSignals.size).toBe(2);
  });

  it('keeps HTML cover probes inside the same bounded queue and aborts them before open', async () => {
    vi.mocked(fetchProjectFiles).mockImplementation(async (projectId) => [{
      name: 'index.html',
      path: 'index.html',
      kind: 'html',
      mtime: Number(projectId.replace('project-', '')),
      size: 1,
      mime: 'text/html',
    }]);
    const activeCoverSignals = new Set<AbortSignal>();
    const coverFetch = vi.fn<typeof fetch>((input, init) => {
      if (String(input).includes('/api/workspace/context')) {
        return Promise.resolve(new Response(JSON.stringify({ context: null }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      const signal = init?.signal;
      if (!signal) throw new Error('HTML cover probe must be cancellable');
      activeCoverSignals.add(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          activeCoverSignals.delete(signal);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', coverFetch);
    const onOpen = vi.fn(() => {
      expect(activeCoverSignals.size).toBe(0);
    });

    render(
      <RecentProjectsStrip
        projects={projects(20)}
        limit={1000}
        onOpen={onOpen}
        heading="All projects"
      />,
    );

    await waitFor(() => expect(activeCoverSignals.size).toBeGreaterThan(0));
    expect(coverFetch.mock.calls.filter(([input]) => String(input).includes('/api/projects/')))
      .toHaveLength(2);

    fireEvent.click(screen.getByTitle('Project 1'));

    expect(onOpen).toHaveBeenCalledWith('project-1');
    expect(activeCoverSignals.size).toBe(0);
    await act(async () => {});
    expect(coverFetch.mock.calls.filter(([input]) => String(input).includes('/api/projects/')))
      .toHaveLength(2);
  });

  it('aborts hidden Home scans and does not continue a design-system read into brand.json', async () => {
    vi.mocked(fetchProjectFileText).mockClear();
    let coverSignal: AbortSignal | undefined;
    vi.mocked(fetchProjectFiles).mockImplementation((_projectId, options) => {
      coverSignal = options?.signal;
      return new Promise((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => resolve([
            {
              name: 'logo.svg',
              path: 'assets/logo.svg',
              kind: 'image',
              mtime: 1,
              size: 1,
              mime: 'image/svg+xml',
            },
          ]),
          { once: true },
        );
      });
    });

    const projectToReopen = project({
      id: 'project-ds-reopen',
      name: 'Design System',
      metadata: { kind: 'other', importedFrom: 'design-system' },
    });
    const { rerender } = render(
      <RecentProjectsStrip
        isActive
        projects={[projectToReopen]}
        onOpen={() => {}}
        heading="All projects"
      />,
    );
    await waitFor(() => expect(fetchProjectFiles).toHaveBeenCalledTimes(1));

    rerender(
      <RecentProjectsStrip
        isActive={false}
        projects={[projectToReopen]}
        onOpen={() => {}}
        heading="All projects"
      />,
    );

    expect(coverSignal?.aborted).toBe(true);
    await act(async () => {});
    expect(fetchProjectFileText).not.toHaveBeenCalled();
  });

  it('shows seven projects when the row has room for a seventh card', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1332 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container } = render(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(7);
    });
  });

  it('keeps six projects when the row is below the wide-card threshold', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1331 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container } = render(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(6);
  });

  it('remeasures when projects arrive after the initial empty render', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1400,
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        width: this.classList.contains('recent-projects__row') ? 1331 : 180,
        height: 100,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
    });

    const { container, rerender } = render(
      <RecentProjectsStrip
        projects={[]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    rerender(
      <RecentProjectsStrip
        projects={projects(8)}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    expect(container.querySelectorAll('.recent-projects__card')).toHaveLength(6);
  });

  it('matches project cards with previews and design-system tags', async () => {
    stubCoverProbe();

    const { container } = render(
      <RecentProjectsStrip
        projects={[
          project({
            id: 'project-ds',
            name: 'Acme Design System',
            updatedAt: 4,
            metadata: {
              kind: 'other',
              importedFrom: 'design-system',
            },
          }),
          project({
            id: 'project-html',
            name: 'Web Prototype',
            updatedAt: 3,
          }),
        ]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    expect(screen.getByText('Design System')).toBeTruthy();
    expect(screen.getAllByText('Prototype').length).toBeGreaterThan(0);
    const designSystemCard = container.querySelector('.recent-projects__card.is-design-system-project');
    expect(designSystemCard).toBeTruthy();
    expect(designSystemCard?.querySelectorAll('.design-card-tag')).toHaveLength(1);

    await waitFor(() => {
      expect(designSystemCard?.querySelector('.recent-projects__card-thumb-image img')).toBeTruthy();
      expect(designSystemCard?.querySelector('img')?.getAttribute('src')).toBe(
        '/api/projects/project-ds/files/imagery/cover-0.png?v=3',
      );
      const htmlFrame = container.querySelector<HTMLIFrameElement>('.recent-projects__card-thumb-html iframe');
      expect(htmlFrame).toBeTruthy();
      expect(htmlFrame?.getAttribute('src')).toBe(
        '/api/projects/project-html/files/index.html?v=200',
      );
      expect(container.querySelector('.recent-projects__card-thumb-html .recent-projects__card-glyph')).toBeNull();
    });
  });

  it('uses non-favicon design-system logo alternates when no cover exists', async () => {
    const { container } = render(
      <RecentProjectsStrip
        projects={[
          project({
            id: 'project-ds-fallback',
            name: 'Acme Design System',
            updatedAt: 4,
            metadata: {
              kind: 'other',
              importedFrom: 'design-system',
            },
          }),
        ]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    const designSystemCard = container.querySelector('.recent-projects__card.is-design-system-project');

    await waitFor(() => {
      expect(designSystemCard?.querySelector('.recent-projects__card-thumb-logo img')).toBeTruthy();
      expect(designSystemCard?.querySelector('img')?.getAttribute('src')).toBe(
        '/api/projects/project-ds-fallback/files/logos/wordmark.svg?v=3',
      );
    });
  });

  it('renders HTML and deck covers from the current file URL', async () => {
    const fetchMock = stubCoverProbe();

    const { container } = render(
      <RecentProjectsStrip
        projects={[
          project({
            id: 'project-deck',
            name: 'Simple Deck',
            updatedAt: 4,
            metadata: { kind: 'deck' },
          }),
          project({
            id: 'project-html',
            name: 'Web Prototype',
            updatedAt: 3,
          }),
        ]}
        onOpen={() => {}}
        onViewAll={() => {}}
      />,
    );

    const deckCard = container.querySelector('[data-project-id="project-deck"]');
    const htmlCard = container.querySelector('[data-project-id="project-html"]');

    await waitFor(() => {
      // #5517 collapses a deck card to its first slide, so its frame is built
      // from the fetched document (srcDoc) rather than pointed at the live URL
      // — a running deck would otherwise show whichever slide it drifted to.
      // The URL is still the versioned one, which is what this spec guards.
      expect(deckCard?.querySelector('.recent-projects__deck-iframe')?.getAttribute('srcdoc'))
        .toContain('slide');
      expect(htmlCard?.querySelector('iframe')?.getAttribute('src')).toBe(
        '/api/projects/project-html/files/index.html?v=200',
      );
      expect(deckCard?.querySelector('.recent-projects__card-glyph')).toBeNull();
      expect(htmlCard?.querySelector('.recent-projects__card-glyph')).toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-deck/files/index.html?v=400',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe('recvqabp2Uy23r — shared badge grid overlay vs list inline', () => {
  // The badge has two renderings (see recent-projects.css): a floating
  // hover-revealed overlay inside the thumb (grid) and an always-visible
  // inline pill next to the name (list, whose 128x52 thumb has no room for
  // the overlay). Both must actually be wired to the shared card — a
  // shared project rendering neither is exactly this bug.
  it('renders the shared badge as a thumb overlay in grid view', () => {
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'Shared One' })]}
        onOpen={() => {}}
        heading="All projects"
        isSharedProject={(id) => id === 'project-1'}
      />,
    );

    const badge = screen.getByText('Shared').closest('.recent-projects__card-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('recent-projects__card-badge--inline')).toBe(false);
    expect(badge?.closest('.recent-projects__card-thumb')).not.toBeNull();
  });

  it('renders the shared badge inline next to the name in list view', () => {
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'Shared One' })]}
        onOpen={() => {}}
        heading="All projects"
        isSharedProject={(id) => id === 'project-1'}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));

    const badge = screen.getByText('Shared').closest('.recent-projects__card-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('recent-projects__card-badge--inline')).toBe(true);
    expect(badge?.closest('.recent-projects__card-name-row')).not.toBeNull();
  });

  it('renders no shared badge at all for a project that is not shared', () => {
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'Private One' })]}
        onOpen={() => {}}
        heading="All projects"
        isSharedProject={() => false}
      />,
    );

    expect(screen.queryByText('Shared')).toBeNull();
  });
});

describe('recvqbipG9QDTt — Recent Projects filter needs a visible clear entry', () => {
  // RecentProjectsStrip mounts once per host view and stays alive across
  // EntryShell tab switches — Home's instance in particular is only ever
  // hidden via `content-visibility`, never unmounted — so kindFilter /
  // ownerFilter state survives a round trip through another tab with no
  // visible sign anything is filtered. A filter that now matches zero
  // projects reads as "my projects disappeared" instead of "a filter is on".
  it('shows no clear-filters entry while the default (unfiltered) view is showing', () => {
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'Only Project' })]}
        onOpen={() => {}}
        heading="All projects"
      />,
    );

    expect(screen.queryByTestId('recent-projects-clear-filters')).toBeNull();
  });

  it('surfaces a clear-filters entry once the type filter hides every project, and restores the grid on click', () => {
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'Only Project' })]}
        onOpen={() => {}}
        heading="All projects"
      />,
    );

    // Every project here falls back to the 'prototype' card category
    // (projectCategory's default), so filtering to Media leaves zero
    // matches — exactly the "did my projects disappear?" scenario reported.
    fireEvent.click(screen.getByRole('button', { name: 'Any type' }));
    fireEvent.click(screen.getByRole('button', { name: 'Media' }));

    expect(screen.queryByText('Only Project')).toBeNull();
    const clearButton = screen.getByTestId('recent-projects-clear-filters');

    fireEvent.click(clearButton);

    expect(screen.getByText('Only Project')).toBeTruthy();
    expect(screen.queryByTestId('recent-projects-clear-filters')).toBeNull();
    expect(screen.getByRole('button', { name: 'Any type' })).toBeTruthy();
  });
});

describe('recvqaRqM0dv2x — per-card Duplicate menu item', () => {
  it('keeps Duplicate enabled and wired for a project the current member created', () => {
    const onDuplicate = vi.fn();
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'My project' })]}
        onOpen={() => {}}
        onDuplicate={onDuplicate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const duplicateItem = screen.getByRole('menuitem', { name: 'Duplicate project' });
    expect((duplicateItem as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(duplicateItem);
    expect(onDuplicate).toHaveBeenCalledWith('project-1');
  });
});

describe('recvqbh189zBY6 — single-card delete confirmation', () => {
  // commitDelete used to await onDelete and drop the result either way, so a
  // 403/network failure closed the confirm dialog exactly like a success —
  // the project stayed put with no signal anything had gone wrong.
  it('keeps the dialog open with a visible error when the delete request fails', async () => {
    const onDelete = vi.fn(async () => false);
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'My project' })]}
        onOpen={() => {}}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('project-1');
      expect(within(dialog).getByRole('alert')).toBeTruthy();
    });
    // The dialog is still open — nothing pretended the project was gone.
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('closes the dialog on a successful delete', async () => {
    const onDelete = vi.fn(async () => true);
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'My project' })]}
        onOpen={() => {}}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('project-1');
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('submits at most one delete while the request is pending', async () => {
    let resolveDelete!: (value: true) => void;
    const pendingDelete = new Promise<true>((resolve) => {
      resolveDelete = resolve;
    });
    const onDelete = vi.fn(() => pendingDelete);
    render(
      <RecentProjectsStrip
        projects={[project({ id: 'project-1', name: 'My project' })]}
        onOpen={() => {}}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    const deleteButton = within(dialog).getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(within(dialog).getByText(/My project/)).toBeTruthy();

    await act(async () => resolveDelete(true));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
