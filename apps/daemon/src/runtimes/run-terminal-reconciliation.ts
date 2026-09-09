import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
// TODO(contracts): keep — these type the durable Run's close-status
// classification fields, which are product diagnostics, not telemetry.
import type {
  TrackingRunCancelOrigin,
  TrackingRunTerminalTrigger,
} from '@open-design/contracts/analytics';

import { appendMessageStatusEvent } from '../db.js';
import { reconcileStrategyTaskRunTerminal } from '../strategies/task-store.js';
import {
  interruptDurableRunAfterDaemonRestart,
  RESTART_ERROR_CODE,
  RESTART_ERROR_MESSAGE,
  type RestartRecoverableDurableRunState,
} from './run-restart-recovery.js';
import type { RecoveredProjectTerminals } from '../services/project-mutation.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const RECONCILED_STATUS_MESSAGE = 'Run terminal state reconciled after daemon restart.';

interface DurableRunState extends RestartRecoverableDurableRunState {
  schemaVersion: 1;
  id: string;
  projectId: string | null;
  manualResumeAttemptCount?: number;
  pendingManualResumeAttemptCount?: number;
  conversationId: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  cancelOrigin?: TrackingRunCancelOrigin | null;
  terminalTrigger?: TrackingRunTerminalTrigger | null;
  createdAt: number;
  artifactCount?: number;
  endedWithUnfinishedWork?: boolean;
  userPrompt?: string;
  model?: string;
  resolvedModelId?: string;
  preflightAgentCliVersion?: string;
  reasoning?: string;
  skillId?: string;
  designSystemId?: string;
  designSystemDigest?: string;
  designSystemSelectionSource?: string;
  clientType?: 'desktop' | 'web' | 'unknown';
  analyticsTelemetry?: Record<string, unknown>;
  promptTelemetry?: Record<string, unknown>;
  promptCache?: Record<string, unknown>;
}

interface ReconciliationOptions {
  db: Database.Database;
  runsLogDir: string;
  finalizeTerminalLocally?: (run: DurableRunState, status: string, terminalAt: number) => void;
  reconcileTerminalsWithLocalRepair?: (
    group: RecoveredProjectTerminals,
    repair: () => Promise<void>,
  ) => Promise<void>;
  onLocalReady?: (result: RunTerminalReconciliationResult) => void;
}

export interface RunTerminalReconciliationResult {
  scanned: number;
  interrupted: number;
  messagesReconciled: number;
  strategyTasksReconciled: number;
}

export function beginDurableRunTerminalReconciliation(
  options: Omit<ReconciliationOptions, 'onLocalReady'>,
): {
  localReady: Promise<RunTerminalReconciliationResult>;
  delivery: Promise<RunTerminalReconciliationResult>;
} {
  let localSettled = false;
  let resolveLocal!: (result: RunTerminalReconciliationResult) => void;
  let rejectLocal!: (error: unknown) => void;
  const localReady = new Promise<RunTerminalReconciliationResult>((resolve, reject) => {
    resolveLocal = resolve;
    rejectLocal = reject;
  });
  const delivery = reconcileDurableRunTerminals({
    ...options,
    onLocalReady(result) {
      localSettled = true;
      resolveLocal(result);
    },
  });
  void delivery.catch(error => {
    if (!localSettled) rejectLocal(error);
  });
  return { localReady, delivery };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readState(filePath: string): DurableRunState | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isObject(value) || value.schemaVersion !== 1) return null;
    if (typeof value.id !== 'string' || typeof value.status !== 'string') return null;
    if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return null;
    return value as unknown as DurableRunState;
  } catch {
    return null;
  }
}

function writeState(filePath: string, state: DurableRunState): boolean {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    return false;
  }
}

function reconcileMessages(
  db: Database.Database,
  statesByRunId: Map<string, DurableRunState>,
  now: number,
): number {
  let rows: Array<{ id: string; runId: string | null }> = [];
  try {
    rows = db.prepare(
      `SELECT id, run_id AS runId
         FROM messages
        WHERE run_status IN ('queued', 'running')`,
    ).all() as Array<{ id: string; runId: string | null }>;
  } catch {
    return 0;
  }
  for (const row of rows) {
    const state = row.runId ? statesByRunId.get(row.runId) : undefined;
    const status = state && TERMINAL_STATUSES.has(state.status) ? state.status : 'failed';
    db.prepare(
      `UPDATE messages
          SET run_status = ?, ended_at = COALESCE(ended_at, ?)
        WHERE id = ? AND run_status IN ('queued', 'running')`,
    ).run(status, state?.updatedAt ?? now, row.id);
    const isDaemonRestart = state?.terminalRecoveryReason === 'daemon_restart'
      || state?.errorCode === RESTART_ERROR_CODE;
    appendMessageStatusEvent(db, row.id, status === 'failed'
      ? {
          label: 'error',
          detail: isDaemonRestart
            ? RESTART_ERROR_MESSAGE
            : state?.error ?? RECONCILED_STATUS_MESSAGE,
        }
      : { label: status, detail: RECONCILED_STATUS_MESSAGE });
  }
  return rows.length;
}

function reconcileMessageForTerminal(
  db: Database.Database,
  state: DurableRunState,
  now: number,
): number {
  if (!state.assistantMessageId) return 0;
  const changed = db.prepare(
    `UPDATE messages
        SET run_status = ?, ended_at = COALESCE(ended_at, ?)
      WHERE id = ? AND run_id = ? AND run_status IN ('queued', 'running')`,
  ).run(state.status, state.terminalAt ?? state.updatedAt ?? now, state.assistantMessageId, state.id).changes;
  if (!changed) return 0;
  const isDaemonRestart = state.terminalRecoveryReason === 'daemon_restart'
    || state.errorCode === RESTART_ERROR_CODE;
  appendMessageStatusEvent(db, state.assistantMessageId, state.status === 'failed'
    ? {
        label: 'error',
        detail: isDaemonRestart ? RESTART_ERROR_MESSAGE : state.error ?? RECONCILED_STATUS_MESSAGE,
      }
    : { label: state.status, detail: RECONCILED_STATUS_MESSAGE });
  return 1;
}

function activeMessageRows(db: Database.Database): Array<{
  id: string;
  runId: string | null;
  projectId: string | null;
}> {
  try {
    return db.prepare(
      `SELECT m.id, m.run_id AS runId, c.project_id AS projectId
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.run_status IN ('queued', 'running')`,
    ).all() as Array<{ id: string; runId: string | null; projectId: string | null }>;
  } catch {
    return [];
  }
}

async function reconcileProjectTerminalLocals(
  options: ReconciliationOptions,
  states: Array<{ filePath: string; state: DurableRunState }>,
  result: RunTerminalReconciliationResult,
  now: number,
): Promise<void> {
  const reconcile = options.reconcileTerminalsWithLocalRepair;
  if (!reconcile) {
    const statesByRunId = new Map(states.map(entry => [entry.state.id, entry.state]));
    result.messagesReconciled = reconcileMessages(options.db, statesByRunId, now);
    for (const { state } of states) {
      if (state.status !== 'failed' && state.status !== 'canceled') continue;
      if (reconcileStrategyTaskRunTerminalIsolated(options.db, {
        runId: state.id,
        status: state.status,
        updatedAt: state.updatedAt,
      })) result.strategyTasksReconciled += 1;
    }
    for (const { state } of states) {
      if (!TERMINAL_STATUSES.has(state.status)) continue;
      try { options.finalizeTerminalLocally?.(state, state.status, state.terminalAt ?? state.updatedAt); }
      catch (error) { console.warn('[runs] terminal local finalizer failed during restart reconciliation', error); }
    }
    return;
  }

  const terminalStates = states.map(entry => entry.state).filter(state => TERMINAL_STATUSES.has(state.status));
  const durableRunIds = new Set(terminalStates.map(state => state.id));
  const groups = new Map<string, {
    group: RecoveredProjectTerminals;
    states: Array<{
      filePath: string;
      state: DurableRunState;
      pendingExecutionAttempt?: number;
    }>;
  }>();
  for (const entry of states.filter(({ state }) => TERMINAL_STATUSES.has(state.status))) {
    const { filePath, state } = entry;
    if (!state.projectId) continue;
    const completedExecutionAttempt = Number.isSafeInteger(state.manualResumeAttemptCount)
      && state.manualResumeAttemptCount! >= 0
      ? state.manualResumeAttemptCount! : 0;
    const pendingExecutionAttempt = Number.isSafeInteger(state.pendingManualResumeAttemptCount)
      && state.pendingManualResumeAttemptCount! > completedExecutionAttempt
      ? state.pendingManualResumeAttemptCount! : undefined;
    let pendingClaimActive = false;
    let pendingClaimKnown = true;
    if (pendingExecutionAttempt !== undefined && state.assistantMessageId && state.conversationId) {
      try {
        pendingClaimActive = Boolean(options.db.prepare(
          `SELECT 1 FROM messages
            WHERE id = ? AND conversation_id = ? AND role = 'assistant'
              AND run_id = ? AND run_status IN ('queued', 'running')`,
        ).get(state.assistantMessageId, state.conversationId, state.id));
      } catch {
        pendingClaimKnown = false;
      }
    }
    if (pendingExecutionAttempt !== undefined && !pendingClaimKnown) continue;
    if (state.pendingManualResumeAttemptCount !== undefined
      && (pendingExecutionAttempt === undefined || (pendingClaimKnown && !pendingClaimActive))) {
      delete state.pendingManualResumeAttemptCount;
      writeState(filePath, state);
    }
    const executionAttempt = pendingClaimActive
      ? pendingExecutionAttempt!
      : completedExecutionAttempt;
    const key = JSON.stringify([state.projectId]);
    const current = groups.get(key) ?? {
      group: { projectId: state.projectId, terminals: [] },
      states: [],
    };
    current.states.push({
      filePath,
      state,
      ...(pendingClaimActive ? { pendingExecutionAttempt: executionAttempt } : {}),
    });
    current.group = {
      ...current.group,
      terminals: [...current.group.terminals, {
        runId: state.id,
        executionAttempt,
        terminal: state.status,
      }],
    };
    groups.set(key, current);
  }
  for (const { group, states: groupedStates } of groups.values()) {
    try {
      await reconcile(group, async () => {
        for (const entry of groupedStates) {
          if (entry.pendingExecutionAttempt === undefined) continue;
          entry.state.manualResumeAttemptCount = entry.pendingExecutionAttempt;
          delete entry.state.pendingManualResumeAttemptCount;
          if (!writeState(entry.filePath, entry.state)) {
            throw new Error(`Failed to promote resumed run attempt ${entry.state.id}.`);
          }
        }
        for (const { state } of groupedStates) {
          result.messagesReconciled += reconcileMessageForTerminal(options.db, state, now);
          if ((state.status === 'failed' || state.status === 'canceled')
            && reconcileStrategyTaskRunTerminalIsolated(options.db, {
              runId: state.id,
              status: state.status,
              updatedAt: state.updatedAt,
            })) result.strategyTasksReconciled += 1;
        }
      });
    } catch (error) {
      console.warn('[runs] project terminal local reconciliation deferred', group.projectId, error);
    }
  }

  const orphanGroups = new Map<string, {
    group: RecoveredProjectTerminals;
    rows: ReturnType<typeof activeMessageRows>;
  }>();
  for (const row of activeMessageRows(options.db)) {
    if (!row.projectId || (row.runId && durableRunIds.has(row.runId))) continue;
    const key = JSON.stringify([row.projectId]);
    const current = orphanGroups.get(key) ?? {
      group: { projectId: row.projectId, terminals: [] },
      rows: [],
    };
    const runId = row.runId || `orphan-message:${row.id}`;
    current.rows.push(row);
    current.group = {
      ...current.group,
      terminals: [...current.group.terminals, { runId, executionAttempt: 0, terminal: 'failed' }],
    };
    orphanGroups.set(key, current);
  }
  for (const { group, rows } of orphanGroups.values()) {
    try {
      await reconcile(group, async () => {
        for (const row of rows) {
          const changed = options.db.prepare(
            `UPDATE messages SET run_status = 'failed', ended_at = COALESCE(ended_at, ?)
              WHERE id = ? AND run_status IN ('queued', 'running')`,
          ).run(now, row.id).changes;
          if (!changed) continue;
          appendMessageStatusEvent(options.db, row.id, { label: 'error', detail: RECONCILED_STATUS_MESSAGE });
          result.messagesReconciled += 1;
        }
      });
    } catch (error) {
      console.warn('[runs] orphan message terminal reconciliation deferred', group.projectId, error);
    }
  }
}

/**
 * Reconcile one Run's strategy-task terminal, absorbing any failure to read
 * that single record.
 *
 * Startup reconciliation owes EVERY Run its terminal obligation: message
 * repair and strategy-task closure. A task row whose persisted Prompt Bundle
 * can no longer be parsed is one Run's problem, and must never cancel the
 * obligation owed to its siblings — `strategyTaskTurnsForRunIds` already
 * holds this invariant for the message list. Returns whether the record was
 * reconciled; an unreadable record counts as not reconciled rather than
 * as a batch-ending error.
 */
function reconcileStrategyTaskRunTerminalIsolated(
  db: Parameters<typeof reconcileStrategyTaskRunTerminal>[0],
  input: Parameters<typeof reconcileStrategyTaskRunTerminal>[1],
): boolean {
  try {
    return reconcileStrategyTaskRunTerminal(db, input);
  } catch (error) {
    console.warn('[runs] strategy task terminal reconciliation skipped', input.runId, error);
    return false;
  }
}

export async function reconcileDurableRunTerminals(
  options: ReconciliationOptions,
): Promise<RunTerminalReconciliationResult> {
  const result: RunTerminalReconciliationResult = {
    scanned: 0,
    interrupted: 0,
    messagesReconciled: 0,
    strategyTasksReconciled: 0,
  };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(options.runsLogDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const states = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      filePath: path.join(options.runsLogDir, entry.name, 'state.json'),
      state: readState(path.join(options.runsLogDir, entry.name, 'state.json')),
    }))
    .filter((entry): entry is { filePath: string; state: DurableRunState } => entry.state !== null);
  result.scanned = states.length;
  const now = Date.now();

  for (const entry of states) {
    if (!interruptDurableRunAfterDaemonRestart(entry.state, now)) continue;
    writeState(entry.filePath, entry.state);
    result.interrupted += 1;
  }

  // Local portable repairs and their terminal receipts converge before the
  // daemon admits requests.
  await reconcileProjectTerminalLocals(options, states, result, now);

  options.onLocalReady?.({ ...result });

  return result;
}
