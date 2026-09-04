import {
  mergeNoProxyWithLoopbackDefaults,
  mergeProxyAwareEnv,
  withoutProxyEnv,
} from '@open-design/platform';

import type { StoredAgentNetworkPolicy } from '../storage/agent-network-config.js';

export function applyAgentNetworkPolicy(
  env: NodeJS.ProcessEnv,
  policy: StoredAgentNetworkPolicy | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!policy) return { ...env };

  const direct = withoutProxyEnv(env);
  if (policy.mode === 'direct') return direct;

  const url = new URL(policy.proxyUrl);
  if (policy.username) url.username = policy.username;
  if (policy.password) url.password = policy.password;
  const authenticatedProxy = policy.username || policy.password
    ? url.toString()
    : policy.proxyUrl;
  const proxyEnv: NodeJS.ProcessEnv = {
    NO_PROXY: mergeNoProxyWithLoopbackDefaults(policy.noProxy),
    NODE_USE_ENV_PROXY: '1',
  };
  if (url.protocol === 'socks5:') {
    proxyEnv.ALL_PROXY = authenticatedProxy;
  } else {
    proxyEnv.HTTP_PROXY = authenticatedProxy;
    proxyEnv.HTTPS_PROXY = authenticatedProxy;
  }
  return mergeProxyAwareEnv(platform, direct, proxyEnv);
}
