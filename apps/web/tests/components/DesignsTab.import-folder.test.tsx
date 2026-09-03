// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesignsTab } from '../../src/components/DesignsTab';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (k: string) => k }),
  useT: () => (k: string) => k,
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
}));

vi.mock('../../src/analytics/events', () => ({
  trackPageView: vi.fn(),
  trackProjectsListClick: vi.fn(),
  trackProjectsListControlsClick: vi.fn(),
  trackProjectsMorePopoverClick: vi.fn(),
}));

vi.mock('../../src/providers/registry', () => ({
  deleteLiveArtifact: vi.fn(),
  fetchLiveArtifacts: vi.fn(async () => []),
  fetchProjectFiles: vi.fn(async () => []),
  liveArtifactPreviewUrl: vi.fn(() => ''),
}));

vi.mock('../../src/lib/project-cover-cache', () => ({
  getProjectCoverSnapshot: vi.fn(() => undefined),
  projectCoverSnapshotKey: vi.fn(() => ''),
  setProjectCoverSnapshot: vi.fn(),
}));

vi.mock('../../src/components/design-system-project', () => ({
  isDesignSystemProject: () => false,
  isPublishedDesignSystemProject: () => false,
  resolveProjectDesignSystemId: () => null,
}));

vi.mock('../../src/components/project-cover', () => ({
  HtmlProjectCoverFrame: () => null,
  coverFromProjectFile: vi.fn(),
  projectCoverUrl: vi.fn(() => ''),
  selectProjectFileCover: vi.fn(() => null),
}));

vi.mock('../../src/components/LiveArtifactBadges', () => ({
  LiveArtifactBadges: () => null,
}));

vi.mock('@open-design/host', () => ({
  isOpenDesignHostAvailable: () => false,
  pickAndImportHostProject: vi.fn(),
}));

const pickLocalFolderPath = vi.fn();
vi.mock('../../src/state/projects', () => ({
  pickLocalFolderPath: (...args: unknown[]) => pickLocalFolderPath(...args),
}));

vi.mock('../../src/utils/pickAndImportError', () => ({
  formatPickAndImportFailure: (r: unknown) => ({ message: 'import failed', details: String(r) }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pickLocalFolderPath.mockReset();
});

function project(id: string) {
  return {
    id,
    name: `project ${id}`,
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
  } as never;
}

function baseProps() {
  return {
    projects: [project('p1')],
    skills: [],
    designSystems: [],
    onOpen: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDelete: vi.fn(),
  } as unknown as React.ComponentProps<typeof DesignsTab>;
}

describe('DesignsTab first-level folder import', () => {
  it('shows the toolbar import button when onImportFolder is provided', () => {
    render(<DesignsTab {...baseProps()} onImportFolder={vi.fn()} />);
    expect(screen.getByTestId('designs-import-folder')).toBeTruthy();
  });

  it('hides the toolbar import button without import callbacks', () => {
    render(<DesignsTab {...baseProps()} />);
    expect(screen.queryByTestId('designs-import-folder')).toBeNull();
    expect(screen.queryByTestId('designs-empty-import-folder')).toBeNull();
  });

  it('shows the empty-state import button when there are no projects', () => {
    render(
      <DesignsTab
        {...baseProps()}
        projects={[]}
        onImportFolder={vi.fn()}
      />,
    );
    expect(screen.getByTestId('designs-empty-import-folder')).toBeTruthy();
    expect(screen.queryByTestId('designs-import-folder')).toBeNull();
  });

  it('routes the picked folder through onImportFolder', async () => {
    pickLocalFolderPath.mockResolvedValue('/tmp/demo');
    const onImportFolder = vi.fn(async () => {});
    render(<DesignsTab {...baseProps()} onImportFolder={onImportFolder} />);

    fireEvent.click(screen.getByTestId('designs-import-folder'));

    await waitFor(() => {
      expect(onImportFolder).toHaveBeenCalledWith('/tmp/demo');
    });
  });
});
