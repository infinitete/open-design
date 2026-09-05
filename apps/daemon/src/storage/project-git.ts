import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type {
  ApiError, JsonValue, ProjectGitAction, ProjectGitBasis, ProjectGitOperation,
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
  records: { importMarker: string; applied: boolean } | null;
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

export interface ProjectGitPushRecord {
  projectId: string;
  generation: number;
  targetOid: string;
  attempts: number;
  nextAttemptAt: number;
}

export interface ProjectGitMaterializationCompletion {
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
  bumpProject(projectId: string, expected: ProjectGitBasis): number;
  markExported(projectId: string, expected: Pick<ProjectGitBasis, 'bindingGeneration' | 'projectRevision'>, contentRevision: number): void;
  observeRemote(projectId: string, generation: number, oid: string | null): void;
  /** Full local registration invalidation. HTTP remote unbind instead saves remoteUrl:null, retaining management. */
  invalidateBinding(projectId: string, expected: ProjectGitBasis): number;
  mapId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, portableId: string): string;
  attachId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, portableId: string, localId: string): string;
  getPortableId(repositoryProjectId: string, cloneId: string, kind: ProjectGitIdKind, localId: string): string | null;
  enqueueOperation(input: ProjectGitOperationInput): ProjectGitOperation;
  enqueueCheckpoint(input: ProjectGitCheckpointInput): ProjectGitJournalRecord;
  getOperation(id: string): ProjectGitOperation | null;
  getJournal(id: string): ProjectGitJournalRecord | null;
  /** Associate a reserved import ID before prepared; does not create or expose an application project row. */
  attachOperationProject(id: string, projectId: string, basis: ProjectGitBasis): void;
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
const phases: ProjectGitJournalPhase[] = ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete'];
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The project state changed. Refresh and retry.');
const conflict = () => new GitDomainError('CONFLICT', 409, 'The durable operation conflicts with existing state.');
const recoveryRequired = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'The journal requires recovery before completion.');
const json = (value: unknown) => JSON.stringify(value);

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
  if (!next.operationRoot || !next.candidateOid || !next.publishHead || !next.index.ownerToken
    || !next.previewContentDigest || !next.candidateTreeOid || next.publishBase !== next.baseHead
    || next.publishHead !== next.candidateOid || new Set(next.publicationParents).size !== next.publicationParents.length
    || (next.baseHead !== null && next.publicationParents.filter(parent => parent === next.baseHead).length !== 1)
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
  function requireGeneration(id: string, generation: number): ProjectGitBindingRecord {
    const b = getBinding(id); if (!b || b.generation !== generation) throw changed(); return b;
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
  const pushColumns = 'q.project_id AS projectId, q.binding_generation AS generation, q.target_oid AS targetOid, q.attempts, q.next_attempt_at AS nextAttemptAt';
  const store: ProjectGitStore = {
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
      const targetChanged = !row?.active || !current || ['cloneId', 'repositoryProjectId', 'canonicalRoot', 'commonDir', 'branch', 'remoteUrl']
        .some(key => input[key as keyof ProjectGitBindingRecord] !== current[key as keyof ProjectGitBindingRecord]);
      const next = { ...input, ...(current ? { localHead: current.localHead, observedRemoteHead: current.observedRemoteHead,
        confirmedRemoteHead: current.confirmedRemoteHead, materializedHead: current.materializedHead,
        exportedContentRevision: current.exportedContentRevision, dirty: current.dirty } : {}),
        generation: input.generation + Number(targetChanged) };
      if (targetChanged) { next.observedRemoteHead = null; next.confirmedRemoteHead = null; }
      const duplicate = db.prepare('SELECT 1 FROM project_git_bindings WHERE common_dir = ? AND branch = ? AND active = 1 AND project_id != ?')
        .get(next.commonDir, next.branch, next.projectId);
      if (duplicate) throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'This branch already has a writable binding.');
      db.prepare(`INSERT INTO project_git_bindings (project_id, common_dir, branch, generation, active, project_revision, content_revision, exported_content_revision, record_json)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET common_dir = excluded.common_dir,
        branch = excluded.branch, generation = excluded.generation, active = 1, record_json = excluded.record_json`)
        .run(next.projectId, next.commonDir, next.branch, next.generation, next.projectRevision, next.contentRevision, next.exportedContentRevision, json(next));
      if (targetChanged) db.prepare('DELETE FROM project_git_push_queue WHERE project_id = ?').run(input.projectId);
      return getBinding(input.projectId)!;
    }),
    assertRevision: (id, expected) => { const b = getBinding(id); if (b && (expected === undefined || expected !== b.projectRevision)) throw changed(); },
    bumpContent: (id, expected) => transaction(() => {
      requireBasis(id, expected);
      db.prepare("UPDATE project_git_bindings SET content_revision = content_revision + 1, record_json = json_set(record_json, '$.dirty', json('true')) WHERE project_id = ?").run(id);
      return getBinding(id)!.contentRevision;
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
    enqueueOperation: input => publicOperation(enqueue(input))!,
    enqueueCheckpoint: input => enqueue({ ...input, kind: 'checkpoint' }),
    getOperation: id => { const op = getJournal(id); return op ? publicOperation(op) : null; },
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
    completeMaterialization: (id, input) => transaction(() => {
      const op = getJournal(id);
      if (op?.journalPhase === 'complete' && op.completedProjectRevision !== null) {
        if (!sameBasis(op.basis, input.basis)
          || op.completedProjectRevision !== input.basis.projectRevision + Number(input.advanceProjectRevision)) throw changed();
        return op.completedProjectRevision;
      }
      if (!op?.projectId || !op.recoveryData || op.journalPhase !== 'index_published' || !op.phaseCompleted) throw recoveryRequired();
      if (!sameBasis(op.basis, input.basis)) throw changed();
      if (!op.recordsTransition || op.recordsTransition.advanceProjectRevision !== input.advanceProjectRevision) throw recoveryRequired();
      const b = requireBasis(op.projectId, ownedBasis(op)); const head = op.protection?.sealedCandidate?.publishHead ?? op.recoveryData.publishHead;
      db.prepare('UPDATE project_git_bindings SET exported_content_revision = content_revision WHERE project_id = ?').run(b.projectId);
      updateBindingData({ ...b, localHead: head, materializedHead: head, dirty: false });
      // This transaction closes the local-commit/outbox gap, including paused bindings.
      if (b.remoteUrl !== null) store.queuePush(b.projectId, b.generation, head);
      const revision = getBinding(b.projectId)!.projectRevision;
      db.prepare("UPDATE project_git_operations SET journal_phase = 'complete', phase_completed = 1, status = 'succeeded', phase = 'local_saved', result_json = ?, error_json = NULL, completed_project_revision = ?, updated_at = ? WHERE id = ?")
        .run(json({ head }), revision, Date.now(), id);
      return revision;
    }),
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
