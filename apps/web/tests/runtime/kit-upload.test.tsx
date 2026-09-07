// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uploadProjectFile = vi.fn();
const fetchProjectFileText = vi.fn();
const writeProjectTextFile = vi.fn();

vi.mock('../../src/providers/registry', () => ({
  uploadProjectFile: (...args: unknown[]) => uploadProjectFile(...args),
  fetchProjectFileText: (...args: unknown[]) => fetchProjectFileText(...args),
  writeProjectTextFile: (...args: unknown[]) => writeProjectTextFile(...args),
}));

vi.mock('../../src/state/project-git', () => ({
  isProjectMutationCurrent: (_projectId: string, context: { signal: AbortSignal }) => (
    !context.signal.aborted
  ),
}));

import { useKitModuleUpload } from '../../src/runtime/kit-upload';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => vi.clearAllMocks());

describe('useKitModuleUpload epoch authority', () => {
  it('does not start a project upload without an authoritative mutation context', async () => {
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useKitModuleUpload({ projectId: 'project-kit', onUploaded }));

    await act(async () => {
      await result.current.uploadModule('logo', new File(['logo'], 'logo.png'));
    });

    expect(uploadProjectFile).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('clears busy but emits no stale result when authority is revoked during upload', async () => {
    const upload = deferred<{ name: string } | null>();
    uploadProjectFile.mockReturnValue(upload.promise);
    const controller = new AbortController();
    const mutationContext = { expectedProjectRevision: 8, generation: 1, signal: controller.signal };
    const onUploaded = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useKitModuleUpload({ projectId: 'project-kit', onUploaded, onError }));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.uploadModule('logo', new File(['logo'], 'logo.png'), mutationContext);
    });
    expect(result.current.uploading).toBe('logo');
    controller.abort();
    upload.resolve({ name: 'logos/logo.png' });
    await act(async () => pending);

    expect(fetchProjectFileText).not.toHaveBeenCalled();
    expect(writeProjectTextFile).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.uploading).toBeNull());
  });

  it('threads one context through upload, brand read/write and font manifest follow-ups', async () => {
    uploadProjectFile.mockResolvedValue({ name: 'fonts/Inter.woff2' });
    fetchProjectFileText.mockResolvedValueOnce('{}').mockResolvedValueOnce('{"files":[]}');
    writeProjectTextFile.mockResolvedValue({ name: 'saved' });
    const controller = new AbortController();
    const mutationContext = { expectedProjectRevision: 9, generation: 2, signal: controller.signal };
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useKitModuleUpload({ projectId: 'project-kit', onUploaded }));

    await act(async () => {
      await result.current.uploadModule('font', new File(['font'], 'Inter.woff2'), mutationContext);
    });

    expect(uploadProjectFile).toHaveBeenCalledWith(
      'project-kit', expect.any(File), 'fonts/Inter.woff2', mutationContext,
    );
    expect(fetchProjectFileText).toHaveBeenNthCalledWith(1, 'project-kit', 'brand.json', {
      cache: 'no-store', signal: mutationContext.signal,
    });
    expect(writeProjectTextFile.mock.calls[0]?.[3]).toEqual({ mutationContext });
    expect(fetchProjectFileText).toHaveBeenNthCalledWith(2, 'project-kit', 'fonts/manifest.json', {
      cache: 'no-store', signal: mutationContext.signal,
    });
    expect(writeProjectTextFile.mock.calls[1]?.[3]).toEqual({ mutationContext });
    expect(onUploaded).toHaveBeenCalledWith('font', mutationContext);
  });
});
