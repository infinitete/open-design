// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';
import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { resetThumbnailLoadGateForTests } from '../../src/lib/thumbnail-load-gate';
import type { Project } from '../../src/types';

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    fetchProjectFileText: vi.fn(async () => null),
    fetchProjectFiles: vi.fn(async () => []),
    invalidateProjectFilesCache: vi.fn(),
  };
});

vi.mock('@open-design/host', () => ({
  isOpenDesignHostAvailable: () => false,
  pickAndImportHostProject: vi.fn(),
  pickHostWorkingDir: vi.fn(),
}));

const pickLocalFolderPath = vi.fn();
vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return {
    ...actual,
    pickLocalFolderPath: (...args: unknown[]) => pickLocalFolderPath(...args),
  };
});

vi.mock('../../src/utils/pickAndImportError', () => ({
  formatPickAndImportFailure: (r: unknown) => ({ message: 'import failed', details: String(r) }),
}));

afterEach(() => {
  cleanup();
  resetThumbnailLoadGateForTests();
  vi.clearAllMocks();
  pickLocalFolderPath.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
    status: { value: 'not_started' },
    ...overrides,
  } as Project;
}

describe('RecentProjectsStrip first-level folder import', () => {
  it('shows the header import button when onImportFolder is provided', () => {
    render(
      <RecentProjectsStrip
        projects={[project()]}
        limit={1000}
        onOpen={vi.fn()}
        heading="Recent"
        onImportFolder={vi.fn()}
      />,
    );
    expect(screen.getByTestId('home-import-folder')).toBeTruthy();
  });

  it('hides the header import button without import callbacks', () => {
    render(
      <RecentProjectsStrip
        projects={[project()]}
        limit={1000}
        onOpen={vi.fn()}
        heading="Recent"
      />,
    );
    expect(screen.queryByTestId('home-import-folder')).toBeNull();
  });

  it('routes the picked folder through onImportFolder', async () => {
    pickLocalFolderPath.mockResolvedValue('/tmp/demo');
    const onImportFolder = vi.fn(async () => {});
    render(
      <RecentProjectsStrip
        projects={[project()]}
        limit={1000}
        onOpen={vi.fn()}
        heading="Recent"
        onImportFolder={onImportFolder}
      />,
    );

    fireEvent.click(screen.getByTestId('home-import-folder'));

    await waitFor(() => {
      expect(onImportFolder).toHaveBeenCalledWith('/tmp/demo');
    });
  });
});

function stubHomeFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (typeof url === 'string' && url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }));
}

function renderHome(projects: Project[], onImportFolder?: (dir: string) => Promise<void> | void) {
  return render(
    <I18nProvider initial="en">
      <HomeView
        projects={projects as never}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
        {...(onImportFolder ? { onImportFolder } : {})}
      />
    </I18nProvider>,
  );
}

describe('HomeView empty-state folder import', () => {
  it('shows the empty-state import row when there are no projects', async () => {
    stubHomeFetch();
    renderHome([], vi.fn());

    expect(await screen.findByTestId('home-empty-import-folder')).toBeTruthy();
    expect(screen.queryByTestId('home-import-folder')).toBeNull();
  });

  it('hides the empty-state import row without import callbacks', async () => {
    stubHomeFetch();
    renderHome([]);

    await screen.findByTestId('home-hero-input');
    expect(screen.queryByTestId('home-empty-import-folder')).toBeNull();
    expect(screen.queryByTestId('home-import-folder')).toBeNull();
  });

  it('shows the strip header import button when there are projects', async () => {
    stubHomeFetch();
    renderHome([project()], vi.fn());

    expect(await screen.findByTestId('home-import-folder')).toBeTruthy();
    expect(screen.queryByTestId('home-empty-import-folder')).toBeNull();
  });
});
