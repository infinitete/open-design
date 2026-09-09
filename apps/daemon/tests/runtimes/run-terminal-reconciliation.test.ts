import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pinAssistantMessageOnRunCreate } from '../../src/runtimes/chat-run-messages.js';
import { beginDurableRunTerminalReconciliation, reconcileDurableRunTerminals } from '../../src/runtimes/run-terminal-reconciliation.js';
import { createChatRunService } from '../../src/runtimes/runs.js';

describe('durable run terminal reconciliation', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-reconcile-test-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT NOT NULL DEFAULT 'assistant',
        content TEXT NOT NULL DEFAULT '',
        run_id TEXT,
        run_status TEXT,
        last_run_event_id TEXT,
        session_mode TEXT,
        run_context_json TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        events_json TEXT
      )
    `);
  });

  function seedReservedRunWithCleanAttemptZero() {
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      runsLogDir: tmpDir as unknown as null,
    });
    const run = runs.create({
      projectId: 'p1', conversationId: 'c-resume', assistantMessageId: 'm-resume', agentId: 'codex',
    });
    runs.persistState(run);
    runs.finish(run, 'failed', 1, null);
    expect(runs.reserveRestartAttempt(run, 1)).toBe(true);
    db.prepare("INSERT INTO conversations (id, project_id) VALUES ('c-resume', 'p1')").run();
    db.prepare(`INSERT INTO messages
      (id, conversation_id, run_id, run_status, ended_at, events_json)
      VALUES ('m-resume', 'c-resume', ?, 'failed', 2, '[]')`).run(run.id);
    return { run, statePath: run.statePath as string };
  }

  it('repairs a committed same-id resume claim and promotes its reserved execution attempt', async () => {
    const { run, statePath } = seedReservedRunWithCleanAttemptZero();
    expect(pinAssistantMessageOnRunCreate(db, run, { status: 'queued' })).toEqual({ ok: true });
    expect(db.prepare("SELECT run_status AS status, ended_at AS endedAt FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'queued', endedAt: null });

    const reconcile = () => beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (_group, repair) => {
        await repair();
      },
      reportLangfuse: vi.fn(),
    }).localReady;

    await reconcile();
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      manualResumeAttemptCount: 1,
    });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .not.toHaveProperty('pendingManualResumeAttemptCount');

    await reconcile();
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      manualResumeAttemptCount: 1,
    });
  });

  it('defers an unknown resumed-run claim without consuming its pending attempt', async () => {
    const { run, statePath } = seedReservedRunWithCleanAttemptZero();
    expect(pinAssistantMessageOnRunCreate(db, run, { status: 'queued' })).toEqual({ ok: true });
    const messageBeforeRecovery = db.prepare(`SELECT run_status AS status, ended_at AS endedAt,
      events_json AS eventsJson FROM messages WHERE id = 'm-resume'`).get();

    const reconcileGroups = vi.fn(async (_group: unknown, repair: () => Promise<void>) => {
      await repair();
    });
    const reconcile = () => beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: reconcileGroups,
      reportLangfuse: vi.fn(),
    }).localReady;
    const prepare = db.prepare.bind(db);
    let rejectExactClaimEvidence = true;
    vi.spyOn(db, 'prepare').mockImplementation(((source: string) => {
      if (rejectExactClaimEvidence && source.includes('SELECT 1 FROM messages')) {
        rejectExactClaimEvidence = false;
        throw new Error('one-shot pending claim evidence fault');
      }
      return prepare(source);
    }) as typeof db.prepare);

    const first = await reconcile();
    expect(first.messagesReconciled).toBe(0);
    expect(reconcileGroups).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT run_status AS status, ended_at AS endedAt,
      events_json AS eventsJson FROM messages WHERE id = 'm-resume'`).get())
      .toEqual(messageBeforeRecovery);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      pendingManualResumeAttemptCount: 1,
    });

    const second = await reconcile();
    expect(second.messagesReconciled).toBe(1);
    expect(reconcileGroups).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      manualResumeAttemptCount: 1,
    });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .not.toHaveProperty('pendingManualResumeAttemptCount');

    const third = await reconcile();
    expect(third.messagesReconciled).toBe(0);
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      manualResumeAttemptCount: 1,
    });
  });

  it('continues other durable runs while one pending claim remains unknown', async () => {
    const states = [
      { id: 'run-deferred', messageId: 'm-deferred', pendingAttempt: 1 },
      { id: 'run-provable', messageId: 'm-provable' },
    ];
    for (const state of states) {
      const runDir = path.join(tmpDir, state.id);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        id: state.id,
        projectId: 'p1',
        conversationId: `c-${state.id}`,
        assistantMessageId: state.messageId,
        agentId: 'codex',
        status: 'failed',
        createdAt: 1,
        updatedAt: 2,
        ...(state.pendingAttempt === undefined
          ? {}
          : { pendingManualResumeAttemptCount: state.pendingAttempt }),
      }));
      db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)')
        .run(`c-${state.id}`, 'p1');
      db.prepare(`INSERT INTO messages (id, conversation_id, run_id, run_status, events_json)
        VALUES (?, ?, ?, 'running', '[]')`).run(state.messageId, `c-${state.id}`, state.id);
    }
    const prepare = db.prepare.bind(db);
    let rejectExactClaimEvidence = true;
    vi.spyOn(db, 'prepare').mockImplementation(((source: string) => {
      if (rejectExactClaimEvidence && source.includes('SELECT 1 FROM messages')) {
        rejectExactClaimEvidence = false;
        throw new Error('one-shot pending claim evidence fault');
      }
      return prepare(source);
    }) as typeof db.prepare);
    const groups: string[][] = [];

    const result = await beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => {
        groups.push(group.terminals.map(terminal => terminal.runId));
        await repair();
      },
      reportLangfuse: vi.fn(),
    }).localReady;

    expect(result.messagesReconciled).toBe(1);
    expect(groups).toEqual([['run-provable']]);
    expect(db.prepare('SELECT id, run_status AS status FROM messages ORDER BY id').all()).toEqual([
      { id: 'm-deferred', status: 'running' },
      { id: 'm-provable', status: 'failed' },
    ]);
  });

  it('drops a pre-claim attempt reservation without an active exact message', async () => {
    const { statePath } = seedReservedRunWithCleanAttemptZero();
    const reconcileGroups = vi.fn(async (_group: unknown, repair: () => Promise<void>) => {
      await repair();
    });

    await beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: reconcileGroups,
      reportLangfuse: vi.fn(),
    }).localReady;

    expect(reconcileGroups).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .not.toHaveProperty('pendingManualResumeAttemptCount');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .toMatchObject({ manualResumeAttemptCount: 0 });
  });

  it('groups durable local repairs by project and detaches delivery only after local ready', async () => {
    const states = [
      { id: 'run-a', projectId: 'p1', messageId: 'm-a' },
      { id: 'run-b', projectId: 'p1', messageId: 'm-b', attempt: 2 },
      { id: 'run-c', projectId: 'p2', messageId: 'm-c' },
    ];
    for (const state of states) {
      const runDir = path.join(tmpDir, state.id); fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        schemaVersion: 1, id: state.id, projectId: state.projectId,
        conversationId: `c-${state.id}`, assistantMessageId: state.messageId,
        agentId: 'codex', status: 'failed', createdAt: 1, updatedAt: 2,
        ...(state.attempt === undefined ? {} : { manualResumeAttemptCount: state.attempt }),
      }));
      db.prepare('INSERT INTO conversations (id, project_id) VALUES (?, ?)').run(`c-${state.id}`, state.projectId);
      db.prepare(`INSERT INTO messages (id, conversation_id, run_id, run_status, events_json)
        VALUES (?, ?, ?, 'running', '[]')`).run(state.messageId, `c-${state.id}`, state.id);
    }
    let releaseDelivery!: () => void;
    const deliveryBarrier = new Promise<void>(resolve => { releaseDelivery = resolve; });
    const groups: Array<{ projectId: string; runs: string[] }> = [];
    const reconciliation = beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => {
        groups.push({
          projectId: group.projectId,
          runs: group.terminals.map(item => `${item.runId}:${item.executionAttempt}`).sort(),
        });
        await repair();
      },
      reportLangfuse: vi.fn(async () => {
        await deliveryBarrier;
        return { langfuse_expected: false, langfuse_delivery_status: 'not_expected' as const };
      }),
    });
    let deliverySettled = false;
    void reconciliation.delivery.then(() => { deliverySettled = true; });

    const local = await reconciliation.localReady;
    expect(local.messagesReconciled).toBe(3);
    expect(deliverySettled).toBe(false);
    expect(groups.sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual([
      { projectId: 'p1', runs: ['run-a:0', 'run-b:2'] },
      { projectId: 'p2', runs: ['run-c:0'] },
    ]);
    expect(db.prepare('SELECT run_status AS status FROM messages ORDER BY id').all())
      .toEqual([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]);
    releaseDelivery();
    await reconciliation.delivery;
  });

  it('groups orphan messages by persisted conversation project', async () => {
    db.prepare("INSERT INTO conversations (id, project_id) VALUES ('c1', 'p1')").run();
    db.prepare("INSERT INTO messages (id, conversation_id, run_id, run_status, events_json) VALUES ('m1', 'c1', 'orphan-run', 'running', '[]')").run();
    const groups: unknown[] = [];
    const reconciliation = beginDurableRunTerminalReconciliation({
      analytics: { capture: vi.fn() }, appVersion: '0.1.0', db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => { groups.push(group); await repair(); },
      reportLangfuse: vi.fn(),
    });
    const local = await reconciliation.localReady;
    await reconciliation.delivery;
    expect(local.messagesReconciled).toBe(1);
    expect(groups).toEqual([{
      projectId: 'p1',
      terminals: [{ runId: 'orphan-run', executionAttempt: 0, terminal: 'failed' }],
    }]);
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm1'").get())
      .toEqual({ status: 'failed' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails an interrupted run, repairs its message, and emits missing terminal telemetry once', async () => {
    const runId = 'run-interrupted';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'claude',
      status: 'running',
      createdAt: 1_000,
      updatedAt: 2_000,
      analyticsRecovery: {
        context: {
          deviceId: 'device-1',
          sessionId: 'session-1',
          clientType: 'desktop',
          locale: 'zh-CN',
        },
        properties: {
          page_name: 'chat_panel',
          area: 'chat_panel',
          project_id: 'p1',
          conversation_id: 'c1',
          run_id: runId,
          project_kind: 'prototype',
          design_system_source: 'not_applicable',
          has_attachment: false,
          user_query_tokens: 10,
          model_id: 'default',
          agent_provider_id: 'claude_code',
          skill_id: null,
          mcp_id: null,
          token_count_source: 'estimated',
        },
        insertId: 'run-created-1',
      },
    }));
    db.prepare(
      `INSERT INTO messages (id, run_id, run_status, events_json)
       VALUES (?, ?, 'running', '[]')`,
    ).run('m1', runId);
    const capture = vi.fn(async () => undefined);
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));

    const first = await reconcileDurableRunTerminals({
      analytics: { capture },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    });

    expect(first).toMatchObject({ interrupted: 1, messagesReconciled: 1, analyticsReplayed: 1 });
    expect(db.prepare(`SELECT run_status AS status, ended_at AS endedAt, events_json AS eventsJson FROM messages WHERE id = 'm1'`).get()).toMatchObject({
      status: 'failed',
      endedAt: expect.any(Number),
      eventsJson: expect.stringContaining('daemon restarted'),
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'run_finished',
      insertId: 'run-created-1-finish',
      properties: expect.objectContaining({
        result: 'failed',
        error_code: 'DAEMON_RESTARTED',
        failure_category: 'process_exit',
        failure_detail: 'interrupted',
        failure_stage: 'finalize',
        retryable: true,
        user_action: 'retry',
        terminal_trigger: 'daemon_restart',
        terminal_reconciled: true,
        terminal_recovery_reason: 'daemon_restart',
      }),
    }));
    expect(reportLangfuse).toHaveBeenCalledWith(expect.objectContaining({
      persistedRunStatus: 'failed',
      run: expect.objectContaining({ id: runId, status: 'failed' }),
    }));

    const recoveredState = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    expect(recoveredState).toMatchObject({
      status: 'failed',
      errorCode: 'DAEMON_RESTARTED',
      analyticsRecovery: { completedAt: expect.any(Number) },
      langfuseCompletedAt: expect.any(Number),
    });

    const second = await reconcileDurableRunTerminals({
      analytics: { capture },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    });
    expect(second.analyticsReplayed).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(reportLangfuse).toHaveBeenCalledTimes(1);
  });

  it('repairs legacy queued messages even when no state journal exists', async () => {
    db.prepare(
      `INSERT INTO messages (id, run_id, run_status, events_json)
       VALUES (?, ?, 'queued', '[]')`,
    ).run('legacy-message', 'legacy-run');

    const result = await reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse: vi.fn(),
      runsLogDir: tmpDir,
    });

    expect(result.messagesReconciled).toBe(1);
    expect(db.prepare(`SELECT run_status AS status FROM messages WHERE id = 'legacy-message'`).get())
      .toEqual({ status: 'failed' });
  });

  it('finalizes every persisted terminal status locally', async () => {
    const finalizeTerminalLocally = vi.fn();
    for (const status of ['succeeded', 'failed', 'canceled']) {
      const runId = `run-${status}`;
      const runDir = path.join(tmpDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        id: runId,
        projectId: 'p1',
        conversationId: null,
        assistantMessageId: null,
        agentId: 'codex',
        status,
        createdAt: 1_000,
        updatedAt: 2_000,
        terminalAt: 2_000,
      }));
    }

    await reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse: vi.fn(async () => ({
        langfuse_expected: false,
        langfuse_delivery_status: 'not_expected',
      })),
      runsLogDir: tmpDir,
      finalizeTerminalLocally,
    });

    expect(finalizeTerminalLocally.mock.calls.map(([run, status]) => ({
      id: run.id,
      status,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'run-canceled', status: 'canceled' },
      { id: 'run-failed', status: 'failed' },
      { id: 'run-succeeded', status: 'succeeded' },
    ]);
  });

  it('preserves the real failure taxonomy when replaying incomplete analytics', async () => {
    const runId = 'run-analytics-incomplete';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'claude',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      exitCode: 1,
      error: 'Authentication required before starting the session.',
      errorCode: 'AGENT_AUTH_REQUIRED',
      analyticsRecovery: {
        context: {
          deviceId: 'device-1',
          sessionId: 'session-1',
          clientType: 'desktop',
          locale: 'en',
        },
        properties: {
          page_name: 'chat_panel',
          area: 'chat_panel',
          project_id: 'p1',
          conversation_id: 'c1',
          run_id: runId,
        },
        insertId: 'run-created-analytics-incomplete',
      },
      langfuseCompletedAt: 2_000,
    }));
    db.prepare(
      `INSERT INTO messages (id, run_id, run_status, events_json)
       VALUES (?, ?, 'running', '[]')`,
    ).run('m1', runId);
    const capture = vi.fn(async () => undefined);

    const result = await reconcileDurableRunTerminals({
      analytics: { capture },
      appVersion: '0.15.1',
      db,
      reportLangfuse: vi.fn(),
      runsLogDir: tmpDir,
    });

    expect(result).toMatchObject({
      interrupted: 0,
      messagesReconciled: 1,
      analyticsReplayed: 1,
    });
    const message = db.prepare(
      `SELECT run_status AS status, events_json AS eventsJson FROM messages WHERE id = 'm1'`,
    ).get() as { status: string; eventsJson: string };
    expect(message).toMatchObject({
      status: 'failed',
      eventsJson: expect.stringContaining('Authentication required before starting the session.'),
    });
    expect(message.eventsJson).not.toContain('daemon restarted');
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'run_finished',
      properties: expect.objectContaining({
        result: 'failed',
        error_code: 'AGENT_AUTH_REQUIRED',
        failure_category: 'auth',
        failure_detail: 'auth_required',
        failure_stage: 'session_init',
        retryable: false,
        user_action: 'login',
        terminal_reconciled: true,
        terminal_recovery_reason: 'analytics_incomplete',
      }),
    }));
  });

  it('does not read events after analytics and Langfuse are checkpointed', async () => {
    const runId = 'run-fully-checkpointed';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'claude',
      status: 'succeeded',
      createdAt: 1_000,
      updatedAt: 2_000,
      analyticsRecovery: {
        context: {},
        properties: {},
        insertId: 'run-created-fully-checkpointed',
        completedAt: 2_000,
      },
      langfuseCompletedAt: 2_000,
    }));
    const readFile = vi.spyOn(fs, 'readFileSync');
    const capture = vi.fn();
    const reportLangfuse = vi.fn();

    const result = await reconcileDurableRunTerminals({
      analytics: { capture },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    });

    expect(result).toMatchObject({
      scanned: 1,
      analyticsReplayed: 0,
      langfuseReplayed: 0,
    });
    expect(readFile).not.toHaveBeenCalledWith(path.join(runDir, 'events.jsonl'), 'utf8');
    expect(capture).not.toHaveBeenCalled();
    expect(reportLangfuse).not.toHaveBeenCalled();
  });

  it('keeps failed Langfuse delivery retryable on each daemon boot', async () => {
    const runId = 'run-langfuse-retry';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-fixture',
        status: 'in_flight',
        attemptCount: 1,
        crashWindow: true,
        startedAt: 1_900,
      },
    }));
    const reportLangfuse = vi.fn(async (args: Record<string, unknown>) => {
      (args.onDeliveryAttempt as (() => void) | undefined)?.();
      return {
        langfuse_expected: true,
        langfuse_delivery_status: 'failed' as const,
        langfuse_drop_reason: 'network_error' as const,
      };
    });
    const options = {
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    };

    await reconcileDurableRunTerminals(options);
    await reconcileDurableRunTerminals(options);

    expect(reportLangfuse).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        telemetryDelivery: {
          version: 1,
          idempotencyKey: 'od-run-telemetry-v1-fixture',
          status: 'failed',
          attemptCount: 3,
          crashWindow: false,
          dropReason: 'network_error',
        },
      });
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .not.toHaveProperty('langfuseCompletedAt');
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).telemetryDelivery)
      .not.toHaveProperty('finalizedAt');
  });

  it('terminalizes mapped send-mode single-run recovery without a legacy network replay', async () => {
    const runId = 'run-task-rollout-upgrade';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-upgrade-fixture',
        status: 'in_flight',
        attemptCount: 1,
        crashWindow: true,
        startedAt: 1_900,
      },
    }));
    const reportLangfuse = vi.fn();
    let crashBeforeTaskClaim = true;
    let taskAccepted = false;
    const beginTaskObservationForRun = vi.fn(() => {
      if (crashBeforeTaskClaim) {
        crashBeforeTaskClaim = false;
        throw new Error('simulated crash before task delivery claim');
      }
      taskAccepted = true;
      return {
        suppressSingleRun: true,
        completion: Promise.resolve({ action: 'sent' }),
      };
    });
    const options = {
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      taskObservationModeForRun: vi.fn(() => 'send' as const),
      taskObservationRepresentationForRun: vi.fn(() =>
        taskAccepted ? 'task_accepted' as const : 'task_pending' as const),
      beginTaskObservationForRun,
      runsLogDir: tmpDir,
    };

    await expect(reconcileDurableRunTerminals(options)).rejects.toThrow(
      'simulated crash before task delivery claim',
    );
    expect(reportLangfuse).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        telemetryDelivery: { status: 'in_flight', crashWindow: true },
      });

    await expect(reconcileDurableRunTerminals(options)).resolves.toMatchObject({
      langfuseReplayed: 1,
    });
    await expect(reconcileDurableRunTerminals(options)).resolves.toMatchObject({
      langfuseReplayed: 0,
    });

    expect(reportLangfuse).not.toHaveBeenCalled();
    expect(beginTaskObservationForRun).toHaveBeenCalledTimes(2);
    expect(beginTaskObservationForRun).toHaveBeenNthCalledWith(1, runId);
    expect(beginTaskObservationForRun).toHaveBeenNthCalledWith(2, runId);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'not_expected',
          attemptCount: 1,
          crashWindow: false,
          dropReason: 'task_hierarchy_rollout',
          finalizedAt: expect.any(Number),
        },
      });
  });

  it('preserves a Task privacy reason when startup checkpoints a mapped Run', async () => {
    const runId = 'run-task-privacy-tombstone';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
    }));
    let representation: 'task_pending' | 'task_not_expected' = 'task_pending';
    const reportLangfuse = vi.fn();

    await expect(reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      taskObservationModeForRun: () => 'send',
      taskObservationRepresentationForRun: () => representation,
      taskObservationNotExpectedReasonForRun: () => 'metrics_consent_off',
      beginTaskObservationForRun: () => ({
        suppressSingleRun: true,
        completion: Promise.resolve().then(() => {
          representation = 'task_not_expected';
        }),
      }),
      runsLogDir: tmpDir,
    })).resolves.toMatchObject({ langfuseReplayed: 1 });

    expect(reportLangfuse).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'not_expected',
          dropReason: 'metrics_consent_off',
          finalizedAt: expect.any(Number),
        },
      });
  });

  it('fails open to ordinary recovery when the Task mode lookup throws', async () => {
    const runId = 'run-task-mode-lookup-failed';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
    }));
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      taskObservationModeForRun: () => {
        throw new Error('synthetic Task store failure');
      },
      taskObservationRepresentationForRun: () => {
        throw new Error('synthetic Task representation failure');
      },
      runsLogDir: tmpDir,
    })).resolves.toMatchObject({ langfuseReplayed: 1 });

    expect(warn).toHaveBeenCalledWith(
      '[telemetry] task mode lookup failed during startup recovery',
    );
    expect(warn).toHaveBeenCalledWith(
      '[telemetry] task representation lookup failed during startup recovery',
    );
    expect(reportLangfuse).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'accepted',
          finalizedAt: expect.any(Number),
        },
      });
  });

  it('uses a local compatibility result when the completed representation lookup throws', async () => {
    const runId = 'run-task-completed-lookup-failed';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
    }));
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let representationLookups = 0;

    await expect(reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      taskObservationModeForRun: () => 'send',
      taskObservationRepresentationForRun: () => {
        representationLookups += 1;
        if (representationLookups === 1) return 'task_pending';
        throw new Error('synthetic completed representation failure');
      },
      beginTaskObservationForRun: () => ({
        suppressSingleRun: true,
        completion: Promise.resolve({ action: 'compatibility' }),
      }),
      runsLogDir: tmpDir,
    })).resolves.toMatchObject({ langfuseReplayed: 1 });

    expect(warn).toHaveBeenCalledWith(
      '[telemetry] completed task representation lookup failed during startup recovery',
    );
    expect(reportLangfuse).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'accepted',
          finalizedAt: expect.any(Number),
        },
      });
  });

  it.each(['off', 'observe'] as const)(
    'preserves legacy startup delivery in %s task-observation mode',
    async (mode) => {
      const runId = `run-task-rollout-${mode}`;
      const runDir = path.join(tmpDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        id: runId,
        projectId: 'p1',
        conversationId: 'c1',
        assistantMessageId: 'm1',
        agentId: 'codex',
        status: 'failed',
        createdAt: 1_000,
        updatedAt: 2_000,
        telemetryDelivery: {
          version: 1,
          idempotencyKey: `od-run-telemetry-v1-${mode}`,
          status: 'in_flight',
          attemptCount: 0,
          crashWindow: true,
          startedAt: 1_900,
        },
      }));
      const reportLangfuse = vi.fn(async () => ({
        langfuse_expected: true,
        langfuse_delivery_status: 'accepted' as const,
      }));
      const beginTaskObservationForRun = vi.fn(() => ({
        suppressSingleRun: false,
        completion: Promise.resolve(),
      }));

      await reconcileDurableRunTerminals({
        analytics: { capture: vi.fn() },
        appVersion: '0.15.1',
        db,
        reportLangfuse,
        taskObservationModeForRun: () => mode,
        beginTaskObservationForRun,
        runsLogDir: tmpDir,
      });

      expect(reportLangfuse).toHaveBeenCalledOnce();
      expect(beginTaskObservationForRun).toHaveBeenCalledTimes(
        mode === 'observe' ? 1 : 0,
      );
    },
  );

  it('keeps startup observe best-effort when local finalization rejects', async () => {
    const runId = 'run-task-rollout-observe-reject';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-observe-reject',
        status: 'in_flight',
        attemptCount: 0,
        crashWindow: true,
        startedAt: 1_900,
      },
    }));
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      taskObservationModeForRun: () => 'observe',
      beginTaskObservationForRun: () => ({
        suppressSingleRun: false,
        completion: Promise.reject(new Error('synthetic observe failure')),
      }),
      runsLogDir: tmpDir,
    })).resolves.toMatchObject({ langfuseReplayed: 1 });

    expect(warn).toHaveBeenCalledWith(
      '[telemetry] task observation failed in startup observe mode',
    );
    expect(reportLangfuse).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        telemetryDelivery: {
          status: 'accepted',
          crashWindow: false,
          finalizedAt: expect.any(Number),
        },
      });
  });

  it('retries an accepted telemetry delivery after a crash before checkpoint', async () => {
    const runId = 'run-langfuse-crash-window';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-crash-fixture',
        status: 'in_flight',
        attemptCount: 1,
        crashWindow: true,
        startedAt: 1_900,
      },
    }));
    const calls: Array<Record<string, unknown>> = [];
    let firstAttempt = true;
    const reportLangfuse = vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      (args.onDeliveryAttempt as (() => void) | undefined)?.();
      if (firstAttempt) {
        firstAttempt = false;
        // The upstream has accepted the request, but the daemon dies before
        // reconcileDurableRunTerminals can persist langfuseCompletedAt.
        throw new Error('simulated crash after telemetry acceptance');
      }
      return {
        langfuse_expected: true,
        langfuse_delivery_status: 'accepted' as const,
      };
    });
    const options = {
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    };

    await expect(reconcileDurableRunTerminals(options)).rejects.toThrow(
      'simulated crash after telemetry acceptance',
    );
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .not.toHaveProperty('langfuseCompletedAt');

    await expect(reconcileDurableRunTerminals(options)).resolves.toMatchObject({
      langfuseReplayed: 1,
    });
    expect(reportLangfuse).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({
      deliveryIdempotencyKey: 'od-run-telemetry-v1-crash-fixture',
      run: expect.objectContaining({ id: runId, status: 'failed' }),
      persistedRunStatus: 'failed',
      persistedEndedAt: 2_000,
    });
    expect(calls[1]?.run).toEqual(calls[0]?.run);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'accepted',
          attemptCount: 3,
          crashWindow: false,
          finalizedAt: expect.any(Number),
        },
      });
  });

  it('best-effort replays an unmarked legacy terminal record once', async () => {
    const runId = 'run-legacy-unmarked';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      errorCode: 'AGENT_EXIT_1',
    }));
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));

    const result = await reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    });

    expect(result.langfuseReplayed).toBe(1);
    expect(reportLangfuse).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          status: 'accepted',
          idempotencyKey: expect.stringMatching(/^od-run-telemetry-v1-/u),
        },
      });
  });

  it('repairs a v1 failed completion into a retryable delivery without changing its key', async () => {
    const runId = 'run-v1-failed-finalized';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 1,
      id: runId,
      projectId: 'p1',
      conversationId: 'c1',
      assistantMessageId: 'm1',
      agentId: 'codex',
      status: 'failed',
      createdAt: 1_000,
      updatedAt: 2_000,
      langfuseCompletedAt: 2_100,
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-preserved',
        status: 'failed',
        attemptCount: 2,
        crashWindow: false,
        startedAt: 1_900,
        dropReason: 'network_error',
        finalizedAt: 2_100,
      },
    }));
    const reportLangfuse = vi.fn(async () => ({
      langfuse_expected: true,
      langfuse_delivery_status: 'accepted' as const,
    }));

    await expect(reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse,
      runsLogDir: tmpDir,
    })).resolves.toMatchObject({ langfuseReplayed: 1 });

    expect(reportLangfuse).toHaveBeenCalledWith(expect.objectContaining({
      deliveryIdempotencyKey: 'od-run-telemetry-v1-preserved',
    }));
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')))
      .toMatchObject({
        langfuseCompletedAt: expect.any(Number),
        telemetryDelivery: {
          idempotencyKey: 'od-run-telemetry-v1-preserved',
          status: 'accepted',
          attemptCount: 2,
        },
      });
  });

  it('seeds every durable sibling fact before choosing the first Task representation', async () => {
    const writeRun = (runId: string, extra: Record<string, unknown> = {}) => {
      const runDir = path.join(tmpDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
        schemaVersion: 1,
        id: runId,
        projectId: 'p1',
        conversationId: 'c1',
        assistantMessageId: null,
        agentId: 'codex',
        status: 'succeeded',
        createdAt: 1_000,
        updatedAt: 2_000,
        ...extra,
      }));
    };
    writeRun('run-a-unmarked');
    writeRun('run-b-delivered', {
      langfuseCompletedAt: 2_100,
      telemetryDelivery: {
        version: 1,
        idempotencyKey: 'od-run-telemetry-v1-sibling',
        status: 'accepted',
        attemptCount: 1,
        crashWindow: false,
        startedAt: 1_900,
        finalizedAt: 2_100,
      },
    });
    const seeded: string[] = [];

    await reconcileDurableRunTerminals({
      analytics: { capture: vi.fn() },
      appVersion: '0.15.1',
      db,
      reportLangfuse: vi.fn(async () => ({
        langfuse_expected: true,
        langfuse_delivery_status: 'accepted' as const,
      })),
      seedTaskObservationRunFact: (runId) => { seeded.push(runId); },
      taskObservationRepresentationForRun: () => {
        expect(seeded).toEqual(['run-a-unmarked', 'run-b-delivered']);
        return 'single_run';
      },
      runsLogDir: tmpDir,
    });

    expect(seeded).toEqual(['run-a-unmarked', 'run-b-delivered']);
  });
});
