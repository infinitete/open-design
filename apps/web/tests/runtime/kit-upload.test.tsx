// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uploadProjectFile = vi.fn();
const fetchProjectFileText = vi.fn();
const writeProjectTextFile = vi.fn();

vi.mock('../../src/providers/registry', () => ({
  uploadProjectFile: (...args: unknown[]) => uploadProjectFile(...args),
  fetchProjectFileText: (...args: unknown[]) => fetchProjectFileText(...args),
  writeProjectTextFile: (...args: unknown[]) => writeProjectTextFile(...args),
}));

import { useKitModuleUpload } from '../../src/runtime/kit-upload';

afterEach(() => vi.clearAllMocks());

describe('useKitModuleUpload', () => {
  it('threads one upload through brand read/write and font manifest follow-ups', async () => {
    uploadProjectFile.mockResolvedValue({ name: 'fonts/Inter.woff2' });
    fetchProjectFileText.mockResolvedValueOnce('{}').mockResolvedValueOnce('{"files":[]}');
    writeProjectTextFile.mockResolvedValue({ name: 'saved' });
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useKitModuleUpload({ projectId: 'project-kit', onUploaded }));

    await act(async () => {
      await result.current.uploadModule('font', new File(['font'], 'Inter.woff2'));
    });

    expect(uploadProjectFile).toHaveBeenCalledWith(
      'project-kit', expect.any(File), 'fonts/Inter.woff2',
    );
    expect(fetchProjectFileText).toHaveBeenNthCalledWith(1, 'project-kit', 'brand.json', {
      cache: 'no-store',
    });
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(
      1, 'project-kit', 'brand.json', expect.any(String),
    );
    expect(fetchProjectFileText).toHaveBeenNthCalledWith(2, 'project-kit', 'fonts/manifest.json', {
      cache: 'no-store',
    });
    expect(writeProjectTextFile).toHaveBeenNthCalledWith(
      2, 'project-kit', 'fonts/manifest.json', expect.any(String),
    );
    expect(onUploaded).toHaveBeenCalledWith('font');
  });
});
