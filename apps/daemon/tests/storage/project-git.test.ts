import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { migrateProjectGit } from '../../src/storage/project-git-migrations.js';
import {
  createProjectGitStore,
  type ProjectGitBindingRecord,
  type ProjectGitJournalPhase,
  type ProjectGitRecoveryData,
  type ProjectGitStore,
  type ProjectGitRegistrationIntent,
} from '../../src/storage/project-git.js';

describe('project Git durable store', () => {
  let root: string;
  let file: string;
  let db: Database.Database;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'od-git-sqlite-'));
    file = join(root, 'state.sqlite');
    db = new Database(file);
    migrateProjectGit(db);
  });
  afterEach(() => {
    if (db.open) db.close();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  const request = { projectId: null, actorId: 'local', kind: 'open' as const,
    idempotencyKey: 'request-1', requestDigest: 'digest-1', payload: { branch: 'main' } };
  it('durably consumes a succeeded preview for exactly one same-actor/project matching confirmation', () => {
    let store = createProjectGitStore(db);
    const preview = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'enable_preview' });
    const consumer = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'enable', idempotencyKey: 'confirm' });
    expect(() => store.consumePreview(preview.id, consumer.id)).toThrow();
    store.updateOperation(preview.id, { status: 'succeeded', phase: 'local_saved', error: null, result: { preview: { id: preview.id, kind: 'enable', basis: preview.basis,
      targetOid: null, expiresAt: 1000, dependencies: [], changes: { addedPaths: [], modifiedPaths: [], deletedPaths: [], settingsChanged: 0,
        conversationsChanged: 0, ignoredPaths: [], privatePaths: [], missingPaths: [], historyMode: 'complete', collisions: [] } } } });
    store.consumePreview(preview.id, consumer.id);
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(() => store.consumePreview(preview.id, consumer.id)).not.toThrow();
    for (const change of [{ idempotencyKey: 'other' }, { actorId: 'foreign', idempotencyKey: 'foreign' },
      { projectId: 'p2', idempotencyKey: 'other-project' }, { kind: 'bind' as const, idempotencyKey: 'wrong-kind' }]) {
      const other = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'enable', ...change });
      expect(() => store.consumePreview(preview.id, other.id)).toThrow();
    }
  });

  it('backfills a conflict resolver link to a viable legacy attempt instead of an earlier failed row', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding()); const current = basis(b);
    const conflict = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'sync', idempotencyKey: 'legacy-conflict', basis: current,
      payload: { lane: 'network' } });
    store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
      error: { code: 'CONFLICT', message: 'Retained conflict.' } });
    const failed = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'resolve', idempotencyKey: 'legacy-failed', basis: current,
      payload: { conflictOperationId: conflict.id } });
    store.updateOperation(failed.id, { status: 'failed', phase: 'failed', result: null, error: { code: 'CONFLICT', message: 'Failed.' } });
    db.prepare('DELETE FROM project_git_conflict_resolutions').run();
    const viable = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'resolve', idempotencyKey: 'legacy-viable', basis: current,
      payload: { conflictOperationId: conflict.id } });
    db.prepare('DELETE FROM project_git_conflict_resolutions').run();
    db.prepare('INSERT INTO project_git_conflict_resolutions VALUES (?, ?)').run(conflict.id, failed.id);

    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(db.prepare('SELECT resolve_operation_id AS id FROM project_git_conflict_resolutions WHERE conflict_operation_id = ?')
      .get(conflict.id)).toEqual({ id: viable.id });
    expect(store.getJournal(failed.id)?.status).toBe('failed');
  });

  it('centrally settles only unowned admitted work and preserves terminal and recoverable journals', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const admitted = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'restore', idempotencyKey: 'admitted-failure', basis: basis(b) });
    store.settleAdmittedOperationFailure(admitted.id, { code: 'INTERNAL_ERROR', message: 'Project versioning operation failed.' });
    expect(store.getOperation(admitted.id)).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'INTERNAL_ERROR' } });
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.getOperation(admitted.id)).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'INTERNAL_ERROR' } });

    const terminal = store.enqueueOperation({ ...request, idempotencyKey: 'terminal' });
    store.updateOperation(terminal.id, { status: 'succeeded', phase: 'local_saved', result: null, error: null });
    store.settleAdmittedOperationFailure(terminal.id, { code: 'INTERNAL_ERROR', message: 'ignored' });
    expect(store.getOperation(terminal.id)).toMatchObject({ status: 'succeeded', error: null });

    const recoverable = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'restore', idempotencyKey: 'recoverable', basis: basis(b) });
    store.setPhase(recoverable.id, 'prepared', recovery());
    store.settleAdmittedOperationFailure(recoverable.id, { code: 'INTERNAL_ERROR', message: 'ignored' });
    expect(store.getJournal(recoverable.id)).toMatchObject({ status: 'queued', journalPhase: 'prepared', recoveryData: expect.any(Object) });
  });

  it('atomically closes interrupted admissions after SQLite close and keeps them terminal after another reopen', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding({ ...binding(), autoSync: false });
    const operations = [
      store.enqueueOperation({ ...request, idempotencyKey: 'restart-import' }),
      store.enqueueOperation({ ...request, projectId: 'p1', kind: 'binding_preview', idempotencyKey: 'restart-preview', basis: basis(b) }),
      store.enqueueOperation({ ...request, projectId: 'p1', kind: 'sync', idempotencyKey: 'restart-sync', basis: basis(b), payload: { lane: 'network' } }),
    ];
    store.updateOperation(operations[1]!.id, { status: 'running', phase: 'waiting_idle', result: null, error: null });
    store.updateOperation(operations[2]!.id, { status: 'waiting', phase: 'waiting_idle', result: null, error: null });

    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(new Set(store.reconcileInterruptedAdmissions())).toEqual(new Set(operations.map(operation => operation.id)));
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    for (const operation of operations) {
      expect(store.getOperation(operation.id)).toMatchObject({ status: 'failed', phase: 'failed',
        error: { code: 'RECOVERY_REQUIRED', details: { reason: 'interrupted_admission' } } });
    }
    expect(store.reconcileInterruptedAdmissions()).toEqual([]);
  });
  function binding(): ProjectGitBindingRecord {
    return { projectId: 'p1', cloneId: 'c1', repositoryProjectId: 'r1',
      canonicalRoot: join(root, 'project'), commonDir: join(root, 'project/.git'),
      branch: 'main', remoteUrl: 'https://private.invalid/repo', generation: 0,
      autoSync: true, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0,
      materializedHead: null, dirty: false };
  }
  function recovery(): ProjectGitRecoveryData {
    return { operationRoot: join(root, 'operations/op1'), baseHead: null, publishHead: 'candidate',
      previewContentDigest: 'preview-digest', candidateTreeOid: 'target-tree', publishBase: null, publicationParents: [],
      candidateOid: 'candidate', paths: [{ path: 'index.html', oldDigest: 'old', candidateDigest: 'new',
        backupPath: join(root, 'operations/op1/index.backup'), protected: false, applied: false }],
      index: { path: join(root, 'project/.git/index'), oldDigest: 'old-index', candidateDigest: 'new-index',
        backupPath: join(root, 'operations/op1/index'), ownerToken: 'owner-1', published: false },
      records: null, refPublished: false };
  }
  function basis(b: ProjectGitBindingRecord) {
    return { bindingGeneration: b.generation, projectRevision: b.projectRevision,
      contentRevision: b.contentRevision, localHead: b.localHead, remoteHead: b.observedRemoteHead };
  }
  function finishPhase(store: ProjectGitStore, id: string, phase: Exclude<ProjectGitJournalPhase, 'complete'>, data: ProjectGitRecoveryData) {
    if (phase !== 'records_applied') { store.completePhase(id, phase, data); return; }
    const op = store.getJournal(id)!;
    store.completeRecords(id, { basis: op.basis, importMarker: data.records?.importMarker ?? null,
      advanceProjectRevision: op.kind !== 'checkpoint' }, () => undefined);
    if (data.records) data.records.applied = true;
  }
  function changeExternalBasis(store: ProjectGitStore, kind: 'generation' | 'project' | 'content' | 'remote') {
    const current = store.getBinding('p1')!;
    if (kind === 'generation') store.saveBinding({ ...current, branch: 'external-branch' });
    if (kind === 'project') store.bumpProject('p1', basis(current));
    if (kind === 'content') store.bumpContent('p1', basis(current));
    if (kind === 'remote') store.observeRemote('p1', current.generation, 'external-remote');
  }

  it('keeps the actual local branch immutable while changing the remote target and rejects duplicate writable roots', () => {
    const store = createProjectGitStore(db); const initial = store.saveBinding(binding());
    const next = store.saveBinding({ ...initial, branch: 'release' });
    expect(next).toMatchObject({ branch: 'release', localBranch: 'main', generation: 2 });
    expect(() => store.saveBinding({ ...next, localBranch: 'other' })).toThrow();
    expect(() => store.saveBinding({ ...binding(), projectId: 'p2', branch: 'other', commonDir: join(root, 'other/.git') })).toThrow();
    expect(() => store.saveBinding({ ...binding(), projectId: 'p2', branch: 'other', localBranch: 'main', canonicalRoot: join(root, 'worktree') })).toThrow();
    db.close(); db = new Database(file); migrateProjectGit(db);
    expect(createProjectGitStore(db).getBinding('p1')).toMatchObject({ branch: 'release', localBranch: 'main' });
  });

  it('retains immutable registration intent and atomically finalizes binding-only target changes', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'bind', basis: basis(b) });
    const intent: ProjectGitRegistrationIntent = { kind: 'bind', completion: 'binding_only', userOperationId: op.id, executionOperationId: op.id,
      projectId: 'p1', cloneId: 'c1', repositoryProjectId: 'r1', dataRootId: 'data', canonicalRoot: b.canonicalRoot, commonDir: b.commonDir,
      localBranch: 'main', targetBranch: 'release', remoteUrl: 'https://new.invalid/repo', autoSync: true,
      originalUserBasis: op.basis, executionBasis: op.basis, hidden: false,
      previousOwner: { ref: 'refs/open-design/bindings/old', oid: 'a'.repeat(40), generation: 1 },
      targetOwner: { ref: 'refs/open-design/bindings/new', expectedOid: null, oid: 'b'.repeat(40), generation: 2 } };
    expect(() => store.prepareRegistration({ ...intent, existingProjectIds: [] })).toThrow();
    store.prepareRegistration(intent);
    expect(store.listPendingRegistrations()).toEqual([{ ...intent, state: 'pending' }]);
    expect(() => store.prepareRegistration({ ...intent, targetBranch: 'forged' })).toThrow();
    expect(() => store.completeRegistration(intent)).toThrow();
    expect(() => db.transaction(() => { store.completeRegistration(intent); throw new Error('rollback'); })()).toThrow('rollback');
    expect(store.getBinding('p1')!.branch).toBe('main');
    expect(store.getRegistration(op.id)!.state).toBe('pending');
    db.transaction(() => store.completeRegistration(intent))();
    expect(store.getBinding('p1')).toMatchObject({ branch: 'release', localBranch: 'main', generation: 2 });
    expect(store.getOperation(op.id)).toMatchObject({ status: 'succeeded', result: { projectId: 'p1' } });
    expect(store.listPendingRegistrations()).toEqual([]);
    db.transaction(() => store.completeRegistration(intent))();
    expect(store.getBinding('p1')!.generation).toBe(2);
    db.close(); db = new Database(file);
    expect(createProjectGitStore(db).getRegistration(op.id)!.state).toBe('complete');
  });

  it('adopts an external HEAD with exact basis CAS, keeps revisions and export provenance, and queues the OID atomically', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding({ ...binding(), localHead: 'a'.repeat(40), materializedHead: 'a'.repeat(40) });
    store.adoptExternalHead('p1', basis(b), 'b'.repeat(40));
    expect(store.getBinding('p1')).toMatchObject({ localHead: 'b'.repeat(40), materializedHead: b.materializedHead,
      dirty: true, projectRevision: 0, contentRevision: 0, exportedContentRevision: 0 });
    expect(store.listDuePushes(0)).toContainEqual(expect.objectContaining({ targetOid: 'b'.repeat(40), generation: b.generation }));
    expect(() => store.adoptExternalHead('p1', basis(b), 'c'.repeat(40))).toThrowError();
    db.close(); db = new Database(file);
    expect(createProjectGitStore(db).getBinding('p1')!.localHead).toBe('b'.repeat(40));
  });

  it('keeps publication mode immutable and refuses fast-forward protection and external adoption during prepared recovery', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding({ ...binding(), localHead: 'a'.repeat(40) });
    const op = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'sync', basis: basis(b) });
    const data = { ...recovery(), publicationMode: 'fast_forward' as const, baseHead: b.localHead, publishBase: b.localHead, publicationParents: ['intermediate'] };
    store.setPhase(op.id, 'prepared', data);
    expect(() => store.adoptExternalHead('p1', basis(b), 'b'.repeat(40))).toThrowError();
    expect(() => store.completePhase(op.id, 'prepared', { ...data, publicationMode: 'commit', publicationParents: [b.localHead!] })).toThrowError();
    store.completePhase(op.id, 'prepared', data); store.setPhase(op.id, 'protected', data);
    expect(() => store.prepareProtection(op.id, { basis: basis(b), checkpointOperationId: 'child', checkpointOid: 'child-oid' })).toThrowError();
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { previewContentDigest: 'digest', candidateTreeOid: 'tree', publishBase: 'child', publicationParents: ['child'], candidateOid: 'oid', publishHead: 'oid' })).toThrowError();
    expect(store.getBinding('p1')!.localHead).toBe(b.localHead);
    expect(store.getJournal(op.id)!.recoveryData!.publicationMode).toBe('fast_forward');
  });

  it('keeps one operation for a retried request across database reopen', () => {
    const first = createProjectGitStore(db).enqueueOperation(request);
    db.close(); db = new Database(file); migrateProjectGit(db);
    const store = createProjectGitStore(db);
    expect(store.enqueueOperation(request).id).toBe(first.id);
    expect(() => store.enqueueOperation({ ...request, requestDigest: 'different' })).toThrow();
    expect(store.getJournal(first.id)).toMatchObject({ actorId: 'local', scope: 'import', payload: { branch: 'main' } });
  });

  it('keeps an exact wrapper-free retry receipt across database reopen', () => {
    let store = createProjectGitStore(db);
    const operation = store.enqueueOperation(request);
    expect(store.claimOperationRequest({ actorId: 'local', projectId: null, action: 'retry',
      idempotencyKey: 'retry-request', requestDigest: 'retry-digest', operationId: operation.id })).toEqual({
      created: true, operationId: operation.id, requestDigest: 'retry-digest',
    });

    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.findOperationRequest({ actorId: 'local', projectId: null, action: 'retry', idempotencyKey: 'retry-request' }))
      .toEqual({ operationId: operation.id, requestDigest: 'retry-digest' });
    expect(store.claimOperationRequest({ actorId: 'local', projectId: null, action: 'retry',
      idempotencyKey: 'retry-request', requestDigest: 'retry-digest', operationId: operation.id })).toEqual({
      created: false, operationId: operation.id, requestDigest: 'retry-digest',
    });
    expect(() => store.claimOperationRequest({ actorId: 'local', projectId: null, action: 'retry',
      idempotencyKey: 'different-retry', requestDigest: 'other-digest', operationId: operation.id })).toThrow();
    expect(store.findOperationRequest({ actorId: 'local', projectId: null, action: 'retry', idempotencyKey: 'different-retry' })).toBeNull();
    expect(() => store.claimOperationRequest({ actorId: 'local', projectId: null, action: 'retry',
      idempotencyKey: 'retry-request', requestDigest: 'different', operationId: operation.id })).toThrow();
  });

  it('admits only one resolution operation for a retained conflict', () => {
    const store = createProjectGitStore(db); const current = store.saveBinding(binding());
    const conflict = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'sync',
      idempotencyKey: 'retained-conflict', basis: basis(current), payload: { lane: 'network' } });
    store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
      error: { code: 'CONFLICT', message: 'Resolve this conflict.' } });
    const first = store.enqueueOperation({ ...request, projectId: 'p1', kind: 'resolve', idempotencyKey: 'resolve-one',
      basis: basis(current), payload: { conflictOperationId: conflict.id } });
    expect(store.getJournal(first.id)?.payload).toEqual({ conflictOperationId: conflict.id });
    expect(() => store.enqueueOperation({ ...request, projectId: 'p1', kind: 'resolve', idempotencyKey: 'resolve-two',
      basis: basis(current), payload: { conflictOperationId: conflict.id } })).toThrow();
  });

  it('arbitrates simultaneous idempotent writers in separate processes', async () => {
    const moduleUrl = new URL('../../src/storage/project-git.ts', import.meta.url).href;
    const source = `import Database from 'better-sqlite3';
      import { createProjectGitStore } from ${JSON.stringify(moduleUrl)};
      const db = new Database(${JSON.stringify(file)});
      process.stdout.write('ready\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try { process.stdout.write(createProjectGitStore(db).enqueueOperation(${JSON.stringify(request)}).id + '\\n'); }
      finally { db.close(); process.stdin.destroy(); }`;
    const children = [0, 1].map(() => spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd: process.cwd(), stdio: 'pipe' }));
    try {
      const results = children.map(child => new Promise<string>((resolve, reject) => {
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve(stdout.trim().split('\n').at(-1)!) : reject(new Error(stderr)));
      }));
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve()); child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
      })));
      for (const child of children) child.stdin.end('go');
      const ids = await Promise.all(results);
      expect(ids[0]).toBeTruthy(); expect(ids[1]).toBe(ids[0]);
      expect(createProjectGitStore(db).listPendingOperations()).toHaveLength(1);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  });

  it('separates actors, kinds and project scopes without NULL uniqueness holes', () => {
    const store = createProjectGitStore(db);
    const ids = [request, { ...request, actorId: 'other' }, { ...request, kind: 'enable_preview' as const },
      { ...request, projectId: 'import' }].map(input => store.enqueueOperation(input).id);
    expect(new Set(ids).size).toBe(4);
  });

  it('rolls back a failed migration and safely retries without rewriting existing data', () => {
    const other = new Database(join(root, 'migration.sqlite'));
    try {
      other.exec('CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES (\'keep\'); CREATE VIEW project_git_push_queue AS SELECT 1');
      expect(() => migrateProjectGit(other)).toThrow();
      expect(other.prepare("SELECT name FROM sqlite_master WHERE name = 'project_git_bindings'").get()).toBeUndefined();
      other.exec('DROP VIEW project_git_push_queue');
      migrateProjectGit(other); migrateProjectGit(other);
      expect(other.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'keep' });
      const store = createProjectGitStore(other); store.enqueueOperation(request); migrateProjectGit(other);
      expect(store.listPendingOperations()).toHaveLength(1);
    } finally { other.close(); }
  });

  it('hooks the migration into the real database startup with an explicit data root', () => {
    const startup = openDatabase(root, { dataDir: join(root, 'startup') });
    expect(createProjectGitStore(startup).enqueueOperation(request).kind).toBe('open');
  });

  it('adds transition columns to the prior schema without inventing completed records effects', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery(); data.paths[0]!.protected = true; data.paths[0]!.applied = true;
    // A pre-fix database could only record the phase name/completion bit, not an owned revision transition.
    db.prepare("UPDATE project_git_operations SET journal_phase = 'records_applied', phase_completed = 1, recovery_json = ? WHERE id = ?")
      .run(JSON.stringify(data), op.id);
    db.exec('ALTER TABLE project_git_operations DROP COLUMN records_transition_json; ALTER TABLE project_git_operations DROP COLUMN protection_json; ALTER TABLE project_git_operations DROP COLUMN owner_operation_id');
    db.close(); db = new Database(file); migrateProjectGit(db); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.getJournal(op.id)).toMatchObject({ recordsTransition: null, protection: null, ownerOperationId: null });
    expect(() => store.setPhase(op.id, 'ref_published', data)).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(store.getBinding('p1')?.projectRevision).toBe(0);
  });

  it('increments content independently and rejects stale revision and generation mutations', () => {
    const store = createProjectGitStore(db);
    const b = store.saveBinding(binding());
    expect(b.generation).toBe(1);
    expect(() => store.assertRevision('p1', undefined)).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED', status: 409 }));
    store.assertRevision('p1', 0);
    expect(store.bumpContent('p1', basis(b))).toBe(1);
    expect(store.getBinding('p1')).toMatchObject({ projectRevision: 0, contentRevision: 1, dirty: true });
    expect(() => store.bumpContent('p1', basis(b))).toThrow();
    const current = store.getBinding('p1')!;
    expect(store.bumpProject('p1', basis(current))).toBe(1);
    expect(() => store.assertRevision('p1', 0)).toThrow();
    expect(() => store.saveBinding(b)).toThrow();
    expect(() => store.assertRevision('unmanaged', undefined)).not.toThrow();
  });

  it('atomically receipts each run terminal once and rejects tuple substitution', () => {
    let store = createProjectGitStore(db);
    const b = store.saveBinding(binding());
    expect(store.recordRunTerminal({
      runId: 'run-1',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'failed',
    })).toBe(true);
    expect(store.getBinding('p1')).toMatchObject({ contentRevision: 1, dirty: true });
    expect(store.recordRunTerminal({
      runId: 'run-1',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'failed',
    })).toBe(false);
    expect(store.getBinding('p1')?.contentRevision).toBe(1);
    expect(() => store.recordRunTerminal({
      runId: 'run-1',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'canceled',
    })).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));

    expect(() => store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation + 1,
      projectRevision: b.projectRevision,
      terminal: 'succeeded',
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(db.prepare('SELECT count(*) AS count FROM project_git_run_terminals').get())
      .toEqual({ count: 1 });
    expect(store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'succeeded',
    })).toBe(true);

    db.close();
    db = new Database(file);
    migrateProjectGit(db);
    store = createProjectGitStore(db);
    expect(store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 0,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'succeeded',
    })).toBe(false);
    const cleanBasis = store.getBinding('p1')!;
    store.markExported('p1', basis(cleanBasis), cleanBasis.contentRevision);
    expect(store.getBinding('p1')?.dirty).toBe(false);
    expect(store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 1,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'failed',
    })).toBe(true);
    expect(store.getBinding('p1')?.dirty).toBe(true);
    expect(store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 1,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'failed',
    })).toBe(false);
    expect(() => store.recordRunTerminal({
      runId: 'run-2',
      executionAttempt: 1,
      projectId: 'p1',
      bindingGeneration: b.generation,
      projectRevision: b.projectRevision,
      terminal: 'canceled',
    })).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(store.recordRunTerminal({
      runId: 'unmanaged-run',
      executionAttempt: 0,
      projectId: 'unmanaged',
      bindingGeneration: 0,
      projectRevision: 0,
      terminal: 'failed',
    })).toBe(false);
    expect(store.getBinding('p1')?.contentRevision).toBe(3);
  });

  it('losslessly migrates legacy run terminal receipts to execution attempt zero', () => {
    db.exec(`DROP TABLE project_git_run_terminals;
      CREATE TABLE project_git_run_terminals (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        project_revision INTEGER NOT NULL,
        terminal TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO project_git_run_terminals VALUES ('legacy-run', 'p1', 2, 3, 'failed', 123);`);

    migrateProjectGit(db);

    expect(db.prepare(`SELECT run_id AS runId, execution_attempt AS executionAttempt,
      project_id AS projectId, binding_generation AS bindingGeneration,
      project_revision AS projectRevision, terminal, created_at AS createdAt
      FROM project_git_run_terminals`).all()).toEqual([{
      runId: 'legacy-run', executionAttempt: 0, projectId: 'p1', bindingGeneration: 2,
      projectRevision: 3, terminal: 'failed', createdAt: 123,
    }]);
    expect((db.prepare('PRAGMA table_info(project_git_run_terminals)').all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((column: { pk: number }) => column.pk > 0)
      .map((column: { name: string; pk: number }) => [column.name, column.pk]))
      .toEqual([['run_id', 1], ['execution_attempt', 2]]);
  });

  it('keeps generation tombstones across local invalidation and rejects stale targets after rebind', () => {
    const store = createProjectGitStore(db);
    const b = store.saveBinding(binding());
    store.queuePush('p1', b.generation, 'old');
    expect(store.invalidateBinding('p1', basis(b))).toBe(2);
    expect(store.getBinding('p1')).toBeNull();
    expect(store.listBindings()).toEqual([]);
    expect(store.getBindingGeneration('p1')).toBe(2);
    expect(() => store.assertRevision('p1', undefined)).not.toThrow();
    expect(() => store.saveBinding(b)).toThrow();
    const rebound = store.saveBinding({ ...b, generation: 2, branch: 'next' });
    expect(rebound.generation).toBe(3);
    expect(() => store.queuePush('p1', 1, 'late')).toThrow();
    expect(store.listDuePushes(Date.now())).toEqual([]);
    expect(store.listBindings()).toHaveLength(1);
    const changed = store.saveBinding({ ...rebound, remoteUrl: 'https://other.invalid/repo' });
    expect(changed.generation).toBe(4);
    expect(() => store.saveBinding({ ...rebound, autoSync: false })).toThrow();
  });

  it('prevents duplicate writable branch bindings in the same common directory', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    expect(() => store.saveBinding({ ...binding(), projectId: 'p2', cloneId: 'c2' })).toThrow();
    expect(store.saveBinding({ ...binding(), projectId: 'p2', cloneId: 'c2', branch: 'other', canonicalRoot: join(root, 'other-worktree') }).generation).toBe(1);
    store.invalidateBinding('p1', basis(b));
    expect(store.saveBinding({ ...binding(), projectId: 'p3', cloneId: 'c3' }).generation).toBe(1);
  });

  it('rebinds after reopen using nonzero tombstone revisions and rejects a stale tombstone', () => {
    let store = createProjectGitStore(db); let b = store.saveBinding(binding());
    store.bumpContent('p1', basis(b)); b = store.getBinding('p1')!;
    store.bumpProject('p1', basis(b)); b = store.getBinding('p1')!;
    store.invalidateBinding('p1', basis(b));
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    const tombstone = store.getBindingTombstone('p1')!;
    expect(tombstone).toEqual({ generation: 2, projectRevision: 1, contentRevision: 1 });
    expect(store.getBinding('p1')).toBeNull(); store.assertRevision('p1', undefined);
    expect(store.saveBinding({ ...binding(), ...tombstone }).generation).toBe(3);
    expect(store.getBindingTombstone('p1')).toBeNull();
    expect(() => store.saveBinding({ ...binding(), ...tombstone })).toThrow();
  });

  it('removes only the remote while retaining local management and revision enforcement', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    store.queuePush('p1', b.generation, 'head');
    const local = store.saveBinding({ ...b, remoteUrl: null });
    expect(local).toMatchObject({ generation: 2, remoteUrl: null, canonicalRoot: b.canonicalRoot });
    expect(store.listDuePushes(Date.now())).toEqual([]);
    expect(() => store.assertRevision('p1', undefined)).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(store.bumpContent('p1', basis(local))).toBe(1);
    expect(store.getBindingTombstone('p1')).toBeNull();
  });

  it('preserves stable forward and reverse IDs across reopen with clone isolation', () => {
    let store = createProjectGitStore(db);
    expect(store.attachId('r1', 'c1', 'conversation', 'portable-1', 'existing-row')).toBe('existing-row');
    const imported = store.mapId('r1', 'c2', 'conversation', 'portable-1');
    expect(imported).not.toBe('existing-row');
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.mapId('r1', 'c1', 'conversation', 'portable-1')).toBe('existing-row');
    expect(store.mapId('r1', 'c2', 'conversation', 'portable-1')).toBe(imported);
    expect(store.getPortableId('r1', 'c1', 'conversation', 'existing-row')).toBe('portable-1');
    expect(store.getPortableId('r1', 'c2', 'conversation', 'existing-row')).toBeNull();
  });

  it('rejects ID replacement, reverse ambiguity and cross-kind portable collisions', () => {
    const store = createProjectGitStore(db);
    store.attachId('r1', 'c1', 'conversation', 'portable-1', 'existing-row');
    expect(() => store.attachId('r1', 'c1', 'conversation', 'portable-1', 'replacement')).toThrow();
    expect(() => store.attachId('r1', 'c1', 'conversation', 'portable-2', 'existing-row')).toThrow();
    expect(() => store.mapId('r1', 'c2', 'message', 'portable-1')).toThrow();
    expect(store.getPortableId('r1', 'c1', 'conversation', 'existing-row')).toBe('portable-1');
  });

  it('separates portable turns from record identities while preserving clone ownership', () => {
    let store = createProjectGitStore(db);
    store.attachId('r1', 'c1', 'message', 'shared-id', 'local-message');
    const turn = store.mapId('r1', 'c1', 'turn', 'shared-id');
    expect(turn).not.toBe('local-message');
    expect(store.getPortableId('r1', 'c1', 'turn', turn)).toBe('shared-id');
    expect(() => store.mapId('r1', 'c2', 'conversation', 'shared-id')).toThrow();
    expect(store.mapId('r1', 'c2', 'turn', 'shared-id')).not.toBe(turn);
    expect(() => store.attachId('r1', 'c3', 'turn', 'shared-id', turn)).toThrow();
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.mapId('r1', 'c1', 'turn', 'shared-id')).toBe(turn);
    expect(store.mapId('r1', 'c1', 'message', 'shared-id')).toBe('local-message');
  });

  it('migrates the old all-kind namespace without changing any mapped IDs', () => {
    db.exec(`DROP TABLE project_git_id_map;
      CREATE TABLE project_git_id_map (
        repository_project_id TEXT NOT NULL, clone_id TEXT NOT NULL, kind TEXT NOT NULL,
        portable_id TEXT NOT NULL, local_id TEXT NOT NULL,
        PRIMARY KEY (repository_project_id, clone_id, portable_id),
        UNIQUE (repository_project_id, clone_id, kind, local_id));
      INSERT INTO project_git_id_map VALUES ('r1', 'c1', 'message', 'm1', 'local-m1');
      INSERT INTO project_git_id_map VALUES ('r1', 'c1', 'turn', 't1', 'local-t1');`);
    migrateProjectGit(db); migrateProjectGit(db);
    const store = createProjectGitStore(db);
    expect(store.mapId('r1', 'c1', 'message', 'm1')).toBe('local-m1');
    expect(store.mapId('r1', 'c1', 'turn', 't1')).toBe('local-t1');
    expect(store.mapId('r1', 'c1', 'turn', 'm1')).not.toBe('local-m1');
  });

  it('rejects attaching one physical local message to different clones while retaining exact retry', () => {
    let store = createProjectGitStore(db);
    expect(store.attachId('r1', 'c1', 'message', 'portable-message', 'local-message')).toBe('local-message');
    expect(store.attachId('r1', 'c1', 'message', 'portable-message', 'local-message')).toBe('local-message');
    expect(() => store.attachId('r1', 'c2', 'message', 'portable-message', 'local-message')).toThrow();
    expect(() => store.attachId('r1', 'c2', 'message', 'different-portable', 'local-message')).toThrow();
    expect(() => store.attachId('r2', 'c3', 'message', 'another-portable', 'local-message')).toThrow();
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.attachId('r1', 'c1', 'message', 'portable-message', 'local-message')).toBe('local-message');
    expect(() => store.attachId('r1', 'c2', 'message', 'portable-message', 'local-message')).toThrow();
    expect(store.mapId('r1', 'c2', 'message', 'portable-message')).not.toBe('local-message');
  });

  it('reopens pending pushes and only acknowledges the exact generation and target', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    store.queuePush('p1', b.generation, 'first'); store.queuePush('p1', b.generation, 'newer');
    expect(store.ackPush('p1', b.generation, 'first')).toBe(false);
    expect(store.deferPush('p1', b.generation, 'first', 900)).toBe(false);
    expect(store.deferPush('p1', b.generation, 'newer', 900)).toBe(true);
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.listDuePushes(899)).toEqual([]);
    expect(store.listDuePushes(900)).toMatchObject([{ targetOid: 'newer', attempts: 1, nextAttemptAt: 900 }]);
    expect(store.ackPush('p1', 0, 'newer')).toBe(false);
    expect(store.ackPush('p1', 1, 'newer')).toBe(true);
    expect(store.getBinding('p1')?.confirmedRemoteHead).toBe('newer');
    expect(store.listDuePushes(999)).toEqual([]);
  });

  it('retains dirty content newer than an export and fences remote observations', () => {
    const store = createProjectGitStore(db); let b = store.saveBinding(binding());
    store.bumpContent('p1', basis(b)); b = store.getBinding('p1')!;
    store.bumpContent('p1', basis(b));
    store.markExported('p1', { bindingGeneration: 1, projectRevision: 0 }, 1);
    expect(store.getBinding('p1')).toMatchObject({ contentRevision: 2, exportedContentRevision: 1, dirty: true });
    store.markExported('p1', { bindingGeneration: 1, projectRevision: 0 }, 2);
    expect(store.getBinding('p1')?.dirty).toBe(false);
    expect(() => store.markExported('p1', { bindingGeneration: 1, projectRevision: 0 }, 3)).toThrow();
    store.bumpProject('p1', basis(store.getBinding('p1')!));
    expect(() => store.markExported('p1', { bindingGeneration: 1, projectRevision: 0 }, 2)).toThrow();
    store.observeRemote('p1', 1, 'remote');
    expect(store.getBinding('p1')?.observedRemoteHead).toBe('remote');
    expect(() => store.observeRemote('p1', 0, 'stale')).toThrow();
  });

  it('keeps private inputs and checkpoint journals out of public operation projections', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, payload: { url: 'https://secret.invalid', localPath: root } });
    store.setPhase(op.id, 'prepared', recovery());
    store.updateOperation(op.id, { status: 'waiting', phase: 'recovering', result: { head: 'candidate' }, error: null });
    const visible = store.getOperation(op.id)!;
    expect(Object.keys(visible).sort()).toEqual(['basis', 'error', 'id', 'kind', 'phase', 'projectId', 'result', 'status']);
    expect(JSON.stringify(visible)).not.toContain(root);
    expect(JSON.stringify(visible)).not.toContain('secret.invalid');
    const checkpoint = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', idempotencyKey: 'c1',
      requestDigest: 'checkpoint-1', basis: basis(b), payload: {} });
    expect(checkpoint.kind).toBe('checkpoint');
    expect(store.getOperation(checkpoint.id)).toBeNull();
    expect(store.listRecoverable()).toHaveLength(2);
  });

  it('requires original managed-project basis and preserves it on idempotent retry', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    expect(() => store.enqueueOperation({ ...request, projectId: 'p1' })).toThrow();
    const original = { ...request, projectId: 'p1', basis: basis(b) };
    const op = store.enqueueOperation(original);
    store.bumpProject('p1', basis(b));
    expect(store.enqueueOperation(original).basis.projectRevision).toBe(0);
    expect(() => store.enqueueOperation({ ...original, idempotencyKey: 'new' })).toThrow();
    expect(store.getJournal(op.id)?.basis.projectRevision).toBe(0);
  });

  it('attaches a reserved import project once without changing actor or idempotency scope', () => {
    let store = createProjectGitStore(db); const op = store.enqueueOperation(request);
    const b = store.saveBinding(binding());
    store.attachOperationProject(op.id, 'p1', basis(b));
    store.attachOperationProject(op.id, 'p1', basis(b));
    expect(store.enqueueOperation(request)).toMatchObject({ id: op.id, projectId: 'p1', basis: basis(b) });
    expect(store.getJournal(op.id)).toMatchObject({ scope: 'import', actorId: 'local' });
    expect(() => store.attachOperationProject(op.id, 'different', basis(b))).toThrow();
    expect(() => store.attachOperationProject(op.id, 'p1', { ...basis(b), projectRevision: 1 })).toThrow();
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.enqueueOperation(request).projectId).toBe('p1');
    store.setPhase(op.id, 'prepared', recovery());
    store.attachOperationProject(op.id, 'p1', basis(b));
    const late = store.enqueueOperation({ ...request, idempotencyKey: 'late' });
    store.setPhase(late.id, 'prepared', recovery());
    expect(() => store.attachOperationProject(late.id, 'p1', basis(b))).toThrow();
  });

  it('rejects an old managed journal before recording new side-effect intent on a rebound project', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, projectId: 'p1', basis: basis(b) });
    store.saveBinding({ ...b, branch: 'other' });
    expect(() => store.setPhase(op.id, 'prepared', recovery())).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(store.getJournal(op.id)?.journalPhase).toBeNull();
  });

  it('persists intent before completion and rejects skipped or regressed journal facts', () => {
    const store = createProjectGitStore(db); const op = store.enqueueOperation(request); const data = recovery();
    expect(() => store.completePhase(op.id, 'prepared', data)).toThrow();
    store.setPhase(op.id, 'prepared', data);
    expect(() => store.setPhase(op.id, 'protected', data)).toThrow();
    store.completePhase(op.id, 'prepared', data);
    expect(() => store.setPhase(op.id, 'files_applied', data)).toThrow();
    store.setPhase(op.id, 'protected', data);
    expect(() => store.completePhase(op.id, 'protected', data)).toThrow();
    data.paths[0]!.protected = true;
    store.completePhase(op.id, 'protected', data);
    expect(() => store.setPhase(op.id, 'prepared', data)).toThrow();
    expect(() => store.setPhase(op.id, 'files_applied', { ...data, candidateOid: 'different' })).toThrow();
    db.close(); db = new Database(file); migrateProjectGit(db);
    expect(createProjectGitStore(db).listRecoverable()[0]).toMatchObject({
      journalPhase: 'protected', phaseCompleted: true,
      recoveryData: { baseHead: null, candidateOid: 'candidate', paths: [{ protected: true, applied: false }] },
    });
  });

  it('does not accept completion facts before their corresponding durable intent', () => {
    const store = createProjectGitStore(db); const op = store.enqueueOperation(request); const data = recovery();
    expect(() => store.setPhase(op.id, 'prepared', { ...data, refPublished: true })).toThrow();
    store.setPhase(op.id, 'prepared', data); store.completePhase(op.id, 'prepared', data);
    const premature = structuredClone(data); premature.paths[0]!.protected = true;
    expect(() => store.setPhase(op.id, 'protected', premature)).toThrow();
    store.setPhase(op.id, 'protected', data);
    expect(() => store.completePhase(op.id, 'protected', { ...premature, refPublished: true })).toThrow();
    expect(() => store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', result: null, error: null })).toThrow();
  });

  it('commits imported records, ID map, marker and owned revision before refs, then resumes without a second import', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    data.records = { importMarker: 'import-1', applied: false };
    db.exec('CREATE TABLE imported_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    for (const phase of ['prepared', 'protected', 'files_applied'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      finishPhase(store, op.id, phase, data);
    }
    const input = { basis: basis(b), importMarker: 'import-1', advanceProjectRevision: true };
    expect(() => store.completeRecords(op.id, input, () => undefined)).toThrow();
    store.setPhase(op.id, 'records_applied', data);
    expect(() => store.completePhase(op.id, 'records_applied', { ...data, records: { importMarker: 'import-1', applied: true } })).toThrow();
    expect(() => store.completeRecords(op.id, { ...input, importMarker: null }, () => undefined)).toThrow();
    expect(() => store.completeRecords(op.id, input, () => {
      store.attachId('r1', 'c1', 'message', 'portable-message', 'restored-message');
      db.prepare('INSERT INTO imported_messages VALUES (?, ?)').run('restored-message', 'restored');
      throw new Error('import failed');
    })).toThrow('import failed');
    expect(db.prepare('SELECT * FROM imported_messages').all()).toEqual([]);
    expect(store.getPortableId('r1', 'c1', 'message', 'restored-message')).toBeNull();
    expect(store.getBinding('p1')?.projectRevision).toBe(0);
    expect(store.getJournal(op.id)).toMatchObject({ phaseCompleted: false, recordsTransition: null });
    let imports = 0;
    expect(store.completeRecords(op.id, input, () => {
      imports++;
      store.attachId('r1', 'c1', 'message', 'portable-message', 'restored-message');
      db.prepare('INSERT INTO imported_messages VALUES (?, ?)').run('restored-message', 'restored');
    })).toBe(1);
    expect(store.getBinding('p1')?.projectRevision).toBe(1);
    expect(store.getJournal(op.id)).toMatchObject({ basis: { projectRevision: 0 }, journalPhase: 'records_applied',
      phaseCompleted: true, recordsTransition: { importMarker: 'import-1', projectRevision: 1 } });
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.completeRecords(op.id, input, () => { imports++; })).toBe(1);
    expect(imports).toBe(1);
    expect(db.prepare('SELECT * FROM imported_messages').all()).toEqual([{ id: 'restored-message', content: 'restored' }]);
    const persisted = store.getJournal(op.id)!.recoveryData!;
    store.setPhase(op.id, 'ref_published', persisted); persisted.refPublished = true;
    store.completePhase(op.id, 'ref_published', persisted);
    store.setPhase(op.id, 'index_published', persisted); persisted.index.published = true;
    store.completePhase(op.id, 'index_published', persisted);
    expect(store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: true })).toBe(1);
    expect(store.getBinding('p1')?.projectRevision).toBe(1);
    expect(store.getOperation(op.id)?.basis.projectRevision).toBe(0);
    expect(store.completeRecords(op.id, input, () => { imports++; })).toBe(1);
    expect(imports).toBe(1);
  });

  it.each([
    { head: 'base', parents: ['base', 'remote'], want: ['protect', 'remote'] },
    { head: 'base', parents: ['remote', 'base'], want: ['remote', 'protect'] },
    { head: null, parents: [], want: ['protect'] },
    { head: null, parents: ['remote'], want: ['protect', 'remote'] },
  ])('persists owned protection and seals same-tree publication with original parents $parents', ({ head, parents, want }) => {
    let store = createProjectGitStore(db); const b = store.saveBinding({ ...binding(), localHead: head });
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = { ...recovery(), baseHead: head, publishBase: head, publicationParents: parents };
    store.setPhase(op.id, 'prepared', data); store.completePhase(op.id, 'prepared', data);
    store.setPhase(op.id, 'protected', data);
    const checkpoint = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', basis: basis(b),
      idempotencyKey: 'protect-checkpoint', requestDigest: 'protect-digest', payload: {}, ownerOperationId: op.id });
    const checkpointData = { ...recovery(), operationRoot: join(root, 'operations/checkpoint'),
      baseHead: head, publishBase: head, publicationParents: head ? [head] : [],
      candidateOid: 'protect', publishHead: 'protect', candidateTreeOid: 'protected-tree', records: null };
    store.setPhase(checkpoint.id, 'prepared', checkpointData); store.completePhase(checkpoint.id, 'prepared', checkpointData);
    const intent = { basis: basis(b), checkpointOperationId: checkpoint.id, checkpointOid: 'protect' };
    expect(() => store.completeProtection(op.id, intent)).toThrow();
    expect(() => store.prepareProtection(op.id, { ...intent, checkpointOid: 'forged' })).toThrow();
    store.prepareProtection(op.id, intent); store.prepareProtection(op.id, intent);
    expect(() => store.completeProtection(op.id, intent)).toThrow();
    for (const phase of ['protected', 'files_applied', 'records_applied', 'ref_published', 'index_published'] as const) {
      store.setPhase(checkpoint.id, phase, checkpointData);
      if (phase === 'protected') checkpointData.paths[0]!.protected = true;
      if (phase === 'files_applied') checkpointData.paths[0]!.applied = true;
      if (phase === 'ref_published') checkpointData.refPublished = true;
      if (phase === 'index_published') checkpointData.index.published = true;
      finishPhase(store, checkpoint.id, phase, checkpointData);
    }
    store.completeMaterialization(checkpoint.id, { basis: basis(b), advanceProjectRevision: false });
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.getBinding('p1')).toMatchObject({ localHead: 'protect', projectRevision: 0, contentRevision: 0 });
    expect(() => store.completeProtection(op.id, { ...intent, checkpointOid: 'forged' })).toThrow();
    store.completeProtection(op.id, intent); store.completeProtection(op.id, intent);
    expect(store.getJournal(op.id)).toMatchObject({ basis: { localHead: head }, recoveryData: { baseHead: head, candidateTreeOid: 'target-tree' },
      protection: { completed: true, publishBase: 'protect' } });
    const candidate = { previewContentDigest: 'preview-digest', candidateTreeOid: 'target-tree', publishBase: 'protect',
      publicationParents: want, candidateOid: 'replacement', publishHead: 'replacement' };
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { ...candidate, previewContentDigest: 'changed' })).toThrow();
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { ...candidate, candidateTreeOid: 'changed-tree' })).toThrow();
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { ...candidate, publicationParents: ['protect', 'protect'] })).toThrow();
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { ...candidate, publicationParents: ['unrelated'] })).toThrow();
    store.sealProtectedCandidate(op.id, basis(b), candidate);
    store.sealProtectedCandidate(op.id, basis(b), candidate);
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { ...candidate, candidateOid: 'other', publishHead: 'other' })).toThrow();
    expect(() => store.setPhase(op.id, 'protected', { ...data, publishBase: 'protect' })).toThrow();
    data.paths[0]!.protected = true; store.completePhase(op.id, 'protected', data);
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    for (const phase of ['files_applied', 'records_applied', 'ref_published', 'index_published'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      if (phase === 'index_published') data.index.published = true;
      finishPhase(store, op.id, phase, data);
    }
    expect(store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: true })).toBe(1);
    expect(store.getBinding('p1')).toMatchObject({ localHead: 'replacement', projectRevision: 1, contentRevision: 0 });
    expect(store.getJournal(op.id)?.protection?.sealedCandidate?.publicationParents).toEqual(want);
    expect(store.getOperation(op.id)?.basis).toEqual(basis(b));
  });

  it.each(['restore', 'checkpoint'] as const)('does not invoke an import callback for a declared no-import $0', kind => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = kind === 'checkpoint' ? store.enqueueCheckpoint({ ...request, projectId: 'p1', basis: basis(b) })
      : store.enqueueOperation({ ...request, kind, projectId: 'p1', basis: basis(b) });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      finishPhase(store, op.id, phase, data);
    }
    store.setPhase(op.id, 'records_applied', data);
    const advance = kind !== 'checkpoint';
    expect(() => store.completeRecords(op.id, { basis: basis(b), importMarker: 'invented', advanceProjectRevision: advance }, () => undefined)).toThrow();
    let called = false;
    expect(store.completeRecords(op.id, { basis: basis(b), importMarker: null, advanceProjectRevision: advance }, () => { called = true; })).toBe(advance ? 1 : 0);
    expect(called).toBe(false);
  });

  it.each(['generation', 'project', 'content', 'remote'] as const)('rejects an unrelated $0 transition after records completion', change => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      finishPhase(store, op.id, phase, data);
    }
    changeExternalBasis(store, change);
    expect(() => store.setPhase(op.id, 'ref_published', data)).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(() => store.completeRecords(op.id, { basis: basis(store.getBinding('p1')!), importMarker: null, advanceProjectRevision: true }, () => undefined)).toThrow();
    expect(store.getJournal(op.id)?.basis).toEqual(basis(b));
    expect(store.getJournal(op.id)?.journalPhase).toBe('records_applied');
  });

  it.each(['generation', 'project', 'content', 'remote'] as const)('rejects external $0 changes after a protection receipt', change => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    store.setPhase(op.id, 'prepared', data); store.completePhase(op.id, 'prepared', data);
    store.setPhase(op.id, 'protected', data);
    const checkpoint = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', basis: basis(b),
      idempotencyKey: 'owned', requestDigest: 'digest', payload: {}, ownerOperationId: op.id });
    const protective = { ...recovery(), candidateOid: 'protect', publishHead: 'protect', candidateTreeOid: 'protected-tree' };
    store.setPhase(checkpoint.id, 'prepared', protective); store.completePhase(checkpoint.id, 'prepared', protective);
    const input = { basis: basis(b), checkpointOperationId: checkpoint.id, checkpointOid: 'protect' };
    store.prepareProtection(op.id, input);
    for (const phase of ['protected', 'files_applied', 'records_applied', 'ref_published', 'index_published'] as const) {
      store.setPhase(checkpoint.id, phase, protective);
      if (phase === 'protected') protective.paths[0]!.protected = true;
      if (phase === 'files_applied') protective.paths[0]!.applied = true;
      if (phase === 'ref_published') protective.refPublished = true;
      if (phase === 'index_published') protective.index.published = true;
      finishPhase(store, checkpoint.id, phase, protective);
    }
    store.completeMaterialization(checkpoint.id, { basis: basis(b), advanceProjectRevision: false });
    expect(() => db.transaction(() => {
      changeExternalBasis(store, change);
      expect(() => store.completeProtection(op.id, input)).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
      expect(store.getJournal(op.id)?.protection?.completed).toBe(false);
      throw new Error('rollback fixture mutation');
    }).immediate()).toThrow('rollback fixture mutation');
    store.completeProtection(op.id, input);
    changeExternalBasis(store, change);
    expect(() => store.completeProtection(op.id, input)).toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(() => store.sealProtectedCandidate(op.id, basis(b), { previewContentDigest: 'preview-digest', candidateTreeOid: 'target-tree',
      publishBase: 'protect', publicationParents: ['protect'], candidateOid: 'sealed', publishHead: 'sealed' }))
      .toThrowError(expect.objectContaining({ code: 'PROJECT_STATE_CHANGED' }));
    expect(store.getJournal(op.id)?.protection?.sealedCandidate).toBeNull();
  });

  it('refuses an unrelated checkpoint owner and requires protection intent before child publication', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    store.setPhase(op.id, 'prepared', data); store.completePhase(op.id, 'prepared', data);
    store.setPhase(op.id, 'protected', data);
    const unrelated = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', basis: basis(b), idempotencyKey: 'unrelated', requestDigest: 'digest', payload: {} });
    store.setPhase(unrelated.id, 'prepared', data);
    expect(() => store.prepareProtection(op.id, { basis: basis(b), checkpointOperationId: unrelated.id, checkpointOid: 'candidate' })).toThrow();
    const owned = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', basis: basis(b), idempotencyKey: 'owned', requestDigest: 'digest', payload: {}, ownerOperationId: op.id });
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied'] as const) {
      store.setPhase(owned.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      finishPhase(store, owned.id, phase, data);
    }
    expect(() => store.setPhase(owned.id, 'ref_published', data)).toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(() => store.prepareProtection(op.id, { basis: basis(b), checkpointOperationId: owned.id, checkpointOid: 'candidate' })).toThrow();
  });

  it('recovers ref publication before index replacement and atomically completes the matching binding', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', idempotencyKey: 'checkpoint',
      requestDigest: 'digest', basis: basis(b), payload: {} });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      finishPhase(store, op.id, phase, data);
    }
    store.updateOperation(op.id, { status: 'failed', phase: 'failed', result: null, error: null });
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.listRecoverable()[0]).toMatchObject({ journalPhase: 'ref_published', recoveryData: { refPublished: true, index: { published: false } } });
    expect(() => store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: false })).toThrow();
    store.setPhase(op.id, 'index_published', data); data.index!.published = true;
    store.completePhase(op.id, 'index_published', data);
    expect(() => store.completeMaterialization(op.id, { basis: { ...basis(b), bindingGeneration: 0 }, advanceProjectRevision: false })).toThrow();
    expect(store.getBinding('p1')?.localHead).toBeNull();
    for (const remainingDirty of [false, true]) expect(() => store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: false, remainingDirty }))
      .toThrowError(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: false })).toBe(0);
    expect(store.getBinding('p1')).toMatchObject({ localHead: 'candidate', materializedHead: 'candidate', projectRevision: 0 });
    expect(store.listDuePushes(Date.now())).toMatchObject([{ targetOid: 'candidate', generation: 1 }]);
    expect(store.listRecoverable()).toEqual([]);
    expect(store.getJournal(op.id)).toMatchObject({ journalPhase: 'complete', phaseCompleted: true, status: 'succeeded' });
  });

  it('commits journal, baseline and paused outbox together before process death; replay preserves newer targets', async () => {
    let store = createProjectGitStore(db); const b = store.saveBinding({ ...binding(), autoSync: false });
    const op = store.enqueueOperation({ ...request, kind: 'restore', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      if (phase === 'index_published') data.index!.published = true;
      finishPhase(store, op.id, phase, data);
    }
    const input = { basis: basis(b), advanceProjectRevision: true };
    const source = `import Database from 'better-sqlite3';
      import { createProjectGitStore } from ${JSON.stringify(new URL('../../src/storage/project-git.ts', import.meta.url).href)};
      const db = new Database(${JSON.stringify(file)});
      createProjectGitStore(db).completeMaterialization(${JSON.stringify(op.id)}, ${JSON.stringify(input)});
      process.kill(process.pid, 'SIGKILL');`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const signal = await new Promise<string | null>((resolve, reject) => {
      child.on('error', reject); child.on('exit', (code, signal) => code === null ? resolve(signal) : reject(new Error(stderr)));
    });
    expect(signal).toBe('SIGKILL');
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.getBinding('p1')).toMatchObject({ projectRevision: 1, localHead: 'candidate', autoSync: false });
    expect(store.listDuePushes(Date.now())).toMatchObject([{ targetOid: 'candidate' }]);
    expect(store.getJournal(op.id)?.journalPhase).toBe('complete');
    expect(store.completeMaterialization(op.id, input)).toBe(1);
    store.queuePush('p1', 1, 'later-head');
    expect(store.completeMaterialization(op.id, input)).toBe(1);
    expect(store.listDuePushes(Date.now())).toMatchObject([{ targetOid: 'later-head' }]);
    expect(store.getBinding('p1')?.projectRevision).toBe(1);
  });

  it('composes completion, target change and new-generation queue without exposing the old target queue', () => {
    const store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueOperation({ ...request, kind: 'bind', projectId: 'p1', basis: basis(b) });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      if (phase === 'index_published') data.index!.published = true;
      finishPhase(store, op.id, phase, data);
    }
    store.queuePush('p1', 1, 'previous');
    const observerDb = new Database(file); const observer = createProjectGitStore(observerDb);
    try {
      const compose = (abort: boolean) => db.transaction(() => {
        store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: true });
        expect(observer.listDuePushes(Date.now())).toMatchObject([{ generation: 1, targetOid: 'previous' }]);
        const next = store.saveBinding({ ...store.getBinding('p1')!, remoteUrl: 'https://next.invalid/repo' });
        store.queuePush('p1', next.generation, next.localHead!);
        if (abort) throw new Error('transaction rollback');
      }).immediate();
      expect(() => compose(true)).toThrow('transaction rollback');
      expect(store.getJournal(op.id)?.journalPhase).toBe('index_published');
      expect(store.getBinding('p1')).toMatchObject({ generation: 1, projectRevision: 1 });
      compose(false);
      expect(observer.listDuePushes(Date.now())).toMatchObject([{ generation: 2, targetOid: 'candidate' }]);
      expect(observer.getBinding('p1')).toMatchObject({ generation: 2, projectRevision: 1, remoteUrl: 'https://next.invalid/repo' });
    } finally { observerDb.close(); }
  });
});
