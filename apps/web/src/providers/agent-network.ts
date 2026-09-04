import type {
  AgentNetworkPrefs,
  AgentNetworkUpdatePrefs,
  AppConfigResponse,
} from '@open-design/contracts';

export async function saveAgentNetworkPrefs(
  agentNetwork: AgentNetworkUpdatePrefs,
): Promise<AgentNetworkPrefs> {
  const response = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentNetwork }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { message?: string } | string;
    } | null;
    const message = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message;
    throw new Error(message || `Proxy settings save failed (${response.status})`);
  }
  const payload = await response.json() as AppConfigResponse;
  return payload.config.agentNetwork ?? {};
}
