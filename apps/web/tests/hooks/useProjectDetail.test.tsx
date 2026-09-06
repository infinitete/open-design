// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Project } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectDetail } from '../../src/hooks/useProjectDetail';

function project(name: string, updatedAt: number): Project {
  return {
    id: 'project',
    name,
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useProjectDetail', () => {
  it('does not let an older overlapping response overwrite the latest refresh', async () => {
    const responses: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      responses.push(resolve);
    })));
    const { result } = renderHook(() => useProjectDetail('project'));
    await waitFor(() => expect(responses).toHaveLength(1));

    let latestRefresh!: Promise<void>;
    act(() => {
      latestRefresh = result.current.refresh();
    });
    await waitFor(() => expect(responses).toHaveLength(2));
    await act(async () => {
      responses[1]!(new Response(JSON.stringify({
        project: project('latest', 3),
        resolvedDir: '/latest',
      }), { status: 200 }));
      await latestRefresh;
    });
    expect(result.current.project?.name).toBe('latest');

    await act(async () => {
      responses[0]!(new Response(JSON.stringify({
        project: project('stale', 2),
        resolvedDir: '/stale',
      }), { status: 200 }));
      await Promise.resolve();
    });
    expect(result.current.project?.name).toBe('latest');
    expect(result.current.resolvedDir).toBe('/latest');
  });

  it('rejects an authoritative refresh so reconciliation cannot unlock on failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        project: project('initial', 1),
        resolvedDir: '/initial',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })));
    const { result } = renderHook(() => useProjectDetail('project'));
    await waitFor(() => expect(result.current.project?.name).toBe('initial'));

    await expect(result.current.refresh({ throwOnError: true })).rejects.toThrow(
      'GET /api/projects/project → HTTP 503',
    );
    await waitFor(() => expect(result.current.error?.message).toContain('HTTP 503'));
  });
});
