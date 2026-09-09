import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';
import { classifyRunFailure } from '../../src/run-failure-classification.js';
import { deriveRunErrorCode, runResultFromStatus } from '../../src/run-result.js';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

type RunStatus = {
  id: string;
  projectId: string;
  conversationId: string;
  assistantMessageId: string;
  agentId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  errorCode: string | null;
  /** The daemon's own settled verdict, published on the terminal run status. */
  failureCategory: string | null;
  failureDetail: string | null;
  eventsLogPath: string;
};

type RunEvent = {
  event: string;
  data: unknown;
};

describe('run failure classification smoke', () => {
  const originalEnv = snapshotEnv();
  let started: StartedServer | null = null;
  let binDir: string | null = null;
  let dataDirs: string[] = [];

  afterEach(async () => {
    await stopDaemon();
    if (binDir) await rm(binDir, { recursive: true, force: true });
    binDir = null;
    for (const root of dataDirs) await removeDataDir(root);
    dataDirs = [];
    restoreEnv(originalEnv);
    vi.resetModules();
  });

  async function stopDaemon(): Promise<void> {
    const current = started;
    started = null;
    if (!current) return;
    await Promise.resolve(current.shutdown?.());
    current.server.closeAllConnections?.();
    current.server.closeIdleConnections?.();
    await new Promise<void>((resolve) => current.server.close(() => resolve()));
  }

  // A fresh module import resolves the per-case OD_DATA_DIR, keeping rollout
  // state and durable logs isolated from previous failures.
  async function startIsolatedServer(): Promise<StartedServer> {
    await stopDaemon();
    vi.resetModules();
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-run-failure-smoke-data-'));
    dataDirs.push(root);
    process.env.OD_DATA_DIR = root;
    const serverModule = await import('../../src/server.js') as unknown as {
      startServer(options: { port: number; returnServer: true }): Promise<StartedServer>;
    };
    return await serverModule.startServer({ port: 0, returnServer: true });
  }

  it('preserves daemon verdicts and durable log classifications for representative failures', async () => {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-run-failure-smoke-bin-'));
    await writeFakeClaude(binDir, 'claude-auth', [
      'HTTP 401 Unauthorized: invalid API key.',
      'Please run /login.',
    ].join(' '));
    await writeFakeClaude(binDir, 'claude-rate-limit', [
      'HTTP 429 Too Many Requests: rate limit exceeded by upstream provider.',
      'Retry after 30 seconds.',
    ].join(' '));
    await writeFakeClaude(binDir, 'claude-upstream', [
      'HTTP 503 Service Unavailable: upstream provider unavailable.',
      'Gateway timeout while waiting for first token.',
    ].join(' '));
    await writeFakeClaude(binDir, 'claude-hang', null);
    await writeFakeDeepseek(binDir, 'deepseek');

    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '400';

    const cases = [
      {
        id: 'auth_401',
        daemonPublishesVerdict: true,

        agentId: 'claude',
        config: { agentCliEnv: { claude: { CLAUDE_BIN: path.join(binDir, 'claude-auth') } } },
        expectedCode: 'AGENT_AUTH_REQUIRED',
        expectedCodes: ['AGENT_AUTH_REQUIRED', 'AGENT_EXECUTION_FAILED'],
        expectedCategory: 'auth',
        expectedDetail: 'invalid_api_key',
      },
      {
        id: 'rate_limit_429',
        daemonPublishesVerdict: true,

        agentId: 'claude',
        config: { agentCliEnv: { claude: { CLAUDE_BIN: path.join(binDir, 'claude-rate-limit') } } },
        expectedCode: 'RATE_LIMITED',
        expectedCategory: 'rate_limit',
        expectedDetail: 'rate_limit_429',
      },
      {
        id: 'upstream_503',
        daemonPublishesVerdict: true,

        agentId: 'claude',
        config: { agentCliEnv: { claude: { CLAUDE_BIN: path.join(binDir, 'claude-upstream') } } },
        expectedCode: 'UPSTREAM_UNAVAILABLE',
        expectedCategory: 'upstream_unavailable',
        expectedDetail: 'upstream_5xx',

      },
      {
        id: 'context_window',

        // Rejected during prompt assembly, before the runtime finish path that
        // stamps run.failureCategory, so the status carries no daemon verdict.
        daemonPublishesVerdict: false,
        agentId: 'deepseek',
        config: { agentCliEnv: { deepseek: { DEEPSEEK_BIN: path.join(binDir, 'deepseek') } } },
        expectedCode: 'AGENT_PROMPT_TOO_LARGE',
        expectedCategory: 'prompt_too_large',
        expectedDetail: 'prompt_too_large',
        message: `od-failure-smoke-context ${'large-context '.repeat(10_000)}`,
      },
      {
        id: 'hang_timeout',
        daemonPublishesVerdict: true,

        agentId: 'claude',
        config: { agentCliEnv: { claude: { CLAUDE_BIN: path.join(binDir, 'claude-hang') } } },
        expectedCode: 'AGENT_EXECUTION_FAILED',
        expectedCategory: 'timeout',
        expectedDetail: 'inactivity_timeout',
      },
    ] as const;

    for (const item of cases) {
      started = await startIsolatedServer();
      await putConfig(started.url, { odNextStrategyMode: 'active' });
      await putConfig(started.url, { agentId: item.agentId, ...item.config });
      const run = await createAndWaitForRun(started.url, {
        caseId: item.id,
        agentId: item.agentId,
        message: 'message' in item ? item.message : `od-failure-smoke-${item.id}`,
      });
      const events = await readCompletedRunEvents(run.eventsLogPath);
      const errorCode = deriveRunErrorCode(run);
      const failure = classifyRunFailure({
        result: runResultFromStatus(run.status),
        status: run,
        ...(errorCode ? { errorCode } : {}),
        agentId: run.agentId,
        events,
      });
      expect(run.status, item.id).toBe('failed');
      expect('expectedCodes' in item ? item.expectedCodes : [item.expectedCode])
        .toContain(errorCode);
      // The daemon computes its own verdict from in-memory events when the
      // runtime finishes and publishes it on the terminal run status. That is
      // the value the chat UI and persisted message consume,
      // so assert it directly instead of only re-deriving a verdict test-side.
      // A request rejected before the runtime finish path never reaches that
      // assignment, so each case states which side of the boundary it is on
      // rather than tolerating a null.
      expect(run.failureCategory, item.id)
        .toBe(item.daemonPublishesVerdict ? item.expectedCategory : null);
      expect(run.failureDetail, item.id)
        .toBe(item.daemonPublishesVerdict ? item.expectedDetail : null);
      // Re-derivation from the completed durable log must agree with it.
      expect(failure?.failure_category, item.id).toBe(item.expectedCategory);
      expect(failure?.failure_detail, item.id).toBe(item.expectedDetail);
    }
  }, 120_000);

  it('reclassifies upstream + install/env failures end-to-end through a real daemon run (#3408 P1)', async () => {
    // End-to-end proof for the reclassification: a real agent process emits the
    // production error text (or fails to spawn), the daemon records it into the
    // run's events.jsonl, and classifyRunFailure (on the REAL recorded events,
    // not a hand-built input) must land it in the correct category instead of
    // the opaque execution_failed bucket. Generous inactivity timeout so the
    // 100ms exit always wins the race (this test is not about timeouts).
    binDir = await mkdtemp(path.join(os.tmpdir(), 'od-reclassify-bin-'));
    await writeFakeClaude(binDir, 'amr-ratelimit', '429 您的账户已达到速率限制，请您控制请求频率');
    await writeFakeClaude(binDir, 'amr-model', 'API Error: 400 model deepseek-v4-pro-202606 not in allowed list');
    await writeFakeClaude(
      binDir,
      'env-node-path',
      "'node' is not recognized as an internal or external command, operable program or batch file.",
    );
    // The agent itself reports a missing vendored sub-binary (real codex shape).
    await writeFakeClaude(
      binDir,
      'env-spawn-enoent',
      'Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/codex ENOENT',
    );
    await writeFakeClaude(
      binDir,
      'a-prefill',
      'MLX prefill memory guard rejected this prompt: Prefill context too large for available memory',
    );
    await writeFakeClaude(
      binDir,
      'a-thread-start',
      'Reading prompt from stdin... Error: thread/start: thread/start failed: failed to start session',
    );
    await writeFakeClaude(
      binDir,
      'a-auth',
      "login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)",
    );
    await writeFakeClaude(
      binDir,
      'a-lmstudio',
      "No models loaded. Please load a model in the developer page or use the 'lms load' command.",
    );
    await writeFakeClaude(
      binDir,
      'a-resume-expired',
      'no conversation found with session id 1d2c3b4a-0000-0000-0000-000000000000',
    );

    process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS = '5000';
    started = await startIsolatedServer();
    const cases = [
      { bin: 'amr-ratelimit', category: 'rate_limit', detail: 'rate_limit_429' },
      { bin: 'amr-model', category: 'model_unavailable', detail: 'model_not_found' },
      { bin: 'env-node-path', category: 'process_exit', detail: 'cli_not_installed' },
      { bin: 'env-spawn-enoent', category: 'process_exit', detail: 'cli_not_installed' },
      { bin: 'a-prefill', category: 'prompt_too_large', detail: 'prompt_too_large' },
      { bin: 'a-thread-start', category: 'process_exit', detail: 'agent_protocol_error' },
      { bin: 'a-auth', category: 'auth', detail: 'auth_required' },
      { bin: 'a-lmstudio', category: 'model_unavailable', detail: 'local_model_not_loaded' },
      { bin: 'a-resume-expired', category: 'process_exit', detail: 'session_resume_expired' },
    ] as const;

    for (const item of cases) {
      await putConfig(started.url, {
        agentId: 'claude',
        agentCliEnv: { claude: { CLAUDE_BIN: path.join(binDir, item.bin) } },
      });
      const run = await createAndWaitForRun(started.url, {
        caseId: item.bin,
        agentId: 'claude',
        message: `od-amr-reclassify-${item.bin}`,
      });
      const events = await readCompletedRunEvents(run.eventsLogPath);
      const errorCode = deriveRunErrorCode(run);
      const failure = classifyRunFailure({
        result: runResultFromStatus(run.status),
        status: run,
        ...(errorCode ? { errorCode } : {}),
        agentId: run.agentId,
        events,
      });
      expect(run.status, item.bin).toBe('failed');
      expect(run.failureCategory, item.bin).toBe(item.category);
      expect(run.failureDetail, item.bin).toBe(item.detail);
      // The reclassification must NOT leave it in the opaque bucket.
      expect(failure?.failure_detail, item.bin).not.toBe('execution_failed');
      expect(failure?.failure_category, item.bin).toBe(item.category);
      expect(failure?.failure_detail, item.bin).toBe(item.detail);
    }
  }, 60_000);

});

async function removeDataDir(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
    return;
  } catch {
    // fall through to the permission-restoring retry
  }
  const { chmodSync, readdirSync, statSync } = await import('node:fs');
  const restore = (target: string): void => {
    try {
      chmodSync(target, 0o700);
      if (!statSync(target).isDirectory()) return;
      for (const entry of readdirSync(target)) restore(path.join(target, entry));
    } catch {
      // best effort
    }
  };
  restore(root);
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS: process.env.OD_CHAT_RUN_INACTIVITY_TIMEOUT_MS,
    OD_DATA_DIR: process.env.OD_DATA_DIR,
  };
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const FAKE_CLAUDE_HELP = `Usage: claude -p ${
  Object.keys(claudeAgentDef.capabilityFlags).map((flag) => `[${flag}]`).join(' ')
}`;

async function writeFakeClaude(dir: string, name: string, stderr: string | null): Promise<void> {
  const bin = path.join(dir, name);
  const body = stderr === null
    ? `setInterval(() => {}, 1000);\n`
    : `process.stderr.write(${JSON.stringify(`${stderr}\n`)});\nsetTimeout(() => process.exit(1), 100);\n`;
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('claude-code 1.0.0-smoke');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log(${JSON.stringify(FAKE_CLAUDE_HELP)});
  process.exit(0);
}
${body}`, 'utf8');
  await chmod(bin, 0o755);
}

async function writeFakeDeepseek(dir: string, name: string): Promise<void> {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('deepseek 0.0.0-smoke');
  process.exit(0);
}
console.log('DeepSeek fake should not be spawned for prompt-too-large smoke.');
process.exit(0);
`, 'utf8');
  await chmod(bin, 0o755);
}

async function putConfig(url: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${url}/api/app-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
}

async function createAndWaitForRun(url: string, input: {
  caseId: string;
  agentId: string;
  message: string;
}): Promise<RunStatus> {
  const projectId = `failure_smoke_${input.caseId}_${randomUUID()}`;
  const projectResponse = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: `Failure smoke ${input.caseId}`,
      metadata: { kind: 'prototype' },
      skipDiscoveryBrief: true,
    }),
  });
  expect(projectResponse.status).toBe(200);
  const projectBody = await projectResponse.json() as { conversationId: string };
  const assistantMessageId = `assistant_${input.caseId}_${randomUUID()}`;
  const runResponse = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      conversationId: projectBody.conversationId,
      assistantMessageId,
      clientRequestId: `client_${input.caseId}_${randomUUID()}`,
      agentId: input.agentId,
      message: input.message,
      currentPrompt: input.message,
    }),
  });
  expect(runResponse.status).toBe(202);
  const runBody = await runResponse.json() as { runId: string };
  return await waitForRun(url, runBody.runId);
}

async function waitForRun(url: string, runId: string): Promise<RunStatus> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const run = await response.json() as RunStatus;
    if (run.status === 'failed' || run.status === 'succeeded' || run.status === 'canceled') {
      return run;
    }
    await delay(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

async function readRunEvents(file: string): Promise<RunEvent[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

/**
 * Read a Run's durable event log once it is complete.
 *
 * The daemon emits `end` as a Run's final event and only then closes the log
 * write stream, so a log that already carries an `end` record carries every
 * earlier record too. Terminal Run status is published to `GET /api/runs/:id`
 * before that buffered write has necessarily reached disk, so sampling the file
 * the instant the status flips can classify a log whose error record is still
 * in flight. This waits for the log's own completion marker — not for the
 * assertion to pass, and not for a fixed delay.
 */
async function readCompletedRunEvents(file: string): Promise<RunEvent[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const events = await readRunEvents(file);
    if (events.some((event) => event.event === 'end')) return events;
    if (Date.now() >= deadline) {
      throw new Error(`run log ${file} never recorded a terminal end event`);
    }
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
