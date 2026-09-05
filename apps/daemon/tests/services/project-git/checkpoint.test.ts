import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync as requireWrite } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, utimes, unlink, rename, readdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitBasis } from '@open-design/contracts';
import { createGitFixture } from '../../helpers/project-git.js';
import { migrateProjectGit } from '../../../src/storage/project-git-migrations.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { getProjectGate } from '../../../src/services/project-git/gate.js';
import * as gitProcess from '../../../src/services/project-git/git-process.js';
import { prepareCheckpoint, publishCheckpoint, journalCheckpoint, readCheckpointPublication, computeCheckpointContentDigest } from '../../../src/services/project-git/checkpoint.js';
import type { CheckpointCoordination } from '../../../src/services/project-git/checkpoint.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';

const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
const gitEnv = { GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig,
  GIT_AUTHOR_NAME: 'Checkpoint Test', GIT_AUTHOR_EMAIL: 'checkpoint@example.invalid',
  GIT_COMMITTER_NAME: 'Checkpoint Test', GIT_COMMITTER_EMAIL: 'checkpoint@example.invalid' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
function portable(chat = true, name = 'Project') {
  return serializePortableMetadata({ manifest: { schemaVersion: 1, repositoryProjectId: 'r1', resources: [] },
    project: { schemaVersion: 1, name, createdAt: 1, kind: 'prototype', preferences: {}, contentRefs: [], linkedFolderRequirements: [] },
    conversations: chat ? [{ schemaVersion: 1, id: 'chat', title: 'Chat', mode: 'design', createdAt: 1 }] : [], messages: [] });
}
async function writeEntries(root: string, entries: Map<string, Uint8Array>) {
  for (const [path, bytes] of entries) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
}

async function fixture(initial = true, seed?: (f: Awaited<ReturnType<typeof createGitFixture>>) => Promise<void>) {
  const f = await createGitFixture();
  const db = new Database(join(f.root, 'state.sqlite')); migrateProjectGit(db);
  cleanup.push(async () => { if (db.open) db.close(); await f.close(); });
  if (initial) {
    await writeFile(join(f.a, 'index.html'), 'first');
    await f.git(f.a, 'add', '--', 'index.html'); await f.git(f.a, 'commit', '-m', 'first');
  }
  await seed?.(f);
  const head = initial ? await f.git(f.a, 'rev-parse', 'HEAD') : null;
  const store = createProjectGitStore(db);
  store.saveBinding({ projectId: 'p1', cloneId: 'c1', repositoryProjectId: 'r1', canonicalRoot: f.a,
    commonDir: join(f.a, '.git'), branch: 'main', remoteUrl: 'https://example.invalid/project', generation: 0,
    autoSync: false, localHead: head, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: head, dirty: false });
  const readBasis = (): ProjectGitBasis => {
    const b = store.getBinding('p1')!;
    return { bindingGeneration: b.generation, projectRevision: b.projectRevision,
      contentRevision: b.contentRevision, localHead: b.localHead, remoteHead: b.observedRemoteHead };
  };
  const gate = await getProjectGate({ root: f.a, instanceId: randomUUID(), ownerDomain: 'checkpoint-test', dataRootId: f.root });
  const coordination: CheckpointCoordination = { projectId: 'p1', basis: readBasis(), gate, readBasis, gitEnv };
  const input = { root: f.a, operationDir: join(f.root, 'op'), head, portableEntries: new Map<string, Uint8Array>(), coordination };
  const enqueue = (ownerOperationId?: string) => store.enqueueCheckpoint({ projectId: 'p1', actorId: 'local',
    idempotencyKey: randomUUID(), requestDigest: randomUUID(), payload: {}, basis: coordination.basis,
    ...(ownerOperationId ? { ownerOperationId } : {}) }).id;
  return { ...f, db, head, store, input, coordination, enqueue, readBasis };
}

describe('consistent project checkpoints', () => {
  it('uses the same semantic content digest before and after generated writeback and HEAD publication', async () => {
    const f = await fixture(); f.input.portableEntries = portable(); const candidate = await prepareCheckpoint(f.input);
    await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store });
    const next = await prepareCheckpoint({ ...f.input, head: candidate.commitOid,
      coordination: { ...f.coordination, basis: f.readBasis() } });
    expect(next.previewContentDigest).toBe(candidate.previewContentDigest); expect(next.commitOid).toBeNull();
    expect(computeCheckpointContentDigest({ sourceDigests: { a: 'a'.repeat(64) }, sourceModes: { a: '100644' }, portableDigests: {}, removedPaths: [] }))
      .toBe(createHash('sha256').update('[["a","100644","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]\n').digest('hex'));
  });

  it('treats __proto__ and constructor as literal source filenames', async () => {
    const f = await fixture(); await writeFile(join(f.a, '__proto__'), 'prototype bytes'); await writeFile(join(f.a, 'constructor'), 'constructor bytes');
    const candidate = await prepareCheckpoint(f.input);
    expect(candidate.sourceDigests['__proto__']).toBe(createHash('sha256').update('prototype bytes').digest('hex'));
    expect(candidate.sourceDigests['constructor']).toBe(createHash('sha256').update('constructor bytes').digest('hex'));
    const operationId = f.enqueue(); await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store });
    expect(await f.git(f.a, 'show', 'HEAD:__proto__')).toBe('prototype bytes');
    expect((await readCheckpointPublication({ root: f.a, operationId, store: f.store })).evidence.sourceDigests['constructor'])
      .toBe(createHash('sha256').update('constructor bytes').digest('hex'));
  });
  it('does not consume the user staged index', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'staged-user-work');
    await f.git(f.a, 'add', '--', 'index.html');
    const before = await readFile(join(f.a, '.git/index'));
    const staged = await f.git(f.a, 'diff', '--cached', '--binary');
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    expect(await f.git(f.a, 'diff', '--cached', '--binary')).toBe(staged);
  });

  it('returns no commit or duplicate outbox for the same semantic tree', async () => {
    const f = await fixture(); const before = await readFile(join(f.a, '.git/index'));
    const candidate = await prepareCheckpoint(f.input);
    expect(candidate.commitOid).toBeNull();
    expect(await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store })).toBeNull();
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    expect(f.store.listDuePushes(Date.now())).toEqual([]);
  });

  it('publishes a child and a clean normal index while retaining files and baseline revision', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'second');
    const before = await readFile(join(f.a, '.git/index'));
    const candidate = await prepareCheckpoint(f.input);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    const operationId = f.enqueue();
    expect(await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).toBe(candidate.commitOid);
    expect(await f.git(f.a, 'rev-parse', 'HEAD^')).toBe(f.head);
    expect(await f.git(f.a, 'diff', '--cached', '--exit-code')).toBe('');
    expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('second');
    expect(await f.git(f.a, 'show', 'HEAD:index.html')).toBe('second');
    expect(f.store.getBinding('p1')).toMatchObject({ localHead: candidate.commitOid, projectRevision: 0 });
    expect(f.store.getJournal(operationId)).toMatchObject({ journalPhase: 'complete',
      recordsTransition: { importMarker: null, advanceProjectRevision: false, projectRevision: 0 } });
    expect(f.store.listDuePushes(Date.now())).toMatchObject([{ targetOid: candidate.commitOid }]);
  });

  it.each(['chat', 'settings'])('commits %s-only portable changes', async kind => {
    const f = await fixture(); f.input.portableEntries = portable(kind === 'chat', kind === 'settings' ? 'Changed settings' : 'Project');
    const candidate = await prepareCheckpoint(f.input);
    expect(candidate.commitOid).not.toBeNull();
    expect(await f.git(f.a, 'show', `${candidate.commitOid}:.open-design/project.json`)).toContain(kind === 'settings' ? 'Changed settings' : 'Project');
    expect(await f.git(f.a, 'show', `${candidate.commitOid}:index.html`)).toBe('first');
    await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store });
    expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
    expect(await f.git(f.a, 'diff', '--exit-code')).toBe('');
  });

  it('includes tracked UI-ignored files, deletes removed tracked files and handles NUL-delimited names', async () => {
    const f = await fixture(true, async f => {
      await mkdir(join(f.a, 'node_modules')); await writeFile(join(f.a, 'node_modules/owned.txt'), 'old');
      await f.git(f.a, 'add', '--', 'node_modules/owned.txt'); await f.git(f.a, 'commit', '-m', 'tracked');
    });
    await writeFile(join(f.a, '.gitignore'), 'node_modules/\n');
    await writeFile(join(f.a, 'node_modules/owned.txt'), 'new');
    await writeFile(join(f.a, 'space and\nnewline.txt'), 'literal name'); await unlink(join(f.a, 'index.html'));
    const candidate = await prepareCheckpoint(f.input);
    expect(await f.git(f.a, 'show', `${candidate.commitOid}:node_modules/owned.txt`)).toBe('new');
    expect(await f.git(f.a, 'show', `${candidate.commitOid}:space and\nnewline.txt`)).toBe('literal name');
    expect(await f.git(f.a, 'ls-tree', '--name-only', candidate.commitOid!)).not.toContain('index.html');
  });

  it('detects an external equal-size edit even when mtime is restored during preparation', async () => {
    const f = await fixture(); const path = join(f.a, 'index.html'); const before = await stat(path);
    let reads = 0;
    f.input.coordination = { ...f.coordination, readBasis: async () => {
      if (++reads === 2) { await writeFile(path, 'other'); await utimes(path, before.atime, before.mtime); }
      return f.readBasis();
    } };
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await readFile(path, 'utf8')).toBe('other');
  });

  it('detects a content revision change during preparation', async () => {
    const f = await fixture(); let reads = 0;
    f.coordination.readBasis = () => { if (++reads === 2) f.store.bumpContent('p1', f.readBasis()); return f.readBasis(); };
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  });

  it('checks real SHA-256 bytes for a large binary candidate', async () => {
    const f = await fixture(); const bytes = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await writeFile(join(f.a, 'large.bin'), bytes);
    const candidate = await prepareCheckpoint(f.input);
    expect(candidate.sourceDigests['large.bin']).toBe(createHash('sha256').update(bytes).digest('hex'));
    const object = await gitProcess.runGit({ cwd: f.a, args: ['cat-file', '--batch'], stdin: Buffer.from(`${candidate.commitOid}:large.bin\n`) });
    const start = object.stdout.indexOf(10) + 1;
    expect(createHash('sha256').update(object.stdout.subarray(start, -1)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it.each(['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer', 'index.lock'])('preserves an external %s operation', async marker => {
    const f = await fixture(); const path = join(f.a, '.git', marker);
    await writeFile(path, 'external marker');
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    expect(await readFile(path, 'utf8')).toBe('external marker');
  });

  it.each(['.env.local', 'config.yaml', 'app.sqlite-wal', 'credentials.json', 'private.key'])('refuses private %s paths without exposing bytes', async path => {
    const f = await fixture(); await writeFile(join(f.a, path), 'private-value-do-not-log');
    const error = await prepareCheckpoint(f.input).catch(error => error);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', details: { paths: [path] } });
    expect(JSON.stringify(error)).not.toContain('private-value-do-not-log');
  });

  it('refuses a tracked private path even when now ignored and leaves history alone', async () => {
    const f = await fixture(true, async f => {
      await writeFile(join(f.a, '.env'), 'private history'); await f.git(f.a, 'add', '.env'); await f.git(f.a, 'commit', '-m', 'private');
      await writeFile(join(f.a, '.gitignore'), '.env\n');
    });
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { paths: ['.env'] } });
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('fails identity preflight before constructing private indexes or candidate objects', async () => {
    const f = await fixture(); f.coordination.gitEnv = { GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig };
    await writeFile(join(f.a, 'index.html'), 'new content');
    const objects = await f.git(f.a, 'count-objects', '-v');
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'GIT_IDENTITY_REQUIRED' });
    expect(await readdir(f.root)).not.toContain('op');
    // Repository lease creates its own owner blob, but never a checkpoint commit or index.
    expect(await f.git(f.a, 'rev-list', '--all', '--count')).toBe('1');
    expect(objects).toContain('count: 3');
  });

  it('publishes an unborn checkpoint using an all-zero creation CAS', async () => {
    const f = await fixture(false); await writeFile(join(f.a, 'index.html'), 'initial');
    const candidate = await prepareCheckpoint({ ...f.input, reason: { source: 'initialize', runs: [] } });
    await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store });
    expect(await f.git(f.a, 'rev-list', '--parents', 'HEAD')).toBe(candidate.commitOid);
    expect(await f.git(f.a, 'diff', '--cached', '--exit-code')).toBe('');
  });

  it('writes all AI terminal outcomes in commit metadata without coauthor trailers', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'ai result');
    const reason = { source: 'ai' as const, runs: [
      { id: 'r1', terminal: 'succeeded' as const }, { id: 'r2', terminal: 'failed' as const }, { id: 'r3', terminal: 'cancelled' as const },
    ] };
    const candidate = await prepareCheckpoint({ ...f.input, reason });
    const message = await f.git(f.a, 'show', '-s', '--format=%B', candidate.commitOid!);
    expect(message).toContain(JSON.stringify(reason)); expect(message).not.toMatch(/co-authored-by/iu);
  });

  it('refuses an index.lock created after no-op preparation', async () => {
    const f = await fixture(); const candidate = await prepareCheckpoint(f.input);
    await writeFile(join(f.a, '.git/index.lock'), 'user lock');
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    expect(await readFile(join(f.a, '.git/index.lock'), 'utf8')).toBe('user lock');
  });

  it.each(['file', 'staged', 'revision', 'head'])('rejects stale %s before publication and retains external state', async kind => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const operationId = f.enqueue();
    if (kind === 'file' || kind === 'staged') await writeFile(join(f.a, 'index.html'), 'external');
    if (kind === 'staged') await f.git(f.a, 'add', 'index.html');
    if (kind === 'revision') f.store.bumpContent('p1', f.readBasis());
    if (kind === 'head') { await f.git(f.a, 'add', 'index.html'); await f.git(f.a, 'commit', '-m', 'external'); }
    const index = await readFile(join(f.a, '.git/index')); const head = await f.git(f.a, 'rev-parse', 'HEAD');
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).rejects.toMatchObject({ code: kind === 'staged' ? 'EXTERNAL_GIT_BUSY' : 'PROJECT_STATE_CHANGED' });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(index); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('loses a real HEAD CAS race without changing the external index or deleting foreign locks', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const index = await readFile(join(f.a, '.git/index'));
    const rival = (await gitProcess.runGit({ cwd: f.a, args: ['commit-tree', `${f.head}^{tree}`, '-p', f.head!],
      env: gitEnv, stdin: Buffer.from('rival\n') })).stdout.toString().trim();
    const original = gitProcess.runGit;
    vi.spyOn(gitProcess, 'runGit').mockImplementation(async input => {
      if (input.args[0] === 'update-ref' && input.args[2] === 'refs/heads/main') {
        await f.git(f.a, 'update-ref', 'refs/heads/main', rival, f.head!);
        await rename(join(f.a, '.git/index.lock'), join(f.root, 'our-moved-lock'));
        await writeFile(join(f.a, '.git/index.lock'), 'foreign lock');
      }
      return original(input);
    });
    const operationId = f.enqueue();
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(rival);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
    expect(await readFile(join(f.a, '.git/index.lock'), 'utf8')).toBe('foreign lock');
    expect(f.store.getJournal(operationId)).toMatchObject({ journalPhase: 'ref_published', phaseCompleted: false });
  });

  it.each(['journal', 'adapter'])('retains owned lock and pre-CAS index after a post-CAS %s failure', async fault => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const before = await readFile(join(f.a, '.git/index'));
    const operationId = f.enqueue();
    if (fault === 'journal') {
      const complete = f.store.completePhase;
      vi.spyOn(f.store, 'completePhase').mockImplementation((id, phase, data) => { if (phase === 'ref_published') throw new Error('crash after CAS'); complete(id, phase, data); });
    } else {
      const original = gitProcess.runGit;
      vi.spyOn(gitProcess, 'runGit').mockImplementation(async input => {
        const result = await original(input);
        if (input.args[0] === 'update-ref' && input.args[2] === 'refs/heads/main') throw new Error('crash after CAS');
        return result;
      });
    }
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).rejects.toThrow('crash after CAS');
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(candidate.commitOid);
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    expect(await readFile(join(f.a, '.git/index.lock'))).toEqual(await readFile(candidate.privateIndexPath));
    expect(f.store.getJournal(operationId)).toMatchObject({ journalPhase: 'ref_published', phaseCompleted: false,
      recoveryData: { refPublished: false, index: { published: false } } });
  });

  it('does not rename an owned inode whose candidate index bytes were overwritten after CAS', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const before = await readFile(join(f.a, '.git/index'));
    const complete = f.store.completePhase;
    vi.spyOn(f.store, 'completePhase').mockImplementation((id, phase, data) => {
      complete(id, phase, data);
      if (phase === 'ref_published') {
        // The actual write is performed at the next real Git/read boundary below.
        overwrite = true;
      }
    });
    let overwrite = false; const original = f.store.setPhase;
    vi.spyOn(f.store, 'setPhase').mockImplementation((id, phase, data) => {
      original(id, phase, data); if (overwrite && phase === 'index_published') requireWrite(join(f.a, '.git/index.lock'), 'foreign bytes');
    });
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
  });

  it('accepts exact completed replay without replacing a newer outbox', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const input = { root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store };
    await publishCheckpoint(input); f.store.queuePush('p1', f.readBasis().bindingGeneration, 'later-head');
    expect(await publishCheckpoint(input)).toBe(candidate.commitOid);
    expect(f.store.listDuePushes(Date.now())).toMatchObject([{ targetOid: 'later-head' }]);
  });

  it('rejects a foreign or reconstructed candidate before journaling', async () => {
    const f = await fixture(); const other = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input);
    for (const input of [
      { root: f.a, branch: 'main', candidate: { ...candidate }, operationId: f.enqueue(), store: f.store },
      { root: other.a, branch: 'main', candidate, operationId: other.enqueue(), store: other.store },
    ]) await expect(publishCheckpoint(input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it.each([true, false])('requires an owned outer protection intent before child publication (intent=%s)', async hasIntent => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'protected content');
    const candidate = await prepareCheckpoint(f.input);
    const outer = f.store.enqueueOperation({ projectId: 'p1', actorId: 'local', kind: 'restore',
      basis: f.coordination.basis, idempotencyKey: 'outer', requestDigest: 'outer-digest', payload: {} });
    const data = { operationRoot: join(f.root, 'outer'), baseHead: f.head, previewContentDigest: candidate.previewContentDigest,
      candidateTreeOid: candidate.treeOid, publishBase: f.head, publicationParents: [f.head!],
      publishHead: candidate.commitOid!, candidateOid: candidate.commitOid!, paths: [], records: null, refPublished: false,
      index: { path: join(f.a, '.git/index'), oldDigest: null, candidateDigest: 'outer-index', backupPath: null, ownerToken: 'outer-owner', published: false } };
    f.store.setPhase(outer.id, 'prepared', data); f.store.completePhase(outer.id, 'prepared', data);
    f.store.setPhase(outer.id, 'protected', data);
    const input = { root: f.a, branch: 'main', candidate, operationId: f.enqueue(outer.id), store: f.store };
    await journalCheckpoint(input); await journalCheckpoint(input);
    const protection = { basis: f.coordination.basis, checkpointOperationId: input.operationId, checkpointOid: candidate.commitOid! };
    if (hasIntent) {
      f.store.prepareProtection(outer.id, protection); await publishCheckpoint(input); f.store.completeProtection(outer.id, protection);
      expect(f.store.getJournal(outer.id)).toMatchObject({ basis: f.coordination.basis, protection: { completed: true, publishBase: candidate.commitOid } });
      expect(f.store.getBinding('p1')).toMatchObject({ projectRevision: 0, contentRevision: 0, localHead: candidate.commitOid });
      expect(await f.git(f.a, 'rev-parse', 'HEAD^')).toBe(f.head);
    } else {
      await expect(publishCheckpoint(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
      expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
      expect(f.store.getJournal(input.operationId)?.journalPhase).toBe('prepared');
    }
  });

  it('journals removal of obsolete owned conversations and leaves a clean full worktree', async () => {
    const f = await fixture(true, async f => { await writeEntries(f.a, portable()); await f.git(f.a, 'add', '.open-design'); await f.git(f.a, 'commit', '-m', 'chat'); });
    f.input.portableEntries = portable(false);
    const candidate = await prepareCheckpoint(f.input); const operationId = f.enqueue();
    await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store });
    const obsolete = [...portable().keys()].find(path => path.includes('/conversations/'))!;
    await expect(readFile(join(f.a, obsolete))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.getJournal(operationId)?.recoveryData?.paths).toContainEqual(expect.objectContaining({ path: obsolete, candidateDigest: null, applied: true }));
    expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
  });

  it.each(['unknown', 'external'])('refuses %s portable data rather than overwriting or deleting it', async kind => {
    const f = await fixture(true, async f => { await writeEntries(f.a, portable()); await f.git(f.a, 'add', '.open-design'); await f.git(f.a, 'commit', '-m', 'portable'); });
    const path = kind === 'unknown' ? '.open-design/user-note.txt' : '.open-design/project.json';
    await writeFile(join(f.a, path), 'external data'); f.input.portableEntries = portable(false, 'New name');
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: kind === 'unknown' ? 'PORTABLE_FORMAT_UNSUPPORTED' : 'PROJECT_STATE_CHANGED' });
    expect(await readFile(join(f.a, path), 'utf8')).toBe('external data');
  });

  it('retains byte backups and file intent after interrupted portable writeback before HEAD CAS', async () => {
    const f = await fixture(); f.input.portableEntries = portable(); const candidate = await prepareCheckpoint(f.input);
    const before = await readFile(join(f.a, '.git/index')); const operationId = f.enqueue();
    const complete = f.store.completePhase;
    vi.spyOn(f.store, 'completePhase').mockImplementation((id, phase, data) => { if (phase === 'files_applied') throw new Error('interrupted files'); complete(id, phase, data); });
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).rejects.toThrow('interrupted files');
    const journal = f.store.getJournal(operationId)!;
    expect(journal).toMatchObject({ journalPhase: 'files_applied', phaseCompleted: false });
    expect(journal.recoveryData!.paths.length).toBe(3);
    for (const [path, bytes] of f.input.portableEntries) expect(await readFile(join(f.a, path))).toEqual(Buffer.from(bytes));
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('reads original journal objects, portable bytes and owned lock after SQLite reopen without preparing another commit', async () => {
    const f = await fixture(); f.input.portableEntries = portable(); const candidate = await prepareCheckpoint(f.input);
    const operationId = f.enqueue(); const complete = f.store.completePhase;
    vi.spyOn(f.store, 'completePhase').mockImplementation((id, phase, data) => { if (phase === 'ref_published') throw new Error('crash'); complete(id, phase, data); });
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store })).rejects.toThrow('crash');
    f.db.close(); const db = new Database(join(f.root, 'state.sqlite'));
    try {
      const recovered = await readCheckpointPublication({ root: f.a, operationId, store: createProjectGitStore(db) });
      expect(recovered.evidence.commitOid).toBe(candidate.commitOid);
      expect(recovered.journal.basis).toEqual(f.coordination.basis);
      expect(recovered.indexBytes).toEqual(await readFile(candidate.privateIndexPath));
      expect(recovered.lockReceipt).toMatchObject({ ownerToken: recovered.journal.recoveryData!.index.ownerToken });
      expect(recovered.evidence.portablePaths).toHaveLength(3);
      expect(await f.git(f.a, 'rev-list', '--count', 'HEAD')).toBe('2');
    } finally { db.close(); }
  });

  it.each(['index', 'evidence', 'backup', 'root', 'symlink', 'receipt'])('rejects %s recovery material mismatches', async fault => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const operationId = f.enqueue();
    await journalCheckpoint({ root: f.a, branch: 'main', candidate, operationId, store: f.store });
    const data = f.store.getJournal(operationId)!.recoveryData!;
    let root = f.a;
    if (fault === 'index') await writeFile(candidate.privateIndexPath, 'corrupt');
    if (fault === 'evidence') {
      const path = join(data.operationRoot, 'checkpoint.json'); const evidence = JSON.parse(await readFile(path, 'utf8'));
      evidence.commitOid = f.head; await writeFile(path, JSON.stringify(evidence));
    }
    if (fault === 'backup') await writeFile(data.index.backupPath!, 'corrupt');
    if (fault === 'root') root = (await fixture()).a;
    if (fault === 'symlink') {
      await rename(candidate.privateIndexPath, join(f.root, 'outside.index'));
      await symlink(join(f.root, 'outside.index'), candidate.privateIndexPath);
    }
    if (fault === 'receipt') {
      await writeFile(join(f.a, '.git/index.lock'), 'foreign lock');
      await writeFile(join(data.operationRoot, 'index-lock.json'), JSON.stringify({ ownerToken: data.index.ownerToken, dev: '0', ino: '0' }));
    }
    await expect(readCheckpointPublication({ root, operationId, store: f.store })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('retains the original SQLite journal and index lock when a real publisher is SIGKILLed after HEAD CAS', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'process checkpoint'); const before = await readFile(join(f.a, '.git/index'));
    const checkpointUrl = new URL('../../../src/services/project-git/checkpoint.ts', import.meta.url).href;
    const storeUrl = new URL('../../../src/storage/project-git.ts', import.meta.url).href;
    const gateUrl = new URL('../../../src/services/project-git/gate.ts', import.meta.url).href;
    const source = `import Database from 'better-sqlite3';
      import { prepareCheckpoint, publishCheckpoint } from ${JSON.stringify(checkpointUrl)};
      import { createProjectGitStore } from ${JSON.stringify(storeUrl)};
      import { getProjectGate } from ${JSON.stringify(gateUrl)};
      const root = process.argv[1]; const operationDir = process.argv[2];
      const db = new Database(process.argv[3]); const store = createProjectGitStore(db);
      const readBasis = () => { const b = store.getBinding('p1'); return { bindingGeneration:b.generation, projectRevision:b.projectRevision, contentRevision:b.contentRevision, localHead:b.localHead, remoteHead:b.observedRemoteHead }; };
      const basis = readBasis(); const gate = await getProjectGate({ root, instanceId:'crash-worker', ownerDomain:'checkpoint-test', dataRootId:operationDir });
      const candidate = await prepareCheckpoint({ root, operationDir, head:basis.localHead, portableEntries:new Map(), coordination:{ projectId:'p1', basis, gate, readBasis, gitEnv:${JSON.stringify(gitEnv)} } });
      const op = store.enqueueCheckpoint({ projectId:'p1', actorId:'local', basis, idempotencyKey:'process-crash', requestDigest:'process-crash', payload:{} });
      const complete = store.completePhase;
      store.completePhase = (id, phase, data) => { if (phase === 'ref_published') process.kill(process.pid, 'SIGKILL'); complete(id, phase, data); };
      await publishCheckpoint({ root, branch:'main', candidate, operationId:op.id, store });`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, f.a, join(f.root, 'worker-op'), join(f.root, 'state.sqlite')],
      { cwd: process.cwd(), env: { ...env, ...gitEnv }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (_code, signal) => resolve(signal)); });
    expect(stderr).toBe(''); expect(signal).toBe('SIGKILL');
    const journal = f.store.listRecoverable().find(op => op.idempotencyKey === 'process-crash')!;
    expect(journal).toMatchObject({ journalPhase: 'ref_published', phaseCompleted: false, recoveryData: { refPublished: false } });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    const retained = await readCheckpointPublication({ root: f.a, operationId: journal.id, store: f.store });
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(retained.evidence.commitOid);
    expect(await readFile(join(f.a, '.git/index.lock'))).toEqual(retained.indexBytes);
  });

  it('reenumerates ignored reserved metadata added during preparation', async () => {
    const f = await fixture(); f.input.portableEntries = portable(); await writeFile(join(f.a, '.git/info/exclude'), '.open-design/\n');
    let reads = 0;
    f.coordination.readBasis = async () => {
      if (++reads === 2) { await mkdir(join(f.a, '.open-design')); await writeFile(join(f.a, '.open-design/external.txt'), 'external'); }
      return f.readBasis();
    };
    await expect(prepareCheckpoint(f.input)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
    expect(await readFile(join(f.a, '.open-design/external.txt'), 'utf8')).toBe('external');
  });

  it('retains the old index if an external ref writer changes HEAD after our CAS', async () => {
    const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'candidate');
    const candidate = await prepareCheckpoint(f.input); const before = await readFile(join(f.a, '.git/index'));
    const setPhase = f.store.setPhase;
    vi.spyOn(f.store, 'setPhase').mockImplementation((id, phase, data) => {
      setPhase(id, phase, data);
      if (phase === 'index_published') execFileSync('git', ['update-ref', 'refs/heads/main', f.head!, candidate.commitOid!],
        { cwd: f.a, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), ...gitEnv, GIT_CONFIG_NOSYSTEM: '1' } });
    });
    await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: f.enqueue(), store: f.store })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(before);
    expect(await readFile(join(f.a, '.git/index.lock'))).toEqual(await readFile(candidate.privateIndexPath));
  });
});
