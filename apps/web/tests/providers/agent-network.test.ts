import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveAgentNetworkPrefs } from '../../src/providers/agent-network';

const originalFetch = globalThis.fetch;

describe('saveAgentNetworkPrefs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', originalFetch);
  });

  it('writes only agentNetwork and returns the daemon public view', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      config: {
        agentNetwork: {
          codex: {
            mode: 'custom',
            proxyUrl: 'http://proxy.test:8080',
            username: 'alice',
            passwordConfigured: true,
          },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveAgentNetworkPrefs({
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.test:8080',
        username: 'alice',
        password: 'write-only-password',
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      agentNetwork: {
        codex: {
          mode: 'custom',
          proxyUrl: 'http://proxy.test:8080',
          username: 'alice',
          password: 'write-only-password',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('write-only-password');
  });

  it('surfaces the daemon error message when the proxy save is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Proxy URL is invalid' },
    }), { status: 422, headers: { 'content-type': 'application/json' } })));

    await expect(saveAgentNetworkPrefs({})).rejects.toThrow('Proxy URL is invalid');
  });
});
