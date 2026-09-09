import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';
import { createRunLifecycleTracer } from '../src/run-lifecycle-tracer.js';

import {
  type Conversation,
  type RunTiming,
  type StartedServer,
  TEST_BUDGET_MS,
  clearTelemetryEnv,
  createChatProject,
  createOdNextDesignProject,
  expectVisibleOutputNotBeforeFirstToken,
  putConfig,
  restoreEnv,
  sendRunAndWait,
  snapshotEnv,
  readLocalLifecycleRun,
  writeFakeOpencode,
} from './first-visible-output-harness.js';

vi.mock('../src/run-lifecycle-tracer.js', { spy: true });

// Exercise real decode/filter/emission call sites and read their local clocks.
// The pass-through spy preserves the tracer implementation and only exposes its
// run argument; no sink, synthetic timestamps, or test-only product API is used.
describe('first_visible_output is stamped at emission, not at first token', () => {
  const originalEnv = snapshotEnv();
  let started: StartedServer | null = null;
  let binDir: string | null = null;

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    vi.mocked(createRunLifecycleTracer).mockClear();
    if (binDir) await rm(binDir, { force: true, recursive: true });
    binDir = null;
    restoreEnv(originalEnv);
  });

  it('reports a real gap when the safety guard withholds the first bytes', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-fvo-withheld-'));
    // The model opens a markdown heading whose keyword lands exactly on a
    // chunk boundary. The role-marker guard cannot classify `## user` until it
    // sees the next character, so it withholds the whole chunk. The daemon has
    // its first token; the user still has nothing on screen.
    const bin = await writeFakeOpencode(binDir, 'opencode-withheld', `
  emit({ type: 'text', part: { type: 'text', text: '## user' } });
  setTimeout(() => {
    emit({ type: 'text', part: { type: 'text', text: 'names are listed below.' } });
    finishTurn();
  }, ${WITHHOLD_MS});`);

    const timing = await runOnceAndReadTiming({
      bin,
      label: 'guard-withheld',
      strategyRollout: 'off',
    });

    expectVisibleOutputNotBeforeFirstToken(timing);
    const gap =
      timing.firstVisibleOutputAt! - timing.firstTokenAt!;
    // The withheld window is the whole point of the metric. Allow generous
    // slack under load; the pre-fix value is exactly 0.
    expect(gap).toBeGreaterThanOrEqual(WITHHOLD_MS - 100);
  }, TEST_BUDGET_MS);

  it('does not manufacture a gap when the first token is emitted straight through', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-fvo-direct-'));
    const bin = await writeFakeOpencode(binDir, 'opencode-direct', `
  emit({ type: 'text', part: { type: 'text', text: 'Here is your answer.' } });
  finishTurn();`);

    const timing = await runOnceAndReadTiming({
      bin,
      label: 'direct-text',
      strategyRollout: 'off',
    });

    // Never negative: the daemon cannot show bytes before it has the token they
    // are made of. This held only by accident while both marks shared one
    // timestamp; now that they are stamped independently it is enforced by
    // reading the decode clock BEFORE the emit at every text_delta site.
    expectVisibleOutputNotBeforeFirstToken(timing);
    const gap =
      timing.firstVisibleOutputAt! - timing.firstTokenAt!;
    // And no manufactured gap. The residue is the daemon's own SSE fan-out for
    // one delta — sub-millisecond when idle, a few ms on a loaded box — which is
    // an order of magnitude below the withheld window the metric reports.
    expect(gap).toBeLessThan(100);
  }, TEST_BUDGET_MS);

  it('leaves the visible-output mark unset when no bytes are emitted', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-fvo-never-'));
    // The guard withholds `## user` and the CLI exits before the next chunk
    // could release it, so nothing visible ever reaches the client. There is
    // no visible-output measurement to record locally.
    const bin = await writeFakeOpencode(binDir, 'opencode-never', `
  emit({ type: 'text', part: { type: 'text', text: '## user' } });
  finishTurn();`);

    const timing = await runOnceAndReadTiming({
      bin,
      label: 'never-visible',
      strategyRollout: 'off',
    });

    expect(timing.firstTokenAt).toBeTypeOf('number');
    expect(timing.firstVisibleOutputAt).toBeUndefined();
  }, TEST_BUDGET_MS);

  // The OD Next machine protocol is a THIRD thing that can withhold visible
  // bytes, and unlike the other two it can hold them past the end of the
  // stream: text that might still turn out to be a reserved `<open-design-…>`
  // block is only released when `finish()` proves it was prose, at child
  // close. That release does not go through the daemon's ordinary emission
  // choke point — it persists and broadcasts the tail directly — so the mark
  // has to be applied there too. Without it the run reports no visible output
  // at all in local diagnostics despite a real close-time release.
  it('reports the close-time wait when the strategy releases the reply at finish', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-fvo-strategy-'));
    // Every visible byte of this reply is withheld until close. The machine
    // block is suppressed by design (it is protocol, not prose) and the only
    // remaining text is `<o` — a prefix of a reserved opening tag, which the
    // protocol must hold because the next chunk could complete
    // `<open-design-plan-contract`. The next chunk never comes, so `finish()`
    // is what finally rules it out and releases it.
    const bin = await writeFakeOpencode(binDir, 'opencode-strategy-tail', `
  emit({ type: 'text', part: { type: 'text', text: [
    '<open-design-runtime-state>',
    '{"schemaVersion":2}',
    '</open-design-runtime-state>',
  ].join('\\n') + '<o' } });
  setTimeout(finishTurn, ${WITHHOLD_MS});`);

    const timing = await runOnceAndReadTiming({
      bin,
      label: 'strategy-tail',
      strategyRollout: 'active',
    });

    expectVisibleOutputNotBeforeFirstToken(timing);
    const gap =
      timing.firstVisibleOutputAt! - timing.firstTokenAt!;
    expect(gap).toBeGreaterThanOrEqual(WITHHOLD_MS - 100);
  }, TEST_BUDGET_MS);

  async function runOnceAndReadTiming(options: {
    bin: string;
    label: string;
    /**
     * Required, never inherited. `off` exercises the daemon's generic emission
     * choke point; `active` additionally puts the OD Next machine protocol in
     * front of it, which is the only way the close-time release path exists at
     * all.
     */
    strategyRollout: 'off' | 'active';
  }): Promise<RunTiming> {
    clearTelemetryEnv();
    process.env.OD_NEXT_STRATEGY_ROLLOUT = options.strategyRollout;
    if (options.strategyRollout === 'active') {
      // Local-only escape hatch for the runtime-capability fixture gate, which
      // a fake CLI cannot satisfy. It does not weaken anything this case
      // asserts: admission still has to resolve a real bundled strategy
      // package, task type and agent, which is what the `strategyTask`
      // assertion below checks.
      process.env.OD_NEXT_STRATEGY_LOCAL_SYNTHETIC_CANARY = '1';
    }

    started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    await putConfig(started.url, {
      agentId: 'opencode',
      agentCliEnv: { opencode: { OPENCODE_BIN: options.bin } },
    });

    const conversation: Conversation = options.strategyRollout === 'active'
      ? await createOdNextDesignProject(started.url, options.label)
      : await createChatProject(started.url, options.label);
    const { created, run } = await sendRunAndWait(
      started.url,
      conversation,
      `render ${options.label}`,
    );
    // Prove the mode the case claims to be in. Without this the strategy case
    // could quietly degrade into an ordinary run — admission has many gates —
    // and keep passing for the wrong reason.
    if (options.strategyRollout === 'active') {
      expect(created.pluginId).toBe('od-next-strategy');
      expect(created.strategyTask).toBeDefined();
    } else {
      expect(created.strategyTask).toBeUndefined();
    }
    expect(run.status).toBe('succeeded');
    const localRun = readLocalLifecycleRun(run.id, vi.mocked(createRunLifecycleTracer).mock.calls);
    expect(localRun.analyticsTelemetry).toBeDefined();
    return localRun.analyticsTelemetry!;
  }
});

const WITHHOLD_MS = 400;
