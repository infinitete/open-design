import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchConnectorStatuses,
  fetchLiveArtifacts,
  fetchPreviewComments,
} from '../../src/providers/registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authoritative reconciliation reads', () => {
  it('evicts an older coalesced live-artifact read when a fresh read is requested', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        liveArtifacts: [{ id: 'current-artifact', title: 'Current' }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const stale = fetchLiveArtifacts('fresh-project');
    await expect(fetchLiveArtifacts('fresh-project', { fresh: true })).resolves.toEqual([
      expect.objectContaining({ id: 'current-artifact' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveOld(new Response(JSON.stringify({
      liveArtifacts: [{ id: 'stale-artifact', title: 'Stale' }],
    }), { status: 200 }));
    await expect(stale).resolves.toEqual([expect.objectContaining({ id: 'stale-artifact' })]);
  });

  it('rejects connector status HTTP failures when the reconciliation barrier opts in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchConnectorStatuses({ requireAuthoritative: true })).rejects.toThrow(
      'Connector status request failed (503)',
    );
  });

  it('rejects live artifact HTTP failures when the reconciliation barrier opts in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchLiveArtifacts('authoritative-project', {
      requireAuthoritative: true,
    })).rejects.toThrow('Live artifacts request failed (503)');
  });

  it('rejects preview comment HTTP failures when the reconciliation barrier opts in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchPreviewComments('project', 'conversation', {
      requireAuthoritative: true,
    })).rejects.toThrow('Preview comments request failed (503)');
  });

  it('preserves the historical empty fallbacks for non-authoritative readers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(fetchConnectorStatuses()).resolves.toEqual({});
    await expect(fetchLiveArtifacts('fallback-project')).resolves.toEqual([]);
  });
});
