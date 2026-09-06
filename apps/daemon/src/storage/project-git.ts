import { createHash, randomUUID } from 'node:crypto';
import { parsePortableSnapshot, ProjectGitDependencySchema } from '@open-design/contracts';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type {
  ApiError, JsonValue, ProjectGitAction, ProjectGitBasis, ProjectGitDependency, ProjectGitOperation,
  ProjectGitOperationResult, ProjectGitOperationStatus, ProjectGitPhase,
} from '@open-design/contracts';
import { GitDomainError } from '../services/project-git/errors.js';

/** Private local binding. Never return this record from HTTP or write it to portable content. */
export interface ProjectGitBindingRecord {
  projectId: string;
  cloneId: string;
  repositoryProjectId: string;
  canonicalRoot: string;
  commonDir: string;
  branch: string;
  /** Actual local writable ref. Older records default to branch (the remote target). */
  localBranch?: string;
  remoteUrl: string | null;
  generation: number;
  autoSync: boolean;
  localHead: string | null;
  observedRemoteHead: string | null;
  confirmedRemoteHead: string | null;
  projectRevision: number;
  contentRevision: number;
  exportedContentRevision: number;
  materializedHead: string | null;
  dirty: boolean;
}

/** Private immutable admission journal; paths and owners originate only in the trusted registry. */
export interface ProjectGitRegistrationIntent {
  kind: 'enable' | 'bind' | 'open' | 'unbind';
  completion: 'materialization' | 'checkpoint' | 'binding_only';
  userOperationId: string; executionOperationId: string;
  projectId: string; cloneId: string; repositoryProjectId: string; dataRootId: string;
  canonicalRoot: string; commonDir: string; localBranch: string; targetBranch: string;
  remoteUrl: string | null; autoSync: boolean; hidden: boolean;
  originalUserBasis: ProjectGitBasis; executionBasis: ProjectGitBasis;
  previousOwner: { ref: string; oid: string; generation: number } | null;
  targetOwner: { ref: string; expectedOid: string | null; oid: string; generation: number };
  initialImport?: { candidateOid: string; rootDev: string; rootIno: string };
  materialization?: { candidateOid: string; publicationMode: 'commit' | 'fast_forward'; previewContentDigest: string };
  existingProjectIds?: string[];
  dependencies?: ProjectGitDependency[];
}
export interface ProjectGitRegistrationRecord extends ProjectGitRegistrationIntent {
  state: 'pending' | 'complete' | 'aborted';
}
export interface ProjectGitOpenPreparation {
  root?: { dev: string; ino: string };
  candidate?: { candidateOid: string; repositoryProjectId: string; canonicalSnapshotJson: string; snapshotDigest: string };
}
export interface ProjectGitEnableInitialization {
  projectId: string; canonicalRoot: string; dev: string; ino: string; branch: string; objectFormat: 'sha1' | 'sha256';
  previewId: string; previewEvidenceDigest: string; basis: ProjectGitBasis;
}

export type ProjectGitIdKind = 'project' | 'conversation' | 'message' | 'turn';
export type ProjectGitJournalPhase = 'prepared' | 'protected' | 'files_applied' | 'records_applied'
  | 'ref_published' | 'index_published' | 'complete';

export interface ProjectGitRecoveryPath {
  path: string;
  oldDigest: string | null;
  candidateDigest: string | null;
  backupPath: string | null;
  protected: boolean;
  applied: boolean;
}

/** Server supplies all machine-local paths. Intent identity is immutable once prepared. */
export interface ProjectGitRecoveryData {
  /** Missing on older journals means the original direct-parent commit protocol. */
  publicationMode?: 'commit' | 'fast_forward' | 'initial_import';
  operationRoot: string;
  baseHead: string | null;
  previewContentDigest: string;
  candidateTreeOid: string;
  publishBase: string | null;
  publicationParents: string[];
  publishHead: string;
  candidateOid: string;
  paths: ProjectGitRecoveryPath[];
  index: {
    path: string;
    oldDigest: string | null;
    candidateDigest: string;
    backupPath: string | null;
    ownerToken: string;
    published: boolean;
  };
  records: { importMarker: string; applied: boolean; mode?: 'replace' | 'preserve' } | null;
  refPublished: boolean;
}

export interface ProjectGitOperationInput {
  projectId: string | null;
  actorId: string;
  kind: ProjectGitAction['kind'];
  idempotencyKey: string;
  requestDigest: string;
  payload: JsonValue;
  /** Required for an enabled project; never substitute a fresh basis for a stale request. */
  basis?: ProjectGitBasis;
}

export interface ProjectGitCheckpointInput extends Omit<ProjectGitOperationInput, 'kind' | 'projectId' | 'basis'> {
  projectId: string;
  basis: ProjectGitBasis;
  ownerOperationId?: string;
}

export interface ProjectGitRecordsCompletion {
  basis: ProjectGitBasis;
  importMarker: string | null;
  advanceProjectRevision: boolean;
}

export interface ProjectGitRecordsTransition {
  importMarker: string | null;
  advanceProjectRevision: boolean;
  projectRevision: number;
}

export interface ProjectGitProtectionInput {
  basis: ProjectGitBasis;
  checkpointOperationId: string;
  checkpointOid: string;
}

export interface ProjectGitProtectedCandidate {
  previewContentDigest: string;
  candidateTreeOid: string;
  publishBase: string;
  publicationParents: string[];
  candidateOid: string;
  publishHead: string;
}

export interface ProjectGitProtectionRecord {
  checkpointOperationId: string;
  checkpointOid: string;
  completed: boolean;
  publishBase: string | null;
  sealedCandidate: ProjectGitProtectedCandidate | null;
}

/** Private journal, deliberately not assignable to the public operation DTO. */
export interface ProjectGitJournalRecord extends Omit<ProjectGitOperation, 'kind'> {
  kind: ProjectGitAction['kind'] | 'checkpoint';
  actorId: string;
  scope: string;
  idempotencyKey: string;
  requestDigest: string;
  payload: JsonValue;
  journalPhase: ProjectGitJournalPhase | null;
  phaseCompleted: boolean;
  recoveryData: ProjectGitRecoveryData | null;
  completedProjectRevision: number | null;
  ownerOperationId: string | null;
  recordsTransition: ProjectGitRecordsTransition | null;
  protection: ProjectGitProtectionRecord | null;
  createdAt: number;
  updatedAt: number;
}

/** Only already-sanitized public result/error fields belong here, never raw Git/process errors. */
export interface ProjectGitOperationUpdate {
  status: ProjectGitOperationStatus;
  phase: ProjectGitPhase;
  result: ProjectGitOperationResult | null;
  error: ApiError | null;
}

export interface ProjectGitRetryAttempt {
  operationId: string;
  attempt: number;
  state: 'admitted' | 'started' | 'settled';
  priorStatus: ProjectGitOperationStatus;
  priorPhase: ProjectGitPhase;
  priorResult: ProjectGitOperationResult | null;
  priorError: ApiError | null;
}

export interface ProjectGitPushRecord {
  projectId: string;
  generation: number;
  targetOid: string;
  attempts: number;
  nextAttemptAt: number;
}

export interface ProjectGitMaterializationCompletion {
  /** Trusted terminal inventory observation, supported only by restore journals. */
  remainingDirty?: boolean;
  basis: ProjectGitBasis;
  /** Must match the prior records transition; final completion never increments the baseline. */
  advanceProjectRevision: boolean;
}

export interface ProjectGitBindingTombstone {
  generation: number;
  projectRevision: number;
  contentRevision: number;
}

export interface ProjectGitStore {
  freezeOpenPreparation(operationId: string, preparation: ProjectGitOpenPreparation): void;
  getOpenPreparation(operationId: string): ProjectGitOpenPreparation | null;
  freezeEnableInitialization(operationId: string, initialization: ProjectGitEnableInitialization): void;
  getEnableInitialization(operationId: string): ProjectGitEnableInitialization | null;
  freezeOpenRemote(operationId: string, remote: { head: string | null; objectFormat: 'sha1' | 'sha256' }): void;
  getOpenRemote(operationId: string): { head: string | null; objectFormat: 'sha1' | 'sha256' } | null;
  consumePreview(previewOperationId: string, consumerOperationId: string): void;
  prepareRegistration(intent: ProjectGitRegistrationIntent): void;
  getRegistration(executionOperationId: string): ProjectGitRegistrationRecord | null;
  listPendingRegistrations(): ProjectGitRegistrationRecord[];
  /** Called only by an owned synchronous terminal closure inside the same database transaction. */
  completeRegistration(intent: ProjectGitRegistrationIntent): ProjectGitBindingRecord;
  abortRegistration(intent: ProjectGitRegistrationIntent, error: ApiError): void;
  /** Transaction identity, not merely a matching SQLite filename. */
  assertDatabase(database: Database.Database): void;
  getBinding(projectId: string): ProjectGitBindingRecord | null;
  listBindings(): ProjectGitBindingRecord[];
  getBindingGeneration(projectId: string): number;
  getBindingTombstone(projectId: string): ProjectGitBindingTombstone | null;
  /** First create expects generation 0. Rebind expects tombstone generation. Target changes increment it.
   * Existing saves CAS revisions and preserve runtime heads/dirty/export facts; use the narrow ports below. */
  saveBinding(binding: ProjectGitBindingRecord): ProjectGitBindingRecord;
  assertRevision(projectId: string, expected: number | undefined): void;
  bumpContent(projectId: string, expected: ProjectGitBasis): number;
  /** Atomically receipts one physical run terminal and marks its managed project dirty once. */
  recordRunTerminal(input: {
    runId: string;
    executionAttempt: number;
    projectId: string;
    bindingGeneration: number;
    projectRevision: number;
    terminal: string;
  }): boolean;
  bumpProject(projectId: string, expected: ProjectGitBasis): number;
  markExported(projectId: string, expected: Pick<ProjectGitBasis, 'bindingGeneration' | 'projectRevision'>, contentRevision: number): void;
  /** Trusted caller proves idle descendant HEAD and unchanged portable tree under the registered gate. */
  adoptExternalHead(projectId: string, expected: ProjectGitBasis, oid: string): void;
  observeRemote(projectId: string, generation: number, oid: string | null): void;
  /** Full local registration invalidation. HTTP remote unbind instead saves remoteUrl:null, retaining management. */
  invalidateBinding(projectId: string, expected: ProjectGitBasis): number;
  mapId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, portableId: string): string;
  attachId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, portableId: string, localId: string): string;
  getPortableId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, localId: string): string | null;
  enqueueOperation(input: ProjectGitOperationInput): ProjectGitOperation;
  enqueueCheckpoint(input: ProjectGitCheckpointInput): ProjectGitJournalRecord;
  getOperation(id: string): ProjectGitOperation | null;
  getLatestProjectOperation(projectId: string): ProjectGitOperation | null;
  /** Freezes a private conflict artifact reference without exposing it through the public operation DTO. */
  freezeConflictEvidence(operationId: string, basis: ProjectGitBasis, evidence: { path: string; digest: string }): void;
  getConflictResolutionOwner(conflictOperationId: string): string | null;
  markRetainedConflictStale(operationId: string): void;
  supersedeRetainedConflict(staleOperationId: string, replacementOperationId: string,
    replacement: Pick<ProjectGitOperationUpdate, 'result' | 'error'>): void;
  findOperation(input: Pick<ProjectGitOperationInput, 'actorId' | 'projectId' | 'kind' | 'idempotencyKey'>): ProjectGitJournalRecord | null;
  findOperationRequest(input: { actorId: string; projectId: string | null; action: 'retry'; idempotencyKey: string }):
    { operationId: string; requestDigest: string } | null;
  claimOperationRequest(input: { actorId: string; projectId: string | null; action: 'retry'; idempotencyKey: string;
    requestDigest: string; operationId: string }): { operationId: string; requestDigest: string; created: boolean;
      admitted: boolean; attempt: number };
  getRetryAttempt(operationId: string): ProjectGitRetryAttempt | null;
  listActiveRetryAttempts(): ProjectGitRetryAttempt[];
  startRetryAttempt(operationId: string, attempt: number): boolean;
  settleRetryAttempt(operationId: string, attempt: number): void;
  /** Settles bootstrap-owned retry attempts that cannot be resumed without guessing prior effects. */
  reconcileInterruptedRetryAttempts(operationIds?: ReadonlySet<string>): string[];
  getJournal(id: string): ProjectGitJournalRecord | null;
  /** Associate a reserved import ID before prepared; does not create or expose an application project row. */
  attachOperationProject(id: string, projectId: string, basis: ProjectGitBasis): void;
  /** Replaces admission-only request payload before any recovery phase or terminal settlement exists. */
  replaceAdmittedOperationPayload(id: string, payload: JsonValue, basis?: ProjectGitBasis): void;
  /** Closes a worker that failed before it established an owned recovery/registration intent. */
  settleAdmittedOperationFailure(id: string, error: ApiError): void;
  /** Closes crash-stranded admission-only work before runtime schedulers can observe it. */
  reconcileInterruptedAdmissions(operationIds?: ReadonlySet<string>): string[];
  updateOperation(id: string, update: ProjectGitOperationUpdate): void;
  listPendingOperations(): ProjectGitJournalRecord[];
  /** Writes intent BEFORE the effect; completePhase separately records verified completion. */
  setPhase(id: string, phase: Exclude<ProjectGitJournalPhase, 'complete'>, recoveryData: ProjectGitRecoveryData): void;
  completePhase(id: string, phase: Exclude<ProjectGitJournalPhase, 'complete'>, recoveryData: ProjectGitRecoveryData): void;
  /** Owns import + marker + revision atomically. The synchronous callback runs only for a declared non-null import. */
  completeRecords(id: string, input: ProjectGitRecordsCompletion, applyRecords: () => undefined): number;
  prepareProtection(id: string, input: ProjectGitProtectionInput): void;
  completeProtection(id: string, input: ProjectGitProtectionInput): void;
  sealProtectedCandidate(id: string, basis: ProjectGitBasis, candidate: ProjectGitProtectedCandidate): void;
  listRecoverable(): ProjectGitJournalRecord[];
  completeMaterialization(id: string, input: ProjectGitMaterializationCompletion): number;
  /** Completes the resolve materialization and its retained conflict in one SQLite transaction. */
  completeConflictResolution(resolveOperationId: string, conflictOperationId: string, input: ProjectGitMaterializationCompletion): number;
  queuePush(projectId: string, generation: number, oid: string): ProjectGitPushRecord;
  listDuePushes(now: number): ProjectGitPushRecord[];
  deferPush(projectId: string, generation: number, oid: string, nextAttemptAt: number): boolean;
  ackPush(projectId: string, generation: number, oid: string): boolean;
}

interface BindingRow {
  record_json: string;
  generation: number;
  active: number;
  project_revision: number;
  content_revision: number;
  exported_content_revision: number;
}
interface OperationRow {
  id: string; actor_id: string; scope: string; kind: ProjectGitJournalRecord['kind'];
  idempotency_key: string; request_digest: string; project_id: string | null; basis_json: string;
  payload_json: string; status: ProjectGitOperationStatus; phase: ProjectGitPhase;
  result_json: string | null; error_json: string | null; journal_phase: ProjectGitJournalPhase | null;
  phase_completed: number; recovery_json: string | null; completed_project_revision: number | null; created_at: number; updated_at: number;
  records_transition_json: string | null; protection_json: string | null; owner_operation_id: string | null;
}
interface RetryAttemptRow {
  operation_id: string;
  attempt: number;
  state: ProjectGitRetryAttempt['state'];
  prior_status: ProjectGitOperationStatus;
  prior_phase: ProjectGitPhase;
  prior_result_json: string | null;
  prior_error_json: string | null;
}
const phases: ProjectGitJournalPhase[] = ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete'];
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The project state changed. Refresh and retry.');
const conflict = () => new GitDomainError('CONFLICT', 409, 'The durable operation conflicts with existing state.');
const recoveryRequired = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'The journal requires recovery before completion.');
const json = (value: unknown) => JSON.stringify(value);
function canonicalPayloadJson(value: JsonValue): string {
  const normalize = (item: JsonValue): JsonValue => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key]!)])) : item;
  return JSON.stringify(normalize(value)) + '\n';
}

function bindingFrom(row: BindingRow): ProjectGitBindingRecord {
  return { ...JSON.parse(row.record_json) as ProjectGitBindingRecord, generation: row.generation,
    projectRevision: row.project_revision, contentRevision: row.content_revision,
    exportedContentRevision: row.exported_content_revision };
}
function journalFrom(row: OperationRow): ProjectGitJournalRecord {
  return { id: row.id, actorId: row.actor_id, scope: row.scope, kind: row.kind,
    idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, projectId: row.project_id,
    basis: JSON.parse(row.basis_json), payload: JSON.parse(row.payload_json), status: row.status, phase: row.phase,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error_json === null ? null : JSON.parse(row.error_json), journalPhase: row.journal_phase,
    phaseCompleted: row.phase_completed === 1, recoveryData: row.recovery_json === null ? null : JSON.parse(row.recovery_json),
    completedProjectRevision: row.completed_project_revision,
    ownerOperationId: row.owner_operation_id,
    recordsTransition: row.records_transition_json === null ? null : JSON.parse(row.records_transition_json),
    protection: row.protection_json === null ? null : JSON.parse(row.protection_json),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function publicOperation(record: ProjectGitJournalRecord): ProjectGitOperation | null {
  if (record.kind === 'checkpoint') return null;
  return { id: record.id, kind: record.kind, status: record.status, phase: record.phase,
    projectId: record.projectId, basis: record.basis, result: record.result, error: record.error };
}
function sameBasis(a: ProjectGitBasis, b: ProjectGitBasis): boolean {
  return a.bindingGeneration === b.bindingGeneration && a.projectRevision === b.projectRevision
    && a.contentRevision === b.contentRevision && a.localHead === b.localHead && a.remoteHead === b.remoteHead;
}
function basisFor(b: ProjectGitBindingRecord): ProjectGitBasis {
  return { bindingGeneration: b.generation, projectRevision: b.projectRevision,
    contentRevision: b.contentRevision, localHead: b.localHead, remoteHead: b.observedRemoteHead };
}

/** Completions may add facts, but must not erase facts or replace the prepared intent. */
function validateRecovery(previous: ProjectGitRecoveryData | null, next: ProjectGitRecoveryData): void {
  const mode = next.publicationMode ?? 'commit';
  if (!['commit', 'fast_forward', 'initial_import'].includes(mode) || (mode === 'fast_forward' && next.baseHead === null)
    || (mode === 'initial_import' && next.baseHead !== null)
    || !next.operationRoot || !next.candidateOid || !next.publishHead || !next.index.ownerToken
    || !next.previewContentDigest || !next.candidateTreeOid || next.publishBase !== next.baseHead
    || next.publishHead !== next.candidateOid || new Set(next.publicationParents).size !== next.publicationParents.length
    || (mode === 'commit' && next.baseHead !== null && next.publicationParents.filter(parent => parent === next.baseHead).length !== 1)
    || new Set(next.paths.map(p => p.path)).size !== next.paths.length
    || next.paths.some(p => p.oldDigest !== null && !p.backupPath)
    || (next.index.oldDigest !== null && !next.index.backupPath)) throw recoveryRequired();
  if (!previous) return;
  const identity = (data: ProjectGitRecoveryData) => ({ ...data, refPublished: false,
    paths: data.paths.map(p => ({ ...p, protected: false, applied: false })),
    index: { ...data.index, published: false }, records: data.records && { ...data.records, applied: false } });
  if (!isDeepStrictEqual(identity(previous), identity(next)) || (previous.refPublished && !next.refPublished)
    || (previous.index.published && !next.index.published)
    || (previous.records?.applied && !next.records?.applied)
    || previous.paths.some((p, i) => (p.protected && !next.paths[i]!.protected) || (p.applied && !next.paths[i]!.applied))) {
    throw recoveryRequired();
  }
}

export function createProjectGitStore(db: Database.Database): ProjectGitStore {
  const bindingRow = (id: string) => db.prepare('SELECT * FROM project_git_bindings WHERE project_id = ?').get(id) as BindingRow | undefined;
  const getBinding = (id: string) => { const row = bindingRow(id); return row?.active ? bindingFrom(row) : null; };
  const getJournal = (id: string) => {
    const row = db.prepare('SELECT * FROM project_git_operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? journalFrom(row) : null;
  };
  const getRetryAttempt = (operationId: string): ProjectGitRetryAttempt | null => {
    const row = db.prepare('SELECT * FROM project_git_retry_attempts WHERE operation_id = ?').get(operationId) as RetryAttemptRow | undefined;
    return row ? {
      operationId: row.operation_id,
      attempt: row.attempt,
      state: row.state,
      priorStatus: row.prior_status,
      priorPhase: row.prior_phase,
      priorResult: row.prior_result_json === null ? null : JSON.parse(row.prior_result_json),
      priorError: row.prior_error_json === null ? null : JSON.parse(row.prior_error_json),
    } : null;
  };
  function requireGeneration(id: string, generation: number): ProjectGitBindingRecord {
    const b = getBinding(id); if (!b || b.generation !== generation) throw changed(); return b;
  }
  function getRegistration(id: string): ProjectGitRegistrationRecord | null {
    const row = db.prepare('SELECT intent_json, state FROM project_git_registrations WHERE execution_operation_id = ?').get(id) as
      { intent_json: string; state: ProjectGitRegistrationRecord['state'] } | undefined;
    return row ? { ...JSON.parse(row.intent_json) as ProjectGitRegistrationIntent, state: row.state } : null;
  }
  function requireRegistration(intent: ProjectGitRegistrationIntent): ProjectGitRegistrationRecord {
    const record = getRegistration(intent.executionOperationId);
    if (!record) throw recoveryRequired();
    const { state: _state, ...original } = record;
    if (!isDeepStrictEqual(original, intent)) throw recoveryRequired();
    return record;
  }
  function requireBasis(id: string, expected: ProjectGitBasis): ProjectGitBindingRecord {
    const b = requireGeneration(id, expected.bindingGeneration);
    if (!sameBasis(basisFor(b), expected)) throw changed(); return b;
  }
  function ownedBasis(op: ProjectGitJournalRecord): ProjectGitBasis {
    return { ...op.basis, projectRevision: op.recordsTransition?.projectRevision ?? op.basis.projectRevision,
      localHead: op.protection?.completed ? op.protection.checkpointOid : op.basis.localHead };
  }
  function protectionPair(id: string, input: ProjectGitProtectionInput) {
    const op = getJournal(id); const checkpoint = getJournal(input.checkpointOperationId);
    if (!op?.projectId || !op.recoveryData || !sameBasis(op.basis, input.basis)) throw changed();
    if (['fast_forward', 'initial_import'].includes(op.recoveryData.publicationMode ?? '')) throw recoveryRequired();
    if (op.kind === 'checkpoint' || !checkpoint?.recoveryData || checkpoint.kind !== 'checkpoint'
      || checkpoint.ownerOperationId !== op.id || checkpoint.projectId !== op.projectId
      || !sameBasis(checkpoint.basis, op.basis) || checkpoint.recoveryData.publishHead !== input.checkpointOid
      || checkpoint.recoveryData.candidateOid !== input.checkpointOid
      || checkpoint.recoveryData.previewContentDigest !== op.recoveryData.previewContentDigest
      || !isDeepStrictEqual(checkpoint.recoveryData.publicationParents, op.basis.localHead === null ? [] : [op.basis.localHead])) {
      throw recoveryRequired();
    }
    return { op, checkpoint };
  }
  function writeProtection(id: string, protection: ProjectGitProtectionRecord): void {
    db.prepare('UPDATE project_git_operations SET protection_json = ?, updated_at = ? WHERE id = ?').run(json(protection), Date.now(), id);
  }
  function updateBindingData(b: ProjectGitBindingRecord): void {
    db.prepare('UPDATE project_git_bindings SET record_json = ? WHERE project_id = ? AND generation = ?')
      .run(json(b), b.projectId, b.generation);
  }
  const transaction = <T>(work: () => T): T => db.transaction(work).immediate();

  function attachId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, portableId: string, localId?: string): string {
    return transaction(() => {
      const mismatchedKind = kind === 'turn' ? undefined : db.prepare("SELECT 1 FROM project_git_id_map WHERE repository_project_id = ? AND portable_id = ? AND kind != ? AND kind != 'turn' LIMIT 1")
        .get(repositoryProjectId, portableId, kind);
      if (mismatchedKind) throw conflict();
      const current = db.prepare('SELECT local_id FROM project_git_id_map WHERE repository_project_id = ? AND clone_id = ? AND kind = ? AND portable_id = ?')
        .get(repositoryProjectId, cloneId, kind, portableId) as { local_id: string } | undefined;
      if (current) { if (localId && localId !== current.local_id) throw conflict(); return current.local_id; }
      const target = localId ?? randomUUID();
      const reverse = db.prepare('SELECT 1 FROM project_git_id_map WHERE kind = ? AND local_id = ?')
        .get(kind, target);
      if (reverse) throw conflict();
      db.prepare('INSERT INTO project_git_id_map (repository_project_id, clone_id, kind, portable_id, local_id) VALUES (?, ?, ?, ?, ?)')
        .run(repositoryProjectId, cloneId, kind, portableId, target);
      return target;
    });
  }
  function enqueue(input: Omit<ProjectGitOperationInput, 'kind'> & { kind: ProjectGitJournalRecord['kind']; ownerOperationId?: string }): ProjectGitJournalRecord {
    return transaction(() => {
      if (!input.actorId || !input.idempotencyKey || !input.requestDigest) throw conflict();
      const scope = input.projectId === null ? 'import' : `project:${input.projectId}`;
      const existing = db.prepare('SELECT * FROM project_git_operations WHERE actor_id = ? AND scope = ? AND kind = ? AND idempotency_key = ?')
        .get(input.actorId, scope, input.kind, input.idempotencyKey) as OperationRow | undefined;
      if (existing) {
        if (existing.request_digest !== input.requestDigest || existing.owner_operation_id !== (input.ownerOperationId ?? null)) throw conflict();
        return journalFrom(existing);
      }
      if (input.kind === 'resolve' && input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload)
        && typeof input.payload.conflictOperationId === 'string'
        && db.prepare('SELECT 1 FROM project_git_conflict_resolutions WHERE conflict_operation_id = ?').get(input.payload.conflictOperationId)) throw conflict();
      const binding = input.projectId === null ? null : getBinding(input.projectId);
      if (binding) {
        if (!input.basis) throw changed(); requireBasis(binding.projectId, input.basis);
      } else if (input.kind === 'checkpoint') throw changed();
      const basis = input.basis ?? { projectRevision: 0, contentRevision: 0, bindingGeneration: 0, localHead: null, remoteHead: null };
      if (input.ownerOperationId) {
        const owner = getJournal(input.ownerOperationId);
        if (input.kind !== 'checkpoint' || !owner || owner.kind === 'checkpoint'
          || owner.projectId !== input.projectId || !sameBasis(owner.basis, basis)
          || owner.journalPhase !== 'protected' || owner.phaseCompleted) throw recoveryRequired();
      }
      const id = randomUUID(); const now = Date.now();
      db.prepare(`INSERT INTO project_git_operations
        (id, actor_id, scope, kind, idempotency_key, request_digest, project_id, basis_json, payload_json, status, phase, created_at, updated_at, owner_operation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'waiting_idle', ?, ?, ?)`)
        .run(id, input.actorId, scope, input.kind, input.idempotencyKey, input.requestDigest, input.projectId,
          json(basis), json(input.payload), now, now, input.ownerOperationId ?? null);
      if (input.kind === 'resolve' && input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload)
        && typeof input.payload.conflictOperationId === 'string') {
        db.prepare(`INSERT INTO project_git_conflict_resolutions (conflict_operation_id, resolve_operation_id)
          VALUES (?, ?)`).run(input.payload.conflictOperationId, id);
      }
      return getJournal(id)!;
    });
  }
  function writePhase(id: string, phase: Exclude<ProjectGitJournalPhase, 'complete'>, data: ProjectGitRecoveryData, completed: boolean): void {
    transaction(() => {
      const op = getJournal(id); if (!op) throw recoveryRequired();
      if (!completed && op.projectId !== null && op.basis.bindingGeneration > 0) requireBasis(op.projectId, ownedBasis(op));
      if (completed && phase === 'records_applied') throw recoveryRequired();
      validateRecovery(op.recoveryData, data);
      if (op.recoveryData === null && data.baseHead !== op.basis.localHead) throw changed();
      if (!completed && phase === 'ref_published' && op.ownerOperationId) {
        const owner = getJournal(op.ownerOperationId);
        if (owner?.protection?.checkpointOperationId !== op.id || owner.protection.checkpointOid !== data.publishHead
          || owner.journalPhase !== 'protected' || owner.phaseCompleted) throw recoveryRequired();
      }
      const index = phases.indexOf(phase); const previous = op.journalPhase === null ? -1 : phases.indexOf(op.journalPhase);
      if (index >= 4 && !op.recordsTransition) throw recoveryRequired();
      // An intent write never adds completion facts; a completion write cannot pre-claim later effects.
      const permitted = completed ? index : previous;
      if ((permitted < 1 && data.paths.some(p => p.protected)) || (permitted < 2 && data.paths.some(p => p.applied))
        || (permitted < 3 && data.records?.applied) || (permitted < 4 && data.refPublished)
        || (permitted < 5 && data.index.published)) throw recoveryRequired();
      if (!completed && op.recoveryData && !isDeepStrictEqual(op.recoveryData, data)) throw recoveryRequired();
      if (completed) {
        if (previous !== index) throw recoveryRequired();
        if ((index >= 1 && data.paths.some(p => !p.protected)) || (index >= 2 && data.paths.some(p => !p.applied))
          || (index >= 3 && data.records && !data.records.applied) || (index >= 4 && !data.refPublished)
          || (index >= 5 && !data.index.published)) throw recoveryRequired();
        if (phase === 'protected' && op.protection && !op.protection.sealedCandidate) throw recoveryRequired();
      } else if (!(index === previous && !op.phaseCompleted)
        && !(index === previous + 1 && (previous === -1 || op.phaseCompleted))) throw recoveryRequired();
      db.prepare('UPDATE project_git_operations SET journal_phase = ?, phase_completed = ?, recovery_json = ?, updated_at = ? WHERE id = ?')
        .run(phase, Number(completed), json(data), Date.now(), id);
    });
  }
  function visibleExistingProjects(intent: ProjectGitRegistrationIntent): string[] {
    if (intent.existingProjectIds === undefined) return [];
    if (intent.kind !== 'open' || !Array.isArray(intent.existingProjectIds)
      || intent.existingProjectIds.some(id => typeof id !== 'string' || !id || id === intent.projectId)
      || new Set(intent.existingProjectIds).size !== intent.existingProjectIds.length) throw recoveryRequired();
    return intent.existingProjectIds.filter(id => {
      const b = getBinding(id);
      return b?.repositoryProjectId === intent.repositoryProjectId && Boolean(db.prepare(`SELECT 1 FROM projects p WHERE p.id = ?
        AND NOT EXISTS (SELECT 1 FROM project_git_registrations r WHERE r.project_id = p.id AND r.hidden = 1 AND r.state != 'complete')`).get(id));
    });
  }
  function finishMaterialization(id: string, input: ProjectGitMaterializationCompletion, conflictOperationId?: string): number {
    return transaction(() => {
      const op = getJournal(id);
      if (conflictOperationId && store.getConflictResolutionOwner(conflictOperationId) !== id) throw recoveryRequired();
      if (input.remainingDirty !== undefined && (op?.kind !== 'restore' || typeof input.remainingDirty !== 'boolean')) throw recoveryRequired();
      if (op?.journalPhase === 'complete' && op.completedProjectRevision !== null) {
        if (!sameBasis(op.basis, input.basis)
          || op.completedProjectRevision !== input.basis.projectRevision + Number(input.advanceProjectRevision)) throw changed();
        if (conflictOperationId) {
          const conflictOperation = getJournal(conflictOperationId);
          if (!conflictOperation || conflictOperation.status !== 'succeeded' || conflictOperation.error !== null) throw recoveryRequired();
        }
        return op.completedProjectRevision;
      }
      if (!op?.projectId || !op.recoveryData || op.journalPhase !== 'index_published' || !op.phaseCompleted) throw recoveryRequired();
      if (!sameBasis(op.basis, input.basis)) throw changed();
      if (!op.recordsTransition || op.recordsTransition.advanceProjectRevision !== input.advanceProjectRevision) throw recoveryRequired();
      let conflictOperation: ProjectGitJournalRecord | null = null;
      if (conflictOperationId) {
        conflictOperation = getJournal(conflictOperationId);
        if (!conflictOperation || conflictOperation.kind !== 'sync' || conflictOperation.projectId !== op.projectId
          || conflictOperation.status !== 'waiting' || conflictOperation.phase !== 'conflict'
          || !sameBasis(conflictOperation.basis, op.basis)) throw recoveryRequired();
      }
      const b = requireBasis(op.projectId, ownedBasis(op)); const head = op.protection?.sealedCandidate?.publishHead ?? op.recoveryData.publishHead;
      db.prepare('UPDATE project_git_bindings SET exported_content_revision = content_revision WHERE project_id = ?').run(b.projectId);
      updateBindingData({ ...b, localHead: head, materializedHead: head, dirty: input.remainingDirty ?? false });
      if (b.remoteUrl !== null) store.queuePush(b.projectId, b.generation, head);
      const revision = getBinding(b.projectId)!.projectRevision;
      db.prepare("UPDATE project_git_operations SET journal_phase = 'complete', phase_completed = 1, status = 'succeeded', phase = 'local_saved', result_json = ?, error_json = NULL, completed_project_revision = ?, updated_at = ? WHERE id = ?")
        .run(json({ head }), revision, Date.now(), id);
      if (conflictOperation) {
        db.prepare("UPDATE project_git_operations SET status = 'succeeded', phase = 'local_saved', result_json = ?, error_json = NULL, updated_at = ? WHERE id = ?")
          .run(json({ head }), Date.now(), conflictOperation.id);
      }
      return revision;
    });
  }
  const pushColumns = 'q.project_id AS projectId, q.binding_generation AS generation, q.target_oid AS targetOid, q.attempts, q.next_attempt_at AS nextAttemptAt';
  const store: ProjectGitStore = {
    getOpenPreparation: id => {
      const row = db.prepare('SELECT root_json, candidate_json FROM project_git_preparations WHERE operation_id = ?').get(id) as
        { root_json: string | null; candidate_json: string | null } | undefined;
      return row ? { ...(row.root_json ? { root: JSON.parse(row.root_json) } : {}), ...(row.candidate_json ? { candidate: JSON.parse(row.candidate_json) } : {}) } : null;
    },
    freezeOpenPreparation: (id, preparation) => transaction(() => {
      const op = getJournal(id); const current = store.getOpenPreparation(id);
      if (!op || op.kind !== 'open' || op.scope !== 'import' || op.journalPhase !== null || getRegistration(id)
        || Object.keys(preparation).some(key => !['root', 'candidate'].includes(key))) throw recoveryRequired();
      const payload = op.payload as { url?: string; branch?: string; reservedProjectId?: string; cloneId?: string; plainRepositoryProjectId?: string; createdAt?: number };
      if (!payload || Object.keys(payload).sort().join(',') !== 'branch,cloneId,createdAt,plainRepositoryProjectId,reservedProjectId,url'
        || ![payload.reservedProjectId, payload.cloneId, payload.plainRepositoryProjectId].every(value => typeof value === 'string' && /^[a-zA-Z0-9-]+$/u.test(value))
        || typeof payload.url !== 'string' || typeof payload.branch !== 'string' || !Number.isSafeInteger(payload.createdAt)) throw recoveryRequired();
      if (preparation.root && (Object.keys(preparation.root).sort().join(',') !== 'dev,ino'
        || !/^\d+$/u.test(preparation.root.dev) || !/^\d+$/u.test(preparation.root.ino))) throw recoveryRequired();
      if (preparation.candidate) {
        const c = preparation.candidate; const remote = store.getOpenRemote(id);
        if (!remote || !(current?.root ?? preparation.root) || Object.keys(c).sort().join(',') !== 'candidateOid,canonicalSnapshotJson,repositoryProjectId,snapshotDigest'
          || !(remote.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(c.candidateOid)
          || createHash('sha256').update(c.canonicalSnapshotJson).digest('hex') !== c.snapshotDigest
          || parsePortableSnapshot(JSON.parse(c.canonicalSnapshotJson)).manifest.repositoryProjectId !== c.repositoryProjectId) throw recoveryRequired();
        const snapshot = parsePortableSnapshot(JSON.parse(c.canonicalSnapshotJson));
        if (canonicalPayloadJson(JSON.parse(c.canonicalSnapshotJson) as JsonValue) !== c.canonicalSnapshotJson) throw recoveryRequired();
        if (c.candidateOid !== remote.head && (c.repositoryProjectId !== payload.plainRepositoryProjectId || snapshot.project.createdAt !== payload.createdAt)) throw recoveryRequired();
      }
      for (const key of ['root', 'candidate'] as const) if (current?.[key] && preparation[key] && !isDeepStrictEqual(current[key], preparation[key])) throw changed();
      const next = { ...current, ...preparation };
      db.prepare(`INSERT INTO project_git_preparations(operation_id,root_json,candidate_json) VALUES (?,?,?)
        ON CONFLICT(operation_id) DO UPDATE SET root_json=excluded.root_json,candidate_json=excluded.candidate_json`)
        .run(id, next.root ? json(next.root) : null, next.candidate ? json(next.candidate) : null);
    }),
    getEnableInitialization: id => {
      const row = db.prepare('SELECT initialization_json FROM project_git_preparations WHERE operation_id=?').get(id) as { initialization_json: string | null } | undefined;
      if (!row?.initialization_json) return null;
      const value = JSON.parse(row.initialization_json) as ProjectGitEnableInitialization;
      if (!db.prepare('SELECT 1 FROM project_git_preview_consumers WHERE preview_operation_id=? AND consumer_operation_id=?').get(value.previewId, id)) throw recoveryRequired();
      return value;
    },
    freezeEnableInitialization: (id, initialization) => transaction(() => {
      const op = getJournal(id); const preview = getJournal(initialization.previewId);
      const payload = preview?.payload as { evidenceDigest?: string } | undefined;
      if (!op || op.kind !== 'enable' || op.projectId !== initialization.projectId || op.journalPhase !== null || getRegistration(id)
        || !sameBasis(op.basis, initialization.basis) || !preview || preview.kind !== 'enable_preview' || preview.actorId !== op.actorId
        || preview.projectId !== op.projectId || payload?.evidenceDigest !== initialization.previewEvidenceDigest
        || !db.prepare('SELECT 1 FROM project_git_preview_consumers WHERE preview_operation_id=? AND consumer_operation_id=?').get(initialization.previewId, id)
        || !/^\d+$/u.test(initialization.dev) || !/^\d+$/u.test(initialization.ino) || !['sha1', 'sha256'].includes(initialization.objectFormat)) throw recoveryRequired();
      const prior = store.getEnableInitialization(id);
      if (prior) { if (!isDeepStrictEqual(prior, initialization)) throw changed(); return; }
      db.prepare('INSERT INTO project_git_preparations(operation_id,initialization_json) VALUES (?,?)').run(id, json(initialization));
    }),
    getRegistration,
    listPendingRegistrations: () => (db.prepare("SELECT execution_operation_id FROM project_git_registrations WHERE state = 'pending' ORDER BY execution_operation_id").all() as
      { execution_operation_id: string }[]).map(row => getRegistration(row.execution_operation_id)!),
    prepareRegistration: intent => transaction(() => {
      if (getRegistration(intent.executionOperationId)) { requireRegistration(intent); return; }
      if (intent.dependencies !== undefined) {
        if (intent.kind !== 'open' || !Array.isArray(intent.dependencies)) throw recoveryRequired();
        let previous = '';
        for (const dependency of intent.dependencies) {
          if (!ProjectGitDependencySchema.safeParse(dependency).success || !['agent', 'model', 'plugin'].includes(dependency.kind)
            || dependency.requiredForContent || dependency.nextStep?.action !== 'install_dependency'
            || dependency.nextStep.label !== dependency.label || !dependency.label
            || /^(?:\/|~|[a-zA-Z]:[\\/])|[\u0000-\u001f\u007f]/u.test(dependency.label)) throw recoveryRequired();
          const key = JSON.stringify([dependency.kind, dependency.label]); if (key <= previous) throw recoveryRequired(); previous = key;
        }
      }
      if (visibleExistingProjects(intent).length !== (intent.existingProjectIds?.length ?? 0)) throw recoveryRequired();
      const user = getJournal(intent.userOperationId); const execution = getJournal(intent.executionOperationId);
      if (!user || !execution || user.kind !== intent.kind || execution.projectId !== intent.projectId
        || !sameBasis(user.basis, intent.originalUserBasis) || !sameBasis(execution.basis, intent.executionBasis)
        || execution.journalPhase !== null || execution.ownerOperationId !== null
        || (intent.hidden && intent.kind !== 'open')
        || (intent.initialImport && (!intent.hidden || intent.completion !== 'materialization' || intent.executionBasis.localHead !== null))
        || (intent.completion === 'checkpoint' ? intent.kind !== 'enable' || execution.kind !== 'checkpoint' || user.id === execution.id
          : user.id !== execution.id)) throw recoveryRequired();
      if (intent.kind === 'open') {
        const preparation = store.getOpenPreparation(user.id); const remote = store.getOpenRemote(user.id);
        const payload = user.payload as { url?: string; branch?: string; reservedProjectId?: string; cloneId?: string };
        if (user.scope !== 'import' || !preparation?.candidate || !preparation.root || !remote || !intent.initialImport
          || intent.projectId !== payload.reservedProjectId || intent.cloneId !== payload.cloneId
          || intent.remoteUrl !== payload.url || intent.targetBranch !== payload.branch || intent.localBranch !== payload.branch
          || intent.initialImport.candidateOid !== preparation.candidate.candidateOid
          || intent.repositoryProjectId !== preparation.candidate.repositoryProjectId
          || intent.initialImport.rootDev !== preparation.root.dev || intent.initialImport.rootIno !== preparation.root.ino) throw recoveryRequired();
        const snapshot = parsePortableSnapshot(JSON.parse(preparation.candidate.canonicalSnapshotJson)); const logical = new Set<string>();
        for (const preferences of [snapshot.project.preferences, ...snapshot.conversations.map(item => item.preferences)]) {
          if (preferences?.agentId) logical.add(json(['agent', preferences.agentId]));
          if (preferences?.model) logical.add(json(['model', preferences.model]));
        }
        for (const resource of snapshot.manifest.resources) if (snapshot.project.contentRefs.includes(resource.digest)) {
          for (const location of resource.locations) if (location.purpose === 'plugin' && location.sourceLabel) logical.add(json(['plugin', location.sourceLabel]));
        }
        if (intent.dependencies?.some(item => !logical.has(json([item.kind, item.label])))) throw recoveryRequired();
      }
      const b = requireBasis(intent.projectId, intent.executionBasis);
      if (intent.materialization) {
        const candidate = intent.materialization; const payload = user.payload as { previewId?: unknown; previewContentDigest?: unknown };
        const preview = typeof payload?.previewId === 'string' ? getJournal(payload.previewId) : null;
        const consumed = db.prepare('SELECT 1 FROM project_git_preview_consumers WHERE preview_operation_id = ? AND consumer_operation_id = ?')
          .get(typeof payload?.previewId === 'string' ? payload.previewId : '', user.id);
        if (intent.kind !== 'bind' || intent.completion !== 'materialization' || intent.initialImport || !consumed
          || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate.candidateOid) || !/^[a-f0-9]{64}$/u.test(candidate.previewContentDigest)
          || !['commit', 'fast_forward'].includes(candidate.publicationMode) || payload.previewContentDigest !== candidate.previewContentDigest
          || preview?.kind !== 'binding_preview' || preview.actorId !== user.actorId || preview.projectId !== intent.projectId
          || preview.status !== 'succeeded' || !sameBasis(preview.basis, intent.executionBasis)
          || (candidate.publicationMode === 'fast_forward' && (!intent.executionBasis.localHead || candidate.candidateOid !== preview.result?.preview?.targetOid))) throw recoveryRequired();
      } else if (intent.kind === 'bind' && intent.completion === 'materialization') throw recoveryRequired();
      if (b.canonicalRoot !== intent.canonicalRoot || b.commonDir !== intent.commonDir || b.cloneId !== intent.cloneId
        || b.repositoryProjectId !== intent.repositoryProjectId || (b.localBranch ?? b.branch) !== intent.localBranch) throw changed();
      db.prepare(`INSERT INTO project_git_registrations (execution_operation_id, user_operation_id, project_id, hidden, state, intent_json)
        VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(intent.executionOperationId, intent.userOperationId, intent.projectId, Number(intent.hidden), json(intent));
    }),
    completeRegistration: intent => {
      if (!db.inTransaction) throw recoveryRequired();
      return transaction(() => {
        const record = requireRegistration(intent);
        if (record.state === 'aborted') throw recoveryRequired();
        const b = getBinding(intent.projectId); if (!b) throw recoveryRequired();
        if (record.state === 'complete') return b;
        const execution = getJournal(intent.executionOperationId)!;
        if (intent.completion === 'binding_only') requireBasis(intent.projectId, intent.executionBasis);
        else if (intent.completion === 'checkpoint' && execution.journalPhase === null && execution.recoveryData === null) {
          requireBasis(intent.projectId, intent.executionBasis);
          if (execution.status !== 'succeeded' || execution.ownerOperationId !== null
            || (execution.result?.head ?? null) !== intent.executionBasis.localHead) throw recoveryRequired();
        }
        else if (execution.journalPhase !== 'complete' || execution.status !== 'succeeded'
          || b.generation !== intent.executionBasis.bindingGeneration || b.contentRevision !== intent.executionBasis.contentRevision
          || b.projectRevision !== execution.completedProjectRevision
          || b.localHead !== execution.result?.head) throw recoveryRequired();
        const next = store.saveBinding({ ...b, branch: intent.targetBranch, localBranch: intent.localBranch,
          remoteUrl: intent.remoteUrl, autoSync: intent.autoSync });
        if (next.generation !== intent.targetOwner.generation) throw recoveryRequired();
        if (next.remoteUrl && next.localHead) store.queuePush(next.projectId, next.generation, next.localHead);
        if (intent.hidden) {
          const row = db.prepare('SELECT metadata_json FROM projects WHERE id = ?').get(intent.projectId) as { metadata_json: string | null } | undefined;
          if (!row) throw recoveryRequired();
          const metadata = row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, JsonValue> : {};
          metadata.baseDir = intent.canonicalRoot;
          db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?').run(json(metadata), intent.projectId);
        }
        db.prepare("UPDATE project_git_registrations SET state = 'complete' WHERE execution_operation_id = ?").run(intent.executionOperationId);
        const result: ProjectGitOperationResult = { projectId: next.projectId, ...(next.localHead ? { head: next.localHead } : {}),
          ...(intent.existingProjectIds === undefined ? {} : { existingProjectIds: visibleExistingProjects(intent) }),
          ...(intent.dependencies === undefined ? {} : { dependencies: intent.dependencies }) };
        db.prepare("UPDATE project_git_operations SET status = 'succeeded', phase = 'local_saved', result_json = ?, error_json = NULL, updated_at = ? WHERE id = ?")
          .run(json(result), Date.now(), intent.userOperationId);
        return next;
      });
    },
    abortRegistration: (intent, error) => transaction(() => {
      const record = requireRegistration(intent);
      if (record.state === 'aborted') return;
      const execution = getJournal(intent.executionOperationId);
      if (record.state !== 'pending' || !execution || execution.journalPhase !== null || execution.recoveryData !== null) throw recoveryRequired();
      requireBasis(intent.projectId, intent.executionBasis);
      if (intent.kind === 'enable' || intent.kind === 'open') store.invalidateBinding(intent.projectId, intent.executionBasis);
      db.prepare("UPDATE project_git_registrations SET state = 'aborted' WHERE execution_operation_id = ?").run(intent.executionOperationId);
      for (const id of new Set([intent.userOperationId, intent.executionOperationId])) {
        store.updateOperation(id, { status: 'failed', phase: 'failed', result: null, error });
      }
    }),
    getBinding,
    listBindings: () => (db.prepare('SELECT * FROM project_git_bindings WHERE active = 1 ORDER BY project_id').all() as BindingRow[]).map(bindingFrom),
    getBindingGeneration: id => bindingRow(id)?.generation ?? 0,
    getBindingTombstone: id => {
      const row = bindingRow(id);
      return row && !row.active ? { generation: row.generation, projectRevision: row.project_revision, contentRevision: row.content_revision } : null;
    },
    saveBinding: input => transaction(() => {
      const row = bindingRow(input.projectId); const current = row ? bindingFrom(row) : null;
      if (input.generation !== (row?.generation ?? 0) || (current && (input.projectRevision !== current.projectRevision
        || input.contentRevision !== current.contentRevision))) throw changed();
      const localBranch = input.localBranch ?? (row?.active && current ? current.localBranch ?? current.branch : input.branch);
      if (row?.active && current && localBranch !== (current.localBranch ?? current.branch)) throw changed();
      const targetChanged = !row?.active || !current || ['cloneId', 'repositoryProjectId', 'canonicalRoot', 'commonDir', 'branch', 'remoteUrl']
        .some(key => input[key as keyof ProjectGitBindingRecord] !== current[key as keyof ProjectGitBindingRecord]);
      const next = { ...input, ...(localBranch !== input.branch || input.localBranch !== undefined ? { localBranch } : {}),
        ...(current ? { localHead: current.localHead, observedRemoteHead: current.observedRemoteHead,
        confirmedRemoteHead: current.confirmedRemoteHead, materializedHead: current.materializedHead,
        exportedContentRevision: current.exportedContentRevision, dirty: current.dirty } : {}),
        generation: input.generation + Number(targetChanged) };
      if (targetChanged) { next.observedRemoteHead = null; next.confirmedRemoteHead = null; }
      const duplicate = db.prepare(`SELECT 1 FROM project_git_bindings WHERE active = 1 AND project_id != ?
        AND (canonical_root = ? OR (common_dir = ? AND (branch = ? OR local_branch = ?)))`)
        .get(next.projectId, next.canonicalRoot, next.commonDir, next.branch, localBranch);
      if (duplicate) throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'This branch already has a writable binding.');
      db.prepare(`INSERT INTO project_git_bindings (project_id, common_dir, branch, generation, active, project_revision, content_revision, exported_content_revision, record_json, canonical_root, local_branch)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET common_dir = excluded.common_dir,
        branch = excluded.branch, generation = excluded.generation, active = 1, record_json = excluded.record_json,
        canonical_root = excluded.canonical_root, local_branch = excluded.local_branch`)
        .run(next.projectId, next.commonDir, next.branch, next.generation, next.projectRevision, next.contentRevision, next.exportedContentRevision, json(next), next.canonicalRoot, localBranch);
      if (targetChanged) db.prepare('DELETE FROM project_git_push_queue WHERE project_id = ?').run(input.projectId);
      return getBinding(input.projectId)!;
    }),
    assertRevision: (id, expected) => { const b = getBinding(id); if (b && (expected === undefined || expected !== b.projectRevision)) throw changed(); },
    bumpContent: (id, expected) => transaction(() => {
      requireBasis(id, expected);
      db.prepare("UPDATE project_git_bindings SET content_revision = content_revision + 1, record_json = json_set(record_json, '$.dirty', json('true')) WHERE project_id = ?").run(id);
      return getBinding(id)!.contentRevision;
    }),
    recordRunTerminal: input => transaction(() => {
      const existing = db.prepare(`SELECT project_id AS projectId, binding_generation AS bindingGeneration,
        project_revision AS projectRevision, terminal FROM project_git_run_terminals
        WHERE run_id = ? AND execution_attempt = ?`)
        .get(input.runId, input.executionAttempt) as Omit<typeof input, 'runId' | 'executionAttempt'> | undefined;
      if (existing) {
        if (!isDeepStrictEqual(existing, {
          projectId: input.projectId,
          bindingGeneration: input.bindingGeneration,
          projectRevision: input.projectRevision,
          terminal: input.terminal,
        })) throw recoveryRequired();
        return false;
      }
      const binding = getBinding(input.projectId);
      if (!binding) return false;
      if (!input.runId || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 0
        || !['succeeded', 'failed', 'canceled'].includes(input.terminal)
        || binding.generation !== input.bindingGeneration
        || binding.projectRevision !== input.projectRevision) throw changed();
      db.prepare(`INSERT INTO project_git_run_terminals
        (run_id, execution_attempt, project_id, binding_generation, project_revision, terminal, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.runId, input.executionAttempt, input.projectId, input.bindingGeneration,
          input.projectRevision, input.terminal, Date.now());
      db.prepare("UPDATE project_git_bindings SET content_revision = content_revision + 1, record_json = json_set(record_json, '$.dirty', json('true')) WHERE project_id = ?")
        .run(input.projectId);
      return true;
    }),
    bumpProject: (id, expected) => transaction(() => {
      requireBasis(id, expected);
      db.prepare('UPDATE project_git_bindings SET project_revision = project_revision + 1 WHERE project_id = ?').run(id);
      return getBinding(id)!.projectRevision;
    }),
    markExported: (id, expected, revision) => transaction(() => {
      const b = requireGeneration(id, expected.bindingGeneration);
      if (b.projectRevision !== expected.projectRevision || revision < b.exportedContentRevision
        || revision > b.contentRevision || !Number.isSafeInteger(revision)) throw changed();
      db.prepare('UPDATE project_git_bindings SET exported_content_revision = ? WHERE project_id = ?').run(revision, id);
      updateBindingData({ ...b, exportedContentRevision: revision, dirty: revision !== b.contentRevision });
    }),
    adoptExternalHead: (id, expected, oid) => transaction(() => {
      const b = requireBasis(id, expected);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) throw changed();
      if (store.listRecoverable().some(op => op.projectId === id && op.recoveryData !== null)) throw recoveryRequired();
      updateBindingData({ ...b, localHead: oid, dirty: true });
      if (b.remoteUrl !== null) store.queuePush(id, b.generation, oid);
    }),
    observeRemote: (id, generation, oid) => transaction(() => {
      updateBindingData({ ...requireGeneration(id, generation), observedRemoteHead: oid });
    }),
    invalidateBinding: (id, expected) => transaction(() => {
      const b = requireBasis(id, expected);
      db.prepare('UPDATE project_git_bindings SET active = 0, generation = generation + 1 WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_git_push_queue WHERE project_id = ?').run(id);
      return b.generation + 1;
    }),
    assertDatabase: database => { if (database !== db) throw recoveryRequired(); },
    mapId: (repository, clone, kind, portable) => attachId(repository, clone, kind, portable),
    attachId,
    getPortableId: (repository, clone, kind, local) => (db.prepare('SELECT portable_id FROM project_git_id_map WHERE repository_project_id = ? AND clone_id = ? AND kind = ? AND local_id = ?')
      .get(repository, clone, kind, local) as { portable_id: string } | undefined)?.portable_id ?? null,
    getOpenRemote: id => {
      const row = db.prepare('SELECT head, object_format FROM project_git_open_remotes WHERE operation_id = ?').get(id) as { head: string | null; object_format: string } | undefined;
      if (!row) return null;
      if (!['sha1', 'sha256'].includes(row.object_format) || (row.head !== null && (typeof row.head !== 'string'
        || !(row.object_format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(row.head)))) throw recoveryRequired();
      return { head: row.head, objectFormat: row.object_format as 'sha1' | 'sha256' };
    },
    freezeOpenRemote: (id, remote) => transaction(() => {
      const op = getJournal(id);
      if (!op || op.kind !== 'open' || op.scope !== 'import' || !['sha1', 'sha256'].includes(remote.objectFormat)
        || (remote.head !== null && !(remote.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(remote.head))) throw recoveryRequired();
      const current = store.getOpenRemote(id);
      if (current) { if (!isDeepStrictEqual(current, remote)) throw changed(); return; }
      if (op.journalPhase !== null || op.recoveryData !== null || store.getRegistration(id)) throw recoveryRequired();
      db.prepare('INSERT INTO project_git_open_remotes VALUES (?, ?, ?)').run(id, remote.head, remote.objectFormat);
    }),
    consumePreview: (previewId, consumerId) => transaction(() => {
      const preview = getJournal(previewId); const consumer = getJournal(consumerId);
      if (!preview || !consumer || preview.actorId !== consumer.actorId || preview.projectId === null
        || preview.projectId !== consumer.projectId || preview.scope !== consumer.scope || preview.status !== 'succeeded'
        || preview.result?.preview?.id !== previewId || !sameBasis(preview.basis, consumer.basis)
        || !((preview.kind === 'enable_preview' && consumer.kind === 'enable' && preview.result.preview.kind === 'enable')
          || (preview.kind === 'binding_preview' && consumer.kind === 'bind' && preview.result.preview.kind === 'bind')
          || (preview.kind === 'restore_preview' && consumer.kind === 'restore' && preview.result.preview.kind === 'restore'))) throw conflict();
      const existing = db.prepare('SELECT preview_operation_id, consumer_operation_id FROM project_git_preview_consumers WHERE preview_operation_id = ? OR consumer_operation_id = ?')
        .all(previewId, consumerId) as { preview_operation_id: string; consumer_operation_id: string }[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0]!.preview_operation_id !== previewId || existing[0]!.consumer_operation_id !== consumerId) throw conflict();
        return;
      }
      db.prepare('INSERT INTO project_git_preview_consumers VALUES (?, ?)').run(previewId, consumerId);
    }),
    enqueueOperation: input => publicOperation(enqueue(input))!,
    enqueueCheckpoint: input => enqueue({ ...input, kind: 'checkpoint' }),
    getOperation: id => { const op = getJournal(id); return op ? publicOperation(op) : null; },
    getLatestProjectOperation: id => {
      const row = db.prepare("SELECT * FROM project_git_operations WHERE project_id = ? AND kind != 'checkpoint' ORDER BY updated_at DESC, id DESC LIMIT 1")
        .get(id) as OperationRow | undefined;
      return row ? publicOperation(journalFrom(row)) : null;
    },
    freezeConflictEvidence: (id, basis, evidence) => transaction(() => {
      const op = getJournal(id);
      if (!op || op.kind !== 'sync' || op.journalPhase !== null || op.status !== 'running'
        || !/^conflict-[a-zA-Z0-9-]+\.json$/u.test(evidence.path)
        || !/^[a-f0-9]{64}$/u.test(evidence.digest)
        || op.payload === null || typeof op.payload !== 'object' || Array.isArray(op.payload)
        || op.payload.lane !== 'network' || op.projectId === null) throw recoveryRequired();
      const binding = getBinding(op.projectId);
      if (!binding || !sameBasis(basisFor(binding), basis)
        || op.basis.bindingGeneration !== basis.bindingGeneration
        || op.basis.projectRevision !== basis.projectRevision
        || op.basis.contentRevision !== basis.contentRevision
        || op.basis.localHead !== basis.localHead) throw changed();
      const next = { ...op.payload, conflictEvidence: evidence };
      const current = op.payload.conflictEvidence;
      if (current !== undefined && !isDeepStrictEqual(current, evidence)) throw recoveryRequired();
      db.prepare('UPDATE project_git_operations SET basis_json = ?, payload_json = ?, updated_at = ? WHERE id = ?')
        .run(json(basis), canonicalPayloadJson(next), Date.now(), id);
    }),
    getConflictResolutionOwner: conflictId => {
      const row = db.prepare(`SELECT resolve_operation_id AS id FROM project_git_conflict_resolutions
        WHERE conflict_operation_id = ?`).get(conflictId) as { id: string } | undefined;
      return row?.id ?? null;
    },
    markRetainedConflictStale: id => transaction(() => {
      const op = getJournal(id);
      if (!op || op.kind !== 'sync' || op.status !== 'waiting' || op.phase !== 'conflict' || op.journalPhase !== null
        || op.payload === null || typeof op.payload !== 'object' || Array.isArray(op.payload)
        || op.payload.lane !== 'network') throw conflict();
      db.prepare('UPDATE project_git_operations SET payload_json = ?, updated_at = ? WHERE id = ?')
        .run(canonicalPayloadJson({ ...op.payload, stale: true }), Date.now(), id);
    }),
    supersedeRetainedConflict: (staleId, replacementId, replacement) => transaction(() => {
      const stale = getJournal(staleId); const next = getJournal(replacementId);
      if (!stale || !next || stale.id === next.id || stale.kind !== 'sync' || next.kind !== 'sync'
        || stale.projectId === null || stale.projectId !== next.projectId || stale.status !== 'waiting' || stale.phase !== 'conflict'
        || stale.journalPhase !== null || next.status !== 'running' || next.journalPhase !== null
        || next.payload === null || typeof next.payload !== 'object' || Array.isArray(next.payload)
        || next.payload.lane !== 'network' || next.payload.conflictEvidence === undefined
        || (isDeepStrictEqual(stale.basis, next.basis)
          && !(stale.payload !== null && typeof stale.payload === 'object' && !Array.isArray(stale.payload) && stale.payload.stale === true))) throw conflict();
      requireBasis(stale.projectId, next.basis);
      const now = Date.now();
      db.prepare("UPDATE project_git_operations SET status = 'succeeded', phase = 'local_saved', error_json = NULL, updated_at = ? WHERE id = ?")
        .run(now, staleId);
      db.prepare("UPDATE project_git_operations SET status = 'waiting', phase = 'conflict', result_json = ?, error_json = ?, updated_at = ? WHERE id = ?")
        .run(replacement.result === null ? null : json(replacement.result), replacement.error === null ? null : json(replacement.error), now, replacementId);
    }),
    findOperation: input => {
      const row = db.prepare('SELECT * FROM project_git_operations WHERE actor_id = ? AND scope = ? AND kind = ? AND idempotency_key = ?')
        .get(input.actorId, input.projectId === null ? 'import' : `project:${input.projectId}`, input.kind, input.idempotencyKey) as OperationRow | undefined;
      return row ? journalFrom(row) : null;
    },
    findOperationRequest: input => {
      const row = db.prepare(`SELECT operation_id AS operationId, request_digest AS requestDigest
        FROM project_git_operation_requests WHERE actor_id = ? AND scope = ? AND action = ? AND idempotency_key = ?`)
        .get(input.actorId, input.projectId === null ? 'import' : `project:${input.projectId}`, input.action, input.idempotencyKey) as
        { operationId: string; requestDigest: string } | undefined;
      return row ?? null;
    },
    claimOperationRequest: input => transaction(() => {
      const scope = input.projectId === null ? 'import' : `project:${input.projectId}`;
      const owner = db.prepare(`SELECT actor_id AS actorId, scope, action, idempotency_key AS idempotencyKey,
        request_digest AS requestDigest, operation_id AS operationId
        FROM project_git_operation_requests WHERE operation_id = ?`).get(input.operationId) as
        { actorId: string; scope: string; action: string; idempotencyKey: string; requestDigest: string; operationId: string } | undefined;
      if (owner && (owner.actorId !== input.actorId || owner.scope !== scope || owner.action !== input.action
        || owner.idempotencyKey !== input.idempotencyKey || owner.requestDigest !== input.requestDigest)) throw conflict();
      const inserted = db.prepare(`INSERT INTO project_git_operation_requests
        (actor_id, scope, action, idempotency_key, request_digest, operation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(actor_id, scope, action, idempotency_key) DO NOTHING`)
        .run(input.actorId, scope, input.action, input.idempotencyKey, input.requestDigest, input.operationId, Date.now());
      const existing = store.findOperationRequest(input);
      if (!existing || existing.requestDigest !== input.requestDigest || existing.operationId !== input.operationId) throw conflict();
      const operation = getJournal(input.operationId);
      const activeAttempt = getRetryAttempt(input.operationId);
      if (!operation || operation.scope !== scope
        || activeAttempt && activeAttempt.state !== 'settled') {
        if (!operation || !activeAttempt || !['queued', 'running', 'waiting'].includes(operation.status)) throw conflict();
        return { ...existing, created: inserted.changes === 1, admitted: false, attempt: activeAttempt.attempt };
      }
      if (operation.status === 'succeeded') {
        return { ...existing, created: inserted.changes === 1, admitted: false, attempt: activeAttempt?.attempt ?? 0 };
      }
      if (!['failed', 'waiting'].includes(operation.status)) throw conflict();
      const attempt = (activeAttempt?.attempt ?? 0) + 1;
      const now = Date.now();
      db.prepare(`INSERT INTO project_git_retry_attempts
        (operation_id, attempt, state, prior_status, prior_phase, prior_result_json, prior_error_json, created_at, updated_at)
        VALUES (?, ?, 'admitted', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET attempt = excluded.attempt, state = excluded.state,
          prior_status = excluded.prior_status, prior_phase = excluded.prior_phase,
          prior_result_json = excluded.prior_result_json, prior_error_json = excluded.prior_error_json,
          created_at = excluded.created_at, updated_at = excluded.updated_at`)
        .run(operation.id, attempt, operation.status, operation.phase,
          operation.result === null ? null : json(operation.result), operation.error === null ? null : json(operation.error), now, now);
      db.prepare("UPDATE project_git_operations SET status = 'queued', phase = 'waiting_idle', error_json = NULL, updated_at = ? WHERE id = ?")
        .run(now, operation.id);
      return { ...existing, created: inserted.changes === 1, admitted: true, attempt };
    }),
    getRetryAttempt,
    listActiveRetryAttempts: () => (db.prepare("SELECT operation_id AS operationId FROM project_git_retry_attempts WHERE state IN ('admitted', 'started') ORDER BY created_at, operation_id")
      .all() as { operationId: string }[]).map(row => getRetryAttempt(row.operationId)!),
    startRetryAttempt: (operationId, attempt) => transaction(() => {
      const retry = getRetryAttempt(operationId); const operation = getJournal(operationId);
      if (!retry || retry.attempt !== attempt || retry.state !== 'admitted' || !operation
        || operation.status !== 'queued' || operation.phase !== 'waiting_idle'
        || operation.journalPhase !== null || operation.recoveryData !== null
        || getRegistration(operationId)?.state === 'pending') return false;
      const now = Date.now();
      db.prepare("UPDATE project_git_retry_attempts SET state = 'started', updated_at = ? WHERE operation_id = ? AND attempt = ? AND state = 'admitted'")
        .run(now, operationId, attempt);
      db.prepare("UPDATE project_git_operations SET status = 'running', updated_at = ? WHERE id = ?")
        .run(now, operationId);
      return true;
    }),
    settleRetryAttempt: (operationId, attempt) => transaction(() => {
      const retry = getRetryAttempt(operationId); const operation = getJournal(operationId);
      if (!retry || retry.attempt !== attempt || !operation) throw recoveryRequired();
      if (retry.state === 'settled') return;
      if (['queued', 'running'].includes(operation.status) && operation.journalPhase === null
        && operation.recoveryData === null && getRegistration(operationId)?.state !== 'pending') throw recoveryRequired();
      db.prepare("UPDATE project_git_retry_attempts SET state = 'settled', updated_at = ? WHERE operation_id = ? AND attempt = ?")
        .run(Date.now(), operationId, attempt);
    }),
    reconcileInterruptedRetryAttempts: operationIds => transaction(() => {
      const rows = db.prepare("SELECT operation_id AS operationId FROM project_git_retry_attempts WHERE state IN ('admitted', 'started') ORDER BY created_at, operation_id")
        .all() as { operationId: string }[];
      const reconciled: string[] = [];
      for (const row of rows) {
        if (operationIds && !operationIds.has(row.operationId)) continue;
        const operation = getJournal(row.operationId);
        if (!operation) throw recoveryRequired();
        if (!['queued', 'running', 'waiting'].includes(operation.status)) {
          db.prepare("UPDATE project_git_retry_attempts SET state = 'settled', updated_at = ? WHERE operation_id = ?")
            .run(Date.now(), operation.id);
          continue;
        }
        if (operation.journalPhase !== null || operation.recoveryData !== null || getRegistration(operation.id)?.state === 'pending') continue;
        const now = Date.now();
        db.prepare("UPDATE project_git_operations SET status = 'failed', phase = 'failed', result_json = NULL, error_json = ?, updated_at = ? WHERE id = ?")
          .run(json({ code: 'RECOVERY_REQUIRED', message: 'The admitted retry was interrupted before it could safely resume.',
            details: { reason: 'interrupted_retry', nextStep: 'Retry the operation.' } }), now, operation.id);
        db.prepare("UPDATE project_git_retry_attempts SET state = 'settled', updated_at = ? WHERE operation_id = ?")
          .run(now, operation.id);
        reconciled.push(operation.id);
      }
      return reconciled;
    }),
    getJournal,
    attachOperationProject: (id, projectId, basis) => transaction(() => {
      const op = getJournal(id);
      if (!op || op.kind !== 'open' || op.scope !== 'import') throw conflict();
      if (op.projectId !== null) {
        if (op.projectId !== projectId || !sameBasis(op.basis, basis)) throw conflict();
        return;
      }
      if (op.journalPhase !== null) throw recoveryRequired();
      requireBasis(projectId, basis);
      db.prepare('UPDATE project_git_operations SET project_id = ?, basis_json = ?, updated_at = ? WHERE id = ?')
        .run(projectId, json(basis), Date.now(), id);
    }),
    replaceAdmittedOperationPayload: (id, payload, nextBasis) => transaction(() => {
      const op = getJournal(id);
      if (op && op.journalPhase === null && op.recoveryData === null && isDeepStrictEqual(op.payload, payload)
        && (!nextBasis || isDeepStrictEqual(op.basis, nextBasis))) return;
      const admission = op?.payload && typeof op.payload === 'object' && !Array.isArray(op.payload)
        ? op.payload as Record<string, JsonValue> : null;
      const refinable = !!op && !!admission && (
        (op.kind === 'enable_preview' && Object.keys(admission).length === 0)
        || (op.kind === 'enable' && typeof admission.previewId === 'string' && !('previewContentDigest' in admission))
        || (op.kind === 'binding_preview' && typeof admission.url === 'string' && typeof admission.branch === 'string'
          && !('evidencePath' in admission))
        || (op.kind === 'bind' && typeof admission.previewId === 'string' && 'confirmation' in admission
          && !('previewContentDigest' in admission))
        || (op.kind === 'unbind' && Object.keys(admission).length === 0)
        || (op.kind === 'restore_preview' && typeof admission.targetOid === 'string' && 'file' in admission && !('captured' in admission))
        || (op.kind === 'sync' && admission.lane === 'network')
      );
      if (!op || !['queued', 'running'].includes(op.status) || op.phase !== 'waiting_idle' || op.journalPhase !== null
        || op.recoveryData !== null || op.result !== null || op.error !== null || !refinable) throw conflict();
      if (nextBasis && op.projectId !== null) requireBasis(op.projectId, nextBasis);
      db.prepare('UPDATE project_git_operations SET basis_json = ?, payload_json = ?, updated_at = ? WHERE id = ?')
        .run(json(nextBasis ?? op.basis), json(payload), Date.now(), id);
    }),
    settleAdmittedOperationFailure: (id, error) => transaction(() => {
      const op = getJournal(id);
      if (!op || !['queued', 'running'].includes(op.status) || op.journalPhase !== null || op.recoveryData !== null
        || getRegistration(id)?.state === 'pending') return;
      db.prepare("UPDATE project_git_operations SET status = 'failed', phase = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
        .run(json(error), Date.now(), id);
    }),
    reconcileInterruptedAdmissions: operationIds => transaction(() => {
      const reconciled: string[] = [];
      for (const op of store.listPendingOperations()) {
        const payload = op.payload !== null && typeof op.payload === 'object' && !Array.isArray(op.payload)
          ? op.payload as Record<string, JsonValue> : null;
        const retainedWaiting = op.status === 'waiting' && op.phase !== 'waiting_idle';
        const quarantine = op.actorId === 'project-git-background' && op.kind === 'sync' && payload?.lane === 'quarantine';
        if ((operationIds && !operationIds.has(op.id)) || op.kind === 'checkpoint' || op.ownerOperationId !== null
          || op.journalPhase !== null || op.recoveryData !== null || getRegistration(op.id)?.state === 'pending'
          || retainedWaiting || quarantine) continue;
        const retryable = ['enable', 'bind', 'open', 'restore', 'resolve', 'sync'].includes(op.kind);
        const nextStep = retryable ? 'Retry the interrupted operation.'
          : op.kind.endsWith('_preview') ? 'Create a new preview.' : 'Submit a new request.';
        db.prepare("UPDATE project_git_operations SET status = 'failed', phase = 'failed', result_json = NULL, error_json = ?, updated_at = ? WHERE id = ?")
          .run(json({ code: 'RECOVERY_REQUIRED', message: 'The operation was interrupted before durable work began.',
            details: { reason: 'interrupted_admission', nextStep } }), Date.now(), op.id);
        reconciled.push(op.id);
      }
      return reconciled;
    }),
    updateOperation: (id, update) => transaction(() => {
      const op = getJournal(id); if (!op) throw conflict();
      if (update.status === 'succeeded' && op.journalPhase && op.journalPhase !== 'complete') throw recoveryRequired();
      if (op.journalPhase === 'complete') throw conflict();
      db.prepare('UPDATE project_git_operations SET status = ?, phase = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ?')
        .run(update.status, update.phase, update.result === null ? null : json(update.result), update.error === null ? null : json(update.error), Date.now(), id);
    }),
    listPendingOperations: () => (db.prepare("SELECT * FROM project_git_operations WHERE status IN ('queued', 'running', 'waiting') ORDER BY created_at, id").all() as OperationRow[]).map(journalFrom),
    setPhase: (id, phase, data) => writePhase(id, phase, data, false),
    completePhase: (id, phase, data) => writePhase(id, phase, data, true),
    completeRecords: (id, input, applyRecords) => transaction(() => {
      const op = getJournal(id);
      if (!op?.projectId || !op.recoveryData || !sameBasis(op.basis, input.basis)) throw changed();
      if (input.importMarker !== (op.recoveryData.records?.importMarker ?? null)
        || input.advanceProjectRevision !== (op.kind !== 'checkpoint')
        || (op.kind === 'checkpoint' && input.importMarker !== null)) throw recoveryRequired();
      if (op.recordsTransition) {
        if (op.recordsTransition.importMarker !== input.importMarker
          || op.recordsTransition.advanceProjectRevision !== input.advanceProjectRevision) throw recoveryRequired();
        return op.recordsTransition.projectRevision;
      }
      if (op.journalPhase !== 'records_applied' || op.phaseCompleted) throw recoveryRequired();
      const b = requireBasis(op.projectId, ownedBasis(op));
      if (input.importMarker !== null && applyRecords() !== undefined) throw recoveryRequired();
      // The callback imports application rows/ID mappings synchronously in THIS transaction.
      requireBasis(op.projectId, ownedBasis(op));
      const transition: ProjectGitRecordsTransition = { importMarker: input.importMarker,
        advanceProjectRevision: input.advanceProjectRevision, projectRevision: b.projectRevision + Number(input.advanceProjectRevision) };
      db.prepare('UPDATE project_git_bindings SET project_revision = ? WHERE project_id = ?').run(transition.projectRevision, b.projectId);
      const data = op.recoveryData;
      if (data.records) data.records.applied = true;
      db.prepare('UPDATE project_git_operations SET phase_completed = 1, records_transition_json = ?, recovery_json = ?, updated_at = ? WHERE id = ?')
        .run(json(transition), json(data), Date.now(), id);
      return transition.projectRevision;
    }),
    prepareProtection: (id, input) => transaction(() => {
      const { op, checkpoint } = protectionPair(id, input);
      if (op.protection) {
        if (op.protection.checkpointOperationId !== input.checkpointOperationId || op.protection.checkpointOid !== input.checkpointOid) throw recoveryRequired();
        return;
      }
      requireBasis(op.projectId!, op.basis);
      if (op.journalPhase !== 'protected' || op.phaseCompleted || checkpoint.journalPhase !== 'prepared') throw recoveryRequired();
      writeProtection(id, { checkpointOperationId: checkpoint.id, checkpointOid: input.checkpointOid,
        completed: false, publishBase: null, sealedCandidate: null });
    }),
    completeProtection: (id, input) => transaction(() => {
      const { op, checkpoint } = protectionPair(id, input); const protection = op.protection;
      if (!protection || protection.checkpointOperationId !== checkpoint.id || protection.checkpointOid !== input.checkpointOid) throw recoveryRequired();
      if (protection.completed) {
        if (op.journalPhase !== 'complete') requireBasis(op.projectId!, ownedBasis(op));
        return;
      }
      if (op.journalPhase !== 'protected' || op.phaseCompleted || checkpoint.journalPhase !== 'complete'
        || !checkpoint.phaseCompleted || checkpoint.status !== 'succeeded'
        || checkpoint.completedProjectRevision !== op.basis.projectRevision
        || checkpoint.recordsTransition?.advanceProjectRevision !== false) throw recoveryRequired();
      requireBasis(op.projectId!, { ...op.basis, localHead: input.checkpointOid });
      writeProtection(id, { ...protection, completed: true, publishBase: input.checkpointOid });
    }),
    sealProtectedCandidate: (id, basis, candidate) => transaction(() => {
      const op = getJournal(id); const protection = op?.protection; const data = op?.recoveryData;
      if (!op?.projectId || !data || !sameBasis(op.basis, basis)) throw changed();
      if (['fast_forward', 'initial_import'].includes(data.publicationMode ?? '')) throw recoveryRequired();
      if (!protection?.completed) throw recoveryRequired();
      if (op.journalPhase !== 'complete') requireBasis(op.projectId, ownedBasis(op));
      if (protection.sealedCandidate) {
        if (!isDeepStrictEqual(protection.sealedCandidate, candidate)) throw recoveryRequired();
        return;
      }
      const parents = op.basis.localHead === null ? [protection.checkpointOid, ...data.publicationParents]
        : data.publicationParents.map(parent => parent === op.basis.localHead ? protection.checkpointOid : parent);
      if (op.journalPhase !== 'protected' || op.phaseCompleted || candidate.previewContentDigest !== data.previewContentDigest
        || candidate.candidateTreeOid !== data.candidateTreeOid || candidate.publishBase !== protection.checkpointOid
        || !candidate.candidateOid || candidate.publishHead !== candidate.candidateOid
        || parents.includes(candidate.candidateOid) || new Set(parents).size !== parents.length
        || !isDeepStrictEqual(candidate.publicationParents, parents)) throw recoveryRequired();
      writeProtection(id, { ...protection, sealedCandidate: candidate });
    }),
    listRecoverable: () => (db.prepare(`SELECT * FROM project_git_operations WHERE
      (journal_phase IS NOT NULL AND journal_phase != 'complete') OR (journal_phase IS NULL AND status IN ('queued', 'running', 'waiting'))
      ORDER BY created_at, id`).all() as OperationRow[]).map(journalFrom),
    completeMaterialization: (id, input) => {
      const operation = getJournal(id);
      const payload = operation?.payload;
      const conflictOperationId = operation?.kind === 'resolve' && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        && typeof payload.conflictOperationId === 'string' ? payload.conflictOperationId : undefined;
      if (operation?.kind === 'resolve' && !conflictOperationId) throw recoveryRequired();
      return finishMaterialization(id, input, conflictOperationId);
    },
    completeConflictResolution: (id, conflictId, input) => finishMaterialization(id, input, conflictId),
    queuePush: (id, generation, oid) => transaction(() => {
      requireGeneration(id, generation);
      db.prepare(`INSERT INTO project_git_push_queue (project_id, binding_generation, target_oid) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET binding_generation = excluded.binding_generation, target_oid = excluded.target_oid,
        attempts = CASE WHEN target_oid = excluded.target_oid THEN attempts ELSE 0 END,
        next_attempt_at = CASE WHEN target_oid = excluded.target_oid THEN next_attempt_at ELSE 0 END`).run(id, generation, oid);
      return db.prepare(`SELECT ${pushColumns} FROM project_git_push_queue q WHERE q.project_id = ?`).get(id) as ProjectGitPushRecord;
    }),
    listDuePushes: now => db.prepare(`SELECT ${pushColumns} FROM project_git_push_queue q JOIN project_git_bindings b
      ON b.project_id = q.project_id AND b.generation = q.binding_generation AND b.active = 1
      WHERE q.next_attempt_at <= ? ORDER BY q.next_attempt_at, q.project_id`).all(now) as ProjectGitPushRecord[],
    deferPush: (id, generation, oid, at) => transaction(() => {
      if (getBinding(id)?.generation !== generation) return false;
      return db.prepare('UPDATE project_git_push_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE project_id = ? AND binding_generation = ? AND target_oid = ?')
        .run(at, id, generation, oid).changes === 1;
    }),
    ackPush: (id, generation, oid) => transaction(() => {
      const b = getBinding(id); if (b?.generation !== generation) return false;
      const deleted = db.prepare('DELETE FROM project_git_push_queue WHERE project_id = ? AND binding_generation = ? AND target_oid = ?').run(id, generation, oid).changes === 1;
      if (deleted) updateBindingData({ ...b, confirmedRemoteHead: oid });
      return deleted;
    }),
  };
  return store;
}
