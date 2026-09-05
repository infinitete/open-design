import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCrashFixture, fixtureCommit, fixtureGitEnv, openCrashFixture, portableSnapshot } from '../../helpers/project-git-crash-worker.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { materializeProject } from '../../../src/services/project-git/materialize.js';
import { createProjectGitRestoreService } from '../../../src/services/project-git/restore.js';
import { recoverProjectOperations } from '../../../src/services/project-git/recovery.js';
import { createProjectFileVersion, readLegacyProjectFile } from '../../../src/project-file-versions.js';

const fixtures: Awaited<ReturnType<typeof createCrashFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { if (f.db.open) f.db.close(); await f.close(); } });
const request = () => ({ actorId: 'local', idempotencyKey: randomUUID(), expectedProjectRevision: 2 });
async function fixture() {
  const f = await createCrashFixture(); fixtures.push(f);
  const v2 = await materializeProject(f.input);
  const snapshot = portableSnapshot('V3'); const entries = serializePortableMetadata(snapshot);
  entries.set('index.html', Buffer.from('V3')); entries.set('.gitignore', Buffer.from('ignored.txt\n'));
  const basis = await f.input.readBasis();
  const v3 = await fixtureCommit(f.a, join(f.root, 'v3.index'), entries, [v2]);
  const operationId = f.store.enqueueOperation({ projectId: 'project', kind: 'sync', ...request(), basis, requestDigest: randomUUID(), payload: {} }).id;
  const { captureFixturePreview } = await import('../../helpers/project-git-crash-worker.js');
  await materializeProject({ ...f.input, basis, operationId, candidateOid: v3, snapshot, previewContentDigest: await captureFixturePreview(f.input) });
  const input = { db: f.db, store: f.store, operationRoot: f.input.operationDir, now: () => 1000,
    requireProject: (actor: string, id: string) => { if (actor !== 'local' || id !== 'project') throw new Error('not authorized'); },
    resolveProject: () => ({ root: f.a, branch: 'main', gate: f.gate, gitEnv: fixtureGitEnv }), recoveryReady: Promise.resolve() };
  return { ...f, v2, v3, serviceInput: input, service: createProjectGitRestoreService(input) };
}

it.each([false, true])('restores V1 as a child of protected V3 and preserves attached ancestry (dirty=%s)', async dirty => {
  const f = await fixture();
  if (dirty) await writeFile(join(f.a, 'index.html'), 'unsaved V3');
  const preview = await f.service.previewRestore('project', f.head, request());
  const accepted = await f.service.restoreProject('project', preview.id, request());
  const op = f.store.getJournal(accepted.operationId)!; const oid = op.result!.head!;
  const parent = dirty ? op.protection!.checkpointOid : f.v3;
  expect(await f.git(f.a, 'rev-list', '--parents', '--max-count=1', oid)).toBe(`${oid} ${parent}`);
  expect(await f.git(f.a, 'merge-base', '--is-ancestor', f.v3, oid)).toBe('');
  expect(await f.git(f.a, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(await f.git(f.a, 'rev-parse', `${oid}^{tree}`)).toBe(await f.git(f.a, 'rev-parse', `${f.head}^{tree}`));
  expect(await f.git(f.a, 'show', '-s', '--format=%B', oid)).toContain(`restoreTarget: ${f.head}`);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'Before' });
  expect(f.store.getBinding('project')).toMatchObject({ cloneId: 'clone', repositoryProjectId: 'repository', projectRevision: 3 });
  if (dirty) expect(await f.git(f.a, 'show', `${parent}:index.html`)).toBe('unsaved V3');
});

it('rejects expired, edited, remote-changed, unauthorized and reused previews before protection', async () => {
  const f = await fixture(); const preview = await f.service.previewRestore('project', f.head, request());
  const expired = createProjectGitRestoreService({ ...f.serviceInput, now: () => preview.expiresAt });
  await expect(expired.restoreProject('project', preview.id, request())).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  await expect(f.service.restoreProject('project', preview.id, { ...request(), actorId: 'other' })).rejects.toThrow('not authorized');
  await writeFile(join(f.a, 'index.html'), 'after preview');
  await expect(f.service.restoreProject('project', preview.id, request())).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.v3);
  await writeFile(join(f.a, 'index.html'), 'V3');
  f.store.observeRemote('project', preview.basis.bindingGeneration, f.v2);
  await expect(f.service.restoreProject('project', preview.id, request())).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  const fresh = await f.service.previewRestore('project', f.head, request()); const ctx = request();
  const accepted = await f.service.restoreProject('project', fresh.id, ctx);
  expect(await f.service.restoreProject('project', fresh.id, ctx)).toEqual(accepted);
  const release = await f.gate.beginRun();
  try { expect(await f.service.restoreProject('project', fresh.id, ctx)).toEqual(accepted); }
  finally { release(); }
  const conflict = f.store.enqueueOperation({ projectId: 'project', kind: 'sync', ...request(), basis: await f.input.readBasis(), requestDigest: randomUUID(), payload: {} });
  f.store.updateOperation(conflict.id, { status: 'waiting', phase: 'conflict', result: null, error: { code: 'CONFLICT', message: 'new conflict' } });
  expect(await f.service.restoreProject('project', fresh.id, ctx)).toEqual(accepted);
  await expect(f.service.restoreProject('project', 'different-preview', ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(f.service.restoreProject('project', fresh.id, request())).rejects.toBeDefined();
});

it('keeps failed restore quarantined and recovers with the durable original operation', async () => {
  const f = await fixture(); await writeFile(join(f.a, 'index.html'), 'dirty protected');
  const service = createProjectGitRestoreService({ ...f.serviceInput, afterEffect: async (point: string) => { if (point === 'file_applied') throw new Error('crash'); } });
  const preview = await service.previewRestore('project', f.head, request());
  await expect(service.restoreProject('project', preview.id, request())).rejects.toThrow('crash');
  await expect(f.gate.read(async () => 'mixed', 1)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await recoverProjectOperations(f.recoveryInput);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
  expect(await f.git(f.a, 'show', '-s', '--format=%B', 'HEAD')).toContain(`restoreTarget: ${f.head}`);
  expect(f.store.getBinding('project')!.projectRevision).toBe(3);
});

it('restores a plain commit as ordinary files while retaining current settings and chat attachments', async () => {
  const f = await createCrashFixture(); fixtures.push(f);
  const plain = await fixtureCommit(f.a, join(f.root, 'plain.index'), new Map([['index.html', Buffer.from('old plain file')]]), []);
  const snapshot = portableSnapshot('After'); const bytes = Buffer.from('chat attachment');
  const { sha256 } = await import('../../../src/services/project-git/recovery.js'); const digest = sha256(bytes);
  const resourcePath = `.open-design/resources/${digest}/content`;
  snapshot.manifest.resources.push({ digest, locations: [{ path: resourcePath, purpose: 'attachment' }], references: ['message'] });
  snapshot.messages[0]!.resourceRefs.push(digest);
  snapshot.messages[0]!.context.attachments = [{ resourceRef: digest, name: 'attachment.txt', kind: 'file' }];
  const target = serializePortableMetadata(snapshot); target.set(resourcePath, bytes); target.set('index.html', Buffer.from('current'));
  const head = await fixtureCommit(f.a, join(f.root, 'with-plain.index'), target, [f.head, plain]);
  await materializeProject({ ...f.input, candidateOid: head, snapshot });
  f.db.prepare('UPDATE conversations SET intent_signals_json = ?').run('{"localOnly":true}');
  const conversation = (f.db.prepare('SELECT id FROM conversations').get() as { id: string }).id;
  f.db.prepare('INSERT INTO agent_sessions (conversation_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)').run(conversation, 'agent', 'local-session', 123);
  const service = createProjectGitRestoreService({ db: f.db, store: f.store, operationRoot: f.input.operationDir, now: () => 1000,
    requireProject: () => {}, resolveProject: () => ({ root: f.a, branch: 'main', gate: f.gate, gitEnv: fixtureGitEnv }), recoveryReady: Promise.resolve() });
  const ctx = { ...request(), expectedProjectRevision: 1 };
  const beforeMessages = f.db.prepare('SELECT id, content, attachments_json FROM messages').all();
  const beforeConversations = f.db.prepare('SELECT * FROM conversations').all();
  const beforeSessions = f.db.prepare('SELECT * FROM agent_sessions').all();
  const preview = await service.previewRestore('project', plain, ctx);
  expect(preview.changes.historyMode).toBe('files_only');
  await service.restoreProject('project', preview.id, ctx);
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('old plain file');
  expect(await readFile(join(f.a, resourcePath))).toEqual(bytes);
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'After' });
  expect(f.db.prepare('SELECT id, content, attachments_json FROM messages').all()).toEqual(beforeMessages);
  expect(f.db.prepare('SELECT * FROM conversations').all()).toEqual(beforeConversations);
  expect(f.db.prepare('SELECT * FROM agent_sessions').all()).toEqual(beforeSessions);
});

it('managed legacy single-file restore preserves other dirty files, records and original native history', async () => {
  const f = await fixture(); const old = await createProjectFileVersion(f.root, 'a', 'index.html', '<html>legacy</html>');
  const native = await f.git(f.a, 'ls-files', '--others', '--exclude-standard');
  expect(native).toContain('.file-versions/');
  await writeFile(join(f.a, 'other.txt'), 'keep dirty other');
  const records = f.db.prepare('SELECT * FROM projects').all();
  const preview = await f.service.previewFileRestore('project', 'index.html', { source: 'legacy', path: 'index.html', legacyId: old.id }, request());
  await f.service.restoreProject('project', preview.id, request());
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('<html>legacy</html>');
  expect(await readFile(join(f.a, 'other.txt'), 'utf8')).toBe('keep dirty other');
  expect((await readLegacyProjectFile(f.a, 'index.html', old.id)).content).toBe('<html>legacy</html>');
  expect(f.db.prepare('SELECT name, metadata_json FROM projects').all()).toEqual(records.map(row => ({ name: (row as { name: string }).name, metadata_json: (row as { metadata_json: string }).metadata_json })));
  const op = f.store.listPendingOperations().filter(op => op.kind === 'restore'); expect(op).toHaveLength(0);
});

it('blocks active runs and durable conflicts without canceling the run', async () => {
  const f = await fixture(); const release = await f.gate.beginRun();
  await expect(f.service.previewRestore('project', f.head, request())).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  expect(f.gate.activeRuns()).toBe(1); release();
  const basis = await f.input.readBasis();
  const op = f.store.enqueueOperation({ projectId: 'project', kind: 'sync', ...request(), basis, requestDigest: randomUUID(), payload: {} });
  f.store.updateOperation(op.id, { status: 'waiting', phase: 'conflict', result: null, error: { code: 'CONFLICT', message: 'fixture conflict' } });
  await expect(f.service.previewRestore('project', f.head, request())).rejects.toMatchObject({ code: 'GIT_CONFLICT' });
});

it('pairs restore previews durably and rejects every other kind or consumer reuse', async () => {
  const f = await fixture(); const preview = await f.service.previewRestore('project', f.head, request());
  const consumer = f.store.enqueueOperation({ projectId: 'project', kind: 'restore', ...request(), basis: preview.basis, requestDigest: randomUUID(), payload: {} });
  f.store.consumePreview(preview.id, consumer.id); expect(() => f.store.consumePreview(preview.id, consumer.id)).not.toThrow();
  const other = f.store.enqueueOperation({ projectId: 'project', kind: 'restore', ...request(), basis: preview.basis, requestDigest: randomUUID(), payload: {} });
  expect(() => f.store.consumePreview(preview.id, other.id)).toThrow();
  const second = await f.service.previewRestore('project', f.head, request());
  expect(() => f.store.consumePreview(second.id, consumer.id)).toThrow();
  const wrongKind = f.store.enqueueOperation({ projectId: 'project', kind: 'enable', ...request(), basis: preview.basis, requestDigest: randomUUID(), payload: {} });
  expect(() => f.store.consumePreview(second.id, wrongKind.id)).toThrow();
});

it('reopens the database and resumes a single-file restore without rewriting native rows or advancing twice', async () => {
  const f = await fixture(); const old = await createProjectFileVersion(f.root, 'a', 'index.html', 'legacy single file');
  f.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(98765, 'project');
  const before = f.db.prepare('SELECT * FROM projects').all();
  const service = createProjectGitRestoreService({ ...f.serviceInput, afterEffect: async point => { if (point === 'after_records_commit') throw new Error('stop after records'); } });
  const preview = await service.previewFileRestore('project', 'index.html', { source: 'legacy', path: 'index.html', legacyId: old.id }, request());
  const ctx = request();
  await expect(service.restoreProject('project', preview.id, ctx)).rejects.toThrow('stop after records');
  f.db.close(); const reopened = await openCrashFixture(f.root);
  try {
    await recoverProjectOperations(reopened.recoveryInput);
    expect(reopened.db.prepare('SELECT * FROM projects').all()).toEqual(before);
    expect(reopened.store.getBinding('project')).toMatchObject({ projectRevision: 3, contentRevision: 0, exportedContentRevision: 0, dirty: false });
    const restored = reopened.store.findOperation({ projectId: 'project', kind: 'restore', ...ctx })!;
    expect(restored).toMatchObject({ status: 'succeeded', journalPhase: 'complete', recoveryData: { records: { mode: 'preserve' } } });
    await recoverProjectOperations(reopened.recoveryInput);
    expect(reopened.store.getBinding('project')!.projectRevision).toBe(3);
    expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('legacy single file');
  } finally { reopened.db.close(); }
});

it('uses the established empty portable commit as once-only legacy archive completion evidence', async () => {
  const f = await fixture(); const old = await createProjectFileVersion(f.root, 'a', 'index.html', 'native after enable');
  const { exportPortableProject } = await import('../../../src/services/project-git/portable.js');
  const exported = await exportPortableProject({ db: f.db, store: f.store, projectId: 'project', repositoryProjectId: 'repository', cloneId: 'clone', root: f.a });
  expect(exported.snapshot.manifest.resources).toEqual([]);
  expect([...exported.entries.keys()].some(path => path.startsWith('.open-design/legacy-file-history/'))).toBe(false);
  expect((await readLegacyProjectFile(f.a, 'index.html', old.id)).content).toBe('native after enable');
});

it('distinguishes a Git file history identity from a legacy string even when that string is a valid OID', async () => {
  const f = await fixture();
  await expect(f.service.previewFileRestore('project', '.FILE-VERSIONS/old.html', { source: 'git', oid: f.head }, request())).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(f.service.previewFileRestore('project', 'index.html', { source: 'legacy', path: 'index.html', legacyId: f.head }, request())).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(join(f.a, 'keep.txt'), 'keep current file');
  const preview = await f.service.previewFileRestore('project', 'index.html', { source: 'git', oid: f.head }, request());
  expect(preview.targetOid).toBe(f.head); expect(preview.changes.historyMode).toBe('files_only');
  await f.service.restoreProject('project', preview.id, request());
  expect(await readFile(join(f.a, 'index.html'), 'utf8')).toBe('before\n');
  expect(await readFile(join(f.a, 'keep.txt'), 'utf8')).toBe('keep current file');
  expect(f.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')).toEqual({ name: 'V3' });
});
