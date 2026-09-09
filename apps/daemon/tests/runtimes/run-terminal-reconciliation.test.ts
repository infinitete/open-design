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
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (_group, repair) => {
        await repair();
      },
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
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: reconcileGroups,
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
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => {
        groups.push(group.terminals.map(terminal => terminal.runId));
        await repair();
      },
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
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: reconcileGroups,
          }).localReady;

    expect(reconcileGroups).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT run_status AS status FROM messages WHERE id = 'm-resume'").get())
      .toEqual({ status: 'failed' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .not.toHaveProperty('pendingManualResumeAttemptCount');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')))
      .toMatchObject({ manualResumeAttemptCount: 0 });
  });

  it('groups durable local repairs by project before reporting readiness', async () => {
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
    const groups: Array<{ projectId: string; runs: string[] }> = [];
    const reconciliation = beginDurableRunTerminalReconciliation({
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => {
        groups.push({
          projectId: group.projectId,
          runs: group.terminals.map(item => `${item.runId}:${item.executionAttempt}`).sort(),
        });
        await repair();
      },
    });

    const local = await reconciliation.localReady;
    expect(local.messagesReconciled).toBe(3);
    expect(groups.sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual([
      { projectId: 'p1', runs: ['run-a:0', 'run-b:2'] },
      { projectId: 'p2', runs: ['run-c:0'] },
    ]);
    expect(db.prepare('SELECT run_status AS status FROM messages ORDER BY id').all())
      .toEqual([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]);
    await expect(reconciliation.delivery).resolves.toEqual(local);
  });

  it('groups orphan messages by persisted conversation project', async () => {
    db.prepare("INSERT INTO conversations (id, project_id) VALUES ('c1', 'p1')").run();
    db.prepare("INSERT INTO messages (id, conversation_id, run_id, run_status, events_json) VALUES ('m1', 'c1', 'orphan-run', 'running', '[]')").run();
    const groups: unknown[] = [];
    const reconciliation = beginDurableRunTerminalReconciliation({
      db, runsLogDir: tmpDir,
      reconcileTerminalsWithLocalRepair: async (group, repair) => { groups.push(group); await repair(); },
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

  it('fails an interrupted run and repairs its persisted message', async () => {
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
    }));
    db.prepare(`INSERT INTO messages (id, run_id, run_status, events_json)
      VALUES (?, ?, 'running', '[]')`).run('m1', runId);

    const first = await reconcileDurableRunTerminals({ db, runsLogDir: tmpDir });

    expect(first).toMatchObject({ interrupted: 1, messagesReconciled: 1 });
    expect(db.prepare(`SELECT run_status AS status, ended_at AS endedAt, events_json AS eventsJson FROM messages WHERE id = 'm1'`).get()).toMatchObject({
      status: 'failed',
      endedAt: expect.any(Number),
      eventsJson: expect.stringContaining('daemon restarted'),
    });
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'))).toMatchObject({
      status: 'failed',
      errorCode: 'DAEMON_RESTARTED',
    });

    await expect(reconcileDurableRunTerminals({ db, runsLogDir: tmpDir })).resolves.toMatchObject({
      interrupted: 0,
      messagesReconciled: 0,
    });
  });

  it('preserves the real failure when reconciling a running message with a durable failed run', async () => {
    const runId = 'run-auth-failed';
    const runDir = path.join(tmpDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const statePath = path.join(runDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
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
    }));
    db.prepare(`INSERT INTO messages (id, run_id, run_status, events_json)
      VALUES (?, ?, 'running', '[]')`).run('m1', runId);

    const result = await reconcileDurableRunTerminals({ db, runsLogDir: tmpDir });

    expect(result).toMatchObject({ interrupted: 0, messagesReconciled: 1 });
    const message = db.prepare(
      `SELECT run_status AS status, events_json AS eventsJson FROM messages WHERE id = 'm1'`,
    ).get() as { status: string; eventsJson: string };
    expect(message).toMatchObject({
      status: 'failed',
      eventsJson: expect.stringContaining('Authentication required before starting the session.'),
    });
    expect(message.eventsJson).not.toContain('daemon restarted');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      status: 'failed',
      error: 'Authentication required before starting the session.',
      errorCode: 'AGENT_AUTH_REQUIRED',
    });
  });

  it('repairs legacy queued messages even when no state journal exists', async () => {
    db.prepare(`INSERT INTO messages (id, run_id, run_status, events_json)
      VALUES (?, ?, 'queued', '[]')`).run('legacy-message', 'legacy-run');

    const result = await reconcileDurableRunTerminals({ db, runsLogDir: tmpDir });

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

    await reconcileDurableRunTerminals({ db, runsLogDir: tmpDir, finalizeTerminalLocally });

    expect(finalizeTerminalLocally.mock.calls.map(([run, status]) => ({
      id: run.id,
      status,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'run-canceled', status: 'canceled' },
      { id: 'run-failed', status: 'failed' },
      { id: 'run-succeeded', status: 'succeeded' },
    ]);
  });

});
