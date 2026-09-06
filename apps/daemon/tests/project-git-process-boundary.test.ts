import Database from 'better-sqlite3';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { ProjectGitAccepted } from '@open-design/contracts';
import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { discoverRepository } from '../src/services/project-git/repository.js';
import { migrateProjectGit } from '../src/storage/project-git-migrations.js';
import { createProjectGitStore } from '../src/storage/project-git.js';
import { createGitFixture } from './helpers/project-git.js';

type WorkerMessage = { type: 'ready'; url: string }
  | { type: 'retry-started'; operationId: string; kind: string };

const children = new Set<ChildProcess>();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL'); await once(child, 'exit');
  }));
  children.clear();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function messages(child: ChildProcess) {
  const seen: WorkerMessage[] = [];
  child.on('message', message => { seen.push(message as WorkerMessage); });
  return async (match: (message: WorkerMessage) => boolean, timeoutMs = 10_000): Promise<WorkerMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = seen.find(match);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`child message timed out: ${JSON.stringify(seen)}`);
  };
}

async function startChild(data: string, gitBin: string, holdRetryKinds: string[] = []) {
  const settings = join(data, `child-${randomUUID()}.json`);
  await writeFile(settings, JSON.stringify({ gitBin, holdRetryKinds }));
  const child = fork(fileURLToPath(new URL('./helpers/project-git-process-boundary-worker.ts', import.meta.url)), [settings], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, OD_DATA_DIR: data, OD_DISABLE_API_AUTH: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', bytes => { stderr += String(bytes); });
  const nextMessage = messages(child);
  const ready = await nextMessage(message => message.type === 'ready') as Extract<WorkerMessage, { type: 'ready' }>;
  return { child, baseUrl: ready.url, nextMessage, stderr: () => stderr };
}

async function stopChild(worker: Awaited<ReturnType<typeof startChild>>) {
  worker.child.send({ type: 'shutdown' });
  const [code, signal] = await once(worker.child, 'exit') as [number | null, NodeJS.Signals | null];
  expect({ code, signal, stderr: worker.stderr() }).toEqual({ code: 0, signal: null, stderr: '' });
  children.delete(worker.child);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(path); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error(`file was not created: ${path}`);
}

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, match: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder(); let text = ''; const deadline = Date.now() + 10_000;
  while (!match(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`SSE frame timed out: ${text}`);
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`SSE read timed out: ${text}`)), remaining)),
    ]);
    if (next.done) throw new Error(`SSE ended early: ${text}`);
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

it('reopens publicly admitted retry attempts across a real daemon process boundary exactly once', async () => {
  const git = await createGitFixture();
  const data = await mkdtemp(join(tmpdir(), 'od-project-git-process-'));
  cleanups.push(async () => { await git.close(); await rm(data, { recursive: true, force: true }); });
  await writeFile(join(git.a, 'index.html'), 'process boundary');
  await git.git(git.a, 'add', 'index.html');
  await git.git(git.a, 'commit', '-m', 'process boundary');
  await git.git(git.a, 'push', 'origin', 'HEAD:main');
  const head = await git.git(git.a, 'rev-parse', 'HEAD');
  const repository = await discoverRepository(git.a);
  openDatabase(data, { dataDir: data }); closeDatabase();
  let db = new Database(join(data, 'app.sqlite')); migrateProjectGit(db);
  insertProject(db, { id: 'project', name: 'Process project', createdAt: 1, updatedAt: 1,
    metadata: { kind: 'prototype', baseDir: git.a } });
  let store = createProjectGitStore(db);
  store.saveBinding({ projectId: 'project', cloneId: 'process-clone', repositoryProjectId: 'process-repository',
    canonicalRoot: git.a, commonDir: repository.commonDir, branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo',
    generation: 0, autoSync: false, localHead: head, observedRemoteHead: head, confirmedRemoteHead: head,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: head, dirty: false });
  const openTarget = store.enqueueOperation({ projectId: null, actorId: 'local-daemon', kind: 'open',
    idempotencyKey: 'failed-open-target', requestDigest: 'failed-open-target',
    payload: { url: 'ssh://git@example.invalid/repo', branch: 'main' } });
  store.updateOperation(openTarget.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Configure authentication.' } });
  const otherOpen = store.enqueueOperation({ projectId: null, actorId: 'local-daemon', kind: 'open',
    idempotencyKey: 'other-open-target', requestDigest: 'other-open-target',
    payload: { url: 'ssh://git@example.invalid/repo', branch: 'main' } });
  store.updateOperation(otherOpen.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Configure authentication.' } });
  db.close();

  const bin = join(data, 'bin'); await mkdir(bin);
  const blockFetch = join(data, 'block-fetch'); const fetchEntered = join(data, 'fetch-entered');
  const networkLog = join(data, 'network.log');
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY\ncase "$*" in *git-receive-pack*) echo push >> '${networkLog}'; exec git receive-pack '${git.remote}';; *) echo fetch >> '${networkLog}'; touch '${fetchEntered}'; while [ -f '${blockFetch}' ]; do sleep 0.01; done; exec git upload-pack '${git.remote}';; esac\n`);
  await chmod(join(bin, 'ssh'), 0o700);

  const first = await startChild(data, bin, ['resolve', 'open']);
  const controller = new AbortController();
  const stream = await fetch(`${first.baseUrl}/api/projects/project/events`, { signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  let sse = await readSseUntil(reader, text => text.includes('event: ready'));
  await writeFile(blockFetch, 'block');
  const predecessorResponse = await fetch(`${first.baseUrl}/api/projects/project/git/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'lane-predecessor' },
    body: JSON.stringify({ expectedProjectRevision: 0 }),
  });
  expect(predecessorResponse.status, await predecessorResponse.clone().text()).toBe(202);
  await waitForFile(fetchEntered);

  db = new Database(join(data, 'app.sqlite')); store = createProjectGitStore(db);
  const currentBinding = store.getBinding('project')!;
  const currentBasis = { projectRevision: currentBinding.projectRevision, contentRevision: currentBinding.contentRevision,
    localHead: currentBinding.localHead, remoteHead: currentBinding.observedRemoteHead, bindingGeneration: currentBinding.generation };
  const syncTarget = store.enqueueOperation({ projectId: 'project', actorId: 'local-daemon', kind: 'sync',
    idempotencyKey: 'failed-sync-target', requestDigest: 'failed-sync-target', basis: currentBasis, payload: { lane: 'network' } });
  store.updateOperation(syncTarget.id, { status: 'failed', phase: 'auth_required', result: { head: currentBinding.localHead! },
    error: { code: 'GIT_AUTH_REQUIRED', message: 'Configure authentication.' } });
  const conflict = store.enqueueOperation({ projectId: 'project', actorId: 'project-git-background', kind: 'sync',
    idempotencyKey: 'process-retained-conflict', requestDigest: 'process-retained-conflict', basis: currentBasis, payload: { lane: 'network' } });
  store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: { head: currentBinding.localHead! },
    error: { code: 'GIT_CONFLICT', message: 'Resolve the retained conflict.', details: { reason: 'merge_conflict' } } });
  const resolveTarget = store.enqueueOperation({ projectId: 'project', actorId: 'local-daemon', kind: 'resolve',
    idempotencyKey: 'failed-resolve-target', requestDigest: 'failed-resolve-target', basis: currentBasis,
    payload: { conflictOperationId: conflict.id, basis: currentBasis, resolutions: [] } });
  store.updateOperation(resolveTarget.id, { status: 'failed', phase: 'failed', result: null,
    error: { code: 'CONFLICT', message: 'Retry the resolution.' } });
  db.close();

  const retry = (id: string, key: string, expectedProjectRevision?: number) => fetch(
    `${first.baseUrl}/api/project-git-operations/${id}/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }),
    });
  const syncResponse = await retry(syncTarget.id, 'retry-sync', 0);
  expect(syncResponse.status, await syncResponse.clone().text()).toBe(202);
  const syncAccepted = await syncResponse.json() as ProjectGitAccepted;
  expect(syncAccepted).toEqual({ operationId: syncTarget.id });
  const immediate = await fetch(`${first.baseUrl}/api/project-git-operations/${syncTarget.id}`);
  expect(immediate.status).toBe(200);
  expect(await immediate.json()).toMatchObject({ id: syncTarget.id, status: expect.stringMatching(/queued|running/) });
  sse += await readSseUntil(reader, text => text.includes(`"id":"${syncTarget.id}"`)
    && /"status":"(?:queued|running)"/u.test(text));
  expect(sse).toContain('event: project-git-operation');
  const exactSync = await retry(syncTarget.id, 'retry-sync', 0);
  expect(exactSync.status).toBe(202); expect(await exactSync.json()).toEqual(syncAccepted);
  expect((await retry(syncTarget.id, 'retry-sync', 1)).status).toBe(409);
  expect((await retry(syncTarget.id, 'retry-sync-second', 0)).status).toBe(409);

  const resolveResponse = await retry(resolveTarget.id, 'retry-resolve', 0);
  expect(resolveResponse.status, await resolveResponse.clone().text()).toBe(202);
  expect(await resolveResponse.json()).toEqual({ operationId: resolveTarget.id });
  await first.nextMessage(message => message.type === 'retry-started' && message.operationId === resolveTarget.id);
  const exactResolve = await retry(resolveTarget.id, 'retry-resolve', 0);
  expect(exactResolve.status).toBe(202); expect(await exactResolve.json()).toEqual({ operationId: resolveTarget.id });
  expect((await retry(resolveTarget.id, 'retry-resolve-second', 0)).status).toBe(409);

  const openResponse = await retry(openTarget.id, 'retry-open');
  expect(openResponse.status, await openResponse.clone().text()).toBe(202);
  expect(await openResponse.json()).toEqual({ operationId: openTarget.id });
  await first.nextMessage(message => message.type === 'retry-started' && message.operationId === openTarget.id);
  const exactOpen = await retry(openTarget.id, 'retry-open');
  expect(exactOpen.status).toBe(202); expect(await exactOpen.json()).toEqual({ operationId: openTarget.id });
  expect((await retry(otherOpen.id, 'retry-open')).status).toBe(409);
  expect((await retry(openTarget.id, 'retry-open-second')).status).toBe(409);
  expect((await fetch(`${first.baseUrl}/api/project-git-operations/${openTarget.id}`)).status).toBe(200);
  expect((await fetch(`${first.baseUrl}/api/project-git-operations/${openTarget.id}`, {
    headers: { origin: 'https://outside.invalid' },
  })).status).toBe(403);

  controller.abort(); await reader.cancel().catch(() => {});
  first.child.kill('SIGKILL');
  const [, firstSignal] = await once(first.child, 'exit') as [number | null, NodeJS.Signals | null];
  expect(firstSignal).toBe('SIGKILL'); children.delete(first.child);
  await rm(blockFetch, { force: true });
  const effectsBeforeRestart = await readFile(networkLog, 'utf8');

  const second = await startChild(data, bin);
  for (const target of [syncTarget, resolveTarget, openTarget]) {
    const response = await fetch(`${second.baseUrl}/api/project-git-operations/${target.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: target.id, status: 'failed', phase: 'failed',
      error: { code: 'RECOVERY_REQUIRED', details: { reason: 'interrupted_retry' } } });
  }
  expect(await readFile(networkLog, 'utf8')).toBe(effectsBeforeRestart);
  db = new Database(join(data, 'app.sqlite')); store = createProjectGitStore(db);
  const settled = [syncTarget, resolveTarget, openTarget].map(target => ({
    operation: store.getJournal(target.id), attempt: store.getRetryAttempt(target.id),
  }));
  expect(settled.every(item => item.attempt?.state === 'settled' && item.operation?.journalPhase === null
    && item.operation.recoveryData === null)).toBe(true);
  db.close();
  await stopChild(second);

  const third = await startChild(data, bin);
  db = new Database(join(data, 'app.sqlite')); store = createProjectGitStore(db);
  expect([syncTarget, resolveTarget, openTarget].map(target => ({
    operation: store.getJournal(target.id), attempt: store.getRetryAttempt(target.id),
  }))).toEqual(settled);
  db.close();
  expect(await readFile(networkLog, 'utf8')).toBe(effectsBeforeRestart);
  await stopChild(third);
});
