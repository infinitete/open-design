import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, rename, unlink as fsUnlink } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectGitOperation } from '@open-design/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverProjectOperations } from '../../../src/services/project-git/recovery.js';
import { materializeProject } from '../../../src/services/project-git/materialize.js';
import { createCrashFixture, openCrashFixture, fixtureCommit } from '../../helpers/project-git-crash-worker.js';

const fixtures: Awaited<ReturnType<typeof createCrashFixture>>[] = [];
const reopened: Awaited<ReturnType<typeof openCrashFixture>>[] = [];
const children: ChildProcess[] = [];
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
afterEach(async () => { vi.restoreAllMocks(); for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  for (const f of reopened.splice(0)) if (f.db.open) f.db.close();
  for (const f of fixtures.splice(0)) { if (f.db.open) f.db.close(); await f.close(); } });
async function crash(phase: string, kill = false) {
  const f = await createCrashFixture(); fixtures.push(f); f.db.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../helpers/project-git-crash-worker.ts', import.meta.url)), f.root, phase, kill ? 'kill' : 'exit'],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code, signal] = await once(child, 'exit');
  expect(stderr).toBe(''); expect(code).toBe(kill ? null : 73); expect(signal).toBe(kill ? 'SIGKILL' : null);
  const restarted = await openCrashFixture(f.root); reopened.push(restarted);
  return { f, restarted };
}

it('recovers the exact multi-hop fast-forward OID after a real process exits between ref and index publication', async () => {
  const f = await createCrashFixture(); fixtures.push(f);
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'descendant.index'), f.target, [f.input.candidateOid]);
  await writeFile(join(f.root, 'fixture.json'), JSON.stringify({ ...f.description, candidateOid, publicationMode: 'fast_forward' }));
  f.db.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../helpers/project-git-crash-worker.ts', import.meta.url)), f.root, 'after_ref_update', 'exit'],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child); let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
  expect(await once(child, 'exit')).toEqual([73, null]); expect(stderr).toBe('');
  const restarted = await openCrashFixture(f.root); reopened.push(restarted);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(candidateOid);
  await recoverProjectOperations(restarted.recoveryInput); await recoverProjectOperations(restarted.recoveryInput);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(candidateOid);
  expect(await f.git(f.a, 'diff', '--cached', '--name-only')).toBe('');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(1);
  expect(restarted.store.getJournal(f.input.operationId)!.protection).toBeNull();
});

it.each(['mode', 'ancestry', 'protection'] as const)('rejects forged fast-forward %s evidence on restart', async forged => {
  const f = await createCrashFixture(); fixtures.push(f);
  const unrelated = await fixtureCommit(f.a, join(f.root, 'unrelated.index'), f.target, []);
  await expect(materializeProject({ ...f.input, publicationMode: 'fast_forward', candidateOid: unrelated })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
  await expect(materializeProject({ ...f.input, publicationMode: 'fast_forward', afterDurablePhase: async phase => { if (phase === 'prepared') throw new Error('retained'); } })).rejects.toThrow('retained');
  const journal = f.store.getJournal(f.input.operationId)!;
  const path = join(journal.recoveryData!.operationRoot, 'materialization.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  if (forged === 'mode') evidence.publicationMode = 'commit';
  if (forged === 'ancestry') {
    evidence.candidateOid = unrelated;
    f.db.prepare('UPDATE project_git_operations SET recovery_json = ? WHERE id = ?').run(JSON.stringify({ ...journal.recoveryData,
      candidateOid: unrelated, publishHead: unrelated, publicationParents: [] }), journal.id);
  }
  if (forged === 'protection') evidence.protectionRequired = true;
  await writeFile(path, JSON.stringify(evidence));
  await expect(recoverProjectOperations(f.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  await expect(f.gate.read(async () => 'unsafe', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});

async function runCrashCase(phase: string): Promise<{ operation: ProjectGitOperation; fileBytes: Uint8Array; portableBytes: Uint8Array; databaseImportCount: number }> {
  const { f, restarted } = await crash(phase, phase === 'after_ref_update');
  if (phase === 'inside_records_transaction') {
    expect(restarted.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'Before' });
    expect(restarted.db.prepare('SELECT count(*) AS n FROM fixture_imports').get()).toEqual({ n: 0 });
    expect(restarted.store.getBinding('project')!.projectRevision).toBe(0);
    expect(restarted.store.getJournal(f.input.operationId)!.recordsTransition).toBeNull();
  }
  if (phase === 'after_records_commit') {
    expect(restarted.store.getBinding('project')!.projectRevision).toBe(1);
    expect(restarted.store.getJournal(f.input.operationId)!.recordsTransition?.importMarker).toMatch(/^[a-f0-9]{64}$/u);
  }
  if (phase === 'after_ref_update') {
    expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.input.candidateOid);
    const journal = restarted.store.getJournal(f.input.operationId)!;
    expect(journal).toMatchObject({ journalPhase: 'ref_published', phaseCompleted: false });
    expect(await readFile(join(f.a, '.git/index'))).toEqual(await readFile(journal.recoveryData!.index.backupPath!));
  }
  await recoverProjectOperations(restarted.recoveryInput);
  await recoverProjectOperations(restarted.recoveryInput);
  expect(await f.git(f.a, 'diff', '--cached', '--name-only')).toBe('');
  expect(await f.git(f.a, 'rev-list', '--count', `${f.head}..HEAD`)).toBe('1');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(1);
  expect(restarted.db.prepare('SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ?').get('project')).toEqual({ n: 1 });
  expect(restarted.db.prepare("SELECT count(*) AS n FROM project_git_id_map WHERE kind = 'message'").get()).toEqual({ n: 1 });
  return { operation: restarted.store.getOperation(f.input.operationId)!, fileBytes: await readFile(join(f.a, 'index.html')),
    portableBytes: await readFile(join(f.a, '.open-design/project.json')),
    databaseImportCount: (restarted.db.prepare('SELECT count(*) AS n FROM fixture_imports').get() as { n: number }).n };
}

it.each(['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete',
  'file_applied', 'before_records_commit', 'inside_records_transaction', 'after_records_commit',
  'before_ref_update', 'after_ref_update', 'before_index_rename', 'after_index_rename', 'before_file_rename',
  'after_file_rename_before_sync', 'after_index_rename_before_sync'])('reopens and converges an actual child crash at %s', async phase => {
  const result = await runCrashCase(phase);
  expect(result.operation.status).toBe('succeeded');
  expect(result.fileBytes).toEqual(Buffer.from('after\n'));
  expect(result.portableBytes).toEqual(Buffer.from('{"contentRefs":[],"createdAt":1,"kind":"prototype","linkedFolderRequirements":[],"name":"After","preferences":{},"schemaVersion":1}\n'));
  expect(result.databaseImportCount).toBe(1);
});

it('flushes already-written checkpoint bytes and parent before completing an interrupted files intent', async () => {
  const { f, restarted } = await crash('checkpoint:prepared'); const originalOpen = fs.open;
  const checkpointId = await readFile(join(f.root, 'checkpoint-operation'), 'utf8');
  const path = join(f.a, '.open-design/project.json'); let fail = true; const events: string[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path || args[0] === join(f.a, '.open-design')) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        if (args[0] === path && fail) throw new Error('fixture checkpoint file flush failed');
        await sync(); events.push(args[0] === path ? 'file-synced' : 'directory-synced');
      });
    }
    return handle;
  });
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(JSON.parse(await readFile(path, 'utf8')).name).toBe('Checkpoint');
  expect(restarted.store.getJournal(checkpointId)).toMatchObject({ journalPhase: 'files_applied', phaseCompleted: false });
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(restarted.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  fail = false; events.length = 0;
  const completePhase = restarted.store.completePhase.bind(restarted.store);
  vi.spyOn(restarted.store, 'completePhase').mockImplementation((...args) => {
    if (args[0] === checkpointId && args[1] === 'files_applied') {
      expect(events.indexOf('file-synced')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('directory-synced')).toBeGreaterThan(events.indexOf('file-synced'));
    }
    return completePhase(...args);
  });
  await recoverProjectOperations(restarted.recoveryInput);
  expect(restarted.store.getJournal(checkpointId)!.status).toBe('succeeded');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(0);
});

it('rejects a target-matching external edit before any files intent', async () => {
  const { f, restarted } = await crash('prepared');
  await writeFile(join(f.a, 'index.html'), 'after\n');
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(0);
});

it('does not let a fresh automatic attempt bypass the original durable journal after restart', async () => {
  const { f, restarted } = await crash('prepared');
  const original = restarted.store.getJournal(f.input.operationId)!;
  const fresh = restarted.store.enqueueOperation({ projectId: 'project', actorId: 'local', kind: 'restore', basis: original.basis,
    idempotencyKey: 'fresh-auto-attempt', requestDigest: 'fresh-capture', payload: {} });
  const index = await readFile(join(f.a, '.git/index'));
  await expect(materializeProject({ ...restarted.input, operationId: fresh.id })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(restarted.store.getJournal(fresh.id)!.recoveryData).toBeNull();
  expect(restarted.store.getJournal(original.id)!.recoveryData).toEqual(original.recoveryData);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
  expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(0);
  await recoverProjectOperations(restarted.recoveryInput);
  expect(restarted.store.getOperation(original.id)!.status).toBe('succeeded');
  expect(restarted.store.getOperation(fresh.id)!.status).toBe('queued');
});

it('preserves conflicting external bytes and keeps reads closed after restart', async () => {
  const { f, restarted } = await crash('prepared');
  await writeFile(join(f.a, 'index.html'), 'external edit');
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('external edit');
  await expect(restarted.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  expect(restarted.store.getOperation(f.input.operationId)!.error?.code).toBe('RECOVERY_REQUIRED');
});

it.each(['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete',
  'after_ref_published', 'after_index_published'])('recovers original checkpoint portable writeback after child exit at %s', async phase => {
  const { f, restarted } = await crash(`checkpoint:${phase}`);
  const operationId = await readFile(join(f.root, 'checkpoint-operation'), 'utf8');
  const original = restarted.store.getJournal(operationId)!;
  await recoverProjectOperations(restarted.recoveryInput);
  expect(restarted.store.getJournal(operationId)!.status).toBe('succeeded');
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(original.recoveryData!.candidateOid);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('checkpoint user work\n');
  expect(JSON.parse(await readFile(join(f.a, '.open-design/project.json'), 'utf8')).name).toBe('Checkpoint');
  expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(0);
});

it.each(['index_lock_acquired', 'index_lock_receipted'])('requires durable lock ownership after child exit at %s', async phase => {
  const { f, restarted } = await crash(phase);
  const lock = await readFile(join(f.a, '.git/index.lock'));
  if (phase === 'index_lock_acquired') {
    await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(join(f.a, '.git/index.lock'))).toEqual(lock);
  } else {
    await recoverProjectOperations(restarted.recoveryInput);
    expect(restarted.store.getJournal(f.input.operationId)!.status).toBe('succeeded');
  }
});

it.each(['external-head', 'external-index', 'replacement-lock', 'malformed-receipt', 'corrupt-backup'])('preserves retained materials for %s after a real child crash', async fault => {
  const { f, restarted } = await crash('before_ref_update');
  const data = restarted.store.getJournal(f.input.operationId)!.recoveryData!;
  const candidate = await readFile(join(data.operationRoot, 'candidate.index'));
  if (fault === 'external-head') await f.git(f.a, 'update-ref', 'refs/heads/main', f.input.candidateOid);
  if (fault === 'external-index') await writeFile(join(f.a, '.git/index'), 'foreign-index');
  if (fault === 'replacement-lock') { await rename(join(f.a, '.git/index.lock'), join(f.a, '.git/retained-lock')); await writeFile(join(f.a, '.git/index.lock'), 'foreign-lock'); }
  if (fault === 'malformed-receipt') await writeFile(join(data.operationRoot, 'index-lock.json'), 'false');
  if (fault === 'corrupt-backup') await writeFile(data.index.backupPath!, 'corrupt');
  if (fault === 'external-head') {
    // Exact candidate HEAD is recoverable; a third external commit is not.
    await f.git(f.a, 'update-ref', 'refs/heads/main', f.head);
    const external = await f.git(f.a, 'commit-tree', `${f.head}^{tree}`, '-p', f.head, '-m', 'external');
    await f.git(f.a, 'update-ref', 'refs/heads/main', external);
  }
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(join(data.operationRoot, 'candidate.index'))).toEqual(candidate);
  expect(restarted.store.getJournal(f.input.operationId)!.status).toBe('waiting');
});

it('rejects malformed falsy checkpoint receipt even after index rename removed the lock', async () => {
  const { f, restarted } = await crash('checkpoint:after_index_published');
  const id = await readFile(join(f.root, 'checkpoint-operation'), 'utf8'); const data = restarted.store.getJournal(id)!.recoveryData!;
  await writeFile(join(data.operationRoot, 'index-lock.json'), 'false');
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(join(data.operationRoot, 'index-lock.json'), 'utf8')).toBe('false');
});

it('leaves unrelated phase-null actions for their dispatcher without resolving imported projects', async () => {
  const f = await createCrashFixture(); fixtures.push(f);
  f.store.enqueueOperation({ projectId: null, actorId: 'local', kind: 'open', idempotencyKey: 'future-import', requestDigest: 'future-import', payload: {} });
  await recoverProjectOperations({ ...f.recoveryInput, resolveProject: () => { throw new Error('must not resolve phase-null projects'); } });
  expect(f.store.getOperation(f.input.operationId)!.status).toBe('queued');
});

it.each(['mode', 'oldMode', 'protectionRequired'])('rejects tampered %s evidence before applying retained bytes', async field => {
  const { f, restarted } = await crash('dirty:prepared');
  const data = restarted.store.getJournal(f.input.operationId)!.recoveryData!;
  const path = join(data.operationRoot, 'materialization.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  if (field === 'protectionRequired') evidence.protectionRequired = false;
  else evidence.paths.find((item: { path: string }) => item.path === 'index.html')[field] = '100755';
  await writeFile(path, JSON.stringify(evidence));
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('protected user bytes\n');
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
});

it.each(['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete'])('converges owned protection after an actual outer %s crash', async phase => {
  const { f, restarted } = await crash(`dirty:${phase}`);
  await recoverProjectOperations(restarted.recoveryInput);
  const journal = restarted.store.getJournal(f.input.operationId)!;
  expect(journal.status).toBe('succeeded'); expect(journal.protection?.completed).toBe(true);
  expect(journal.basis).toEqual(f.input.basis);
  expect(await f.git(f.a, 'show', `${journal.protection!.checkpointOid}:index.html`)).toBe('protected user bytes');
  expect(await f.git(f.a, 'rev-list', '--count', `${journal.protection!.checkpointOid}..HEAD`)).toBe('1');
  expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(1);
});

it.each(['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete'])('resumes the original owned protection child after its %s process exit', async phase => {
  const { f, restarted } = await crash(`protection:${phase}`);
  const child = restarted.store.listRecoverable().find(op => op.ownerOperationId === f.input.operationId)
    ?? restarted.store.getJournal(restarted.store.getJournal(f.input.operationId)!.protection!.checkpointOperationId)!;
  const childOid = child.recoveryData!.candidateOid;
  await recoverProjectOperations(restarted.recoveryInput);
  const outer = restarted.store.getJournal(f.input.operationId)!;
  expect(outer.status).toBe('succeeded'); expect(outer.protection!.checkpointOid).toBe(childOid);
  expect(await f.git(f.a, 'show', `${childOid}:index.html`)).toBe('protected user bytes');
  expect(await f.git(f.a, 'rev-list', '--count', `${childOid}..HEAD`)).toBe('1');
  expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
  expect(restarted.store.getBinding('project')!.projectRevision).toBe(1);
});

it('quarantines an owned child that exited before prepared evidence without minting a replacement', async () => {
  const { f, restarted } = await crash('protection:enqueued');
  const ids = restarted.store.listRecoverable().map(op => op.id);
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(restarted.store.listRecoverable().map(op => op.id)).toEqual(ids);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  await expect(restarted.gate.read(async () => 'unsafe', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});

it.each(['missing-receipt', 'foreign-inode', 'torn-bytes'])('preserves uncertain staged files with %s after actual exit before rename', async fault => {
  const { f, restarted } = await crash('before_file_rename'); const data = restarted.store.getJournal(f.input.operationId)!.recoveryData!;
  const evidence = JSON.parse(await readFile(join(data.operationRoot, 'materialization.json'), 'utf8'));
  const item = evidence.paths.find((item: { candidateDigest: string | null }) => item.candidateDigest !== null);
  const staged = await readFile(item.temporaryPath);
  if (fault === 'missing-receipt') await fsUnlink(item.temporaryReceiptPath);
  if (fault === 'foreign-inode') { await rename(item.temporaryPath, item.temporaryPath + '-retained'); await writeFile(item.temporaryPath, staged); }
  if (fault === 'torn-bytes') await writeFile(item.temporaryPath, staged.subarray(0, 3));
  const current = await readFile(item.temporaryPath);
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(item.temporaryPath)).toEqual(current);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('rejects an orphan prepared checkpoint child instead of claiming startup recovery succeeded', async () => {
  const { f, restarted } = await crash('checkpoint:prepared');
  const childId = await readFile(join(f.root, 'checkpoint-operation'), 'utf8');
  restarted.db.prepare('UPDATE project_git_operations SET owner_operation_id = ? WHERE id = ?').run('missing-owner', childId);
  await expect(recoverProjectOperations(restarted.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(restarted.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});

it.each(['standalone', 'linked-child'] as const)('rejects valid %s checkpoint artifacts outside the injected parent before consuming them', async kind => {
  const { f, restarted } = await crash(kind === 'standalone' ? 'checkpoint:prepared' : 'protection:complete');
  const checkpointId = kind === 'standalone' ? await readFile(join(f.root, 'checkpoint-operation'), 'utf8')
    : restarted.store.getJournal(f.input.operationId)!.protection!.checkpointOperationId;
  const checkpoint = restarted.store.getJournal(checkpointId)!;
  const wrongParent = join(f.root, 'wrong-artifact-parent'); await fs.mkdir(wrongParent);
  let artifactRoot = checkpoint.recoveryData!.operationRoot;
  if (kind === 'linked-child') {
    const moved = join(wrongParent, 'retained-child'); await rename(artifactRoot, moved);
    const remap = (value: unknown) => JSON.parse(JSON.stringify(value).split(artifactRoot).join(moved));
    const evidencePath = join(moved, 'checkpoint.json');
    await writeFile(evidencePath, JSON.stringify(remap(JSON.parse(await readFile(evidencePath, 'utf8')))));
    restarted.db.prepare('UPDATE project_git_operations SET recovery_json = ? WHERE id = ?').run(JSON.stringify(remap(checkpoint.recoveryData)), checkpointId);
    artifactRoot = moved;
  }
  const { readCheckpointPublication } = await import('../../../src/services/project-git/checkpoint.js');
  await expect(readCheckpointPublication({ root: f.a, operationId: checkpointId, store: restarted.store })).resolves.toBeDefined();
  const artifacts = await fs.readdir(artifactRoot); const bytes = await Promise.all(artifacts.map(path => readFile(join(artifactRoot, path))));
  const originalIndex = await readFile(join(f.a, '.git/index')); const head = await f.git(f.a, 'rev-parse', 'HEAD');
  const portable = await readFile(join(f.a, '.open-design/project.json')); const binding = restarted.store.getBinding('project');
  const beforeCheckpoint = restarted.store.getJournal(checkpointId)!.recoveryData;
  const protection = restarted.store.getJournal(f.input.operationId)!.protection;
  let artifactOpened = false; const originalOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(artifactRoot + '/')) artifactOpened = true;
    return originalOpen(...args);
  });
  await expect(recoverProjectOperations({ ...restarted.recoveryInput,
    operationRoot: kind === 'standalone' ? wrongParent : restarted.recoveryInput.operationRoot })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(artifactOpened).toBe(false);
  expect(await fs.readdir(artifactRoot)).toEqual(artifacts);
  expect(await Promise.all(artifacts.map(path => readFile(join(artifactRoot, path))))).toEqual(bytes);
  expect(await readFile(join(f.a, '.git/index'))).toEqual(originalIndex); expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(f.a, '.open-design/project.json'))).toEqual(portable);
  expect(restarted.store.getBinding('project')).toEqual(binding);
  expect(restarted.store.getJournal(checkpointId)!.recoveryData).toEqual(beforeCheckpoint);
  expect(restarted.store.getJournal(f.input.operationId)!.protection).toEqual(protection);
  await expect(restarted.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});
