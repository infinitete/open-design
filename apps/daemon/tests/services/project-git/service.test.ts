import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectGitEvent } from '@open-design/contracts';
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
import type { MaterializePhase } from '../../../src/services/project-git/materialize.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: {
  instanceId?: string;
  requireProject?: (actorId: string, projectId: string) => Promise<void>;
  resolveAvailability?: (request: { actorId: string; projectId: string; kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string; agentId?: string }) => Promise<boolean>;
  subscribeProject?: (projectId: string, onChange: () => void) => { ready: Promise<void>; unsubscribe(): Promise<void> };
  emit?: (projectId: string, event: ProjectGitEvent) => void;
  afterDurablePhase?: (phase: MaterializePhase) => Promise<void>;
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
  const blockFetch = join(data, 'block-fetch'); const fetchEntered = join(data, 'fetch-entered');
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) echo push >> '${join(data, 'network.log')}'; touch '${pushEntered}'; while [ -f '${blockPush}' ]; do sleep 0.01; done; if [ -f '${denyPush}' ]; then echo 'Permission denied' >&2; exit 1; fi; exec git receive-pack '${git.remote}';; *) echo fetch >> '${join(data, 'network.log')}'; touch '${fetchEntered}'; while [ -f '${blockFetch}' ]; do sleep 0.01; done; exec git upload-pack '${git.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);
  const gitEnv = { ...fixtureGitEnv, PATH: `${bin}:${process.env.PATH}` };
  const composition = await createProjectGitServiceComposition({ db, store, operationRoot,
    resolveProjectRoot: async id => id === 'project' ? git.a : id === 'unmanaged' ? unmanaged : join(data, 'missing'), emit: options.emit ?? (() => {}),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    gitEnv,
    ...(options.requireProject ? { requireProject: options.requireProject } : {}),
    ...(options.resolveAvailability ? { resolveAvailability: options.resolveAvailability } : {}),
    ...(options.subscribeProject ? { subscribeProject: options.subscribeProject } : {}),
    ...(options.afterDurablePhase ? { afterDurablePhase: options.afterDurablePhase } : {}) });
  const repo = await discoverRepository(git.a);
  insertProject(db, { id: 'project', name: 'Local project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: git.a } });
  insertProject(db, { id: 'unmanaged', name: 'Unmanaged project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype', baseDir: unmanaged } });
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'local-repository', canonicalRoot: await realpath(git.a), commonDir: repo.commonDir,
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: await git.git(git.a, 'rev-parse', 'HEAD'),
    observedRemoteHead: null, confirmedRemoteHead: null, projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  cleanups.push(async () => { await composition.service.stop(); if (db.open) db.close(); await git.close(); await rm(data, { recursive: true, force: true }); });
  return { ...composition, db, store, operationRoot, git, gitEnv, data, denyPush, blockPush, pushEntered, blockFetch, fetchEntered, unmanaged };
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

async function settledWithin(store: ReturnType<typeof createProjectGitStore>, operationId: string, timeoutMs = 750) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = store.getJournal(operationId)!;
    if (['succeeded', 'failed'].includes(operation.status)) return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return store.getJournal(operationId)!;
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

it('durably admits binding preview before remote transport starts', async () => {
  const f = await fixture();
  const binding = f.store.getBinding('project')!;
  f.store.saveBinding({ ...binding, remoteUrl: null, autoSync: false });
  await writeFile(f.blockFetch, 'block');
  const executing = f.service.execute({
    kind: 'binding_preview', url: 'ssh://git@example.invalid/repo', branch: 'main',
  }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-binding-preview', expectedProjectRevision: 0,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await access(f.fetchEntered); break; }
      catch { if (Date.now() >= deadline) throw new Error('fetch did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    const admitted = await Promise.race([
      executing,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
    ]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({
      kind: 'binding_preview', status: expect.stringMatching(/queued|running/),
    });
  } finally {
    await rm(f.blockFetch, { force: true });
    await executing.catch(() => undefined);
  }
});

it('durably admits restore preview before full current-content capture', async () => {
  const f = await fixture();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admittedMutation = new Promise<void>(resolve => { entered = resolve; });
  const mutation = f.coordination.withProjectRead('project', async () => {
    entered(); await blocked;
  });
  await admittedMutation;
  const executing = f.service.execute({ kind: 'restore_preview', oid: f.store.getBinding('project')!.localHead! }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-restore-preview', expectedProjectRevision: 0,
  });
  try {
    const admitted = await Promise.race([executing, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: 'restore_preview', status: 'queued' });
  } finally {
    release(); await mutation; await executing.catch(() => undefined);
  }
});

it('durably admits restore confirmation before candidate revalidation and materialization', async () => {
  const f = await fixture();
  const preview = await f.service.execute({ kind: 'restore_preview', oid: f.store.getBinding('project')!.localHead! }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'restore-confirm-preview', expectedProjectRevision: 0,
  });
  await terminal(f.store, preview.operationId);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admittedMutation = new Promise<void>(resolve => { entered = resolve; });
  const mutation = f.coordination.withProjectRead('project', async () => {
    entered(); await blocked;
  });
  await admittedMutation;
  const executing = f.service.execute({ kind: 'restore', previewId: preview.operationId }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'async-restore-confirm', expectedProjectRevision: 0,
  });
  try {
    const admitted = await Promise.race([executing, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: 'restore', status: 'queued' });
  } finally {
    release(); await mutation; await executing.catch(() => undefined);
  }
});

it('durably admits enable preview before full project capture', async () => {
  const f = await fixture();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admittedRead = new Promise<void>(resolve => { entered = resolve; });
  const read = f.coordination.withProjectRead('unmanaged', async () => { entered(); await blocked; });
  await admittedRead;
  const executing = f.service.execute({ kind: 'enable_preview' }, {
    actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'async-enable-preview', expectedProjectRevision: 0,
  });
  try {
    const admitted = await Promise.race([executing, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: 'enable_preview', status: 'queued' });
  } finally {
    release(); await read; await executing.catch(() => undefined);
  }
});

it('durably admits open before remote transport starts and exactly replays the active request', async () => {
  const f = await fixture(); await writeFile(f.blockFetch, 'block');
  const context = { actorId: 'local', projectId: null, idempotencyKey: 'async-open' } as const;
  const action = { kind: 'open', url: 'ssh://git@example.invalid/repo', branch: 'main' } as const;
  const executing = f.service.execute(action, context);
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await access(f.fetchEntered); break; }
      catch { if (Date.now() >= deadline) throw new Error('open fetch did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    const admitted = await Promise.race([executing, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: 'open', status: 'queued' });
    await expect(f.service.execute(action, context)).resolves.toEqual(admitted);
    await expect(f.service.execute({ ...action, branch: 'other' }, context)).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await rm(f.blockFetch, { force: true }); await executing.catch(() => undefined);
  }
});

it.each([
  { action: 'enable' as const, projectId: 'unmanaged' },
  { action: 'bind' as const, projectId: 'project' },
  { action: 'unbind' as const, projectId: 'project' },
])('durably admits $action before its exclusive project work', async ({ action, projectId }) => {
  const f = await fixture();
  let previewId: string | undefined;
  if (action === 'enable') {
    const preview = await f.service.execute({ kind: 'enable_preview' }, {
      actorId: 'local', projectId, idempotencyKey: 'admission-enable-preview', expectedProjectRevision: 0,
    });
    expect(await terminal(f.store, preview.operationId)).toMatchObject({ status: 'succeeded' }); previewId = preview.operationId;
  } else if (action === 'bind') {
    const binding = f.store.getBinding(projectId)!; f.store.saveBinding({ ...binding, remoteUrl: null, autoSync: false });
    const preview = await f.service.execute({ kind: 'binding_preview', url: 'ssh://git@example.invalid/repo', branch: 'main' }, {
      actorId: 'local', projectId, idempotencyKey: 'admission-bind-preview', expectedProjectRevision: 0,
    });
    expect(await terminal(f.store, preview.operationId)).toMatchObject({ status: 'succeeded' }); previewId = preview.operationId;
    const journal = f.store.getJournal(preview.operationId)!; const current = f.store.getBinding(projectId)!;
    expect({ basis: journal.basis, dependencies: journal.result?.preview?.dependencies }).toEqual({
      basis: { bindingGeneration: current.generation, projectRevision: current.projectRevision, contentRevision: current.contentRevision,
        localHead: current.localHead, remoteHead: current.observedRemoteHead }, dependencies: [],
    });
  }
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admittedRead = new Promise<void>(resolve => { entered = resolve; });
  const read = f.coordination.withProjectRead(projectId, async () => { entered(); await blocked; }); await admittedRead;
  const request = action === 'enable' ? { kind: action, previewId: previewId! } as const
    : action === 'bind' ? { kind: action, previewId: previewId! } as const : { kind: action } as const;
  const executing = f.service.execute(request, {
    actorId: 'local', projectId, idempotencyKey: `async-${action}`, expectedProjectRevision: 0,
  });
  try {
    const admitted = await Promise.race([executing, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: action, status: 'queued' });
  } finally {
    release(); await read; await executing.catch(() => undefined);
  }
});

it.each(['enable', 'bind'] as const)('centrally settles a pre-intent %s worker failure after durable admission', async action => {
  const events: ProjectGitEvent[] = [];
  const f = await fixture({ emit: (_projectId, event) => events.push(event) }); let previewId: string;
  if (action === 'enable') {
    const preview = await f.service.execute({ kind: 'enable_preview' }, {
      actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'settle-enable-preview', expectedProjectRevision: 0,
    });
    const journal = await terminal(f.store, preview.operationId); previewId = preview.operationId;
    const evidencePath = (journal.payload as { evidencePath: string }).evidencePath; await rm(join(f.operationRoot, evidencePath));
  } else {
    const binding = f.store.getBinding('project')!; f.store.saveBinding({ ...binding, remoteUrl: null, autoSync: false });
    const preview = await f.service.execute({ kind: 'binding_preview', url: 'ssh://git@example.invalid/repo', branch: 'main' }, {
      actorId: 'local', projectId: 'project', idempotencyKey: 'settle-bind-preview', expectedProjectRevision: 0,
    });
    const journal = await terminal(f.store, preview.operationId); previewId = preview.operationId;
    const evidencePath = (journal.payload as { evidencePath: string }).evidencePath; await rm(join(f.operationRoot, evidencePath));
  }
  const projectId = action === 'enable' ? 'unmanaged' : 'project';
  const admitted = await f.service.execute({ kind: action, previewId }, {
    actorId: 'local', projectId, idempotencyKey: `settle-${action}`, expectedProjectRevision: 0,
  });
  const failed = await settledWithin(f.store, admitted.operationId);
  expect(failed).toMatchObject({
    status: 'failed', phase: 'failed', error: { code: expect.any(String), message: expect.not.stringContaining(f.operationRoot) },
  });
  expect(events).toContainEqual(expect.objectContaining({ type: 'project-git-operation',
    operation: expect.objectContaining({ id: admitted.operationId, status: 'failed', phase: 'failed' }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'project-git-state',
    state: expect.objectContaining({ operationId: admitted.operationId, phase: 'failed' }) }));
});

it('replays a failed admission without worker work, then explicitly retries its original consumer after the dependency recovers', async () => {
  const f = await fixture();
  const previewRequest = { actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'recover-preview', expectedProjectRevision: 0 } as const;
  const previewAccepted = await f.service.execute({ kind: 'enable_preview' }, previewRequest);
  const preview = await terminal(f.store, previewAccepted.operationId);
  const evidencePath = (preview.payload as { evidencePath: string }).evidencePath;
  const evidence = await readFile(join(f.operationRoot, evidencePath)); await rm(join(f.operationRoot, evidencePath));
  const confirmRequest = { actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'recover-enable', expectedProjectRevision: 0 } as const;
  const accepted = await f.service.execute({ kind: 'enable', previewId: preview.id }, confirmRequest);
  expect(await settledWithin(f.store, accepted.operationId)).toMatchObject({ status: 'failed', payload: { previewId: preview.id } });

  await writeFile(join(f.operationRoot, evidencePath), evidence);
  const refine = vi.spyOn(f.store, 'replaceAdmittedOperationPayload');
  expect(await f.service.execute({ kind: 'enable', previewId: preview.id }, confirmRequest)).toEqual(accepted);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(refine).not.toHaveBeenCalled(); refine.mockRestore();
  expect(f.store.getJournal(accepted.operationId)).toMatchObject({ status: 'failed', payload: { previewId: preview.id } });

  const retried = await f.service.execute({ kind: 'retry', operationId: accepted.operationId }, {
    actorId: 'local', projectId: 'unmanaged', idempotencyKey: 'recover-enable-retry', expectedProjectRevision: 0,
  });
  expect(retried).toEqual(accepted);
  expect(await terminal(f.store, accepted.operationId)).toMatchObject({ status: 'succeeded', actorId: 'local', scope: 'project:unmanaged' });
});

it('centrally settles a pre-intent restore verification failure and keeps its original retry identity', async () => {
  const f = await fixture();
  const preview = await f.service.execute({ kind: 'restore_preview', oid: f.store.getBinding('project')!.localHead! }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'settle-restore-preview', expectedProjectRevision: 0,
  });
  await terminal(f.store, preview.operationId);
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const admittedRead = new Promise<void>(resolve => { entered = resolve; });
  const read = f.coordination.withProjectRead('project', async () => { entered(); await blocked; }); await admittedRead;
  const admitted = await f.service.execute({ kind: 'restore', previewId: preview.operationId }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'settle-restore', expectedProjectRevision: 0,
  });
  await writeFile(join(f.git.a, 'index.html'), 'changed outside the daemon gate'); release(); await read;
  const failed = await settledWithin(f.store, admitted.operationId);
  expect(failed).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'PROJECT_STATE_CHANGED' } });
  expect(f.store.findOperation({ actorId: 'local', projectId: 'project', kind: 'restore', idempotencyKey: 'settle-restore' })?.id)
    .toBe(admitted.operationId);
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

it('keeps a completed retry conflict pollable, fenced, and resolvable across repeated service startup', async () => {
  const instanceId = 'completed-retry-conflict-instance';
  const f = await fixture({ instanceId });
  const baseline = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'retry-conflict-baseline', expectedProjectRevision: 0,
  });
  expect(await terminal(f.store, baseline.operationId)).toMatchObject({ status: 'succeeded' });
  await f.git.git(f.git.b, 'fetch', 'origin', 'main');
  await f.git.git(f.git.b, 'checkout', '-B', 'main', 'FETCH_HEAD');
  await writeFile(join(f.git.a, 'index.html'), 'local retry conflict side');
  await f.git.git(f.git.a, 'add', 'index.html');
  await f.git.git(f.git.a, 'commit', '-m', 'local retry conflict side');
  await writeFile(join(f.git.b, 'index.html'), 'remote retry conflict side');
  await f.git.git(f.git.b, 'add', 'index.html');
  await f.git.git(f.git.b, 'commit', '-m', 'remote retry conflict side');
  await f.git.git(f.git.b, 'push', 'origin', 'HEAD:main');
  const syncing = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'completed-retry-conflict', expectedProjectRevision: 0,
  });
  const deadline = Date.now() + 10_000;
  while (f.store.getOperation(syncing.operationId)?.phase !== 'conflict') {
    if (Date.now() >= deadline) throw new Error('sync did not retain a conflict');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await f.service.stop();
  f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const completed = f.store.getJournal(syncing.operationId)!;
  f.db.prepare(`INSERT INTO project_git_operation_requests
    (actor_id, scope, action, idempotency_key, request_digest, operation_id, created_at)
    VALUES ('local', 'project:project', 'retry', 'completed-conflict-retry', 'completed-conflict-digest', ?, ?)`)
    .run(completed.id, Date.now());
  f.db.prepare(`INSERT INTO project_git_retry_attempts
    (operation_id, attempt, state, prior_status, prior_phase, prior_result_json, prior_error_json, created_at, updated_at)
    VALUES (?, 1, 'started', 'failed', 'auth_required', NULL, ?, ?, ?)`).run(completed.id,
      JSON.stringify({ code: 'GIT_AUTH_REQUIRED', message: 'Configure authentication.' }), Date.now(), Date.now());

  const startupEvents: ProjectGitEvent[] = [];
  const restarted = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: (_projectId, event) => { startupEvents.push(event); }, gitEnv: f.gitEnv, instanceId });
  await restarted.service.start();
  expect(f.store.getJournal(completed.id)).toEqual(completed);
  expect(f.store.getRetryAttempt(completed.id)).toMatchObject({ state: 'settled' });
  expect(startupEvents.filter(event => event.type === 'project-git-operation' && event.operation.id === completed.id)).toEqual([]);
  await expect(restarted.service.getState('project')).resolves.toMatchObject({ phase: 'conflict', operationId: completed.id });
  const [conflict] = await restarted.service.conflicts('project');
  expect(conflict).toMatchObject({ kind: 'file', path: 'index.html' });
  await restarted.service.stop();

  const secondEvents: ProjectGitEvent[] = [];
  const second = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: (_projectId, event) => { secondEvents.push(event); }, gitEnv: f.gitEnv, instanceId });
  // Stop the restarted composition before the fixture cleanup closes its shared database.
  cleanups.unshift(() => second.service.stop());
  await second.service.start();
  expect(f.store.getJournal(completed.id)).toEqual(completed);
  expect(secondEvents.filter(event => event.type === 'project-git-operation' && event.operation.id === completed.id)).toEqual([]);
  const networkBefore = await readFile(join(f.data, 'network.log'));
  await expect(second.service.execute({ kind: 'binding_preview', url: 'ssh://git@example.invalid/other', branch: 'main' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'recovered-conflict-fence', expectedProjectRevision: 0,
  })).rejects.toMatchObject({ code: 'GIT_CONFLICT' });
  expect(await readFile(join(f.data, 'network.log'))).toEqual(networkBefore);

  const resolving = await second.service.execute({ kind: 'resolve', operationId: completed.id, basis: completed.basis,
    resolutions: [{ conflictId: conflict!.id, kind: 'select', selectedSide: 'local' }] }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'resolve-recovered-retry-conflict', expectedProjectRevision: 0,
  });
  expect(await terminal(f.store, resolving.operationId)).toMatchObject({ status: 'succeeded' });
  expect(f.store.getOperation(completed.id)).toMatchObject({ status: 'succeeded', phase: 'local_saved' });
});

it('preserves a current started retry that completed in structured waiting-idle across repeated service startup', async () => {
  const instanceId = 'completed-retry-waiting-idle-instance';
  const f = await fixture({ instanceId });
  f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync',
    idempotencyKey: 'completed-waiting-idle-target', requestDigest: 'completed-waiting-idle-target', basis,
    payload: { lane: 'network' } });
  f.store.updateOperation(operation.id, { status: 'failed', phase: 'auth_required', result: { head: binding.localHead! },
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Configure repository authentication.' } });
  expect(f.store.claimOperationRequest({ actorId: 'local', projectId: 'project', action: 'retry',
    idempotencyKey: 'completed-waiting-idle-retry', requestDigest: createHash('sha256').update(JSON.stringify({
      action: { kind: 'retry', operationId: operation.id }, expectedProjectRevision: null,
    })).digest('hex'), operationId: operation.id })).toMatchObject({ admitted: true, attempt: 1 });
  expect(f.store.startRetryAttempt(operation.id, 1)).toBe(true);
  f.store.updateOperation(operation.id, { status: 'waiting', phase: 'waiting_idle', result: { head: binding.localHead! },
    error: { code: 'RECOVERY_REQUIRED', message: 'The managed project repository is unavailable.',
      details: { reason: 'project_root_unavailable', nextStep: 'Restore the managed project folder and retry.' } } });
  const completed = f.store.getJournal(operation.id)!;
  const completedPublic = f.store.getOperation(operation.id)!;
  await f.service.stop();

  const firstEvents: ProjectGitEvent[] = [];
  const restarted = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: (_projectId, event) => { firstEvents.push(event); }, gitEnv: f.gitEnv, instanceId });
  await restarted.service.start();
  expect(f.store.getJournal(operation.id)).toEqual(completed);
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 1, state: 'settled' });
  expect(firstEvents.filter(event => event.type === 'project-git-operation' && event.operation.id === operation.id)).toEqual([]);
  await restarted.service.stop();

  const secondEvents: ProjectGitEvent[] = [];
  const second = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: (_projectId, event) => { secondEvents.push(event); }, gitEnv: f.gitEnv, instanceId });
  cleanups.unshift(() => second.service.stop());
  await second.service.start();
  expect(f.store.getJournal(operation.id)).toEqual(completed);
  await expect(second.service.getOperation(operation.id)).resolves.toEqual(completedPublic);
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 1, state: 'settled' });
  expect(secondEvents.filter(event => event.type === 'project-git-operation' && event.operation.id === operation.id)).toEqual([]);

  const retried = await second.service.execute({ kind: 'retry', operationId: operation.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'completed-waiting-idle-retry',
  });
  expect(retried.operationId).toBe(operation.id);
  expect(await terminal(f.store, operation.id)).toMatchObject({ status: 'succeeded', phase: 'synced', error: null });
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 2, state: 'settled' });
  expect(secondEvents.some(event => event.type === 'project-git-operation' && event.operation.id === operation.id)).toBe(true);
});

it('preserves a legacy receipt-only structured waiting-idle retry across repeated service startup', async () => {
  const instanceId = 'legacy-retry-waiting-idle-instance';
  const f = await fixture({ instanceId });
  f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const operation = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync',
    idempotencyKey: 'legacy-waiting-idle-target', requestDigest: 'legacy-waiting-idle-target', basis,
    payload: { lane: 'network' } });
  f.store.updateOperation(operation.id, { status: 'waiting', phase: 'waiting_idle', result: { head: binding.localHead! },
    error: { code: 'RECOVERY_REQUIRED', message: 'The managed project repository is unavailable.',
      details: { reason: 'project_root_unavailable', nextStep: 'Restore the managed project folder and retry.' } } });
  const retryDigest = createHash('sha256').update(JSON.stringify({
    action: { kind: 'retry', operationId: operation.id }, expectedProjectRevision: null,
  })).digest('hex');
  f.db.prepare(`INSERT INTO project_git_operation_requests
    (actor_id, scope, action, idempotency_key, request_digest, operation_id, created_at)
    VALUES ('local', 'project:project', 'retry', 'legacy-waiting-idle-retry', ?, ?, ?)`).run(retryDigest, operation.id, Date.now());
  f.db.prepare('DELETE FROM project_git_retry_attempts WHERE operation_id = ?').run(operation.id);
  const completed = f.store.getJournal(operation.id)!;
  await f.service.stop();
  migrateProjectGit(f.db);
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 1, state: 'settled',
    priorStatus: 'waiting', priorPhase: 'waiting_idle' });

  const restarted = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: () => {}, gitEnv: f.gitEnv, instanceId });
  await restarted.service.start();
  expect(f.store.getJournal(operation.id)).toEqual(completed);
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 1, state: 'settled' });
  await restarted.service.stop();

  const second = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
    emit: () => {}, gitEnv: f.gitEnv, instanceId });
  cleanups.unshift(() => second.service.stop());
  await second.service.start();
  expect(f.store.getJournal(operation.id)).toEqual(completed);
  expect(f.store.getRetryAttempt(operation.id)).toMatchObject({ attempt: 1, state: 'settled' });
});

it('returns a durably claimed resolution before materialization completes and drains it on stop', async () => {
  let releaseMaterialization!: () => void;
  const materializationBlocked = new Promise<void>(resolve => { releaseMaterialization = resolve; });
  let enterMaterialization!: () => void;
  const materializationEntered = new Promise<void>(resolve => { enterMaterialization = resolve; });
  const f = await fixture({ afterDurablePhase: async phase => {
    if (phase === 'prepared') { enterMaterialization(); await materializationBlocked; }
  } });
  const baseline = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'resolve-baseline', expectedProjectRevision: 0,
  });
  const baselineOperation = await settledWithin(f.store, baseline.operationId, 10_000);
  expect(baselineOperation, JSON.stringify(baselineOperation)).toMatchObject({ status: 'succeeded' });
  await f.git.git(f.git.b, 'fetch', 'origin', 'main');
  await f.git.git(f.git.b, 'checkout', '-B', 'main', 'FETCH_HEAD');
  await writeFile(join(f.git.a, 'index.html'), 'local resolution side');
  await f.git.git(f.git.a, 'add', 'index.html');
  await f.git.git(f.git.a, 'commit', '-m', 'local divergence');
  await writeFile(join(f.git.b, 'index.html'), 'remote resolution side');
  await f.git.git(f.git.b, 'add', 'index.html');
  await f.git.git(f.git.b, 'commit', '-m', 'remote divergence');
  await f.git.git(f.git.b, 'push', 'origin', 'HEAD:main');
  const synchronization = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'resolve-conflict', expectedProjectRevision: 0,
  });
  const conflict = await settledWithin(f.store, synchronization.operationId, 10_000);
  expect(conflict).toMatchObject({ status: 'waiting', phase: 'conflict' });
  const [item] = await f.service.conflicts('project');
  expect(item).toMatchObject({ kind: 'file', path: 'index.html' });
  const action = { kind: 'resolve' as const, operationId: conflict.id, basis: conflict.basis,
    resolutions: [{ conflictId: item!.id, kind: 'select' as const, selectedSide: 'local' as const }] };
  const context = { actorId: 'local', projectId: 'project', idempotencyKey: 'async-resolve', expectedProjectRevision: 0 } as const;
  const resolving = f.service.execute(action, context);
  try {
    const progress = await Promise.race([
      materializationEntered.then(() => ({ materializationStarted: true as const })),
      resolving.then(result => ({ result })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000)),
    ]);
    expect(progress).not.toBeNull();
    const admitted = progress && 'result' in progress ? progress.result : await Promise.race([
      resolving,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
    ]);
    expect(admitted).not.toBeNull();
    expect(f.store.getOperation(admitted!.operationId)).toMatchObject({ kind: 'resolve', status: 'running' });
    await expect(Promise.race([
      materializationEntered.then(() => 'materialization-started' as const),
      new Promise(resolve => setTimeout(() => resolve('materialization-timeout' as const), 5_000)),
    ])).resolves.toBe('materialization-started');
    await expect(f.service.execute(action, context)).resolves.toEqual(admitted);
    await expect(f.service.execute({ ...action, resolutions: [{ ...action.resolutions[0]!, selectedSide: 'remote' }] }, context))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const stopping = f.service.stop();
    await expect(Promise.race([
      stopping.then(() => 'stopped' as const),
      new Promise(resolve => setTimeout(() => resolve('waiting' as const), 100)),
    ])).resolves.toBe('waiting');
    releaseMaterialization();
    await stopping;
    expect(await terminal(f.store, admitted!.operationId)).toMatchObject({ status: 'succeeded' });
  } finally {
    releaseMaterialization();
    await resolving.catch(() => undefined);
  }
});

it('durably admits manual conflict recomputation while the sync worker keeps an unchanged conflict off the network', async () => {
  const f = await fixture();
  const baseline = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'conflict-baseline', expectedProjectRevision: 0,
  });
  await terminal(f.store, baseline.operationId);
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const conflict = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'retained-service-conflict', requestDigest: 'retained-service-conflict', basis, payload: { lane: 'network' } });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve the retained conflict.', details: { reason: 'merge_conflict' } } });
  const networkBefore = await readFile(join(f.data, 'network.log')).catch(() => Buffer.alloc(0));

  const accepted = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'recompute-conflict', expectedProjectRevision: binding.projectRevision,
  });
  expect(await settledWithin(f.store, accepted.operationId)).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  expect(f.store.getOperation(conflict.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  expect(await readFile(join(f.data, 'network.log')).catch(() => Buffer.alloc(0))).toEqual(networkBefore);
});

it('fences a manual sync queued behind network work that retains a conflict before release', async () => {
  const f = await fixture(); await writeFile(f.blockFetch, 'block');
  const binding = f.store.getBinding('project')!;
  const predecessor = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'predecessor-manual-sync', expectedProjectRevision: binding.projectRevision,
  });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await access(f.fetchEntered); break; }
    catch { if (Date.now() >= deadline) throw new Error('background fetch did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  const accepted = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'queued-manual-sync', expectedProjectRevision: binding.projectRevision,
  });
  const admitted = f.store.getJournal(accepted.operationId)!;
  expect(admitted).toMatchObject({ status: 'queued', payload: { retainedConflictId: null } });
  const conflict = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'queued-manual-conflict', requestDigest: 'queued-manual-conflict', basis: admitted.basis, payload: { lane: 'network' } });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve retained conflict.', details: { reason: 'merge_conflict' } } });
  const before = { generation: binding.generation };
  await rm(f.blockFetch);

  const predecessorTerminal = await terminal(f.store, predecessor.operationId);
  expect(predecessorTerminal).toMatchObject({ status: 'succeeded' });
  expect(await terminal(f.store, admitted.id)).toMatchObject({ status: 'failed', phase: 'failed', error: { code: 'GIT_CONFLICT' } });
  expect(f.store.getOperation(conflict.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  expect(f.store.getBinding('project')).toMatchObject({ generation: before.generation, localHead: predecessorTerminal.result?.head });
  expect(f.store.listDuePushes(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

it('fences a sync retry queued behind network work without starting another transport', async () => {
  const events: ProjectGitEvent[] = [];
  const f = await fixture({ emit: (_projectId, event) => { events.push(event); } });
  await writeFile(f.blockFetch, 'block');
  const predecessor = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'retry-lane-predecessor', expectedProjectRevision: 0,
  });
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await access(f.fetchEntered); break; }
    catch { if (Date.now() >= deadline) throw new Error('predecessor fetch did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const target = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync',
    idempotencyKey: 'queued-retry-target', requestDigest: 'queued-retry-target', basis, payload: { lane: 'network' } });
  f.store.updateOperation(target.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Retry after recovery.' } });
  await expect(f.service.execute({ kind: 'retry', operationId: target.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'queued-sync-retry', expectedProjectRevision: 0,
  })).resolves.toEqual({ operationId: target.id });
  expect(f.store.getOperation(target.id)).toMatchObject({ status: expect.stringMatching(/queued|running/),
    phase: 'waiting_idle', error: null });
  expect(f.store.getRetryAttempt(target.id)).toMatchObject({ attempt: 1, state: 'started',
    priorStatus: 'failed', priorError: { code: 'CONFLICT' } });
  expect(events.some(event => event.type === 'project-git-operation' && event.operation.id === target.id
    && ['queued', 'running'].includes(event.operation.status))).toBe(true);
  const conflict = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'queued-retry-conflict', requestDigest: 'queued-retry-conflict', basis, payload: { lane: 'network' } });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve retained conflict.', details: { reason: 'merge_conflict' } } });
  await rm(f.blockFetch);
  expect(await terminal(f.store, predecessor.operationId)).toMatchObject({ status: 'succeeded' });
  await f.service.stop();
  expect(f.store.getOperation(target.id)).toMatchObject({ status: 'failed' });
  expect(f.store.getOperation(conflict.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
  const network = (await readFile(join(f.data, 'network.log'), 'utf8')).trim().split('\n');
  expect(network.filter(line => line === 'push')).toHaveLength(1);
  expect(network.filter(line => line === 'fetch')).toHaveLength(2);
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
  while (f.store.getRetryAttempt(quarantine.id)?.state !== 'settled') {
    if (Date.now() >= retryDeadline) throw new Error('quarantine retry did not recheck the missing root');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(f.store.getJournal(quarantine.id)).toMatchObject({ status: 'waiting', error: { code: 'RECOVERY_REQUIRED' } });
  await expect(restarted.service.execute({ kind: 'retry', operationId: quarantine.id }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'different-retry-quarantine', expectedProjectRevision: 0,
  })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
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

it('serializes start with stop so a delayed startup cannot leak a watcher after shutdown', async () => {
  const subscribed: string[] = []; const unsubscribed: string[] = [];
  const f = await fixture({ subscribeProject: projectId => { subscribed.push(projectId); return {
      ready: Promise.resolve(), unsubscribe: async () => { unsubscribed.push(projectId); },
    }; } });
  const starting = f.service.start(); const stopping = f.service.stop();
  await Promise.all([starting, stopping]);
  expect(unsubscribed).toEqual(subscribed);
  await expect(f.service.execute({ kind: 'pause' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'after-stop', expectedProjectRevision: 0,
  })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});

it('terminalizes every interrupted phase-null admission before startup schedules project work', async () => {
  const f = await fixture();
  f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const retained = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'retained-conflict-on-restart', requestDigest: 'retained-conflict-on-restart', basis, payload: { lane: 'network' } });
  f.store.updateOperation(retained.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve the retained conflict.' } });
  const admitted = [
    f.store.enqueueOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'restart-open',
      requestDigest: 'restart-open', payload: { url: 'ssh://git@example.invalid/repo', branch: 'main' } }),
    f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'binding_preview', idempotencyKey: 'restart-preview',
      requestDigest: 'restart-preview', basis, payload: { url: 'ssh://git@example.invalid/repo', branch: 'main' } }),
    f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', idempotencyKey: 'restart-sync',
      requestDigest: 'restart-sync', basis, payload: { lane: 'network' } }),
    f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'resolve', idempotencyKey: 'restart-resolve',
      requestDigest: 'restart-resolve', basis, payload: { conflictOperationId: retained.id, basis, resolutions: [] } }),
  ];
  f.store.updateOperation(admitted[1]!.id, { status: 'running', phase: 'waiting_idle', result: null, error: null });
  f.store.updateOperation(admitted[2]!.id, { status: 'waiting', phase: 'waiting_idle', result: null, error: null });

  for (const [kind, consumerKind] of [['enable_preview', 'enable'], ['binding_preview', 'bind'], ['restore_preview', 'restore']] as const) {
    const preview = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind,
      idempotencyKey: `restart-${kind}`, requestDigest: `restart-${kind}`, basis, payload: {} });
    f.store.updateOperation(preview.id, { status: 'succeeded', phase: 'local_saved',
      result: { preview: { id: preview.id, kind: consumerKind, basis, targetOid: null, expiresAt: Date.now() + 60_000,
        changes: { addedPaths: [], modifiedPaths: [], deletedPaths: [], settingsChanged: 0, conversationsChanged: 0,
          ignoredPaths: [], privatePaths: [], missingPaths: [], historyMode: 'complete', collisions: [] }, dependencies: [] } }, error: null });
    const consumer = f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: consumerKind,
      idempotencyKey: `restart-${consumerKind}`, requestDigest: `restart-${consumerKind}`, basis,
      payload: { previewId: preview.id } });
    f.store.consumePreview(preview.id, consumer.id);
    admitted.push(consumer);
  }
  await f.service.stop();
  const restarted = await createProjectGitServiceComposition({ db: f.db, store: f.store, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : id === 'unmanaged' ? f.unmanaged : join(f.data, 'missing'),
    emit: () => {}, gitEnv: fixtureGitEnv });
  cleanups.push(() => restarted.service.stop());
  await restarted.service.start();

  for (const operation of admitted) {
    expect(f.store.getOperation(operation.id)).toMatchObject({ status: 'failed', phase: 'failed',
      error: { code: 'RECOVERY_REQUIRED', details: { reason: 'interrupted_admission' } } });
  }
  expect(f.store.getOperation(retained.id)).toMatchObject({ status: 'waiting', phase: 'conflict' });
});

it('settles receipt-owned sync, resolve, and projectless open retries after SQLite reopen exactly once', async () => {
  const firstEvents: ProjectGitEvent[] = [];
  const f = await fixture();
  f.store.saveBinding({ ...f.store.getBinding('project')!, autoSync: false });
  const binding = f.store.getBinding('project')!;
  const basis = { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    localHead: binding.localHead, remoteHead: binding.observedRemoteHead, bindingGeneration: binding.generation };
  const conflict = f.store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'retry-reopen-conflict', requestDigest: 'retry-reopen-conflict', basis, payload: { lane: 'network' } });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null,
    error: { code: 'CONFLICT', message: 'Resolve this conflict.' } });
  const targets = [
    f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'sync', idempotencyKey: 'retry-reopen-sync',
      requestDigest: 'retry-reopen-sync', basis, payload: { lane: 'network' } }),
    f.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'resolve', idempotencyKey: 'retry-reopen-resolve',
      requestDigest: 'retry-reopen-resolve', basis, payload: { conflictOperationId: conflict.id, basis, resolutions: [] } }),
    f.store.enqueueOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'retry-reopen-open',
      requestDigest: 'retry-reopen-open', payload: { url: 'ssh://git@example.invalid/repo', branch: 'main' } }),
  ];
  for (const target of targets) {
    f.store.updateOperation(target.id, { status: 'failed', phase: 'failed', result: null,
      error: { code: 'GIT_AUTH_REQUIRED', message: 'Configure authentication.' } });
  }
  await f.service.stop(); f.db.close();

  const storeModule = fileURLToPath(new URL('../../../src/storage/project-git.ts', import.meta.url));
  const script = `import Database from 'better-sqlite3';
    import { createProjectGitStore } from ${JSON.stringify(storeModule)};
    const settings = JSON.parse(process.argv[1]); const db = new Database(settings.database); const store = createProjectGitStore(db);
    for (const target of settings.targets) store.claimOperationRequest({ actorId: 'local', projectId: target.projectId,
      action: 'retry', idempotencyKey: 'receipt-' + target.id, requestDigest: 'receipt-' + target.id, operationId: target.id });
    if (!store.startRetryAttempt(settings.targets[1].id, 1)) process.exit(2);
    process.stdout.write(JSON.stringify(settings.targets.map(target => store.getOperation(target.id)?.status)));
    db.close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script,
    JSON.stringify({ database: join(f.data, 'app.sqlite'), targets: targets.map(({ id, projectId }) => ({ id, projectId })) })], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  expect(await once(child, 'exit')).toEqual([0, null]);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toEqual(['queued', 'running', 'queued']);

  let reopenedDb = new Database(join(f.data, 'app.sqlite')); migrateProjectGit(reopenedDb);
  let reopenedStore = createProjectGitStore(reopenedDb);
  let restarted = await createProjectGitServiceComposition({ db: reopenedDb, store: reopenedStore, operationRoot: f.operationRoot,
    resolveProjectRoot: async id => id === 'project' ? f.git.a : id === 'unmanaged' ? f.unmanaged : join(f.data, 'missing'),
    emit: (_projectId, event) => { firstEvents.push(event); }, gitEnv: fixtureGitEnv });
  try {
    await restarted.service.start();
    for (const target of targets) {
      expect(reopenedStore.getOperation(target.id)).toMatchObject({ status: 'failed', phase: 'failed',
        error: { code: 'RECOVERY_REQUIRED', details: { reason: 'interrupted_retry' } } });
      expect(reopenedStore.getRetryAttempt(target.id)).toMatchObject({ attempt: 1, state: 'settled' });
    }
    expect(firstEvents.filter(event => event.type === 'project-git-operation'
      && targets.slice(0, 2).some(target => target.id === event.operation.id))).toHaveLength(2);
    await restarted.service.stop(); reopenedDb.close();

    reopenedDb = new Database(join(f.data, 'app.sqlite')); migrateProjectGit(reopenedDb);
    reopenedStore = createProjectGitStore(reopenedDb);
    const secondEvents: ProjectGitEvent[] = [];
    restarted = await createProjectGitServiceComposition({ db: reopenedDb, store: reopenedStore, operationRoot: f.operationRoot,
      resolveProjectRoot: async id => id === 'project' ? f.git.a : join(f.data, 'missing'),
      emit: (_projectId, event) => { secondEvents.push(event); }, gitEnv: fixtureGitEnv });
    await restarted.service.start();
    expect(reopenedStore.listActiveRetryAttempts()).toEqual([]);
    expect(secondEvents.filter(event => event.type === 'project-git-operation'
      && targets.some(target => target.id === event.operation.id))).toEqual([]);
  } finally {
    await restarted.service.stop().catch(() => undefined);
    if (reopenedDb.open) reopenedDb.close();
  }
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

it('returns a claimed retry operation before its network attempt completes', async () => {
  const f = await fixture();
  await writeFile(f.denyPush, 'deny');
  const original = await f.service.execute({ kind: 'sync' }, {
    actorId: 'local', projectId: 'project', idempotencyKey: 'blocked-retry-original', expectedProjectRevision: 0,
  });
  while (f.store.getJournal(original.operationId)?.status !== 'waiting') {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await rm(f.denyPush);
  await rm(f.pushEntered, { force: true });
  await writeFile(f.blockPush, 'block');
  const context = {
    actorId: 'local', projectId: 'project', idempotencyKey: 'blocked-retry', expectedProjectRevision: 0,
  } as const;
  const retrying = f.service.execute({ kind: 'retry', operationId: original.operationId }, context);
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await access(f.pushEntered); break; }
      catch { if (Date.now() >= deadline) throw new Error('retry push did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    const admitted = await Promise.race([
      retrying,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 100)),
    ]);
    expect(admitted).not.toBeNull();
    expect(admitted).toEqual({ operationId: original.operationId });
    expect(f.store.getOperation(original.operationId)).toMatchObject({ status: 'running', phase: 'syncing' });
    await expect(f.service.execute({ kind: 'retry', operationId: original.operationId }, context)).resolves.toEqual(admitted);
    await expect(f.service.execute({ kind: 'retry', operationId: original.operationId }, {
      ...context, idempotencyKey: 'blocked-retry-changed',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await rm(f.blockPush, { force: true });
    await retrying.catch(() => undefined);
  }
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
  const preview = await terminal(f.store, accepted.operationId);
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
  const preview = await terminal(f.store, accepted.operationId); const captured = await readBindingEvidence(f.operationRoot, preview);
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
  const preview = await terminal(f.store, accepted.operationId);
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
