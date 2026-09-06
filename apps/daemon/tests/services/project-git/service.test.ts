import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProjectGitServiceComposition } from '../../../src/services/project-git/service.js';
import { discoverRepository } from '../../../src/services/project-git/repository.js';
import { migrateProjectGit } from '../../../src/storage/project-git-migrations.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { closeDatabase, insertProject, openDatabase } from '../../../src/db.js';
import { createGitFixture } from '../../helpers/project-git.js';
import { fixtureGitEnv, portableSnapshot, writeFixtureEntries } from '../../helpers/project-git-crash-worker.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { canonicalJson } from '../../../src/services/project-git/portable.js';
import { readBindingEvidence } from '../../../src/services/project-git/binding-evidence.js';
import { bindingOwnerRef } from '../../../src/services/project-git/registration.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: {
  requireProject?: (actorId: string, projectId: string) => Promise<void>;
  resolveAvailability?: (request: { actorId: string; projectId: string; kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string; agentId?: string }) => Promise<boolean>;
} = {}) {
  const git = await createGitFixture();
  await writeFile(join(git.a, 'index.html'), 'initial');
  await git.git(git.a, 'add', 'index.html'); await git.git(git.a, 'commit', '-m', 'initial');
  const data = await mkdtemp(join(tmpdir(), 'od-project-git-service-'));
  const unmanaged = join(data, 'unmanaged'); await mkdir(unmanaged); await writeFile(join(unmanaged, 'index.html'), 'unmanaged');
  const operationRoot = join(data, 'operations'); await mkdir(operationRoot);
  openDatabase(data, { dataDir: data }); closeDatabase(); const db = new Database(join(data, 'app.sqlite'));
  migrateProjectGit(db); const store = createProjectGitStore(db);
  const bin = join(data, 'bin'); await mkdir(bin);
  const denyPush = join(data, 'deny-push');
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) if [ -f '${denyPush}' ]; then echo 'Permission denied' >&2; exit 1; fi; exec git receive-pack '${git.remote}';; *) exec git upload-pack '${git.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  const composition = await createProjectGitServiceComposition({ db, store, operationRoot,
    resolveProjectRoot: async id => id === 'project' ? git.a : id === 'unmanaged' ? unmanaged : join(data, 'missing'), emit: () => {},
    gitEnv: { ...fixtureGitEnv, PATH: `${bin}:${process.env.PATH}` },
    ...(options.requireProject ? { requireProject: options.requireProject } : {}),
    ...(options.resolveAvailability ? { resolveAvailability: options.resolveAvailability } : {}) });
  const repo = await discoverRepository(git.a);
  insertProject(db, { id: 'project', name: 'Local project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: git.a } });
  insertProject(db, { id: 'unmanaged', name: 'Unmanaged project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: unmanaged } });
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'local-repository', canonicalRoot: await realpath(git.a), commonDir: repo.commonDir,
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: await git.git(git.a, 'rev-parse', 'HEAD'),
    observedRemoteHead: null, confirmedRemoteHead: null, projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  cleanups.push(async () => { await composition.service.stop(); db.close(); await git.close(); await rm(data, { recursive: true, force: true }); });
  return { ...composition, db, store, operationRoot, git, data, denyPush, unmanaged };
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');

it('derives state from current dirty facts instead of a stale successful operation', async () => {
  const f = await fixture(); const binding = f.store.getBinding('project')!;
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', idempotencyKey: 'old', requestDigest: 'old',
    basis: { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision, localHead: binding.localHead,
      remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation }, payload: { lane: 'network' } });
  f.store.updateOperation(operation.id, { status: 'succeeded', phase: 'synced', result: null, error: null });
  const current = f.store.getBinding('project')!;
  f.store.bumpContent('project', { projectRevision: current.projectRevision, contentRevision: current.contentRevision,
    localHead: current.localHead, remoteHead: current.observedRemoteHead, bindingGeneration: current.generation });
  await expect(f.service.getState('project')).resolves.toMatchObject({ phase: 'dirty', dirty: true });
});

it('reads conflicts only from digest-verified private evidence', async () => {
  const f = await fixture(); let binding = f.store.getBinding('project')!;
  f.store.observeRemote('project', binding.generation, 'b'.repeat(40)); binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision, localHead: binding.localHead,
    remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', idempotencyKey: 'conflict', requestDigest: 'conflict', basis,
    payload: { lane: 'network' } });
  f.store.updateOperation(operation.id, { status: 'running', phase: 'syncing', result: null, error: null });
  const conflict = { id: 'file:index.html', kind: 'file' as const, path: 'index.html', base: { kind: 'text' as const, content: 'base' },
    local: { kind: 'text' as const, content: 'local' }, remote: { kind: 'text' as const, content: 'remote' } };
  const evidence = { schemaVersion: 1, projectId: 'project', canonicalRoot: binding.canonicalRoot, commonDir: binding.commonDir,
    repositoryProjectId: binding.repositoryProjectId, cloneId: binding.cloneId, localBranch: 'main', targetBranch: 'main',
    base: 'a'.repeat(40), local: binding.localHead, remote: basis.remoteHead, basis, previewContentDigest: 'c'.repeat(64), conflicts: [conflict] };
  const bytes = Buffer.from(JSON.stringify(evidence)); const path = `conflict-${operation.id}.json`;
  await writeFile(join(f.operationRoot, path), bytes, { mode: 0o600 });
  f.store.freezeConflictEvidence(operation.id, basis, { path, digest: createHash('sha256').update(bytes).digest('hex') });
  f.store.updateOperation(operation.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve the retained conflict.' } });
  await expect(f.service.conflicts('project')).resolves.toEqual([conflict]);
  await writeFile(join(f.operationRoot, path), '{}');
  await expect(f.service.conflicts('project')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});

it('keeps immutable history readable while the current-content gate is held', async () => {
  const f = await fixture(); await f.service.history('project');
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  const mutation = f.coordination.withProjectMutation({ projectId: 'project', expectedProjectRevision: 0, source: 'test' }, async () => {
    entered(); await blocked;
  }); await admitted;
  try {
    const result = await Promise.race([f.service.history('project').then(() => 'history'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 50))]);
    expect(result).toBe('history');
  } finally { release(); await mutation; }
});

it('coordinates a missing unmanaged root without creating it before the owning mutation', async () => {
  const f = await fixture(); const missing = join(f.data, 'missing');
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.coordination.withProjectRead('missing', async () => {
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.coordination.withProjectMutation({ projectId: 'missing', source: 'test' }, async () => {
    await mkdir(missing);
  });
  await expect(realpath(missing)).resolves.toBe(missing);
});

it('rejects a dangling unmanaged-root symlink instead of following or creating it', async () => {
  const f = await fixture(); const missing = join(f.data, 'missing');
  await symlink(join(f.data, 'outside-does-not-exist'), missing);
  await expect(f.coordination.withProjectRead('missing', async () => undefined))
    .rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  await expect(stat(join(f.data, 'outside-does-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fences new service work during stop and drains an already-admitted action', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ requireProject: async () => { entered(); await held; } }); await f.service.start();
  const action = f.service.execute({ kind: 'enable_preview' }, { actorId: 'local', projectId: 'project', idempotencyKey: 'held' }).catch(() => undefined);
  await admitted;
  const stopping = f.service.stop().then(() => 'stopped');
  expect(await Promise.race([stopping, new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 50))])).toBe('waiting');
  await expect(f.service.getState('project')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  release(); await action; await expect(stopping).resolves.toBe('stopped');
});

it('retries a failed dependency import in its original operation and import scope', async () => {
  let available = false;
  const f = await fixture({ resolveAvailability: async () => {
    if (!available) throw new Error('temporary detector failure');
    return true;
  } });
  const snapshot = portableSnapshot('Imported'); snapshot.project.preferences.agentId = 'fixture-agent';
  await writeFixtureEntries(f.git.a, serializePortableMetadata(snapshot));
  await f.git.git(f.git.a, 'add', '.'); await f.git.git(f.git.a, 'commit', '-m', 'portable');
  await f.git.git(f.git.a, 'push', 'origin', 'HEAD:main');
  const first = await f.service.execute({ kind: 'open', url: 'ssh://git@example.invalid/repo', branch: 'main' },
    { actorId: 'local', projectId: null, idempotencyKey: 'original-open' });
  expect(f.store.getJournal(first.operationId)).toMatchObject({ status: 'failed', scope: 'import', actorId: 'local' });
  available = true;
  const retried = await f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: null, idempotencyKey: 'retry-open' });
  expect(retried.operationId).toBe(first.operationId);
  const journal = f.store.getJournal(first.operationId)!;
  expect(journal, JSON.stringify({ error: journal.error, journalPhase: journal.journalPhase, recoveryData: journal.recoveryData,
    registration: f.store.getRegistration(first.operationId), projectId: journal.projectId })).toMatchObject({ status: 'succeeded', scope: 'import', actorId: 'local' });
  expect((f.store.getJournal(first.operationId)!.payload as { reservedProjectId: string }).reservedProjectId).toBeTruthy();
  expect((f.db.prepare('SELECT COUNT(*) AS count FROM project_git_operations').get() as { count: number }).count).toBe(1);
});

it('retries an auth-blocked sync in the same operation and rejects stale retry without a wrapper', async () => {
  const f = await fixture(); await writeFile(f.denyPush, 'deny');
  const first = await f.service.execute({ kind: 'sync' }, { actorId: 'local', projectId: 'project', idempotencyKey: 'original-sync', expectedProjectRevision: 0 });
  expect(f.store.getJournal(first.operationId)).toMatchObject({ kind: 'sync', status: 'waiting', phase: 'auth_required', scope: 'project:project' });
  await rm(f.denyPush);
  const retried = await f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-sync' });
  expect(retried.operationId).toBe(first.operationId);
  expect(f.store.getJournal(first.operationId)).toMatchObject({ status: 'succeeded', phase: 'synced', actorId: 'local', scope: 'project:project' });
  expect((f.db.prepare("SELECT COUNT(*) AS count FROM project_git_operations WHERE kind = 'sync' AND actor_id = 'local'").get() as { count: number }).count).toBe(1);
  await expect(f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-again' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('rejects a waiting sync retry after binding-generation drift without creating an operation', async () => {
  const f = await fixture(); const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision, localHead: binding.localHead,
    remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', idempotencyKey: 'stale-sync',
    requestDigest: 'stale-sync', basis, payload: { lane: 'network' } });
  f.store.updateOperation(operation.id, { status: 'waiting', phase: 'auth_required', result: null,
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Authenticate and retry.' } });
  f.store.saveBinding({ ...binding, branch: 'other' });
  await expect(f.service.execute({ kind: 'retry', operationId: operation.id },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'stale-retry' })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.getJournal(operation.id)).toMatchObject({ status: 'waiting', phase: 'auth_required', scope: 'project:project' });
  expect((f.db.prepare("SELECT COUNT(*) AS count FROM project_git_operations WHERE kind != 'checkpoint'").get() as { count: number }).count).toBe(1);
});

it('resumes a retained enable under its original preview, actor, scope, and operation ID', async () => {
  const f = await fixture();
  const accepted = await f.service.execute({ kind: 'enable_preview' },
    { actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'enable-preview' });
  const preview = f.store.getJournal(accepted.operationId)!;
  const captured = await readBindingEvidence(f.operationRoot, preview);
  const requestDigest = digest({ kind: 'enable', id: 'unmanaged', previewId: preview.id, expectedProjectRevision: 0 });
  const operation = f.store.enqueueOperation({ projectId: 'unmanaged', actorId: 'local', kind: 'enable', idempotencyKey: 'retained-enable',
    requestDigest, basis: preview.basis, payload: { previewId: preview.id, previewContentDigest: captured.digest } });
  f.store.consumePreview(preview.id, operation.id);
  f.store.updateOperation(operation.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Interrupted before initialization.' } });
  const retried = await f.service.execute({ kind: 'retry', operationId: operation.id },
    { actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'retry-enable' });
  expect(retried.operationId).toBe(operation.id);
  expect(f.store.getJournal(operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:unmanaged' });
  expect(f.store.getBinding('unmanaged')).not.toBeNull();
});

it('resumes a retained bind under its original preview confirmation and operation ID', async () => {
  const f = await fixture(); f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const binding = f.store.getBinding('project')!; const owner = join(f.data, 'owner.json');
  await writeFile(owner, JSON.stringify({ dataRootId: await realpath(f.data), projectId: 'project', canonicalRoot: binding.canonicalRoot,
    localBranch: 'main', generation: binding.generation }));
  const ownerOid = await f.git.git(f.git.a, 'hash-object', '-w', owner);
  await f.git.git(f.git.a, 'update-ref', bindingOwnerRef('main'), ownerOid);
  const accepted = await f.service.execute({ kind: 'binding_preview', url: 'ssh://git@example.invalid/repo', branch: 'main' },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'bind-preview', expectedProjectRevision: 0 });
  const preview = f.store.getJournal(accepted.operationId)!; const captured = await readBindingEvidence(f.operationRoot, preview);
  const requestDigest = digest({ kind: 'bind', id: 'project', previewId: preview.id, confirmation: {}, expectedProjectRevision: 0 });
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'bind', idempotencyKey: 'retained-bind',
    requestDigest, basis: preview.basis, payload: { previewId: preview.id, confirmation: {}, previewContentDigest: captured.digest } });
  f.store.consumePreview(preview.id, operation.id);
  f.store.updateOperation(operation.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Interrupted before registration.' } });
  const retried = await f.service.execute({ kind: 'retry', operationId: operation.id },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-bind' });
  expect(retried.operationId).toBe(operation.id);
  expect(f.store.getJournal(operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:project' });
});

it('resumes a retained restore under its original frozen candidate and operation ID', async () => {
  const f = await fixture(); const binding = f.store.getBinding('project')!;
  const accepted = await f.service.execute({ kind: 'restore_preview', oid: binding.localHead! },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'restore-preview', expectedProjectRevision: 0 });
  const preview = f.store.getJournal(accepted.operationId)!;
  const captured = (preview.payload as { captured: { targetOid: string; candidateOid: string; contentDigest: string } }).captured;
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'restore', idempotencyKey: 'retained-restore',
    requestDigest: digest({ previewId: preview.id }), basis: preview.basis,
    payload: { previewId: preview.id, targetOid: captured.targetOid, candidateOid: captured.candidateOid, previewContentDigest: captured.contentDigest } });
  f.store.consumePreview(preview.id, operation.id);
  f.store.updateOperation(operation.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Interrupted before materialization.' } });
  const retried = await f.service.execute({ kind: 'retry', operationId: operation.id },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-restore' });
  expect(retried.operationId).toBe(operation.id);
  expect(f.store.getJournal(operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:project' });
});
