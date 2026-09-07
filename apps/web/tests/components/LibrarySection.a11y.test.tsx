// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAsset } from '@open-design/contracts';
import type { DesignSystemSummary } from '../../src/types';

vi.mock('../../src/components/plugins-home/useInView', () => ({
  useInView: () => ({ ref: { current: null }, inView: false }),
}));

const fetchLibraryAssets = vi.fn(async (): Promise<LibraryAsset[]> => []);
const fetchLibraryAsset = vi.fn(async (): Promise<LibraryAsset | null> => null);
const fetchDesignSystems = vi.fn<() => Promise<DesignSystemSummary[]>>(async () => []);
const applyLibraryAsset = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('../../src/providers/registry', () => ({
  fetchLibraryAssets: (...args: unknown[]) => fetchLibraryAssets(...(args as [])),
  fetchLibraryAsset: (...args: unknown[]) => fetchLibraryAsset(...(args as [])),
  libraryAssetRawUrl: (id: string) => `/raw/${id}`,
  applyLibraryAsset: (...args: unknown[]) => applyLibraryAsset(...args),
  deleteLibraryAsset: vi.fn(),
  editLibraryAssetAsPage: vi.fn(),
  fetchDesignSystem: vi.fn(),
  fetchDesignSystems: () => fetchDesignSystems(),
  fetchLibraryAssetAsFile: vi.fn(),
}));

const mutationContext = { projectId: 'project-1', revision: 'rev-1', signal: new AbortController().signal };
let mutationCurrent = true;
vi.mock('../../src/state/project-git', () => ({
  captureProjectMutation: vi.fn(() => mutationContext),
  isProjectMutationCurrent: vi.fn(() => mutationCurrent),
}));

import { LibrarySection } from '../../src/components/LibrarySection';

function makeAsset(over: Partial<LibraryAsset> = {}): LibraryAsset {
  const now = 1_700_000_000_000;
  return {
    id: over.id ?? 'asset-1',
    kind: 'image',
    storage: 'owned',
    capturedAt: now,
    archivedDate: '2024-01-01',
    contentHash: `hash-${over.id ?? 'asset-1'}`,
    tags: [],
    sources: [],
    createdAt: now,
    updatedAt: now,
    sourceTitle: 'A photo',
    ...over,
  };
}

describe('LibrarySection accessibility', () => {
  beforeEach(() => {
    fetchLibraryAssets.mockReset().mockResolvedValue([makeAsset()]);
    fetchLibraryAsset.mockReset().mockResolvedValue(null);
    fetchDesignSystems.mockReset().mockResolvedValue([{
      id: 'ds-1', title: 'Brand system', projectId: 'project-1', source: 'user',
      category: 'brand', summary: 'Editable brand system',
    }]);
    applyLibraryAsset.mockReset().mockResolvedValue({ relPath: 'library/reference.png' });
    mutationCurrent = true;
    (globalThis as { EventSource?: unknown }).EventSource = class {
      addEventListener() {}
      close() {}
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('gives the library filter selects accessible names', async () => {
    render(<LibrarySection active onOpenProject={() => {}} />);

    await screen.findByText('A photo');

    expect(screen.getByRole('combobox', { name: 'Filter by kind' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter by source' })).toBeTruthy();
  });

  it('keeps Home library apply disabled until project authority is ready', async () => {
    render(<LibrarySection active onOpenProject={vi.fn()} projectMutationReady={() => false} />);

    await screen.findByText('A photo');
    fireEvent.click(screen.getByRole('button', { name: 'Select asset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use in design system' }));

    const refine = await screen.findByRole('menuitem', { name: /Brand system/ });
    expect((refine as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(refine);
    expect(applyLibraryAsset).not.toHaveBeenCalled();
  });

  it('does not navigate from a Home library apply that loses its epoch', async () => {
    let resolveApply!: (value: { relPath: string }) => void;
    applyLibraryAsset.mockImplementation(() => new Promise((resolve) => {
      resolveApply = resolve;
    }));
    const onOpenProject = vi.fn();
    render(<LibrarySection active onOpenProject={onOpenProject} projectMutationReady={() => true} />);

    await screen.findByText('A photo');
    fireEvent.click(screen.getByRole('button', { name: 'Select asset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use in design system' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Brand system/ }));
    expect(applyLibraryAsset).toHaveBeenCalledWith(
      'asset-1',
      'project-1',
      undefined,
      expect.objectContaining({ mutationContext }),
    );

    mutationCurrent = false;
    await act(async () => resolveApply({ relPath: 'library/reference.png' }));

    expect(onOpenProject).not.toHaveBeenCalled();
  });
});
