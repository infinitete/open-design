import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createGitFixture } from '../../helpers/project-git.js';
import { fixtureCommit, fixtureGitEnv, portableSnapshot, writeFixtureEntries } from '../../helpers/project-git-crash-worker.js';
import { runGit } from '../../../src/services/project-git/git-process.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { readHistory, readCommit, readCommitFile, readCommitConversations } from '../../../src/services/project-git/history.js';

const fixtures: Awaited<ReturnType<typeof createGitFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() { const f = await createGitFixture(); fixtures.push(f); return f; }

it('freezes pagination at the original start across concurrent new commits', async () => {
  const f = await fixture(); let head: string | null = null; const oids: string[] = [];
  for (let i = 0; i < 53; i++) {
    head = await fixtureCommit(f.a, join(f.root, 'history.index'), new Map([['index.html', Buffer.from(String(i))]]), head ? [head] : []);
    oids.unshift(head);
  }
  await f.git(f.a, 'update-ref', 'refs/heads/main', head!);
  const first = await readHistory(f.a, null);
  expect(first.commits.map(c => c.oid)).toEqual(oids.slice(0, 50));
  expect(first.nextCursor).not.toBeNull();
  const added = await fixtureCommit(f.a, join(f.root, 'history.index'), new Map([['new.txt', Buffer.from('new')]]), [head!]);
  await f.git(f.a, 'update-ref', 'refs/heads/main', added);
  const second = await readHistory(f.a, first.nextCursor);
  expect(second.commits.map(c => c.oid)).toEqual(oids.slice(50));
  expect(second.nextCursor).toBeNull();
  expect((await readHistory(f.a, null, 'new.txt')).commits.map(c => c.oid)).toEqual([added]);
  await expect(readHistory(f.a, first.nextCursor, 'new.txt')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('reads real merge parents, binary base64 and inert portable conversation records', async () => {
  const f = await fixture(); const snapshot = portableSnapshot('After');
  snapshot.messages[0]!.content = '<script>inert historical form</script>';
  const entries = serializePortableMetadata(snapshot); entries.set('image.png', Buffer.from([0, 255, 128, 10]));
  const left = await fixtureCommit(f.a, join(f.root, 'h.index'), entries, []);
  const right = await fixtureCommit(f.a, join(f.root, 'h.index'), new Map([['right.txt', Buffer.from('right')]]), []);
  const merge = await fixtureCommit(f.a, join(f.root, 'h.index'), entries, [left, right]);
  await f.git(f.a, 'update-ref', 'refs/heads/main', merge);
  expect((await readCommit(f.a, merge)).parents).toEqual([left, right]);
  expect((await readCommit(f.a, right)).snapshotKind).toBe('files_only');
  expect(await readCommitFile(f.a, merge, 'image.png')).toEqual({ encoding: 'base64', content: 'AP+ACg==', mediaType: 'image/png' });
  expect(await readCommitConversations(f.a, merge)).toEqual(snapshot);
  expect(await readCommitConversations(f.a, right)).toBeNull();
  await expect(readCommitFile(f.a, merge, '../image.png')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(readCommitFile(f.a, merge, '.env')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('rejects abbreviations, revisions, noncommits and unreachable commits', async () => {
  const f = await fixture(); const entries = new Map([['index.html', Buffer.from('safe')]]);
  const head = await fixtureCommit(f.a, join(f.root, 'h.index'), entries, []);
  const foreign = await fixtureCommit(f.a, join(f.root, 'h.index'), new Map([['foreign.txt', Buffer.from('foreign')]]), []);
  await f.git(f.a, 'update-ref', 'refs/heads/main', head);
  for (const oid of [head.slice(0, 12), 'HEAD', head + '^', '0'.repeat(40), foreign,
    await f.git(f.a, 'rev-parse', head + '^{tree}'), await f.git(f.a, 'rev-parse', head + ':index.html')]) {
    await expect(readCommit(f.a, oid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }
});

it.each(['.env', 'state.sqlite', 'config.yaml', '.pi/session/transcript.json', '.transcript.jsonl'])('rejects private versioned %s before exposing bytes', async path => {
  const f = await fixture(); const oid = await fixtureCommit(f.a, join(f.root, 'h.index'), new Map([[path, Buffer.from('private')]]), []);
  await f.git(f.a, 'update-ref', 'refs/heads/main', oid);
  await expect(readCommit(f.a, oid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(readCommitFile(f.a, oid, path)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('does not invoke repository hooks, textconv, or clean filters during history reads', async () => {
  const f = await fixture(); const entries = new Map([['index.html', Buffer.from('safe')], ['.gitattributes', Buffer.from('*.html filter=attack diff=attack')]]);
  await writeFixtureEntries(f.a, entries); await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'external example');
  await mkdir(join(f.root, 'hooks')); await writeFile(join(f.root, 'hooks/post-checkout'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  await f.git(f.a, 'config', 'core.hooksPath', join(f.root, 'hooks'));
  await f.git(f.a, 'config', 'filter.attack.clean', 'exit 92'); await f.git(f.a, 'config', 'filter.attack.required', 'true');
  await f.git(f.a, 'config', 'diff.attack.textconv', 'exit 93');
  const oid = await f.git(f.a, 'rev-parse', 'HEAD');
  expect((await readCommitFile(f.a, oid, 'index.html')).content).toBe(Buffer.from('safe').toString('base64'));
  expect((await readHistory(f.a, null)).commits[0]!.message).toBe('external example\n');
});

it('validates SHA-256 repository identities and rejects SHA-1-sized input in that repository', async () => {
  const f = await fixture(); const root = join(f.root, 'sha256'); await mkdir(root);
  await f.git(root, 'init', '--initial-branch=main', '--object-format=sha256');
  const oid = await fixtureCommit(root, join(f.root, 'sha256.index'), new Map([['file.txt', Buffer.from('sha256')]]), []);
  await f.git(root, 'update-ref', 'refs/heads/main', oid);
  expect(oid).toHaveLength(64); expect((await readCommit(root, oid)).oid).toBe(oid);
  await expect(readCommit(root, oid.slice(0, 40))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});

it('rejects an oversized historical file before returning its contents', async () => {
  const f = await fixture(); const oid = await fixtureCommit(f.a, join(f.root, 'big.index'), new Map([['big.bin', Buffer.alloc(8 * 1024 * 1024 + 1)]]), []);
  await f.git(f.a, 'update-ref', 'refs/heads/main', oid);
  await expect(readCommitFile(f.a, oid, 'big.bin')).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
});

it('bounds sparse history to 200 scanned commits and resumes a frozen empty page', async () => {
  const f = await fixture();
  const first = await fixtureCommit(f.a, join(f.root, 'sparse.index'), new Map([['rare.txt', Buffer.from('original')]]), []);
  const tree = await f.git(f.a, 'rev-parse', `${first}^{tree}`); let head = first;
  for (let i = 0; i < 205; i++) head = await f.git(f.a, 'commit-tree', tree, '-p', head, '-m', `unchanged ${i}`);
  await f.git(f.a, 'update-ref', 'refs/heads/main', head);
  const page = await readHistory(f.a, null, 'rare.txt');
  expect(page.commits).toEqual([]); expect(page.nextCursor).not.toBeNull();
  expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())).toMatchObject({ start: head, offset: 200, path: 'rare.txt' });
  const next = await f.git(f.a, 'commit-tree', tree, '-p', head, '-m', 'concurrent'); await f.git(f.a, 'update-ref', 'refs/heads/main', next);
  const last = await readHistory(f.a, page.nextCursor, 'rare.txt'); expect(last.commits.map(row => row.oid)).toEqual([first]); expect(last.nextCursor).toBeNull();
});

it('classifies declared oversized resources without reading bodies but content detail rejects', async () => {
  const f = await fixture(); const snapshot = portableSnapshot('After');
  const resourcePath = `.open-design/resources/${'a'.repeat(64)}/content`;
  snapshot.manifest.resources.push({ digest: 'a'.repeat(64), locations: [{ path: resourcePath, purpose: 'attachment' }], references: ['message'] });
  snapshot.messages[0]!.resourceRefs.push('a'.repeat(64));
  const entries = serializePortableMetadata(snapshot); entries.set(resourcePath, Buffer.from('small invalid digest'));
  await writeFixtureEntries(f.a, entries); await writeFile(join(f.a, resourcePath), Buffer.alloc(200 * 1024 * 1024 + 1));
  await f.git(f.a, 'add', '.'); await f.git(f.a, 'commit', '-m', 'large declared resource'); const head = await f.git(f.a, 'rev-parse', 'HEAD');
  expect((await readHistory(f.a)).commits[0]!.snapshotKind).toBe('complete');
  expect((await readCommit(f.a, head)).snapshotKind).toBe('complete');
  await expect(readCommitConversations(f.a, head)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
});

it('includes tree layout bytes in the history metadata budget before parsing large inventories', async () => {
  const f = await fixture(); const blob = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from('x') })).stdout.toString().trim();
  const records = Array.from({ length: 70_000 }, (_, i) => `100644 ${blob}\t${String(i).padStart(6, '0')}-${'x'.repeat(90)}\0`).join('');
  await runGit({ cwd: f.a, args: ['update-index', '-z', '--index-info'], stdin: Buffer.from(records) });
  const tree = (await runGit({ cwd: f.a, args: ['write-tree'] })).stdout.toString().trim();
  const head = await f.git(f.a, 'commit-tree', tree, '-m', 'large tree'); await f.git(f.a, 'update-ref', 'refs/heads/main', head);
  expect(await readCommit(f.a, head).then(() => 'unexpected success', (error: { code: string }) => error.code)).toBe('PAYLOAD_TOO_LARGE');
});

it('bounds individual metadata objects and aggregate commit metadata', async () => {
  const f = await fixture(); const tree = await f.git(f.a, 'mktree'); let head: string | undefined;
  for (let i = 0; i < 10; i++) head = (await runGit({ cwd: f.a, args: ['commit-tree', tree, ...(head ? ['-p', head] : [])],
    env: fixtureGitEnv, stdin: Buffer.alloc(900 * 1024, 65 + i) })).stdout.toString().trim();
  await f.git(f.a, 'update-ref', 'refs/heads/main', head!);
  expect((await readCommit(f.a, head!)).oid).toBe(head);
  await expect(readHistory(f.a)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  const oversized = (await runGit({ cwd: f.a, args: ['commit-tree', tree, '-p', head!], env: fixtureGitEnv, stdin: Buffer.alloc(1024 * 1024 + 1, 65) })).stdout.toString().trim();
  await f.git(f.a, 'update-ref', 'refs/heads/main', oversized);
  await expect(readCommit(f.a, oversized)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
});
