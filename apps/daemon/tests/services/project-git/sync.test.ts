import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseSyncAction, retryDelayMs, createProjectGitSyncDeps, readProjectGitConflictEvidence, syncProject } from '../../../src/services/project-git/sync.js';
import { createGitFixture } from '../../helpers/project-git.js';
import { fixtureGitEnv, portableSnapshot, writeFixtureEntries, createCrashFixture } from '../../helpers/project-git-crash-worker.js';
import { closeDatabase, insertProject, insertConversation, openDatabase } from '../../../src/db.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { getProjectGate } from '../../../src/services/project-git/gate.js';
import { getRepositoryOwnerDomain } from '../../../src/services/project-git/repository-lease.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { materializeProject } from '../../../src/services/project-git/materialize.js';
import { createProjectGitScheduler } from '../../../src/services/project-git/scheduler.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(withMessage = false) {
  const f = await createGitFixture(); let db: Database.Database | undefined;
  cleanups.push(async () => { if (db?.open) db.close(); await f.close(); });
  const snapshot = portableSnapshot(withMessage ? 'After' : 'Before');
  const entries = serializePortableMetadata(snapshot);
  entries.set('index.html', Buffer.from('first\nmiddle\nlast\n'));
  await writeFixtureEntries(f.a, entries);
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'base'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
  await f.git(f.b, 'pull', '--ff-only', 'origin', 'main');
  const head = await f.git(f.a, 'rev-parse', 'HEAD');
  const data = join(f.root, 'data'); const operationRoot = join(data, 'operations'); const preparationRoot = join(data, 'transport');
  await mkdir(operationRoot, { recursive: true }); await mkdir(preparationRoot);
  openDatabase(data, { dataDir: data }); closeDatabase(); db = new Database(join(data, 'app.sqlite'));
  let store = createProjectGitStore(db);
  const bin = join(f.root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\nif test -e '${f.root}/offline'; then echo 'ssh: connect to host example.invalid port 22: Connection refused' >&2; exit 1; fi\nif test -e '${f.root}/auth'; then echo 'Permission denied' >&2; exit 1; fi\nprintf '%s\\n' "$*" >> '${f.root}/network.log'\ncase "$*" in *git-receive-pack*) exec git receive-pack '${f.remote}';; *) exec git upload-pack '${f.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  const gitEnv = { ...fixtureGitEnv, PATH: `${bin}:${process.env.PATH}` };
  const gates = new Map();
  for (const id of ['a', 'b'] as const) {
    insertProject(db, { id, name: snapshot.project.name, createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } });
    store.saveBinding({ projectId: id, cloneId: id, repositoryProjectId: 'repository', canonicalRoot: f[id], commonDir: join(f[id], '.git'), branch: 'main',
      remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: head, observedRemoteHead: head, confirmedRemoteHead: head,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: head, dirty: false });
    const generation = store.getBinding(id)!.generation;
    store.observeRemote(id, generation, head); store.queuePush(id, generation, head); store.ackPush(id, generation, head);
    if (withMessage) {
      insertConversation(db, { id: `${id}-conversation`, projectId: id, title: 'Restored chat', sessionMode: 'design', createdAt: 1, updatedAt: 1 });
      db.prepare('INSERT INTO messages (id, conversation_id, role, content, position, created_at) VALUES (?, ?, ?, ?, 0, 2)')
        .run(`${id}-message`, `${id}-conversation`, 'user', 'materialized message');
      store.attachId('repository', id, 'conversation', 'conversation', `${id}-conversation`);
      store.attachId('repository', id, 'message', 'message', `${id}-message`);
      store.attachId('repository', id, 'turn', 'turn', `message:${id}-message`);
    }
    gates.set(id, await getProjectGate({ root: f[id], instanceId: 'sync-fixture', ownerDomain: await getRepositoryOwnerDomain() ?? 'unknown', dataRootId: data }));
  }
  let now = 100_000;
  let afterDurablePhase: ((phase: import('../../../src/services/project-git/materialize.js').MaterializePhase) => Promise<void>) | undefined;
  const compose = () => createProjectGitSyncDeps({ db: db!, store, operationRoot, preparationRoot, now: () => now, random: () => 0.5,
    resolveProject: (id: string) => ({ root: id === 'a' ? f.a : f.b, branch: 'main', gate: gates.get(id)!, gitEnv }),
    ...(afterDurablePhase ? { afterDurablePhase } : {}) });
  let deps = compose();
  return { ...f, head, operationRoot, preparationRoot, gitEnv, gates, get db() { return db!; }, get store() { return store; }, get deps() { return deps; },
    advance: (ms: number) => { now += ms; },
    interruptAfterPrepared() { afterDurablePhase = async phase => { if (phase === 'prepared') throw new Error('resolve interrupted'); }; deps = compose(); },
    reopen() { afterDurablePhase = undefined; db!.close(); db = new Database(join(data, 'app.sqlite')); store = createProjectGitStore(db); deps = compose(); },
    sync: (projectId: string, oneShot = true) => syncProject({ projectId, oneShot, deps }),
  };
}

async function retainedMessageConflict(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('local message', 'a-message'); await f.sync('a');
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('remote message', 'b-message'); await f.deps.checkpoint('b');
  await expect(f.sync('b')).rejects.toMatchObject({ code: 'CONFLICT' });
  const operation = f.store.listPendingOperations().find(item => item.projectId === 'b' && item.phase === 'conflict')!;
  const evidence = await readProjectGitConflictEvidence(f.operationRoot, operation);
  return { operation, evidence, resolution: {
    conflictId: evidence.conflicts.find(item => item.kind === 'message')!.id,
    kind: 'select' as const,
    selectedSide: 'local' as const,
  } };
}

it('distinguishes equality, ancestry, divergence and remote rewrites', () => {
  const input = { local: 'a', remote: 'b', localIsAncestor: false, remoteIsAncestor: false, remoteWasRewritten: false };
  expect(chooseSyncAction(input)).toBe('merge');
  expect(chooseSyncAction({ ...input, remote: 'a' })).toBe('equal');
  expect(chooseSyncAction({ ...input, remote: null })).toBe('push');
  expect(chooseSyncAction({ ...input, localIsAncestor: true })).toBe('fast_forward');
  expect(chooseSyncAction({ ...input, remoteIsAncestor: true })).toBe('push');
  expect(chooseSyncAction({ ...input, remoteWasRewritten: true })).toBe('remote_rewritten');
  expect(chooseSyncAction({ ...input, remote: null, remoteWasRewritten: true })).toBe('remote_rewritten');
});

it('checks before use despite dirty debounce and a future retry deadline without overriding pause', async () => {
  const f = await fixture();
  await writeFile(join(f.b, 'index.html'), 'remote before admission\n'); await f.sync('b');
  const binding = f.store.getBinding('a')!;
  f.store.queuePush('a', binding.generation, binding.localHead!);
  f.store.deferPush('a', binding.generation, binding.localHead!, Number.MAX_SAFE_INTEGER);
  await writeFile(join(f.a, 'local.txt'), 'dirty before admission');
  await syncProject({ projectId: 'a', oneShot: false, checkBeforeUse: true, deps: f.deps });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('remote before admission\n');
  expect(await readFile(join(f.a, 'local.txt'), 'utf8')).toBe('dirty before admission');
  const before = await readFile(join(f.root, 'network.log'), 'utf8');
  f.store.saveBinding({ ...f.store.getBinding('a')!, autoSync: false });
  await syncProject({ projectId: 'a', oneShot: false, checkBeforeUse: true, deps: f.deps });
  expect(await readFile(join(f.root, 'network.log'), 'utf8')).toBe(before);
});

it('exposes the same constructor recovery readiness promise without starting another runtime', async () => {
  const f = await fixture(); const ready = f.deps.recoveryReady;
  expect(ready).toBeInstanceOf(Promise); expect(f.deps.recoveryReady).toBe(ready);
  await ready;
  expect(await f.deps.checkpoint('a')).toBe(f.store.getBinding('a')!.localHead);
});

it('reuses one private fetch ref per managed project', async () => {
  const f = await fixture();
  await f.deps.fetchTarget('a');
  await f.deps.fetchTarget('a');
  await f.deps.fetchTarget('a');
  const refs = (await f.git(f.a, 'for-each-ref', '--format=%(refname)', 'refs/open-design/fetch/')).split('\n').filter(Boolean);
  expect(refs).toHaveLength(1);
});

it('checkpoints and imports on the actual local branch while transporting a different remote target', async () => {
  const f = await fixture();
  for (const id of ['a', 'b']) f.store.saveBinding({ ...f.store.getBinding(id)!, localBranch: 'main', branch: 'release' });
  await writeFile(join(f.a, 'index.html'), 'release content\n'); await f.sync('a');
  const target = await f.git(f.remote, 'rev-parse', 'release');
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
  expect(await f.git(f.a, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  await f.sync('b');
  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(target);
  expect(await f.git(f.b, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(await readFile(join(f.b, 'index.html'), 'utf8')).toBe('release content\n');
  expect(f.store.getBinding('b')).toMatchObject({ localBranch: 'main', branch: 'release', confirmedRemoteHead: target });
});

it('retains a same-message conflict without materializing remote records or changing the current worktree', async () => {
  const f = await fixture(true);
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('local message', 'a-message'); await f.sync('a');
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('remote message', 'b-message'); await f.deps.checkpoint('b');
  const head = await f.git(f.b, 'rev-parse', 'HEAD'); const index = await readFile(join(f.b, '.git/index'));
  const messageFile = (await f.git(f.b, 'ls-files', '.open-design')).split('\n').find(path => path.includes('/messages/'))!;
  const bytes = await readFile(join(f.b, messageFile));
  await expect(f.sync('b')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'merge_conflict' } });
  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(f.b, '.git/index'))).toEqual(index);
  expect(await readFile(join(f.b, messageFile))).toEqual(bytes);
  expect(f.db.prepare('SELECT content FROM messages WHERE id = ?').get('b-message')).toEqual({ content: 'remote message' });
  const conflict = f.store.listPendingOperations().find(operation => operation.projectId === 'b' && operation.phase === 'conflict');
  expect(conflict).toMatchObject({
    error: { code: 'CONFLICT', details: { reason: 'merge_conflict' } },
    payload: {
      lane: 'network',
      conflictEvidence: {
        path: expect.stringMatching(/^conflict-[a-zA-Z0-9-]+\.json$/u),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    },
  });
  expect(conflict!.error!.details).not.toHaveProperty('conflicts');
  expect(conflict!.error!.details).not.toHaveProperty('base');
  expect(conflict!.error!.details).not.toHaveProperty('local');
  expect(conflict!.error!.details).not.toHaveProperty('remote');
  const reference = (conflict!.payload as { conflictEvidence: { path: string; digest: string } }).conflictEvidence;
  const evidenceBytes = await readFile(join(f.operationRoot, reference.path));
  expect(createHash('sha256').update(evidenceBytes).digest('hex')).toBe(reference.digest);
  expect(JSON.parse(evidenceBytes.toString())).toMatchObject({
    schemaVersion: 1,
    projectId: 'b',
    canonicalRoot: f.b,
    repositoryProjectId: 'repository',
    base: expect.stringMatching(/^[a-f0-9]{40}$/u),
    local: head,
    remote: expect.stringMatching(/^[a-f0-9]{40}$/u),
    basis: conflict!.basis,
    previewContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    conflicts: [expect.objectContaining({ kind: 'message', recordId: 'message' })],
  });
  expect((await fs.stat(join(f.operationRoot, reference.path))).mode & 0o777).toBe(0o600);
  await expect(readProjectGitConflictEvidence(f.operationRoot, conflict!)).resolves.toMatchObject({ projectId: 'b', conflicts: [{ kind: 'message' }] });
  await writeFile(join(f.operationRoot, reference.path), Buffer.concat([evidenceBytes, Buffer.from(' ')]));
  await expect(readProjectGitConflictEvidence(f.operationRoot, conflict!)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await unlink(join(f.operationRoot, reference.path));
  await expect(readProjectGitConflictEvidence(f.operationRoot, conflict!)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  const outside = join(f.root, 'outside-conflict.json'); await writeFile(outside, evidenceBytes);
  await fs.symlink(outside, join(f.operationRoot, reference.path));
  await expect(readProjectGitConflictEvidence(f.operationRoot, conflict!)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});

it('lets the current project writer resolve a background conflict through a distinct two-parent operation and atomically closes it', async () => {
  const f = await fixture(true);
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('local message', 'a-message'); await f.sync('a');
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('remote message', 'b-message'); await f.deps.checkpoint('b');
  await expect(f.sync('b')).rejects.toMatchObject({ code: 'CONFLICT' });
  const conflict = f.store.listPendingOperations().find(operation => operation.projectId === 'b' && operation.phase === 'conflict')!;
  const evidence = await readProjectGitConflictEvidence(f.operationRoot, conflict);
  const messageConflict = evidence.conflicts.find(item => item.kind === 'message')!;

  const resolution = {
    projectId: 'b',
    conflictOperationId: conflict.id,
    actorId: 'local-daemon',
    idempotencyKey: 'resolve-message',
    requestDigest: '1'.repeat(64),
    basis: conflict.basis,
    resolutions: [{ conflictId: messageConflict.id, kind: 'select', selectedSide: 'local' }],
  } as const;
  const [resolved, concurrent] = await Promise.all([
    f.deps.resolveConflict(resolution),
    f.deps.resolveConflict(resolution),
  ]);

  expect(resolved).toMatchObject({ kind: 'resolve', status: 'succeeded', projectId: 'b', basis: conflict.basis });
  expect(concurrent.id).toBe(resolved.id);
  expect(resolved.id).not.toBe(conflict.id);
  expect(f.store.getOperation(conflict.id)).toMatchObject({ status: 'succeeded', error: null });
  const merged = await f.git(f.b, 'rev-parse', 'HEAD');
  expect(await f.git(f.b, 'rev-list', '--parents', '--max-count=1', merged)).toBe(`${merged} ${evidence.local} ${evidence.remote}`);
  expect(f.db.prepare('SELECT content FROM messages WHERE id = ?').get('b-message')).toEqual({ content: 'remote message' });
  expect(f.store.listPendingOperations().filter(operation => operation.projectId === 'b' && operation.phase === 'conflict')).toEqual([]);

  const repeated = await f.deps.resolveConflict(resolution);
  expect(repeated.id).toBe(resolved.id);
});

it('keeps every one-shot network effect paused behind retained conflict evidence', async () => {
  const f = await fixture(true);
  const retained = await retainedMessageConflict(f);
  const before = {
    head: await f.git(f.b, 'rev-parse', 'HEAD'),
    remote: await f.git(f.remote, 'rev-parse', 'refs/heads/main'),
    network: await readFile(join(f.root, 'network.log'), 'utf8'),
    pushes: f.store.listDuePushes(Number.MAX_SAFE_INTEGER),
    evidence: await readFile(join(f.operationRoot,
      (retained.operation.payload as { conflictEvidence: { path: string } }).conflictEvidence.path)),
    networkOperations: f.db.prepare("SELECT COUNT(*) AS count FROM project_git_operations WHERE kind = 'sync' AND json_extract(payload_json, '$.lane') = 'network'").get(),
  };

  await expect(syncProject({
    projectId: 'b',
    oneShot: true,
    deps: f.deps,
    request: { actorId: 'local-daemon', idempotencyKey: 'manual-after-conflict', requestDigest: '2'.repeat(64) },
  })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'merge_conflict' } });

  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(before.head);
  expect(await f.git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(before.remote);
  expect(await readFile(join(f.root, 'network.log'), 'utf8')).toBe(before.network);
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual(before.pushes);
  expect(await readFile(join(f.operationRoot,
    (retained.operation.payload as { conflictEvidence: { path: string } }).conflictEvidence.path))).toEqual(before.evidence);
  expect(f.store.getJournal(retained.operation.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM project_git_operations WHERE kind = 'sync' AND json_extract(payload_json, '$.lane') = 'network'").get())
    .toEqual(before.networkOperations);
});

it.each(['file', 'head', 'content', 'project', 'generation', 'remote'] as const)(
  'rejects stale %s conflict state before creating a resolve operation or changing current state',
  async drift => {
    const f = await fixture(true); const retained = await retainedMessageConflict(f);
    if (drift === 'file') await writeFile(join(f.b, 'late.txt'), 'late local edit');
    if (drift === 'head') {
      await writeFile(join(f.b, 'late.txt'), 'late local commit'); await f.git(f.b, 'add', 'late.txt'); await f.git(f.b, 'commit', '-m', 'late local');
    }
    if (drift === 'content') f.store.bumpContent('b', retained.operation.basis);
    if (drift === 'project') f.store.bumpProject('b', retained.operation.basis);
    if (drift === 'generation') f.store.saveBinding({ ...f.store.getBinding('b')!, branch: 'other' });
    if (drift === 'remote') {
      await writeFile(join(f.a, 'late-remote.txt'), 'late remote commit'); await f.git(f.a, 'add', 'late-remote.txt');
      await f.git(f.a, 'commit', '-m', 'late remote'); await f.git(f.a, 'push', 'origin', 'HEAD:refs/heads/main');
    }
    const head = await f.git(f.b, 'rev-parse', 'HEAD'); const index = await readFile(join(f.b, '.git/index'));
    const resolveCount = f.db.prepare("SELECT count(*) AS n FROM project_git_operations WHERE kind = 'resolve'").get();
    await expect(f.deps.resolveConflict({
      projectId: 'b', conflictOperationId: retained.operation.id, actorId: 'project-git-background',
      idempotencyKey: `stale-${drift}`, requestDigest: '2'.repeat(64), basis: retained.operation.basis,
      resolutions: [retained.resolution],
    })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(f.db.prepare("SELECT count(*) AS n FROM project_git_operations WHERE kind = 'resolve'").get()).toEqual(resolveCount);
    expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(f.b, '.git/index'))).toEqual(index);
    expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  },
);

it('recomputes a retained conflict after a permitted local checkpoint and resolves the new two-parent proposal', async () => {
  const f = await fixture(true); const retained = await retainedMessageConflict(f);
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('recomputed local message', 'b-message');
  await f.deps.checkpoint('b');

  await expect(f.sync('b')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'merge_conflict' } });
  const pending = f.store.listPendingOperations().filter(operation => operation.projectId === 'b' && operation.phase === 'conflict');
  expect(pending).toHaveLength(1); expect(pending[0]!.id).not.toBe(retained.operation.id);
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'succeeded', error: null });
  const evidence = await readProjectGitConflictEvidence(f.operationRoot, pending[0]!);
  const messageConflict = evidence.conflicts.find(item => item.kind === 'message')!;
  const resolved = await f.deps.resolveConflict({
    projectId: 'b', conflictOperationId: pending[0]!.id, actorId: 'local-daemon', idempotencyKey: 'resolve-recomputed',
    requestDigest: '5'.repeat(64), basis: pending[0]!.basis,
    resolutions: [{ conflictId: messageConflict.id, kind: 'select', selectedSide: 'local' }],
  });
  expect(resolved).toMatchObject({ status: 'succeeded', kind: 'resolve' });
  const head = await f.git(f.b, 'rev-parse', 'HEAD');
  expect(await f.git(f.b, 'rev-list', '--parents', '--max-count=1', head)).toBe(`${head} ${evidence.local} ${evidence.remote}`);
});

it('requires a fresh empty confirmation when a stale conflict recomputes to a clean merge', async () => {
  const f = await fixture(true); const retained = await retainedMessageConflict(f);
  f.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('local message', 'b-message');
  await f.deps.checkpoint('b'); const checkpoint = await f.git(f.b, 'rev-parse', 'HEAD');

  await expect(f.sync('b')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'merge_conflict' } });
  const pending = f.store.listPendingOperations().filter(operation => operation.projectId === 'b' && operation.phase === 'conflict');
  expect(pending).toHaveLength(1); expect(pending[0]!.id).not.toBe(retained.operation.id);
  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(checkpoint);
  const evidence = await readProjectGitConflictEvidence(f.operationRoot, pending[0]!);
  expect(evidence.conflicts).toEqual([]);

  const resolved = await f.deps.resolveConflict({ projectId: 'b', conflictOperationId: pending[0]!.id,
    actorId: 'local-daemon', idempotencyKey: 'confirm-clean-recompute', requestDigest: '6'.repeat(64),
    basis: pending[0]!.basis, resolutions: [] });
  expect(resolved).toMatchObject({ status: 'succeeded', kind: 'resolve' });
  const head = await f.git(f.b, 'rev-parse', 'HEAD');
  expect(await f.git(f.b, 'rev-list', '--parents', '--max-count=1', head)).toBe(`${head} ${evidence.local} ${evidence.remote}`);
});

it('replays an interrupted resolve and atomically closes both durable operations after reopen', async () => {
  const f = await fixture(true); const retained = await retainedMessageConflict(f); f.interruptAfterPrepared();
  await expect(f.deps.resolveConflict({
    projectId: 'b', conflictOperationId: retained.operation.id, actorId: 'project-git-background',
    idempotencyKey: 'resolve-after-restart', requestDigest: '3'.repeat(64), basis: retained.operation.basis,
    resolutions: [retained.resolution],
  })).rejects.toThrow('resolve interrupted');
  const resolve = f.store.listRecoverable().find(operation => operation.kind === 'resolve')!;
  expect(resolve).toMatchObject({ status: 'waiting', phase: 'waiting_idle', journalPhase: 'prepared' });
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });

  f.reopen(); await f.deps.recoveryReady;

  expect(f.store.getOperation(resolve.id)).toMatchObject({ status: 'succeeded', phase: 'local_saved', error: null });
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'succeeded', phase: 'local_saved', error: null });
  const merged = await f.git(f.b, 'rev-parse', 'HEAD');
  expect(await f.git(f.b, 'rev-list', '--parents', '--max-count=1', merged)).toBe(`${merged} ${retained.evidence.local} ${retained.evidence.remote}`);
  expect(f.db.prepare('SELECT content FROM messages WHERE id = ?').get('b-message')).toEqual({ content: 'remote message' });
});

it('terminalizes a resolve operation when candidate creation fails before recoverable materialization', async () => {
  const f = await fixture(true); const retained = await retainedMessageConflict(f);
  (f.gitEnv as Record<string, string>).GIT_AUTHOR_DATE = 'not-a-git-date';
  const head = await f.git(f.b, 'rev-parse', 'HEAD'); const index = await readFile(join(f.b, '.git/index'));

  await expect(f.deps.resolveConflict({
    projectId: 'b', conflictOperationId: retained.operation.id, actorId: 'project-git-background',
    idempotencyKey: 'resolve-candidate-failure', requestDigest: '4'.repeat(64), basis: retained.operation.basis,
    resolutions: [retained.resolution],
  })).rejects.toMatchObject({ code: 'CONFLICT' });

  const resolve = f.store.findOperation({ actorId: 'project-git-background', projectId: 'b', kind: 'resolve', idempotencyKey: 'resolve-candidate-failure' })!;
  expect(resolve).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'CONFLICT' } });
  expect(resolve.recoveryData).toBeNull();
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(f.b, '.git/index'))).toEqual(index);

  expect((await f.deps.resolveConflict({
    projectId: 'b', conflictOperationId: retained.operation.id, actorId: 'project-git-background',
    idempotencyKey: 'resolve-candidate-failure', requestDigest: '4'.repeat(64), basis: retained.operation.basis,
    resolutions: [retained.resolution],
  })).id).toBe(resolve.id);
  delete (f.gitEnv as Record<string, string>).GIT_AUTHOR_DATE;
  f.reopen(); await f.deps.recoveryReady;
  const retried = await f.deps.retryConflictResolution(resolve.id);
  expect(retried).toMatchObject({ id: resolve.id, status: 'succeeded', kind: 'resolve' });
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'succeeded', error: null });
});

it('rejects an unselected legacy resolver before candidate construction and lets the durable owner finish', async () => {
  const f = await fixture(true); const retained = await retainedMessageConflict(f);
  (f.gitEnv as Record<string, string>).GIT_AUTHOR_DATE = 'not-a-git-date';
  await expect(f.deps.resolveConflict({ projectId: 'b', conflictOperationId: retained.operation.id,
    actorId: 'local-daemon', idempotencyKey: 'selected-resolver', requestDigest: '7'.repeat(64),
    basis: retained.operation.basis, resolutions: [retained.resolution] })).rejects.toMatchObject({ code: 'CONFLICT' });
  const selected = f.store.findOperation({ actorId: 'local-daemon', projectId: 'b', kind: 'resolve', idempotencyKey: 'selected-resolver' })!;
  f.db.prepare('DELETE FROM project_git_conflict_resolutions').run();
  const unselected = f.store.enqueueOperation({ projectId: 'b', actorId: 'legacy-daemon', kind: 'resolve',
    idempotencyKey: 'unselected-resolver', requestDigest: '8'.repeat(64), basis: retained.operation.basis,
    payload: JSON.parse(JSON.stringify({ conflictOperationId: retained.operation.id, basis: retained.operation.basis,
      resolutions: [retained.resolution] })) as import('@open-design/contracts').JsonValue });
  f.store.updateOperation(unselected.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Legacy resolver failed.' } });
  f.db.prepare('DELETE FROM project_git_conflict_resolutions').run();
  f.db.prepare('INSERT INTO project_git_conflict_resolutions VALUES (?, ?)').run(retained.operation.id, selected.id);
  delete (f.gitEnv as Record<string, string>).GIT_AUTHOR_DATE;
  f.reopen(); await f.deps.recoveryReady;

  const [loser, winner] = await Promise.allSettled([
    f.deps.retryConflictResolution(unselected.id),
    f.deps.retryConflictResolution(selected.id),
  ]);
  expect(loser).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT', status: 409 } });
  expect(winner).toMatchObject({ status: 'fulfilled', value: { id: selected.id, status: 'succeeded' } });
  expect(f.store.getOperation(unselected.id)).toMatchObject({ status: 'failed', phase: 'failed' });
  expect(f.store.getOperation(retained.operation.id)).toMatchObject({ status: 'succeeded', error: null });
  f.reopen(); await f.deps.recoveryReady;
  expect(f.store.getConflictResolutionOwner(retained.operation.id)).toBe(selected.id);
  expect(f.store.getOperation(selected.id)).toMatchObject({ status: 'succeeded' });
  expect(f.store.getOperation(unselected.id)).toMatchObject({ status: 'failed' });
});

it('persists the approved backoff schedule with final jitter capped at five minutes', () => {
  expect([0, 1, 2, 3, 4].map(n => retryDelayMs(n, () => 0.5))).toEqual([5000, 30000, 120000, 300000, 300000]);
  expect(retryDelayMs(0, () => 0)).toBe(4000);
  expect(retryDelayMs(0, () => 1)).toBe(6000);
  expect(retryDelayMs(3, () => 0)).toBe(240000);
  expect(retryDelayMs(4, () => 1)).toBe(300000);
});

it('saves local content while paused and performs one confirmed sync without changing autoSync', async () => {
  const f = await fixture(); f.store.saveBinding({ ...f.store.getBinding('a')!, autoSync: false });
  await writeFile(join(f.a, 'index.html'), 'local while paused\n');
  await f.deps.detect('a'); f.advance(5000); await f.deps.detect('a'); await f.sync('a', false);
  const local = await f.git(f.a, 'rev-parse', 'HEAD'); expect(local).not.toBe(f.head);
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ projectId: 'a', targetOid: local }));
  await f.sync('a', true);
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(local);
  expect(f.store.getBinding('a')).toMatchObject({ autoSync: false, confirmedRemoteHead: local });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

it('merges two real clone histories with two parents and retains both nonoverlapping edits', async () => {
  const f = await fixture();
  await writeFile(join(f.a, 'index.html'), 'LOCAL\nmiddle\nlast\n'); await f.sync('a');
  const local = await f.git(f.a, 'rev-parse', 'HEAD');
  await writeFile(join(f.b, 'index.html'), 'first\nmiddle\nREMOTE\n'); const b = await f.deps.checkpoint('b');
  await f.sync('b'); const merged = await f.git(f.b, 'rev-parse', 'HEAD');
  expect(await f.git(f.b, 'rev-list', '--parents', '--max-count=1', merged)).toBe(`${merged} ${b} ${local}`);
  expect(await readFile(join(f.b, 'index.html'), 'utf8')).toBe('LOCAL\nmiddle\nREMOTE\n');
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(merged);
  expect(f.store.getBinding('b')!.confirmedRemoteHead).toBe(merged);
});

it('persists offline retry timing across reopen and confirms an already pushed OID idempotently', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'offline'), '1');
  await writeFile(join(f.a, 'index.html'), 'offline bytes\n'); await expect(f.sync('a')).rejects.toBeDefined();
  const queued = f.store.listDuePushes(Number.MAX_SAFE_INTEGER).find(push => push.projectId === 'a')!;
  expect(queued).toMatchObject({ attempts: 1, nextAttemptAt: 105_000 });
  f.reopen(); expect(f.store.listDuePushes(104_999)).toEqual([]);
  await f.git(f.a, 'push', 'origin', `${queued.targetOid}:refs/heads/main`);
  // Reopen models a daemon dying after server-side push success but before its ACK.
  await unlink(join(f.root, 'offline')); f.advance(5000); f.reopen();
  await f.sync('a');
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual([]);
  expect(f.store.getBinding('a')!.confirmedRemoteHead).toBe(queued.targetOid);
});

it('retains authentication advice across reopen and retries only an explicit oneShot request', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'auth'), '1'); await writeFile(join(f.a, 'new.txt'), 'saved before auth\n');
  await expect(f.sync('a')).rejects.toMatchObject({ code: 'GIT_AUTH_REQUIRED' });
  const local = await f.git(f.a, 'rev-parse', 'HEAD'); f.reopen(); await unlink(join(f.root, 'auth')); f.advance(600_000);
  await f.sync('a', false); expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
  expect(f.store.listPendingOperations()).toContainEqual(expect.objectContaining({ phase: 'auth_required', error: expect.objectContaining({ code: 'GIT_AUTH_REQUIRED' }) }));
  await f.sync('a', true); expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(local);
});

it('automatically retries transient external Git busy after the user finishes staging', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'remote.txt'), 'remote content'); await f.sync('a');
  let staged = false;
  const deps = { ...f.deps, fetchTarget: async (id: string) => {
    const remote = await f.deps.fetchTarget(id);
    if (!staged) { staged = true; await writeFile(join(f.b, 'user.txt'), 'user-staged content'); await f.git(f.b, 'add', 'user.txt'); }
    return remote;
  } };
  await expect(syncProject({ projectId: 'b', oneShot: false, deps })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  const index = await readFile(join(f.b, '.git/index'));
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ projectId: 'b', targetOid: f.head, nextAttemptAt: 105_000 }));
  expect(f.store.listPendingOperations()).toContainEqual(expect.objectContaining({ projectId: 'b', phase: 'external_git_busy' }));
  f.reopen(); f.advance(600_000); await f.sync('b', false); f.advance(5000);
  await expect(f.sync('b', false)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  expect(await readFile(join(f.b, '.git/index'))).toEqual(index);
  expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(f.head);
  // Only the fixture's external user unstages; automatic work must preserve these bytes.
  await f.git(f.b, 'restore', '--staged', 'user.txt');
  await f.sync('b', false); f.advance(5000); await f.sync('b', false);
  const final = await f.git(f.b, 'rev-parse', 'HEAD'); expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(final);
  expect(await f.git(f.b, 'show', 'HEAD:user.txt')).toBe('user-staged content');
  expect(await f.git(f.b, 'show', 'HEAD:remote.txt')).toBe('remote content');
  expect(f.store.getBinding('b')).toMatchObject({ autoSync: true, confirmedRemoteHead: final });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

it('conservatively saves five seconds after an observed change with no subscribers and no network', async () => {
  const f = await fixture(); f.store.saveBinding({ ...f.store.getBinding('a')!, autoSync: false });
  await f.deps.detect('a'); await writeFile(join(f.a, 'index.html'), 'background edit\n'); f.advance(1000); await f.deps.detect('a');
  f.advance(4999); await f.deps.detect('a'); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  f.advance(1); await f.deps.detect('a'); const saved = await f.git(f.a, 'rev-parse', 'HEAD'); expect(saved).not.toBe(f.head);
  f.advance(60_000); await f.deps.detect('a'); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(saved);
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
});

it('refuses noncanonical preparation roots before network or retained artifacts', async () => {
  const f = await fixture();
  const deps = createProjectGitSyncDeps({ db: f.db, store: f.store, operationRoot: f.operationRoot + '/.', preparationRoot: f.preparationRoot,
    now: () => 0, random: () => 0.5, resolveProject: () => ({ root: f.a, branch: 'main', gate: f.gates.get('a')!, gitEnv: f.gitEnv }) });
  await expect(deps.checkpoint('a')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
});

it('does not overwrite or defer a newer local outbox target after a delayed fetch', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'first checkpoint\n');
  let newer: string | null = null;
  const deps = { ...f.deps, fetchTarget: async (id: string) => {
    const remote = await f.deps.fetchTarget(id);
    await writeFile(join(f.a, 'index.html'), 'second checkpoint\n'); newer = await f.deps.checkpoint('a'); return remote;
  } };
  await expect(syncProject({ projectId: 'a', oneShot: true, deps })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ projectId: 'a', targetOid: newer, attempts: 0, nextAttemptAt: 0 }));
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
});

it('fast-forwards alternating real clones across multiple remote commits without synthetic history', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'one.txt'), 'one'); await f.sync('a');
  await writeFile(join(f.a, 'two.txt'), 'two'); await f.sync('a'); const remote = await f.git(f.a, 'rev-parse', 'HEAD');
  await f.sync('b'); expect(await f.git(f.b, 'rev-parse', 'HEAD')).toBe(remote);
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(remote);
  await writeFile(join(f.b, 'three.txt'), 'three'); await f.sync('b'); const final = await f.git(f.b, 'rev-parse', 'HEAD');
  await f.sync('a'); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(final);
});

it('adopts ordinary descendant editor commits without advancing the epoch or losing database edits', async () => {
  const f = await fixture(); const before = f.store.getBinding('a')!;
  f.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Unsaved database edit', 'a');
  f.store.bumpContent('a', { bindingGeneration: before.generation, projectRevision: 0, contentRevision: 0, localHead: before.localHead, remoteHead: before.observedRemoteHead });
  await writeFile(join(f.a, 'external.txt'), 'editor commit'); await f.git(f.a, 'add', 'external.txt'); await f.git(f.a, 'commit', '-m', 'external');
  const external = await f.git(f.a, 'rev-parse', 'HEAD'); await f.deps.checkpoint('a');
  const saved = await f.git(f.a, 'rev-parse', 'HEAD');
  expect(await f.git(f.a, 'rev-list', '--parents', '--max-count=1', saved)).toBe(`${saved} ${external}`);
  expect(f.store.getBinding('a')).toMatchObject({ projectRevision: 0, contentRevision: 1, dirty: false });
  expect(JSON.parse(await readFile(join(f.a, '.open-design/project.json'), 'utf8')).name).toBe('Unsaved database edit');
});

it('clears a no-op adopted editor checkpoint without changing epoch, materialized provenance, or its outbox', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'external.txt'), 'external bytes');
  await f.git(f.a, 'add', 'external.txt'); await f.git(f.a, 'commit', '-m', 'external'); const external = await f.git(f.a, 'rev-parse', 'HEAD');
  await f.deps.checkpoint('a'); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(external);
  expect(f.store.getBinding('a')).toMatchObject({ projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, dirty: false, materializedHead: f.head });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ projectId: 'a', targetOid: external }));
});

it('seeds recovery holds before admitting factory work and resumes the original materialization first', async () => {
  const f = await createCrashFixture(); cleanups.push(async () => { if (f.db.open) f.db.close(); await f.close(); });
  await expect(materializeProject({ ...f.input, afterDurablePhase: async phase => { if (phase === 'prepared') throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
  const prep = join(f.root, 'transport'); await mkdir(prep);
  const deps = createProjectGitSyncDeps({ db: f.db, store: f.store, operationRoot: f.input.operationDir, preparationRoot: prep,
    now: Date.now, random: () => 0.5, resolveProject: () => ({ root: f.a, branch: 'main', gate: f.gate, gitEnv: fixtureGitEnv }) });
  await expect(f.gate.exclusive(async () => 'fresh')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await deps.checkpoint('project');
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.input.candidateOid);
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
  expect(f.db.prepare('SELECT count(*) AS n FROM fixture_imports').get()).toEqual({ n: 1 });
});

it('retries a raced no-op capture with new content instead of clearing an external edit as saved', async () => {
  const f = await fixture(); const update = f.store.updateOperation; let raced = false;
  vi.spyOn(f.store, 'updateOperation').mockImplementation((id, value) => {
    update(id, value);
    if (!raced && value.status === 'succeeded' && f.store.getJournal(id)?.kind === 'checkpoint') {
      raced = true;
      // Synchronous external writer at the publication/return seam, with unchanged contentRevision.
      writeFileSync(join(f.a, 'index.html'), 'raced external bytes\n');
    }
  });
  const saved = await f.deps.checkpoint('a'); expect(saved).not.toBe(f.head);
  expect(await f.git(f.a, 'show', 'HEAD:index.html')).toBe('raced external bytes');
  expect(f.store.getBinding('a')!.dirty).toBe(false);
});

it('leaves clean periodic probes free of checkpoint journals and artifacts', async () => {
  const f = await fixture(); await f.deps.detect('a');
  const before = f.db.prepare('SELECT count(*) AS n FROM project_git_operations').get();
  for (let i = 0; i < 3; i++) { f.advance(60_000); await f.deps.detect('a'); }
  expect(f.db.prepare('SELECT count(*) AS n FROM project_git_operations').get()).toEqual(before);
  expect(await import('node:fs/promises').then(fs => fs.readdir(f.operationRoot))).toEqual([]);
});

it('reports changed external metadata as a durable conflict and preserves database content', async () => {
  const f = await fixture(); const path = join(f.a, '.open-design/project.json');
  const project = JSON.parse(await readFile(path, 'utf8')); project.name = 'Changed externally'; await writeFile(path, JSON.stringify(project) + '\n');
  await f.git(f.a, 'add', '.open-design/project.json'); await f.git(f.a, 'commit', '-m', 'external metadata');
  await expect(f.deps.checkpoint('a')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'external_head_conflict' } });
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('a')).toEqual({ name: 'Before' });
  expect(f.store.listPendingOperations()).toContainEqual(expect.objectContaining({ projectId: 'a', phase: 'conflict' }));
});

it.each(['edit', 'delete', 'mode', 'addition', 'ignored-addition'] as const)('reconciles uncommitted reserved-file %s without masking it with database exports', async change => {
  const f = await fixture(); await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  const path = join(f.a, '.open-design/project.json'); const original = await readFile(path);
  const external = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), name: 'External edit' }) + '\n');
  if (change === 'edit') await writeFile(path, external);
  if (change === 'delete') await unlink(path);
  if (change === 'mode') await chmod(path, 0o755);
  if (change === 'ignored-addition') await writeFile(join(f.a, '.git/info/exclude'), '.open-design/external.json\n');
  if (change === 'addition' || change === 'ignored-addition') await writeFile(join(f.a, '.open-design/external.json'), '{}');
  const index = await readFile(join(f.a, '.git/index'));
  await expect(f.deps.automaticReady('a')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'external_head_conflict' } });
  f.advance(6000);
  await expect(f.deps.checkpoint('a')).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('a')).toEqual({ name: 'Before' });
  expect(f.store.listPendingOperations()).toContainEqual(expect.objectContaining({ projectId: 'a', phase: 'conflict' }));
  if (change === 'delete') await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(path)).toEqual(change === 'edit' ? external : original);
  if (change === 'mode') expect(await import('node:fs/promises').then(fs => fs.stat(path)).then(s => s.mode & 0o111)).not.toBe(0);
  if (change === 'addition' || change === 'ignored-addition') expect(await readFile(join(f.a, '.open-design/external.json'), 'utf8')).toBe('{}');
});

it('still checkpoints ordinary database edits when reserved working files match the known head', async () => {
  const f = await fixture(); await f.deps.detect('a');
  f.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Database edit', 'a');
  await expect(f.deps.automaticReady('a')).resolves.toBe(false); f.advance(5000);
  await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  expect(JSON.parse(await readFile(join(f.a, '.open-design/project.json'), 'utf8')).name).toBe('Database edit');
});

it.each(['.env', 'secrets.json', 'secrets', '.ssh'] as const)('rejects ignored reserved private member %s by path without reading or traversing it', async name => {
  const f = await fixture(); await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  const privatePath = join(f.a, '.open-design', name); let secretPath = privatePath;
  if (name === 'secrets') { await mkdir(privatePath); secretPath = join(privatePath, 'value.txt'); }
  if (name === '.ssh') {
    const target = join(f.root, 'owned-secret-target'); await mkdir(target); secretPath = join(target, 'value.txt');
    await fs.symlink(target, privatePath, 'dir');
  }
  const sentinel = 'fixture-private-value-must-not-be-read'; await writeFile(secretPath, sentinel);
  await writeFile(join(f.a, '.git/info/exclude'), `.open-design/${name}\n`);
  const index = await readFile(join(f.a, '.git/index')); let accesses = 0;
  const deny = (path: unknown) => {
    const value = String(path);
    if (value === privatePath || value.startsWith(privatePath + '/') || value === secretPath || value === join(f.root, 'owned-secret-target')) {
      accesses++; throw new Error('Private access forbidden by fixture');
    }
  };
  const originalRead = fs.readFile; const originalOpen = fs.open; const originalList = fs.readdir;
  const hooks = [
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => { deny(args[0]); return originalRead(...args); }),
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => { deny(args[0]); return originalOpen(...args); }),
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => { deny(args[0]); return originalList(...args); }),
  ];
  syncBuiltinESMExports();
  try {
    await expect(f.deps.automaticReady('a')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'external_head_conflict' } });
    await expect(f.deps.checkpoint('a')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(accesses).toBe(0);
    const pending = f.store.listPendingOperations();
    expect(pending).toContainEqual(expect.objectContaining({ projectId: 'a', phase: 'conflict' }));
    expect(JSON.stringify(pending)).not.toContain(sentinel);
  } finally { for (const hook of hooks) hook.mockRestore(); syncBuiltinESMExports(); }
  expect(await readFile(secretPath, 'utf8')).toBe(sentinel);
  expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('a')).toEqual({ name: 'Before' });
});

it('keeps ignored ordinary-root private files excluded from readiness and checkpoint content', async () => {
  const f = await fixture(); await writeFile(join(f.a, '.git/info/exclude'), '.env\nsecrets.json\n');
  await writeFile(join(f.a, '.env'), 'ordinary-root fixture private'); await writeFile(join(f.a, 'secrets.json'), '{}');
  await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  await expect(f.deps.checkpoint('a')).resolves.toBe(f.head);
  expect(await f.git(f.a, 'ls-files')).not.toContain('.env');
  expect(await f.git(f.a, 'ls-files')).not.toContain('secrets.json');
  expect(await readFile(join(f.a, '.env'), 'utf8')).toBe('ordinary-root fixture private');
});

it.each(['file', 'path', 'index', 'head'] as const)('rejects a torn automatic %s observation and restarts the quiet proof', async boundary => {
  const f = await fixture(); await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  const original = fs.readFile; let raced = false;
  const hook = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await original(...args);
    if (!raced && args[0] === join(f.a, '.git/index')) {
      raced = true;
      if (boundary === 'file') await writeFile(join(f.a, 'index.html'), 'raced named file\n');
      if (boundary === 'path') await writeFile(join(f.a, 'late.txt'), 'raced path\n');
      if (boundary === 'index') { await writeFile(join(f.a, 'staged.txt'), 'user staging\n'); await f.git(f.a, 'add', 'staged.txt'); }
      if (boundary === 'head') await f.git(f.a, 'commit', '--allow-empty', '-m', 'external head');
    }
    return bytes;
  });
  syncBuiltinESMExports();
  try { const ready = await f.deps.automaticReady('a'); expect(raced).toBe(true); expect(ready).toBe(false); }
  finally { hook.mockRestore(); syncBuiltinESMExports(); }
  const head = await f.git(f.a, 'rev-parse', 'HEAD'); const index = await readFile(join(f.a, '.git/index'));
  if (boundary === 'index') {
    f.advance(6000); await expect(f.deps.automaticReady('a')).resolves.toBe(false);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
    await f.git(f.a, 'restore', '--staged', 'staged.txt');
  }
  await expect(f.deps.automaticReady('a')).resolves.toBe(false);
  f.advance(4999); await expect(f.deps.automaticReady('a')).resolves.toBe(false);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(head);
  f.advance(1); await expect(f.deps.automaticReady('a')).resolves.toBe(true);
  if (boundary === 'file') expect(await f.git(f.a, 'show', 'HEAD:index.html')).toBe('raced named file');
  if (boundary === 'path') expect(await f.git(f.a, 'show', 'HEAD:late.txt')).toBe('raced path');
  if (boundary === 'index') expect(await f.git(f.a, 'show', 'HEAD:staged.txt')).toBe('user staging');
  if (boundary === 'head') expect(f.store.getBinding('a')!.localHead).toBe(head);
});

it('keeps the outbox unacknowledged when the remote advances during confirmation', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'local.txt'), 'local');
  let advanced = '';
  const deps = { ...f.deps, confirmTarget: async (id: string) => {
    await f.git(f.b, 'pull', '--ff-only', 'origin', 'main'); await writeFile(join(f.b, 'remote.txt'), 'remote');
    await f.git(f.b, 'add', 'remote.txt'); await f.git(f.b, 'commit', '-m', 'remote advanced'); await f.git(f.b, 'push', 'origin', 'HEAD:refs/heads/main');
    advanced = await f.git(f.b, 'rev-parse', 'HEAD'); return f.deps.confirmTarget(id);
  } };
  await expect(syncProject({ projectId: 'a', oneShot: true, deps })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.getBinding('a')!.confirmedRemoteHead).toBe(f.head);
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER).find(item => item.projectId === 'a')!.attempts).toBe(1);
  f.advance(5000); await f.sync('a'); expect(f.store.getBinding('a')!.confirmedRemoteHead).toBe(advanced);
});

it('refetches a real non-fast-forward rejection before scheduling a new merge attempt', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'local.txt'), 'local'); let fetches = 0;
  const deps = { ...f.deps, fetchTarget: async (id: string) => { fetches++; return f.deps.fetchTarget(id); },
    pushTarget: async (id: string, oid: string, generation: number) => {
      await writeFile(join(f.b, 'other.txt'), 'competing push'); await f.git(f.b, 'add', 'other.txt'); await f.git(f.b, 'commit', '-m', 'competitor');
      await f.git(f.b, 'push', 'origin', 'HEAD:refs/heads/main'); await f.deps.pushTarget(id, oid, generation);
    } };
  await expect(syncProject({ projectId: 'a', oneShot: true, deps })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(fetches).toBe(2); expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(await f.git(f.b, 'rev-parse', 'HEAD'));
  f.advance(5000); await f.sync('a'); expect(await readFile(join(f.a, 'other.txt'), 'utf8')).toBe('competing push');
});

it('stops further automatic network work when pause arrives during a fetch and keeps its outbox', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'local.txt'), 'local');
  await f.deps.checkpoint('a');
  const deps = { ...f.deps, fetchTarget: async (id: string) => {
    const remote = await f.deps.fetchTarget(id); f.store.saveBinding({ ...f.store.getBinding(id)!, autoSync: false }); return remote;
  } };
  await syncProject({ projectId: 'a', oneShot: false, deps });
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
  expect(f.store.listPendingOperations()).toContainEqual(expect.objectContaining({ projectId: 'a', phase: 'paused', status: 'waiting' }));
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
});

it('performs clean automatic remote checks without creating no-op checkpoint journals', async () => {
  const f = await fixture(); await f.sync('a', false);
  expect(f.db.prepare("SELECT count(*) AS n FROM project_git_operations WHERE kind = 'checkpoint'").get()).toEqual({ n: 0 });
});

it('keeps real scheduler startup and later remote-due ticks behind the same five-second observation clock', async () => {
  const f = await fixture(); f.store.saveBinding({ ...f.store.getBinding('b')!, autoSync: false });
  await writeFile(join(f.a, 'manual.txt'), 'startup manual edit');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }); let probes = 0; let networkPasses = 0;
  const scheduler = createProjectGitScheduler({ store: f.store, now: f.deps.now, random: () => 0.5,
    detect: async id => { await f.deps.detect(id); if (id === 'a') probes++; },
    sync: async (projectId, oneShot) => { await syncProject({ projectId, oneShot, deps: f.deps }); networkPasses++; } });
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await condition()) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    expect(await condition()).toBe(true);
  };
  const advance = async (milliseconds: number) => { f.advance(milliseconds); await vi.advanceTimersByTimeAsync(milliseconds); };
  try {
    scheduler.start(); scheduler.start(); await until(() => probes > 0 && networkPasses > 0);
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
    await advance(4_999); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
    await advance(1); await until(async () => (await f.git(f.a, 'rev-parse', 'HEAD')) !== f.head);
    const saved = await f.git(f.a, 'rev-parse', 'HEAD');
    await advance(55_000); await until(() => networkPasses >= 2);
    await writeFile(join(f.a, 'manual.txt'), 'later manual edit'); const beforeWatcher = probes; scheduler.notify('a');
    await until(() => probes > beforeWatcher);
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(saved);
    await advance(4_999); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(saved);
    await advance(1); await until(async () => (await f.git(f.a, 'rev-parse', 'HEAD')) !== saved);
  } finally { await scheduler.stop(); vi.useRealTimers(); }
});

it('does not acknowledge or defer another binding generation after a fetch callback returns late', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'local.txt'), 'local'); let generation = 0;
  const deps = { ...f.deps, fetchTarget: async (id: string) => {
    const remote = await f.deps.fetchTarget(id); const next = f.store.saveBinding({ ...f.store.getBinding(id)!, branch: 'new-target' }); generation = next.generation;
    f.store.queuePush(id, generation, next.localHead!); return remote;
  } };
  await expect(syncProject({ projectId: 'a', oneShot: true, deps })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toContainEqual(expect.objectContaining({ projectId: 'a', generation, attempts: 0, nextAttemptAt: 0 }));
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
});

it('confirms and ACKs after a real daemon process exits following successful push', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'local.txt'), 'durable local content'); await f.deps.checkpoint('a');
  const local = await f.git(f.a, 'rev-parse', 'HEAD');
  const modulePath = fileURLToPath(new URL('../../../src/services/project-git/sync.ts', import.meta.url));
  const script = `import Database from 'better-sqlite3';
    import { createProjectGitStore } from './src/storage/project-git.ts';
    import { getProjectGate } from './src/services/project-git/gate.ts';
    import { getRepositoryOwnerDomain } from './src/services/project-git/repository-lease.ts';
    import { createProjectGitSyncDeps, syncProject } from ${JSON.stringify(modulePath)};
    const settings = JSON.parse(process.argv[1]); const db = new Database(settings.database); const store = createProjectGitStore(db);
    const gate = await getProjectGate({ root: settings.root, instanceId: 'sync-child', ownerDomain: await getRepositoryOwnerDomain() ?? 'unknown', dataRootId: settings.data });
    const deps = createProjectGitSyncDeps({ db, store, operationRoot: settings.operationRoot, preparationRoot: settings.preparationRoot,
      now: Date.now, random: () => 0.5, resolveProject: () => ({ root: settings.root, branch: 'main', gate, gitEnv: settings.gitEnv }) });
    const confirm = deps.confirmTarget; let calls = 0;
    deps.confirmTarget = async id => { if (++calls === 2) process.exit(73); return confirm(id); };
    await syncProject({ projectId: 'a', oneShot: true, deps }); process.exit(1);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script,
    JSON.stringify({ database: join(f.root, 'data/app.sqlite'), data: join(f.root, 'data'), root: f.a, operationRoot: f.operationRoot,
      preparationRoot: f.preparationRoot, gitEnv: f.gitEnv })], { cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
  try { expect(await once(child, 'exit')).toEqual([73, null]); expect(stderr).toBe(''); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(local);
  f.reopen(); expect(f.store.getBinding('a')!.confirmedRemoteHead).toBe(f.head);
  await f.sync('a', true); expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual([]);
  expect(f.store.getBinding('a')!.confirmedRemoteHead).toBe(local);
});

it('detects a deleted or rewritten remote branch and never replaces it automatically', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'new.txt'), 'new\n'); await f.sync('a');
  const before = await f.git(f.a, 'rev-parse', 'HEAD');
  await f.git(f.remote, 'update-ref', 'refs/heads/main', f.head, before);
  await expect(f.sync('a')).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'remote_rewritten' } });
  expect(await f.git(f.remote, 'rev-parse', 'main')).toBe(f.head);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(before);
  expect(f.store.getBinding('a')!.observedRemoteHead).toBe(before);
});
