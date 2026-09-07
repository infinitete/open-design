import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeBrandProject } from '../../src/runtime/brands';

afterEach(() => vi.unstubAllGlobals());

describe('finalizeBrandProject mutation authority', () => {
  it('sends the original revision and signal through the coordinated finalize request', async () => {
    const controller = new AbortController();
    const mutationContext = {
      expectedProjectRevision: 6,
      generation: 2,
      signal: controller.signal,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      brand: { id: 'brand-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await finalizeBrandProject('brand-1', 'project-1', mutationContext);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('X-OD-Project-Revision')).toBe('6');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'project-1',
      expectedProjectRevision: 6,
    });
    expect(init.signal).toBe(controller.signal);
  });
});
