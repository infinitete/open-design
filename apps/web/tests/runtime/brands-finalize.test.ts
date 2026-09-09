import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeBrandProject } from '../../src/runtime/brands';

afterEach(() => vi.unstubAllGlobals());

describe('finalizeBrandProject request', () => {
  it('sends the project id through the finalize request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      brand: { id: 'brand-1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await finalizeBrandProject('brand-1', 'project-1');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'project-1',
    });
  });
});
