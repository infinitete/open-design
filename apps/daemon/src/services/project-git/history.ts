import type { PortableSnapshot, ProjectGitCommit, ProjectGitHistoryPage } from '@open-design/contracts';
import { mimeFor } from '../../projects.js';
import { isPrivateProjectGitPath } from './checkpoint.js';
import { GitDomainError } from './errors.js';
import { runGit } from './git-process.js';
import { parsePortableEntries } from './portable.js';
import { discoverObjectStore, discoverRepository, validateTreeEntries } from './repository.js';

const PAGE_SIZE = 50;
const FILE_LIMIT = 8 * 1024 * 1024;
const invalid = () => new GitDomainError('VALIDATION_FAILED', 400, 'Invalid or unavailable project history target.');
type TreeEntry = { path: string; mode: string; oid: string };

export function assertHistoryPath(path: string): void {
  validateTreeEntries([{ path, mode: '100644' }]);
  if (isPrivateProjectGitPath(path)) throw invalid();
}

/** Only full commit identities reachable from this registered repository HEAD are public history. */
export async function assertHistoryCommit(root: string, oid: string): Promise<void> {
  const { objectFormat } = await discoverObjectStore(root);
  if (typeof oid !== 'string' || !(objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(oid)) throw invalid();
  const { head } = await discoverRepository(root); if (!head) throw invalid();
  try {
    if ((await runGit({ cwd: root, args: ['cat-file', '-t', oid] })).stdout.toString().trim() !== 'commit') throw invalid();
    await runGit({ cwd: root, args: ['merge-base', '--is-ancestor', oid, head] });
  } catch (error) {
    if (error instanceof GitDomainError && error.code === 'GIT_UNAVAILABLE') throw error;
    throw invalid();
  }
}

async function tree(root: string, oid: string): Promise<TreeEntry[]> {
  const raw = (await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', oid] })).stdout;
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw) || (raw.length && !text.endsWith('\0'))) throw invalid();
  const entries = text.split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t'); const [mode, type, object] = record.slice(0, tab).split(' ');
    if (tab < 0 || !mode || type !== 'blob' || !object || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)) throw invalid();
    return { path: record.slice(tab + 1), mode, oid: object };
  });
  validateTreeEntries(entries);
  for (const entry of entries) assertHistoryPath(entry.path);
  return entries;
}

async function objectBytes(root: string, oid: string, type: 'blob' | 'commit'): Promise<Buffer> {
  const size = Number((await runGit({ cwd: root, args: ['cat-file', '-s', oid] })).stdout.toString().trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT) throw new GitDomainError('PAYLOAD_TOO_LARGE', 413, 'Historical object exceeds the preview limit.', { limitBytes: FILE_LIMIT });
  const output = (await runGit({ cwd: root, args: ['cat-file', '--batch'], stdin: Buffer.from(oid + '\n') })).stdout;
  const line = output.indexOf(10);
  if (output.subarray(0, line).toString() !== `${oid} ${type} ${size}` || output.length !== line + size + 2 || output.at(-1) !== 10) throw invalid();
  return output.subarray(line + 1, -1);
}

/** Fully checked immutable bytes; caller still owns project authorization and the registered gate. */
export async function readHistoryEntries(root: string, oid: string): Promise<Map<string, { bytes: Buffer; mode: string }>> {
  await assertHistoryCommit(root, oid);
  const entries = await tree(root, oid); const result = new Map<string, { bytes: Buffer; mode: string }>();
  for (const entry of entries) result.set(entry.path, { bytes: await objectBytes(root, entry.oid, 'blob'), mode: entry.mode });
  return result;
}

export async function readCommitConversations(root: string, oid: string): Promise<PortableSnapshot | null> {
  await assertHistoryCommit(root, oid); const entries = await tree(root, oid);
  const reserved = entries.filter(entry => entry.path === '.open-design' || entry.path.split('/')[0]!.normalize('NFC').toLowerCase() === '.open-design');
  if (!reserved.length) return null;
  const bytes = new Map<string, Uint8Array>();
  for (const entry of reserved) bytes.set(entry.path, await objectBytes(root, entry.oid, 'blob'));
  return parsePortableEntries(bytes);
}

export async function readCommitFile(root: string, oid: string, path: string): Promise<{ encoding: 'base64'; content: string; mediaType: string }> {
  assertHistoryPath(path); await assertHistoryCommit(root, oid);
  const entry = (await tree(root, oid)).find(item => item.path === path);
  if (!entry) throw new GitDomainError('NOT_FOUND', 404, 'Historical file not found.');
  return { encoding: 'base64', content: (await objectBytes(root, entry.oid, 'blob')).toString('base64'), mediaType: mimeFor(path) };
}

export async function readCommit(root: string, oid: string): Promise<ProjectGitCommit> {
  await assertHistoryCommit(root, oid);
  const raw = (await objectBytes(root, oid, 'commit')).toString('utf8'); const separator = raw.indexOf('\n\n');
  if (separator < 0) throw invalid();
  const headers = raw.slice(0, separator).split('\n'); const message = raw.slice(separator + 2);
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  const author = /^author (.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/u.exec(headers.find(line => line.startsWith('author ')) ?? '');
  if (!author || parents.some(parent => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(parent))) throw invalid();
  const current = new Map((await tree(root, oid)).map(entry => [entry.path, entry]));
  const before = new Map((parents[0] ? await tree(root, parents[0]) : []).map(entry => [entry.path, entry]));
  const changedPaths: ProjectGitCommit['changedPaths'] = { added: [], modified: [], deleted: [] };
  for (const [path, entry] of current) {
    const old = before.get(path);
    if (!old) changedPaths.added.push(path);
    else if (old.oid !== entry.oid || old.mode !== entry.mode) changedPaths.modified.push(path);
  }
  for (const path of before.keys()) if (!current.has(path)) changedPaths.deleted.push(path);
  const snapshot = await readCommitConversations(root, oid);
  return { oid, parents, author: { name: author[1]!, email: author[2] || null }, authoredAt: Number(author[3]) * 1000,
    message, source: message.startsWith('Open Design ') ? 'open-design' : 'external', snapshotKind: snapshot ? 'complete' : 'files_only', changedPaths };
}

interface Cursor { version: 1; start: string; last: string; offset: number; path: string | null }
export async function readHistory(root: string, cursor: string | null = null, path?: string): Promise<ProjectGitHistoryPage> {
  if (path !== undefined) assertHistoryPath(path);
  let start = (await discoverRepository(root)).head; let offset = 0;
  if (cursor !== null) {
    let value: Cursor;
    try {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid();
      value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Cursor;
      if (!value || Object.keys(value).sort().join(',') !== 'last,offset,path,start,version' || value.version !== 1
        || !Number.isSafeInteger(value.offset) || value.offset < 1 || value.path !== (path ?? null)) throw invalid();
    } catch { throw invalid(); }
    await assertHistoryCommit(root, value.start); await assertHistoryCommit(root, value.last);
    const previous = (await runGit({ cwd: root, args: ['rev-list', '--topo-order', '--max-count=1', `--skip=${value.offset - 1}`, value.start] })).stdout.toString().trim();
    if (previous !== value.last) throw invalid();
    start = value.start; offset = value.offset;
  }
  if (!start) return { commits: [], nextCursor: null };
  await assertHistoryCommit(root, start);
  const commits: ProjectGitCommit[] = []; let last = '';
  // Scan fixed-size chunks so a sparse path page still advances through the frozen graph.
  while (commits.length < PAGE_SIZE) {
    const oids = (await runGit({ cwd: root, args: ['rev-list', '--topo-order', `--max-count=${PAGE_SIZE + 1}`, `--skip=${offset}`, start] })).stdout.toString().trim().split('\n').filter(Boolean);
    if (!oids.length) return { commits, nextCursor: null };
    for (const oid of oids.slice(0, PAGE_SIZE)) {
      const commit = await readCommit(root, oid); offset++; last = oid;
      if (path === undefined || Object.values(commit.changedPaths).some(paths => paths.includes(path))) commits.push(commit);
      if (commits.length === PAGE_SIZE) break;
    }
    if (commits.length < PAGE_SIZE && oids.length <= PAGE_SIZE) return { commits, nextCursor: null };
    if (commits.length === PAGE_SIZE) {
      const remaining = (await runGit({ cwd: root, args: ['rev-list', '--topo-order', '--max-count=1', `--skip=${offset}`, start] })).stdout.length;
      return { commits, nextCursor: remaining ? Buffer.from(JSON.stringify({ version: 1, start, last, offset, path: path ?? null } satisfies Cursor)).toString('base64url') : null };
    }
  }
  return { commits, nextCursor: null };
}
