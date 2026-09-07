// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAsset, ProjectGitState } from '@open-design/contracts';
import type { DesignSystemSummary } from '../../src/types';

vi.mock('../../src/components/plugins-home/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: false }),
}));

const asset: LibraryAsset = {
  id: 'asset-1', kind: 'image', storage: 'owned', capturedAt: 1_700_000_000_000,
  archivedDate: '2024-01-01', contentHash: 'hash-1', tags: [], sources: [],
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, sourceTitle: 'A photo',
};
const designSystems: DesignSystemSummary[] = Array.from({ length: 100 }, (_, index) => ({
  id: `ds-${index}`,
  title: `Brand system ${index}`,
  projectId: `project-${index}`,
  source: 'user',
  category: 'brand',
  summary: `Editable brand system ${index}`,
}));

vi.mock('../../src/providers/registry', () => ({
  fetchLibraryAssets: vi.fn(async () => [asset]),
  fetchLibraryAsset: vi.fn(async () => null),
  libraryAssetRawUrl: (id: string) => `/raw/${id}`,
  applyLibraryAsset: vi.fn(),
  deleteLibraryAsset: vi.fn(),
  editLibraryAssetAsPage: vi.fn(),
  fetchDesignSystem: vi.fn(),
  fetchDesignSystems: vi.fn(async () => designSystems),
  fetchLibraryAssetAsFile: vi.fn(),
}));

import { LibrarySection } from '../../src/components/LibrarySection';
import { useProjectGitAuthoritySet } from '../../src/providers/project-git';

const legalState: ProjectGitState = {
  enabled: true, phase: 'synced', localHead: 'a'.repeat(40), observedRemoteHead: null,
  confirmedRemoteHead: null, projectRevision: 7, contentRevision: 9,
  bindingGeneration: 2, dirty: false, pendingPush: false, autoSync: true,
  operationId: null, error: null,
  binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
  dependencies: [],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  static active = 0;
  static maxActive = 0;
  private closed = false;
  private readonly projectConnection: boolean;
  readonly close = vi.fn(() => {
    if (this.closed) return;
    this.closed = true;
    if (this.projectConnection) MockEventSource.active -= 1;
  });
  constructor(readonly url: string | URL) {
    this.projectConnection = String(url).includes('/api/projects/');
    MockEventSource.instances.push(this);
    if (this.projectConnection) {
      MockEventSource.active += 1;
      MockEventSource.maxActive = Math.max(MockEventSource.maxActive, MockEventSource.active);
    }
  }
  addEventListener() {}
}

function Harness() {
  const authority = useProjectGitAuthoritySet([]);
  return (
    <LibrarySection
      active
      onOpenProject={vi.fn()}
      projectMutationReady={authority.isReady}
    />
  );
}

function projectConnections() {
  return MockEventSource.instances.filter((source) => String(source.url).includes('/api/projects/'));
}

describe('LibrarySection operation-scoped project authority', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    MockEventSource.active = 0;
    MockEventSource.maxActive = 0;
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(legalState), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
  });

  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it('subscribes only the nominated target from a large design-system menu', async () => {
    render(<Harness />);
    await screen.findByText('A photo');
    fireEvent.click(screen.getByRole('button', { name: 'Select asset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use in design system' }));
    const first = (await screen.findByText('Brand system 0')).closest('button')!;
    const second = screen.getByText('Brand system 1').closest('button')!;

    expect(screen.getAllByRole('menuitem')).toHaveLength(101);
    expect(projectConnections()).toHaveLength(0);

    fireEvent.pointerEnter(first);
    await waitFor(() => expect(projectConnections()).toHaveLength(1));
    expect(String(projectConnections()[0]?.url)).toContain('/project-0/events');

    fireEvent.pointerEnter(second);
    await waitFor(() => expect(projectConnections()).toHaveLength(2));
    expect(projectConnections()[0]?.close).toHaveBeenCalledOnce();
    expect(String(projectConnections()[1]?.url)).toContain('/project-1/events');
    expect(MockEventSource.maxActive).toBeLessThanOrEqual(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(projectConnections()[1]?.close).toHaveBeenCalledOnce());
    expect(MockEventSource.active).toBe(0);
  });
});
