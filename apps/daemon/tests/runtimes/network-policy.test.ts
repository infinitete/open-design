import { describe, expect, it } from 'vitest';
import { PROXY_ENV_KEYS } from '@open-design/platform';

import { applyAgentNetworkPolicy } from '../../src/runtimes/network-policy.js';

describe('applyAgentNetworkPolicy', () => {
  it.each([
    ['http://proxy.test:8080', 'HTTP_PROXY', 'http://proxy.test:8080'],
    ['https://proxy.test:8443', 'HTTPS_PROXY', 'https://proxy.test:8443'],
    ['socks5://proxy.test:1080', 'ALL_PROXY', 'socks5://proxy.test:1080'],
  ] as const)('maps custom proxy %s to %s', (proxyUrl, key, value) => {
    const env = applyAgentNetworkPolicy(
      {
        HTTP_PROXY: 'http://inherited.test:80',
        HTTPS_PROXY: 'http://inherited.test:443',
        NO_PROXY: '.old.test',
        KEEP_ME: 'yes',
      },
      { mode: 'custom', proxyUrl, noProxy: '.corp.test' },
      'linux',
    );

    expect(env[key]).toBe(value);
    expect(env.NO_PROXY).toBe('.corp.test,localhost,127.0.0.1,[::1]');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.KEEP_ME).toBe('yes');
  });

  it('makes direct mode remove every proxy spelling', () => {
    const env = applyAgentNetworkPolicy(
      {
        http_proxy: 'http://lower.test:80',
        HTTPS_PROXY: 'http://upper.test:443',
        all_proxy: 'socks5://old.test:1080',
        No_Proxy: '.old.test',
        NODE_USE_ENV_PROXY: '1',
        KEEP_ME: 'yes',
      },
      { mode: 'direct' },
      'linux',
    );
    const proxyKeys = new Set<string>(PROXY_ENV_KEYS);

    expect(Object.keys(env).filter((key) => proxyKeys.has(key.toUpperCase()))).toEqual([]);
    expect(env.KEEP_ME).toBe('yes');
  });

  it('encodes proxy credentials only in the returned child environment', () => {
    const policy = {
      mode: 'custom' as const,
      proxyUrl: 'http://proxy.test:8080',
      username: 'a user',
      password: 'p@ss:/word',
    };
    const env = applyAgentNetworkPolicy({}, policy, 'linux');

    expect(env.HTTP_PROXY).toBe('http://a%20user:p%40ss%3A%2Fword@proxy.test:8080/');
    expect(policy.proxyUrl).toBe('http://proxy.test:8080');
  });
});
