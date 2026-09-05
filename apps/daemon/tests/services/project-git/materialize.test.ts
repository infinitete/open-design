import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeProject } from '../../../src/services/project-git/materialize.js';
import { recoverProjectOperations } from '../../../src/services/project-git/recovery.js';
import { captureFixturePreview, createCrashFixture, createUnbornCrashFixture, fixtureCommit, portableSnapshot } from '../../helpers/project-git-crash-worker.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { runGit } from '../../../src/services/project-git/git-process.js';
import { fixtureGitEnv } from '../../helpers/project-git-crash-worker.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));

const fixtures: (Awaited<ReturnType<typeof createCrashFixture>> | Awaited<ReturnType<typeof createUnbornCrashFixture>>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { if (f.db.open) f.db.close(); await f.close(); } });
async function fixture() { const f = await createCrashFixture(); fixtures.push(f); return f; }

it('fast-forwards a multi-hop descendant to the exact candidate without an integration commit', async () => {
  const f = await fixture();
  const descendant = await fixtureCommit(f.a, join(f.root, 'descendant.index'), f.target, [f.input.candidateOid]);
  await expect(materializeProject({ ...f.input, candidateOid: descendant, publicationMode: 'fast_forward' })).resolves.toBe(descendant);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(descendant);
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toMatchObject({ publicationMode: 'fast_forward', publicationParents: [f.input.candidateOid] });
  expect(f.store.getJournal(f.input.operationId)!.protection).toBeNull();
});

it('rejects dirty fast-forward capture before journal intent or protection', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'dirty before fast-forward\n');
  const previewContentDigest = await captureFixturePreview(f.input);
  await expect(materializeProject({ ...f.input, publicationMode: 'fast_forward', previewContentDigest })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('dirty before fast-forward\n');
});

it('materializes real files and portable records once in durable phase order', async () => {
  const f = await fixture(); const phases: string[] = [];
  const oid = await materializeProject({ ...f.input, afterDurablePhase: async phase => { phases.push(phase); } });
  expect(phases).toEqual(['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete']);
  expect(oid).toBe(f.input.candidateOid);
  for (const [path, bytes] of f.target) expect(await readFile(join(f.a, path))).toEqual(Buffer.from(bytes));
  await expect(readFile(join(f.a, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.a, 'ignored.txt'), 'utf8')).toBe('keep ignored');
  expect(f.store.getOperation(f.input.operationId)!.status).toBe('succeeded');
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
  expect(f.db.prepare('SELECT count(*) AS n FROM fixture_imports').get()).toEqual({ n: 1 });
  expect(await f.git(f.a, 'diff', '--cached', '--name-only')).toBe('');
  expect(await f.git(f.a, 'rev-list', '--count', `${f.head}..HEAD`)).toBe('1');
  expect(() => f.store.assertRevision('project', 0)).toThrowError();
});

it('keeps failed partial application quarantined and resumes the same operation', async () => {
  const f = await fixture();
  await expect(materializeProject({ ...f.input, afterEffect: async point => { if (point === 'file_applied') throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
  await expect(f.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await expect(f.gate.exclusive(async () => 'fresh')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await recoverProjectOperations(f.recoveryInput);
  await expect(f.gate.read(async () => readFile(join(f.a, 'index.html'), 'utf8'))).resolves.toBe('after\n');
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
});

it('releases a newly held barrier when prepared intent definitively did not commit', async () => {
  const f = await fixture();
  vi.spyOn(f.store, 'setPhase').mockImplementation(() => { throw new Error('fixture rejected intent'); });
  await expect(materializeProject(f.input)).rejects.toThrow('fixture rejected intent');
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
  await expect(f.gate.read(async () => 'original', 10)).resolves.toBe('original');
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('rejects stale basis and candidate snapshot disagreement before application', async () => {
  const f = await fixture();
  await expect(materializeProject({ ...f.input, basis: { ...f.input.basis, contentRevision: 5 } })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  await expect(materializeProject({ ...f.input, snapshot: { ...f.input.snapshot, project: { ...f.input.snapshot.project, name: 'wrong' } } })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  await expect(materializeProject({ ...f.input, previewContentDigest: 'invalid' })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('rejects same-revision external edits after the original preview without effects', async () => {
  const f = await fixture(); const index = await readFile(join(f.a, '.git/index'));
  await writeFile(join(f.a, 'index.html'), 'external after preview\n');
  await expect(materializeProject(f.input)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('external after preview\n');
  expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
  expect(f.store.getBinding('project')!.contentRevision).toBe(0);
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'Before' });
  expect(f.db.prepare('SELECT count(*) AS n FROM fixture_imports').get()).toEqual({ n: 0 });
});

it('rejects a noncanonical artifact parent before preparing retained materials', async () => {
  const f = await fixture(); await fs.mkdir(f.input.operationDir);
  await expect(materializeProject({ ...f.input, operationDir: f.input.operationDir + '/.' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
  expect(await fs.readdir(f.input.operationDir)).toEqual([]);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('protects uncommitted content with an owned checkpoint and changes only the local parent', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'unsaved user work\n');
  f.input.previewContentDigest = await captureFixturePreview(f.input);
  const oid = await materializeProject(f.input); const op = f.store.getJournal(f.input.operationId)!;
  expect(op.protection?.completed).toBe(true);
  expect(op.basis).toEqual(f.input.basis);
  const protectedOid = op.protection!.checkpointOid;
  expect(await f.git(f.a, 'show', `${protectedOid}:index.html`)).toBe('unsaved user work');
  expect(await f.git(f.a, 'rev-list', '--parents', '--max-count=1', oid)).toBe(`${oid} ${protectedOid}`);
  expect(await f.git(f.a, 'rev-parse', `${oid}^{tree}`)).toBe(await f.git(f.a, 'rev-parse', `${f.input.candidateOid}^{tree}`));
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
});

it('rejects symlink parent traversal without changing its outside target', async () => {
  const f = await fixture(); await symlink(f.b, join(f.a, 'nested'), 'dir');
  await expect(materializeProject(f.input)).rejects.toBeDefined();
  await expect(readFile(join(f.b, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('restores a target portable file even when only the owned protection changed it', async () => {
  const f = await fixture();
  f.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('Live database edit', 'project');
  f.input.previewContentDigest = await captureFixturePreview(f.input);
  const snapshot = portableSnapshot('Before'); const target = serializePortableMetadata(snapshot);
  target.set('index.html', Buffer.from('restore target\n')); target.set('.gitignore', Buffer.from('ignored.txt\n'));
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'second.index'), target, [f.head]);
  await materializeProject({ ...f.input, snapshot, candidateOid });
  expect(JSON.parse(await readFile(join(f.a, '.open-design/project.json'), 'utf8')).name).toBe('Before');
  expect(await f.git(f.a, 'status', '--porcelain')).toBe('');
});

it('fences an external normal-index change immediately before ref publication', async () => {
  const f = await fixture(); const external = Buffer.from('externally replaced index');
  await expect(materializeProject({ ...f.input, afterEffect: async point => {
    if (point === 'before_ref_update') await writeFile(join(f.a, '.git/index'), external);
  } })).rejects.toBeDefined();
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(join(f.a, '.git/index'))).toEqual(external);
});

it('rechecks files after the final pre-CAS boundary instead of publishing stale capture', async () => {
  const f = await fixture();
  await expect(materializeProject({ ...f.input, afterEffect: async point => {
    if (point === 'before_ref_update') await writeFile(join(f.a, 'index.html'), 'external late edit');
  } })).rejects.toBeDefined();
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('external late edit');
});

it.each(['before_ref_update', 'before_index_rename', 'after_index_rename'] as const)('fences unchanged captured target content at %s', async boundary => {
  const f = await fixture(); const originalIndex = await readFile(join(f.a, '.git/index'));
  await expect(materializeProject({ ...f.input, afterEffect: async point => {
    if (point === boundary) await writeFile(join(f.a, '.gitignore'), 'external late ignore edit\n');
  } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await readFile(join(f.a, '.gitignore'), 'utf8')).toBe('external late ignore edit\n');
  expect(f.store.getOperation(f.input.operationId)!.status).toBe('waiting');
  await expect(f.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  if (boundary === 'before_ref_update') expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head);
  if (boundary !== 'after_index_rename') expect(await readFile(join(f.a, '.git/index'))).toEqual(originalIndex);
});

it('reports missing LFS payloads before claiming a complete materialization', async () => {
  const f = await fixture(); const target = new Map(f.target);
  target.set('asset.bin', Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 42\n'));
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'lfs.index'), target, [f.head]);
  await expect(materializeProject({ ...f.input, candidateOid })).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it.each([false, true])('preserves an unborn original basis and prepends only its protection parent (remote parent=%s)', async remote => {
  const f = await createUnbornCrashFixture(); fixtures.push(f);
  const candidateOid = remote ? await fixtureCommit(f.a, join(f.root, 'remote-parent.index'), f.target, [f.input.candidateOid]) : f.input.candidateOid;
  const oid = await materializeProject({ ...f.input, candidateOid }); const op = f.store.getJournal(f.input.operationId)!;
  expect(op.basis.localHead).toBeNull(); expect(op.recoveryData!.baseHead).toBeNull();
  expect(await f.git(f.a, 'rev-list', '--parents', '--max-count=1', oid)).toBe([oid, op.protection!.checkpointOid, ...(remote ? [f.input.candidateOid] : [])].join(' '));
  expect(await f.git(f.a, 'show', `${op.protection!.checkpointOid}:index.html`)).toBe('before');
  expect(await f.git(f.a, 'diff', '--cached', '--name-only')).toBe('');
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
});

it.each(['120000', '160000'])('preflights actual Git %s entries without following linked content', async mode => {
  const f = await fixture(); const env = { ...fixtureGitEnv, GIT_INDEX_FILE: join(f.root, 'fixture.index') };
  const oid = mode === '160000' ? f.head : (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from('../outside') })).stdout.toString().trim();
  await runGit({ cwd: f.a, args: ['update-index', '--add', '--cacheinfo', mode, oid, 'linked'], env });
  const tree = (await runGit({ cwd: f.a, args: ['write-tree'], env })).stdout.toString().trim();
  const candidateOid = (await runGit({ cwd: f.a, args: ['commit-tree', tree, '-p', f.head], env, stdin: Buffer.from('linked fixture') })).stdout.toString().trim();
  await expect(materializeProject({ ...f.input, candidateOid })).rejects.toMatchObject({ code: 'PORTABLE_RESOURCE_MISSING' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('rejects a case-colliding actual tree before writing project files', async () => {
  const f = await fixture(); const target = new Map(f.target); target.set('INDEX.HTML', Buffer.from('collision'));
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'collision.index'), target, [f.head]);
  await expect(materializeProject({ ...f.input, candidateOid })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
});

it('flushes operation and file directory entries before claiming durable phases', async () => {
  const f = await fixture(); const synced = new Set<string>(); const original = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (typeof args[0] === 'string' && (await handle.stat()).isDirectory()) {
      const path = args[0]; const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.add(path); });
    }
    return handle;
  });
  await materializeProject({ ...f.input, afterDurablePhase: async phase => {
    if (phase === 'prepared') {
      const data = f.store.getJournal(f.input.operationId)!.recoveryData!;
      expect(synced.has(f.root)).toBe(true); expect(synced.has(f.input.operationDir)).toBe(true); expect(synced.has(data.operationRoot)).toBe(true);
    }
    if (phase === 'files_applied') { expect(synced.has(f.a)).toBe(true); expect(synced.has(join(f.a, 'nested'))).toBe(true); }
  } });
});

it('keeps the files intent and read quarantine after a real directory flush failure', async () => {
  const f = await fixture(); const original = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (args[0] === join(f.a, 'nested') && (await handle.stat()).isDirectory()) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('fixture directory flush failed'));
    return handle;
  });
  await expect(materializeProject(f.input)).rejects.toThrow('fixture directory flush failed');
  expect(f.store.getJournal(f.input.operationId)).toMatchObject({ journalPhase: 'files_applied', phaseCompleted: false });
  await expect(f.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  vi.restoreAllMocks(); await recoverProjectOperations(f.recoveryInput);
  expect(await readFile(join(f.a, 'nested/new.txt'), 'utf8')).toBe('new\n');
});

it.each(['file', 'index'] as const)('repairs a missing %s rename directory flush before completing recovery', async kind => {
  const f = await fixture(); const originalOpen = fs.open; const originalRename = fs.rename;
  const target = kind === 'file' ? join(f.a, 'nested/new.txt') : join(f.a, '.git/index');
  const directory = kind === 'file' ? join(f.a, 'nested') : join(f.a, '.git');
  let renamed = false; let fail = true; const events: string[] = [];
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await originalRename(from, to); if (to === target) renamed = true;
  });
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === directory && (await handle.stat()).isDirectory()) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        if (renamed && fail) throw new Error('fixture post-rename flush failed');
        await sync(); if (renamed) events.push('directory-synced');
      });
    }
    return handle;
  });
  await expect(materializeProject(f.input)).rejects.toThrow('fixture post-rename flush failed');
  expect(renamed).toBe(true);
  expect(f.store.getJournal(f.input.operationId)).toMatchObject({ journalPhase: kind === 'file' ? 'files_applied' : 'index_published', phaseCompleted: false });
  await expect(recoverProjectOperations(f.recoveryInput)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(f.gate.read(async () => 'mixed', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  expect(f.store.getBinding('project')!.projectRevision).toBe(kind === 'file' ? 0 : 1);
  fail = false;
  const completePhase = f.store.completePhase.bind(f.store);
  vi.spyOn(f.store, 'completePhase').mockImplementation((...args) => {
    if (args[1] === (kind === 'file' ? 'files_applied' : 'index_published')) {
      expect(events).toContain('directory-synced'); events.push('phase-complete');
    }
    return completePhase(...args);
  });
  await recoverProjectOperations(f.recoveryInput);
  expect(events.indexOf('directory-synced')).toBeLessThan(events.indexOf('phase-complete'));
  expect(f.store.getOperation(f.input.operationId)!.status).toBe('succeeded');
  expect(f.store.getBinding('project')!.projectRevision).toBe(1);
  await expect(f.gate.read(async () => 'converged', 10)).resolves.toBe('converged');
});

it.each(['.env', 'state.sqlite'])('rejects private candidate %s before materialization effects with path-only diagnostics', async path => {
  const f = await fixture(); const target = new Map(f.target); target.set(path, Buffer.from('inert fixture bytes'));
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'private.index'), target, [f.head]);
  const originalIndex = await readFile(join(f.a, '.git/index'));
  await expect(materializeProject({ ...f.input, candidateOid })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { paths: [path] } });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.head); expect(await readFile(join(f.a, '.git/index'))).toEqual(originalIndex);
  await expect(readFile(join(f.a, path))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'Before' });
  expect(f.store.getJournal(f.input.operationId)!.recoveryData).toBeNull();
});
