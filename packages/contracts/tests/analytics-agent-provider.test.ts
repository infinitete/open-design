import { describe, expect, it } from 'vitest';

import {
  agentIdToTracking,
  deriveConfigureGlobals,
  feedbackAgentProviderIdToTracking,
} from '../src/analytics/events.js';

describe('agentIdToTracking', () => {
  it('folds the retired hosted runtime id into the other bucket', () => {
    // The hosted AMR runtime (the vela CLI) is gone. A persisted agent id of
    // `amr` may still surface in historical rows, but the mapping must not
    // resurrect a dedicated provider id for it: it resolves to `other` like
    // any other unmapped id.
    expect(agentIdToTracking('amr')).toBe('other');
  });

  it('keeps mapping known CLI agents and falls back to other for unknowns', () => {
    expect(agentIdToTracking('claude')).toBe('claude_code');
    expect(agentIdToTracking('codex')).toBe('codex_cli');
    expect(agentIdToTracking('opencode')).toBe('opencode');
    expect(agentIdToTracking('totally-unknown-agent')).toBe('other');
    expect(agentIdToTracking(null)).toBe('other');
    expect(agentIdToTracking(undefined)).toBe('other');
  });

  it('folds retired hosted-runtime feedback into the other bucket too', () => {
    // feedbackAgentProviderIdToTracking falls through to agentIdToTracking
    // for non-BYOK agents, so a historical `amr` feedback id is `other`.
    expect(feedbackAgentProviderIdToTracking('amr')).toBe('other');
  });
});

describe('deriveConfigureGlobals', () => {
  it('never reports the retired hosted runtime', () => {
    // Even with a stale `amr` agent row or a remembered `amr` agent id in
    // the config, the configure globals must only describe the supported
    // local-CLI / BYOK runtimes.
    const globals = deriveConfigureGlobals({
      mode: 'daemon',
      agentId: 'amr',
      agents: [
        { id: 'amr', available: true },
        { id: 'claude', available: true },
      ],
    });
    expect(globals.runtime_type).not.toBe('amr_cloud');
    expect(globals.configure_type).not.toBe('amr');
    expect(globals).not.toHaveProperty('amr_runnable');
    expect(globals.cli_runnable).toBe(true);
    expect(globals.byok_runnable).toBe(false);
  });

  it('keeps deriving local CLI and BYOK states for supported setups', () => {
    expect(
      deriveConfigureGlobals({
        mode: 'daemon',
        agentId: 'claude',
        agents: [{ id: 'claude', available: true }],
      }),
    ).toMatchObject({
      has_available_configure_cli: true,
      configure_type: 'local_cli',
      configure_availability: 'available',
      runtime_type: 'local_cli',
      cli_runnable: true,
      byok_runnable: false,
    });
    expect(
      deriveConfigureGlobals({
        mode: 'api',
        byokConfigured: true,
        agents: [],
      }),
    ).toMatchObject({
      configure_type: 'byok',
      runtime_type: 'byok',
      cli_runnable: false,
      byok_runnable: true,
    });
  });
});
