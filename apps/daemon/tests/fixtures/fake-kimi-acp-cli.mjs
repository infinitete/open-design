#!/usr/bin/env node
/**
 * Fake Kimi Code CLI used by the ACP stdio-MCP wiring test and the ACP stall
 * progress-age specs.
 *
 * Speaks just enough ACP to let the daemon drive a complete turn, and records
 * every `session/new` params object it is given so the test can assert on the
 * payload that actually reached the wire rather than on a helper's return
 * value.
 *
 *   `kimi --version` → prints FAKE_KIMI_VERSION
 *   `kimi acp`       → initialize → session/new → session/prompt
 *
 * Env:
 *   FAKE_KIMI_VERSION          – version string reported by `--version`
 *   FAKE_KIMI_ACP_VERSION      – version reported in the `initialize` result's
 *                                `agentInfo`; defaults to FAKE_KIMI_VERSION.
 *                                Set it apart from FAKE_KIMI_VERSION to prove
 *                                which of the two signals the daemon trusts.
 *   FAKE_KIMI_SESSION_NEW_LOG  – file each session/new params object is
 *                                appended to, one JSON object per line
 *   FAKE_KIMI_STALL_AFTER_PROMPT – when set to '1', session/prompt never
 *                                completes: the CLI streams whatever the knobs
 *                                below enable, then goes silent while holding
 *                                the turn open (the stalled-bridge shape the
 *                                ACP stage watchdog exists for)
 *   FAKE_KIMI_TEXT_BEFORE_STALL – when set to '1' with the stall knob, emit one
 *                                agent text chunk before going silent
 *   FAKE_KIMI_OPEN_TOOL_BEFORE_STALL – when set to '1' with the stall knob,
 *                                open a concrete tool call and never close it
 *   FAKE_KIMI_STALL_HEARTBEAT_MS – heartbeat interval while stalled (default
 *                                20ms); '0' goes completely silent on stdout
 *   FAKE_KIMI_STDERR_ON_SIGTERM – when set to '1', log a shutdown line to
 *                                stderr on SIGTERM, then exit 143
 *   FAKE_KIMI_IGNORE_SIGTERM   – when set to '1', swallow SIGTERM and stay
 *                                alive until something escalates
 *   FAKE_KIMI_DESCENDANT_ACTIVITY_FILE – when set with the stall knob, spawn a
 *                                SIGTERM-ignoring descendant that appends a
 *                                tick to this file every 25ms
 *   FAKE_KIMI_DESCENDANT_PID_FILE – file that receives that descendant's pid
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { argv, stdin, stdout, stderr, env, exit } from 'node:process';

const VERSION = env.FAKE_KIMI_VERSION || '0.38.0';
const ACP_VERSION = env.FAKE_KIMI_ACP_VERSION || VERSION;
const SESSION_NEW_LOG = env.FAKE_KIMI_SESSION_NEW_LOG || '';
const STALL_AFTER_PROMPT = env.FAKE_KIMI_STALL_AFTER_PROMPT === '1';
const STALL_HEARTBEAT_MS = env.FAKE_KIMI_STALL_HEARTBEAT_MS === undefined
  ? 20
  : Number(env.FAKE_KIMI_STALL_HEARTBEAT_MS) || 0;
const TEXT_BEFORE_STALL = env.FAKE_KIMI_TEXT_BEFORE_STALL === '1';
const OPEN_TOOL_BEFORE_STALL = env.FAKE_KIMI_OPEN_TOOL_BEFORE_STALL === '1';
const STDERR_ON_SIGTERM = env.FAKE_KIMI_STDERR_ON_SIGTERM === '1';
const IGNORE_SIGTERM = env.FAKE_KIMI_IGNORE_SIGTERM === '1';
const DESCENDANT_ACTIVITY_FILE = env.FAKE_KIMI_DESCENDANT_ACTIVITY_FILE || '';
const DESCENDANT_PID_FILE = env.FAKE_KIMI_DESCENDANT_PID_FILE || '';

const SESSION_ID = 'fake-kimi-session-1';

// Real agent CLIs log a line or two while shutting down after the host kills
// them. Modelling that is the only way a spec can cover what the daemon does
// with agent bytes that arrive AFTER it has already given up on the turn. The
// two knobs compose: STDERR_ON_SIGTERM alone models a CLI that logs a shutdown
// line and exits; IGNORE_SIGTERM alone models one that never honours the
// signal; together they model the worst case for the host — a child that keeps
// talking on stderr while refusing to die, so every one of those late bytes
// reaches the daemon's raw stderr handler after the verdict.
if (STDERR_ON_SIGTERM || IGNORE_SIGTERM) {
  // Logged once, like a real CLI announcing shutdown, not once per signal —
  // repeating it on every SIGTERM would keep pushing the host's timers out and
  // hide the race this models.
  let announcedShutdown = false;
  process.on('SIGTERM', () => {
    if (STDERR_ON_SIGTERM && !announcedShutdown) {
      announcedShutdown = true;
      stderr.write('[fake-kimi] shutting down after SIGTERM\n');
    }
    if (!IGNORE_SIGTERM) exit(143);
  });
}

if (argv.includes('--version')) {
  stdout.write(`${VERSION}\n`);
  exit(0);
}

if (!argv.includes('acp')) {
  stdout.write(`fake-kimi ${VERSION}\n`);
  exit(0);
}

const write = (msg) => stdout.write(`${JSON.stringify(msg)}\n`);

let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'Kimi Code CLI', version: ACP_VERSION },
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    if (SESSION_NEW_LOG) {
      appendFileSync(SESSION_NEW_LOG, `${JSON.stringify(msg.params ?? {})}\n`);
    }
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: SESSION_ID,
        models: { currentModelId: null, availableModels: [] },
      },
    });
    return;
  }
  if (msg.method === 'session/set_model' || msg.method === 'session/set_config_option') {
    write({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    if (STALL_AFTER_PROMPT) {
      if (TEXT_BEFORE_STALL) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok from fake kimi, about to go quiet' },
            },
          },
        });
      }
      if (DESCENDANT_ACTIVITY_FILE) {
        const descendant = spawnChild(process.execPath, [
          '-e',
          `const fs = require('node:fs');
const activityFile = ${JSON.stringify(DESCENDANT_ACTIVITY_FILE)};
process.on('SIGTERM', () => {});
const tick = () => fs.appendFileSync(activityFile, String(Date.now()) + '\\n');
tick();
setInterval(tick, 25);`,
        ], { stdio: 'ignore' });
        if (DESCENDANT_PID_FILE) writeFileSync(DESCENDANT_PID_FILE, String(descendant.pid));
      }
      // A concrete tool the agent never closes. `kind: 'read'` is a recognized
      // non-think, non-write family, and `in_progress` is not a terminal
      // status, so the host keeps this call open for the whole stall.
      if (OPEN_TOOL_BEFORE_STALL) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'fake-kimi-open-tool-1',
              kind: 'read',
              title: 'Read design tokens',
              status: 'in_progress',
              rawInput: { path: 'tokens.json' },
            },
          },
        });
      }
      // Keep both the ACP stage watchdog and the outer chat inactivity
      // watchdog fed without producing text, thinking, tools, artifacts, or a
      // terminal prompt result. `FAKE_KIMI_STALL_HEARTBEAT_MS=0` drops the
      // heartbeats entirely: the CLI goes completely silent on stdout while
      // the process stays alive — the stalled-bridge shape that lets a
      // watchdog actually fire in a spec.
      if (STALL_HEARTBEAT_MS > 0) {
        setInterval(() => {
          write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: SESSION_ID,
              update: { sessionUpdate: 'heartbeat' },
            },
          });
        }, STALL_HEARTBEAT_MS);
      } else {
        // Hold the event loop open without writing anything.
        setInterval(() => {}, 60_000);
      }
      return;
    }
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok from fake kimi' },
        },
      },
    });
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
}
