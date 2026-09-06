import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  subscribeProject?: (projectId: string, onChange: () => void) => { ready: Promise<void>; unsubscribe(): Promise<void> };
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
  const blockPush = join(data, 'block-push'); const pushEntered = join(data, 'push-entered');
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) touch '${pushEntered}'; while [ -f '${blockPush}' ]; do sleep 0.01; done; if [ -f '${denyPush}' ]; then echo 'Permission denied' >&2; exit 1; fi; exec git receive-pack '${git.remote}';; *) exec git upload-pack '${git.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  const composition = await createProjectGitServiceComposition({ db, store, operationRoot,
    resolveProjectRoot: async id => id === 'project' ? git.a : id === 'unmanaged' ? unmanaged : join(data, 'missing'), emit: () => {},
    gitEnv: { ...fixtureGitEnv, PATH: `${bin}:${process.env.PATH}` },
    ...(options.requireProject ? { requireProject: options.requireProject } : {}),
    ...(options.resolveAvailability ? { resolveAvailability: options.resolveAvailability } : {}),
    ...(options.subscribeProject ? { subscribeProject: options.subscribeProject } : {}) });
  const repo = await discoverRepository(git.a);
  insertProject(db, { id: 'project', name: 'Local project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: git.a } });
  insertProject(db, { id: 'unmanaged', name: 'Unmanaged project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: unmanaged } });
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'local-repository', canonicalRoot: await realpath(git.a), commonDir: repo.commonDir,
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: await git.git(git.a, 'rev-parse', 'HEAD'),
    observedRemoteHead: null, confirmedRemoteHead: null, projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  cleanups.push(async () => { await composition.service.stop(); db.close(); await git.close(); await rm(data, { recursive: true, force: true }); });
  return { ...composition, db, store, operationRoot, git, data, denyPush, blockPush, pushEntered, unmanaged };
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');

async function terminal(store: ReturnType<typeof createProjectGitStore>, operationId: string) {
  const deadline = Date.now() + 10_000;
  while (true) {
    const operation = store.getJournal(operationId)!;
    if (['succeeded', 'failed'].includes(operation.status)) return operation;
    if (Date.now() >= deadline) throw new Error(`operation ${operationId} did not terminate`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

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

it('returns an admitted pollable operation before a blocked Git worker completes', async () => {
  const f = await fixture();
  await writeFile(f.blockPush, 'block');
  const executing = f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-sync', expectedProjectRevision: 0,
  });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await access(f.pushEntered); break; }
    catch { if (Date.now() >= deadline) throw new Error('push did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  const admitted = await Promise.race([
    executing,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 50)),
  ]);
  await rm(f.blockPush);
  expect(admitted).not.toBeNull();
  expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ status: 'running', phase: 'syncing' });
  await expect(f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-sync', expectedProjectRevision: 0,
  })).resolves.toEqual(admitted);
  await expect(f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-sync', expectedProjectRevision: 1,
  })).rejects.toMatchObject({ code: 'CONFLICT' });

  const deadlineAfterRelease = Date.now() + 5_000;
  while (f.store.getOperation(admitted!.operationId)?.status !== 'succeeded') {
    if (Date.now() >= deadlineAfterRelease) throw new Error('sync did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ status: 'succeeded', phase: 'synced' });
  await expect(f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-sync', expectedProjectRevision: 0,
  })).resolves.toEqual(admitted);
});

it('never reuses an existing idempotency key before the delayed request digest is validated', async () => {
  let calls = 0; let releaseValidation!: () => void;
  const validation = new Promise<void>(resolve => { releaseValidation = resolve; });
  const f = await fixture({ requireProject: async () => { if (++calls === 2) await validation; } });
  await writeFile(f.blockPush, 'block');
  try {
    const first = f.service.execute({ kind: 'sync' }, {
      actorId: 'local', projectId: 'project', idempotencyKey: 'digest-race', expectedProjectRevision: 0,
    });
    const deadline = Date.now() + 5_000;
    while (!f.store.findOperation({ actorId: 'local', projectId: 'project', kind: 'sync', idempotencyKey: 'digest-race' })) {
      if (Date.now() >= deadline) throw new Error('first sync was not durably admitted');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const conflicting = f.service.execute({ kind: 'sync' }, {
      actorId: 'local', projectId: 'project', idempotencyKey: 'digest-race', expectedProjectRevision: 1,
    });
    const rejected = await Promise.race([
      conflicting.then(value => ({ value }), error => ({ error })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 50)),
    ]);
    expect(rejected).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(calls).toBe(1);
    releaseValidation();
    await expect(first).resolves.toEqual(expect.objectContaining({ operationId: expect.any(String) }));
  } finally {
    releaseValidation(); await rm(f.blockPush, { force: true });
  }
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

it.each(['remote_rewritten', 'external_head_conflict', 'portable_resource'])(
  'keeps non-itemized %s conflict state out of the itemized conflict endpoint',
  async reason => {
    const f = await fixture(); const binding = f.store.getBinding('project')!;
    const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
      localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
    const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
      idempotencyKey: `non-itemized-${reason}`, requestDigest: reason, basis, payload: { lane: 'network' } });
    f.store.updateOperation(operation.id, { status: 'waiting', phase: 'conflict', result: null,
      error: { code: 'CONFLICT', message: 'Review project state.', details: { reason } } });
    await expect(f.service.conflicts('project')).resolves.toEqual([]);
    await expect(f.service.getState('project')).resolves.toMatchObject({
      phase: 'conflict', error: { details: { reason } },
    });
  },
);

it('keeps immutable history readable while the current-content gate is held', async () => {
  const f = await fixture(); await f.service.history('project');
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  const mutation = f.coordination.withProjectMutation({ projectId: 'project', expectedProjectRevision: 0, source: 'test' }, async () => {
    entered(); await blocked;
  }); await admitted;
  try {
    const result = await Promise.race([f.service.history('project').then(() => 'history'), new Promise<string>(resolve => setTimeout(() => resolve('blocked'), 2_000))]);
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

it('keeps scheduler transitions open until an already-admitted action has drained', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admitted = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ requireProject: async () => { entered(); await held; } });
  const action = f.service.execute({ kind: 'pause' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'pause-before-stop', expectedProjectRevision: 0,
  });
  await admitted;
  const stopping = f.service.stop().then(() => 'stopped');
  expect(await Promise.race([stopping, new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 50))])).toBe('waiting');
  release();
  const accepted = await action;
  await expect(stopping).resolves.toBe('stopped');
  expect(f.store.getOperation(accepted.operationId)).toMatchObject({ status: 'succeeded', phase: 'paused' });
});

it('quarantines a missing managed root without blocking unrelated project startup', async () => {
  const f = await fixture();
  const healthy = await discoverRepository(f.git.b);
  insertProject(f.db, { id: 'healthy', name: 'Healthy', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: f.git.b } });
  f.store.saveBinding({ projectId: 'healthy', cloneId: 'healthy', repositoryProjectId: 'healthy-repository',
    canonicalRoot: healthy.root, commonDir: healthy.commonDir, branch: 'main', remoteUrl: null, generation: 0, autoSync: false,
    localHead: healthy.head, observedRemoteHead: null, confirmedRemoteHead: null, projectRevision: 0, contentRevision: 0,
    exportedContentRevision: 0, materializedHead: healthy.head, dirty: false });
  await f.service.stop();
  const missing = `${f.git.a}-moved`; await rename(f.git.a, missing);
  cleanups.push(async () => { await rename(missing, f.git.a).catch(() => {}); });

  const restarted = await createProjectGitServiceComposition({
    db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'healthy' ? f.git.b : f.git.a,
    emit: () => {}, gitEnv: fixtureGitEnv,
  });
  cleanups.push(() => restarted.service.stop());
  await expect(restarted.service.getState('healthy')).resolves.toMatchObject({ enabled: true });
  await expect(restarted.service.getState('project')).resolves.toMatchObject({
    enabled: true,
    error: { code: 'RECOVERY_REQUIRED' },
  });
  const quarantine = f.store.listPendingOperations().find(operation => operation.projectId === 'project'
    && operation.payload !== null && typeof operation.payload === 'object' && !Array.isArray(operation.payload)
    && operation.payload.lane === 'quarantine')!;
  const unavailableRetry = await restarted.service.execute({ kind: 'retry', operationId: quarantine.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'retry-quarantine', expectedProjectRevision: 0,
  });
  expect(unavailableRetry.operationId).toBe(quarantine.id);
  const retryDeadline = Date.now() + 5_000;
  while (f.store.getJournal(quarantine.id)!.updatedAt <= quarantine.updatedAt) {
    if (Date.now() >= retryDeadline) throw new Error('quarantine retry did not recheck the missing root');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(f.store.getJournal(quarantine.id)).toMatchObject({ status: 'waiting', error: { code: 'RECOVERY_REQUIRED' } });
  await rename(missing, f.git.a);
  const retried = await restarted.service.execute({ kind: 'retry', operationId: quarantine.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'retry-quarantine', expectedProjectRevision: 0,
  });
  expect(retried.operationId).toBe(quarantine.id);
  expect(await terminal(f.store, quarantine.id)).toMatchObject({ status: 'succeeded', error: null });
  await expect(restarted.service.getState('project')).resolves.toMatchObject({ enabled: true, error: null });
});

it('owns one project watcher subscription from start through stop', async () => {
  const subscribed: string[] = []; const unsubscribed: string[] = [];
  const f = await fixture({ subscribeProject: (projectId) => {
    subscribed.push(projectId);
    return { ready: Promise.resolve(), unsubscribe: async () => { unsubscribed.push(projectId); } };
  } });
  await f.service.start();
  expect(subscribed).toEqual(['project']);
  await f.service.stop();
  expect(unsubscribed).toEqual(['project']);
});

it('quarantines corrupt repositories and unavailable Git as project-local state', async () => {
  const f = await fixture(); await f.service.stop();
  const gitDir = join(f.git.a, '.git'); const displaced = join(f.git.a, '.git-corrupt');
  await rename(gitDir, displaced);
  const corrupt = await createProjectGitServiceComposition({
    db: f.db, store: f.store, operationRoot: f.operationRoot, resolveProjectRoot: async () => f.git.a,
    emit: () => {}, gitEnv: fixtureGitEnv,
  });
  await expect(corrupt.service.getState('project')).resolves.toMatchObject({
    error: { code: 'RECOVERY_REQUIRED', details: { reason: 'project_root_unavailable' } },
  });
  await corrupt.service.stop(); await rename(displaced, gitDir);

  const previousPath = process.env.PATH; process.env.PATH = join(f.data, 'no-git-bin');
  let unavailable: Awaited<ReturnType<typeof createProjectGitServiceComposition>>;
  try {
    unavailable = await createProjectGitServiceComposition({
      db: f.db, store: f.store, operationRoot: f.operationRoot, resolveProjectRoot: async () => f.git.a,
      emit: () => {}, gitEnv: fixtureGitEnv,
    });
  } finally { process.env.PATH = previousPath; }
  cleanups.push(() => unavailable.service.stop());
  await expect(unavailable.service.getState('project')).resolves.toMatchObject({
    error: { code: 'RECOVERY_REQUIRED', details: { reason: 'project_root_unavailable', cause: 'GIT_UNAVAILABLE' } },
  });
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
  expect(await terminal(f.store, first.operationId)).toMatchObject({ status: 'failed', scope: 'import', actorId: 'local' });
  available = true;
  const retried = await f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: null, idempotencyKey: 'retry-open' });
  expect(retried.operationId).toBe(first.operationId);
  const journal = await terminal(f.store, first.operationId);
  expect(journal, JSON.stringify({ error: journal.error, journalPhase: journal.journalPhase, recoveryData: journal.recoveryData,
    registration: f.store.getRegistration(first.operationId), projectId: journal.projectId })).toMatchObject({ status: 'succeeded', scope: 'import', actorId: 'local' });
  expect((f.store.getJournal(first.operationId)!.payload as { reservedProjectId: string }).reservedProjectId).toBeTruthy();
  expect((f.db.prepare('SELECT COUNT(*) AS count FROM project_git_operations').get() as { count: number }).count).toBe(1);
});

it('retries an auth-blocked sync in the same operation and rejects stale retry without a wrapper', async () => {
  const f = await fixture(); await writeFile(f.denyPush, 'deny');
  const first = await f.service.execute({ kind: 'sync' }, { actorId: 'local', projectId: 'project', idempotencyKey: 'original-sync', expectedProjectRevision: 0 });
  const deadline = Date.now() + 10_000;
  while (f.store.getJournal(first.operationId)?.status !== 'waiting') {
    if (Date.now() >= deadline) throw new Error('sync did not enter waiting');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(f.store.getJournal(first.operationId)).toMatchObject({ kind: 'sync', status: 'waiting', phase: 'auth_required', scope: 'project:project' });
  await rm(f.denyPush);
  const [retried, concurrent] = await Promise.all([
    f.service.execute({ kind: 'retry', operationId: first.operationId },
      { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-sync' }),
    f.service.execute({ kind: 'retry', operationId: first.operationId },
      { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-sync' }),
  ]);
  expect(retried.operationId).toBe(first.operationId);
  expect(concurrent).toEqual(retried);
  expect(await terminal(f.store, first.operationId)).toMatchObject({ status: 'succeeded', phase: 'synced', actorId: 'local', scope: 'project:project' });
  expect((f.db.prepare("SELECT COUNT(*) AS count FROM project_git_operations WHERE kind = 'sync' AND actor_id = 'local'").get() as { count: number }).count).toBe(1);
  await expect(f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-sync' })).resolves.toEqual(retried);
  await expect(f.service.execute({ kind: 'retry', operationId: first.operationId },
    { actorId: 'local', projectId: 'project', idempotencyKey: 'retry-again' })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it('replays an exact terminal resolve before revalidating its now-stale project revision', async () => {
  const f = await fixture(); const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const conflict = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'background-conflict', requestDigest: 'background-conflict', basis, payload: { lane: 'network' } });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve this conflict.' } });
  const action = { kind: 'resolve' as const, operationId: conflict.id, basis, resolutions: [] };
  const expectedProjectRevision = 999;
  const requestDigest = createHash('sha256').update(JSON.stringify({ action, expectedProjectRevision })).digest('hex');
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'resolve',
    idempotencyKey: 'terminal-resolve', requestDigest, basis, payload: { conflictOperationId: action.operationId } });
  f.store.updateOperation(operation.id, { status: 'succeeded', phase: 'local_saved', result: { head: binding.localHead! }, error: null });

  await expect(f.service.execute(action, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'terminal-resolve', expectedProjectRevision,
  })).resolves.toEqual({ operationId: operation.id });
});

it('lets the current project writer retry a background synchronization', async () => {
  const f = await fixture(); const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const background = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'background-auth', requestDigest: 'background-auth', basis, payload: { lane: 'network' } });
  f.store.updateOperation(background.id, { status: 'waiting', phase: 'auth_required', result: null,
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Authenticate and retry.' } });

  const accepted = await f.service.execute({ kind: 'retry', operationId: background.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'retry-background', expectedProjectRevision: 0,
  });
  expect(accepted.operationId).toBe(background.id);
  expect(await terminal(f.store, background.id)).toMatchObject({ status: 'succeeded', actorId: 'project-git-background' });
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
  expect(await terminal(f.store, operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:unmanaged' });
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
  expect(await terminal(f.store, operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:project' });
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
  expect(await terminal(f.store, operation.id)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:project' });
});
