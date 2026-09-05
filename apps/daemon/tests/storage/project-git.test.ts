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
  type ProjectGitRecoveryData,
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
  function binding(): ProjectGitBindingRecord {
    return { projectId: 'p1', cloneId: 'c1', repositoryProjectId: 'r1',
      canonicalRoot: join(root, 'project'), commonDir: join(root, 'project/.git'),
      branch: 'main', remoteUrl: 'https://private.invalid/repo', generation: 0,
      autoSync: true, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0,
      materializedHead: null, dirty: false };
  }
  function recovery(): ProjectGitRecoveryData {
    return { operationRoot: join(root, 'operations/op1'), baseHead: 'base', publishHead: 'candidate',
      candidateOid: 'candidate', paths: [{ path: 'index.html', oldDigest: 'old', candidateDigest: 'new',
        backupPath: join(root, 'operations/op1/index.backup'), protected: false, applied: false }],
      index: { path: join(root, 'project/.git/index'), oldDigest: 'old-index', candidateDigest: 'new-index',
        backupPath: join(root, 'operations/op1/index'), ownerToken: 'owner-1', published: false },
      records: { importMarker: 'import-1', applied: false }, refPublished: false };
  }
  function basis(b: ProjectGitBindingRecord) {
    return { bindingGeneration: b.generation, projectRevision: b.projectRevision,
      contentRevision: b.contentRevision, localHead: b.localHead, remoteHead: b.observedRemoteHead };
  }

  it('keeps one operation for a retried request across database reopen', () => {
    const first = createProjectGitStore(db).enqueueOperation(request);
    db.close(); db = new Database(file); migrateProjectGit(db);
    const store = createProjectGitStore(db);
    expect(store.enqueueOperation(request).id).toBe(first.id);
    expect(() => store.enqueueOperation({ ...request, requestDigest: 'different' })).toThrow();
    expect(store.getJournal(first.id)).toMatchObject({ actorId: 'local', scope: 'import', payload: { branch: 'main' } });
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
    expect(store.saveBinding({ ...binding(), projectId: 'p2', cloneId: 'c2', branch: 'other' }).generation).toBe(1);
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
      recoveryData: { baseHead: 'base', candidateOid: 'candidate', paths: [{ protected: true, applied: false }] },
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

  it('recovers ref publication before index replacement and atomically completes the matching binding', () => {
    let store = createProjectGitStore(db); const b = store.saveBinding(binding());
    const op = store.enqueueCheckpoint({ projectId: 'p1', actorId: 'daemon', idempotencyKey: 'checkpoint',
      requestDigest: 'digest', basis: basis(b), payload: {} });
    const data = recovery();
    for (const phase of ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published'] as const) {
      store.setPhase(op.id, phase, data);
      if (phase === 'protected') data.paths[0]!.protected = true;
      if (phase === 'files_applied') data.paths[0]!.applied = true;
      if (phase === 'records_applied') data.records!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      store.completePhase(op.id, phase, data);
    }
    store.updateOperation(op.id, { status: 'failed', phase: 'failed', result: null, error: null });
    db.close(); db = new Database(file); migrateProjectGit(db); store = createProjectGitStore(db);
    expect(store.listRecoverable()[0]).toMatchObject({ journalPhase: 'ref_published', recoveryData: { refPublished: true, index: { published: false } } });
    expect(() => store.completeMaterialization(op.id, { basis: basis(b), advanceProjectRevision: false })).toThrow();
    store.setPhase(op.id, 'index_published', data); data.index!.published = true;
    store.completePhase(op.id, 'index_published', data);
    expect(() => store.completeMaterialization(op.id, { basis: { ...basis(b), bindingGeneration: 0 }, advanceProjectRevision: false })).toThrow();
    expect(store.getBinding('p1')?.localHead).toBeNull();
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
      if (phase === 'records_applied') data.records!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      if (phase === 'index_published') data.index!.published = true;
      store.completePhase(op.id, phase, data);
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
      if (phase === 'records_applied') data.records!.applied = true;
      if (phase === 'ref_published') data.refPublished = true;
      if (phase === 'index_published') data.index!.published = true;
      store.completePhase(op.id, phase, data);
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
      expect(store.getBinding('p1')).toMatchObject({ generation: 1, projectRevision: 0 });
      compose(false);
      expect(observer.listDuePushes(Date.now())).toMatchObject([{ generation: 2, targetOid: 'candidate' }]);
      expect(observer.getBinding('p1')).toMatchObject({ generation: 2, projectRevision: 1, remoteUrl: 'https://next.invalid/repo' });
    } finally { observerDb.close(); }
  });
});
