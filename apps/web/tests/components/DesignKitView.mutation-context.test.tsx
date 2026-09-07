// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignKit } from '../../src/runtime/design-kit';

const baseController = new AbortController();
const mutationContext = {
  expectedProjectRevision: 4,
  generation: 0,
  signal: baseController.signal,
};
const captureProjectMutation = vi.fn((_projectId: string) => mutationContext);
const isProjectMutationCurrent = vi.fn((_projectId: string, context: typeof mutationContext) => (
  !context.signal.aborted
));

vi.mock('../../src/i18n', () => ({
  useT: () => ((key: string) => key),
}));

vi.mock('../../src/state/project-git', () => ({
  captureProjectMutation: (...args: unknown[]) => captureProjectMutation(...args as [string]),
  isProjectMutationCurrent: (...args: unknown[]) => isProjectMutationCurrent(...args as [string, typeof mutationContext]),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return { ...actual, fetchProjectFileText: vi.fn(async () => null) };
});

import { DesignKitView } from '../../src/components/DesignKitView';

const kit: DesignKit = {
  name: 'Kit', projectId: 'project-kit', editable: true, canUpload: true,
  logoSrc: null, logoAlternates: [], colors: [], typography: {}, fonts: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DesignKitView project mutation capture', () => {
  it('captures before clipboard.read and passes the original context to upload', async () => {
    const read = deferred<ClipboardItem[]>();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read: vi.fn(() => read.promise) },
    });
    const onUploadModule = vi.fn();
    render(<DesignKitView kit={kit} onUploadModule={onUploadModule} />);

    fireEvent.click(within(screen.getByTestId('design-kit-logo-section'))
      .getByRole('button', { name: 'ds.pasteImage' }));

    expect(captureProjectMutation).toHaveBeenCalledWith('project-kit');
    read.resolve([{ types: ['image/png'], getType: vi.fn(async () => new Blob(['png'], { type: 'image/png' })) } as never]);
    await waitFor(() => expect(onUploadModule).toHaveBeenCalledOnce());
    expect(onUploadModule.mock.calls[0]?.[2]).toBe(mutationContext);
  });

  it('does not upload when the captured epoch is revoked during getType', async () => {
    const controller = new AbortController();
    const context = { ...mutationContext, signal: controller.signal };
    captureProjectMutation.mockReturnValueOnce(context);
    const blob = deferred<Blob>();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn(async () => [{ types: ['image/png'], getType: vi.fn(() => blob.promise) }]),
      },
    });
    const onUploadModule = vi.fn();
    render(<DesignKitView kit={kit} onUploadModule={onUploadModule} />);

    fireEvent.click(within(screen.getByTestId('design-kit-logo-section'))
      .getByRole('button', { name: 'ds.pasteImage' }));
    await waitFor(() => expect(captureProjectMutation).toHaveBeenCalledOnce());
    controller.abort();
    blob.resolve(new Blob(['png'], { type: 'image/png' }));

    await Promise.resolve();
    await Promise.resolve();
    expect(onUploadModule).not.toHaveBeenCalled();
  });
});
