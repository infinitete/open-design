// Real daemon wiring: inspect local lifecycle timestamps, never an export sink.
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { RunWithLifecycleTelemetry } from '../src/run-lifecycle-tracer.js';

export const TEST_BUDGET_MS = 90_000;
export const RUN_TERMINAL_WAIT_MS = 30_000;

export type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};
export type RunStatus = { id: string; status: string };
export type RunTiming = NonNullable<RunWithLifecycleTelemetry['analyticsTelemetry']>;

/** Read the real object passed to the pass-through tracer spy, without replacing
 * any marks. These clocks are local product diagnostics, not HTTP DTO fields. */
export function readLocalLifecycleRun(
  runId: string,
  calls: readonly (readonly RunWithLifecycleTelemetry[])[],
): RunWithLifecycleTelemetry & { id: string; lastAgentActivityAt: number; terminalAt: number } {
  const run = calls.map(([value]) => value).find(
    (value) => (value as RunWithLifecycleTelemetry & { id?: string }).id === runId,
  );
  expect(run, `local lifecycle run ${runId}`).toBeDefined();
  expect(run).toHaveProperty('id', runId);
  return run as RunWithLifecycleTelemetry & {
    id: string; lastAgentActivityAt: number; terminalAt: number;
  };
}

export function expectVisibleOutputNotBeforeFirstToken(timing: RunTiming): void {
  expect(timing.firstTokenAt).toBeTypeOf('number');
  expect(timing.firstVisibleOutputAt).toBeTypeOf('number');
  expect(timing.firstVisibleOutputAt! - timing.firstTokenAt!).toBeGreaterThanOrEqual(0);
}

/**
 * A fake `opencode` on the real json-event-stream spawn path. `body` is the
 * script that emits the turn; it runs with `emit()` and `finishTurn()` in
 * scope.
 */
export async function writeFakeOpencode(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const bin = path.join(dir, name);
  await writeFile(
    bin,
    `#!/usr/bin/env node
const SESSION = 'ses_first_visible_output_0001';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('1.17.7'); process.exit(0); }
if (argv.includes('--help')) { console.log('opencode run [message..]'); process.exit(0); }
if (argv[0] === 'models') { console.log('anthropic/claude-sonnet-4-5'); process.exit(0); }
let stdin = '';
let done = false;
function emit(obj) {
  console.log(JSON.stringify({ ...obj, sessionID: SESSION }));
}
function finishTurn() {
  emit({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 9, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
  setTimeout(() => process.exit(0), 10);
}
function finish() {
  if (done) return; done = true;
  run();
}
function run() {
  emit({ type: 'step_start', part: { type: 'step-start' } });
${body}
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 1500);
`,
    'utf8',
  );
  await chmod(bin, 0o755);
  return bin;
}

export const TELEMETRY_ENV_KEYS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'OPEN_DESIGN_TELEMETRY_RELAY_URL',
  'POSTHOG_KEY',
  'POSTHOG_HOST',
  'OD_NEXT_STRATEGY_ROLLOUT',
  'OD_NEXT_STRATEGY_LOCAL_SYNTHETIC_CANARY',
] as const;

export function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    TELEMETRY_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

export function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function clearTelemetryEnv(): void {
  for (const key of TELEMETRY_ENV_KEYS) delete process.env[key];
}

export async function putConfig(
  url: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${url}/api/app-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(response.status).toBe(200);
  // Populates the runtime/agent inventory the OD Next admission gate reads.
  await fetch(`${url}/api/agents`);
}

export type Conversation = { projectId: string; conversationId: string };

/** Ordinary chat project: the OD Next strategy has nothing to bind to. */
export async function createChatProject(
  url: string,
  label: string,
): Promise<Conversation> {
  return await createProject(url, label, {
    metadata: { kind: 'prototype' },
  });
}

/**
 * Design project carrying an `automatic_default` strategy binding — the shape
 * the OD Next rollout admits. The binding is asserted rather than assumed, so
 * a project-creation change that silently drops it fails here instead of
 * quietly turning the strategy case into an ordinary run.
 */
export async function createOdNextDesignProject(
  url: string,
  label: string,
): Promise<Conversation> {
  const created = await createProject(url, label, {
    metadata: { kind: 'prototype' },
    conversationMode: 'design',
    automaticStrategyTaskProfile: 'prototype',
  });
  expect(created.strategyBinding).toMatchObject({
    provenance: 'automatic_default',
    taskProfile: 'prototype',
  });
  return created;
}

async function createProject(
  url: string,
  label: string,
  extra: Record<string, unknown>,
): Promise<Conversation & { strategyBinding?: unknown }> {
  const projectId = `fvo_${label.replace(/[^a-z0-9]+/giu, '_')}_${randomUUID()}`;
  const response = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: projectId,
      name: 'first visible output smoke',
      skipDiscoveryBrief: true,
      ...extra,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    conversationId: string;
    project?: { metadata?: { strategyBinding?: unknown } };
  };
  return {
    projectId,
    conversationId: body.conversationId,
    strategyBinding: body.project?.metadata?.strategyBinding,
  };
}

export type StartedRun = { run: RunStatus; created: Record<string, unknown> };

export async function sendRunAndWait(
  url: string,
  conversation: Conversation,
  message: string,
): Promise<StartedRun> {
  const response = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      projectId: conversation.projectId,
      conversationId: conversation.conversationId,
      userMessageId: `user_fvo_${randomUUID()}`,
      assistantMessageId: `assistant_fvo_${randomUUID()}`,
      clientRequestId: `client_fvo_${randomUUID()}`,
      agentId: 'opencode',
      message,
      currentPrompt: message,
    }),
  });
  expect(response.status).toBe(202);
  const created = (await response.json()) as Record<string, unknown>;
  return {
    created,
    run: await waitForRun(url, created.runId as string),
  };
}

export async function waitForRun(url: string, runId: string): Promise<RunStatus> {
  const deadline = Date.now() + RUN_TERMINAL_WAIT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const run = (await response.json()) as RunStatus;
    if (
      run.status === 'failed'
      || run.status === 'succeeded'
      || run.status === 'canceled'
    ) {
      return run;
    }
    await delay(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

/** The reply as the user's client received it, reassembled by the daemon. */
export async function readAssistantMessage(
  url: string,
  conversation: Conversation,
  assistantMessageId: string,
): Promise<string> {
  const response = await fetch(
    `${url}/api/projects/${encodeURIComponent(conversation.projectId)}`
      + `/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    messages: Array<{ id: string; role: string; content: string }>;
  };
  const message = body.messages.find((entry) => entry.id === assistantMessageId);
  return message?.content ?? '';
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
