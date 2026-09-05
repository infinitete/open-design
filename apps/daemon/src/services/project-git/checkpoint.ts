import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parsePortableManifest, type ProjectGitBasis } from '@open-design/contracts';
import type { ProjectGitJournalRecord, ProjectGitRecoveryData, ProjectGitRecoveryPath, ProjectGitStore } from '../../storage/project-git.js';
import type { ProjectGate } from './gate.js';
import { GitDomainError } from './errors.js';
import { assertGitIdentity, runGit } from './git-process.js';
import { discoverRepository, validateBranch } from './repository.js';
import { canonicalJson, parsePortableEntries } from './portable.js';

export interface CheckpointReason {
  source: 'initialize' | 'manual' | 'ai' | 'merge' | 'restore';
  runs: { id: string; terminal: 'succeeded' | 'failed' | 'cancelled' }[];
  restoreTarget?: string;
}

/** Service-owned ports. Production supplies the registered gate with its repository lease. */
export interface CheckpointCoordination {
  projectId: string;
  basis: ProjectGitBasis;
  gate: ProjectGate;
  readBasis(): ProjectGitBasis | Promise<ProjectGitBasis>;
  gitEnv?: Record<string, string>;
}

export interface CheckpointCandidate {
  readonly treeOid: string;
  readonly commitOid: string | null;
  readonly baseHead: string | null;
  readonly baseIndexDigest: string | null;
  readonly sourceDigests: Readonly<Record<string, string>>;
  readonly privateIndexPath: string;
  readonly previewContentDigest: string;
}

/** Retained checkpoint.json beneath journal.operationRoot; contains no callbacks or identity. */
export interface CheckpointEvidence {
  treeOid: string;
  commitOid: string | null;
  baseHead: string | null;
  baseIndexDigest: string | null;
  sourceDigests: Record<string, string>;
  sourceModes: Record<string, string>;
  portableDigests: Record<string, string>;
  removedPaths: string[];
  previewContentDigest: string;
  candidateIndexDigest: string;
  portablePaths: (ProjectGitRecoveryPath & { candidatePath: string | null; mode: string })[];
}

/** Retained index-lock.json. Missing receipt is NOT evidence of ownership after a crash. */
export interface CheckpointIndexLockReceipt { ownerToken: string; dev: string; ino: string }
interface Prepared {
  root: string; branch: string; gitDir: string; operationRoot: string;
  coordination: CheckpointCoordination; evidence: CheckpointEvidence; indexBytes: Buffer;
  baseIndex: Buffer | null; ownerToken: string;
}
const prepared = new WeakMap<CheckpointCandidate, Prepared>();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Project content changed. Capture a fresh checkpoint and retry.');
const busy = () => new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'An external Git operation or staged change requires attention.');
const recovery = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'Retained checkpoint publication requires recovery.');
const invalid = () => new GitDomainError('VALIDATION_FAILED', 400, 'Invalid checkpoint input.');
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** SHA-256 of canonicalJson UTF-8 sorted [path, mode, sha256] tuples (including its trailing LF).
 * Physical pre-write metadata, missing files, HEAD and operation/basis identities are not semantic content.
 */
export function computeCheckpointContentDigest(input: {
  sourceDigests: Readonly<Record<string, string>>; sourceModes: Readonly<Record<string, string>>;
  portableDigests: Readonly<Record<string, string>>; removedPaths: readonly string[];
}): string {
  const record = (value: unknown): value is Record<string, string> => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.values(value).every(item => typeof item === 'string');
  if (!record(input.sourceDigests) || !record(input.sourceModes) || !record(input.portableDigests)
    || !Array.isArray(input.removedPaths) || input.removedPaths.some(path => typeof path !== 'string')
    || !isDeepStrictEqual(Object.keys(input.sourceDigests).sort(), Object.keys(input.sourceModes).sort())) throw invalid();
  const files = new Map<string, [string, string]>();
  for (const [path, value] of Object.entries(input.sourceDigests)) {
    safePath(path); const mode = input.sourceModes[path];
    if (value === 'missing' && mode === '0') continue;
    if (!/^[a-f0-9]{64}$/u.test(value) || !mode || !['100644', '100755'].includes(mode)) throw invalid();
    files.set(path, [mode, value]);
  }
  for (const path of input.removedPaths) { safePath(path); files.delete(path); }
  for (const [path, value] of Object.entries(input.portableDigests)) {
    safePath(path); if (!/^[a-f0-9]{64}$/u.test(value)) throw invalid();
    files.set(path, [input.sourceModes[path] === '100755' ? '100755' : '100644', value]);
  }
  return digest(Buffer.from(canonicalJson([...files].sort(([a], [b]) => a < b ? -1 : 1).map(([path, [mode, value]]) => [path, mode, value]))));
}

async function optionalBytes(path: string): Promise<Buffer | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await handle.stat()).isFile()) throw busy(); return await handle.readFile(); }
    finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}

async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

/** Establish each new directory name in its parent before creating anything beneath it. */
async function durableDirectory(path: string, mode: number): Promise<void> {
  const parent = dirname(path);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw recovery();
  } catch (error) {
    if (!missing(error) || parent === path) throw error;
    await durableDirectory(parent, mode);
    try { await mkdir(path, { mode }); }
    catch (createError) { if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw recovery();
  }
  // Also flush an existing boundary: a prior failed attempt may have created it before its parent sync failed.
  if (parent !== path) await syncDirectory(parent);
}

function safePath(path: string): void {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || Buffer.from(path).toString('utf8') !== path
    || path.split('/').some(p => !p || p === '.' || p === '..' || /^\.git$/iu.test(p))) throw invalid();
}

function decodePaths(bytes: Buffer): string[] {
  if (!bytes.length) return [];
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || !text.endsWith('\0')) throw invalid();
  return text.slice(0, -1).split('\0');
}

export function isPrivateProjectGitPath(path: string): boolean {
  return path.split('/').some(part => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.codex|\.claude|credentials(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?|auth\.json|config\.ya?ml|app-config\.json|media-config\.json|mcp-.*\.json|id_rsa|id_ed25519)$/iu.test(part))
    || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/iu.test(path) || /\.(?:pem|key|p12|pfx)$/iu.test(path);
}

async function inspect(root: string, head: string | null, ownedLock?: string) {
  const repository = await discoverRepository(root);
  if (repository.head !== head) throw changed();
  if (!repository.branch) throw busy();
  const indexPath = join(repository.gitDir, 'index');
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'sequencer']) {
    if (await exists(join(repository.gitDir, marker))) throw busy();
  }
  if (!ownedLock && await exists(indexPath + '.lock')) throw busy();
  const staged = decodePaths((await runGit({ cwd: root, args: ['ls-files', '--stage', '-z'] })).stdout);
  const tracked = new Set<string>();
  for (const record of staged) {
    const tab = record.indexOf('\t'); const fields = record.slice(0, tab).split(' ');
    if (tab < 0 || fields[2] !== '0') throw busy();
    const path = record.slice(tab + 1); safePath(path); tracked.add(path);
    if (!['100644', '100755'].includes(fields[0]!)) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409,
      'Linked project content requires manual handling.', { paths: [path] });
  }
  if (head === null ? staged.length > 0
    : (await runGit({ cwd: root, args: ['diff-index', '--cached', '--raw', '-z', head] })).stdout.length > 0) throw busy();
  const untracked = decodePaths((await runGit({ cwd: root, args: ['ls-files', '--others', '--exclude-standard', '-z'] })).stdout);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  for (const path of paths) safePath(path);
  const privatePaths = paths.filter(isPrivateProjectGitPath);
  if (privatePaths.length) throw new GitDomainError('VALIDATION_FAILED', 400,
    'Private configuration cannot be automatically tracked. Review these paths.', { paths: privatePaths });
  const index = await optionalBytes(indexPath);
  return { ...repository, paths, index, indexDigest: index === null ? null : digest(index) };
}

async function readSources(root: string, paths: string[], consume?: (path: string, mode: string, bytes: Buffer) => Promise<void>) {
  const digests: Record<string, string> = Object.create(null);
  const modes: Record<string, string> = Object.create(null);
  for (const path of paths) {
    let target = root;
    try {
      for (const component of path.split('/')) {
        target = join(target, component);
        if ((await lstat(target)).isSymbolicLink()) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409,
          'Linked project content requires manual handling.', { paths: [path] });
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Unsupported project file.', { paths: [path] });
        const bytes = await handle.readFile(); const mode = info.mode & 0o111 ? '100755' : '100644';
        digests[path] = digest(bytes); modes[path] = mode;
        await consume?.(path, mode, bytes);
      } finally { await handle.close(); }
    } catch (error) {
      if (!missing(error)) throw error;
      digests[path] = 'missing'; modes[path] = '0';
    }
  }
  return { digests, modes };
}

async function assertBasis(context: CheckpointCoordination): Promise<void> {
  if (!isDeepStrictEqual(await context.readBasis(), context.basis)) throw changed();
}

async function treeEntries(root: string, tree: string): Promise<Map<string, { mode: string; oid: string }>> {
  const result = new Map<string, { mode: string; oid: string }>();
  for (const record of decodePaths((await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', tree] })).stdout)) {
    const tab = record.indexOf('\t'); const [mode, type, oid] = record.slice(0, tab).split(' '); const path = record.slice(tab + 1);
    safePath(path); if (type !== 'blob' || !mode || !oid) throw recovery();
    result.set(path, { mode, oid });
  }
  return result;
}

async function blob(root: string, oid: string): Promise<Buffer> {
  const bytes = (await runGit({ cwd: root, args: ['cat-file', '--batch'], stdin: Buffer.from(oid + '\n') })).stdout;
  const start = bytes.indexOf(10); const header = bytes.subarray(0, start).toString('ascii').split(' ');
  if (header[0] !== oid || header[1] !== 'blob' || bytes.length !== start + 2 + Number(header[2])) throw recovery();
  return bytes.subarray(start + 1, -1);
}

async function reservedPaths(root: string, path = '.open-design'): Promise<string[]> {
  try {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw recovery();
    if (info.isFile()) return [path];
    if (!info.isDirectory()) throw recovery();
    const result: string[] = [];
    for (const name of await readdir(join(root, path))) result.push(...await reservedPaths(root, `${path}/${name}`));
    return result.sort();
  } catch (error) { if (missing(error)) return []; throw error; }
}

async function portablePlan(root: string, head: string | null, entries: Map<string, Buffer>) {
  const obsolete: string[] = []; const base = new Map<string, Buffer>();
  if (!entries.size) return { obsolete, base, reserved: [] as string[] };
  parsePortableEntries(entries);
  const tree = head ? await treeEntries(root, head) : new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of tree) if (path.startsWith('.open-design/')) base.set(path, await blob(root, entry.oid));
  if (base.size) {
    const manifestBytes = base.get('.open-design/manifest.json');
    if (!manifestBytes) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Unrecognized portable layout.');
    const manifest = parsePortableManifest(JSON.parse(manifestBytes.toString('utf8')));
    for (const resource of manifest.resources) for (const location of resource.locations) {
      const entry = tree.get(location.path);
      if (entry && !base.has(location.path)) base.set(location.path, await blob(root, entry.oid));
    }
    parsePortableEntries(base);
    // Only owned reserved snapshot paths participate in removal; ordinary source entries never do.
    for (const path of base.keys()) if (path.startsWith('.open-design/') && !entries.has(path)) obsolete.push(path);
  }
  const reserved = await reservedPaths(root);
  const unknown = reserved.filter(path => !base.has(path) && !entries.has(path));
  if (unknown.length) throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Unrecognized portable layout.', { paths: unknown });
  return { obsolete, base, reserved };
}

export async function prepareCheckpoint(input: {
  root: string; operationDir: string; head: string | null; portableEntries: Map<string, Uint8Array>;
  reason?: CheckpointReason; coordination: CheckpointCoordination;
}): Promise<CheckpointCandidate> {
  if (!input.coordination || !isAbsolute(input.operationDir) || !isAbsolute(input.root)) throw invalid();
  const context: CheckpointCoordination = { ...input.coordination, basis: { ...input.coordination.basis },
    ...(input.coordination.gitEnv ? { gitEnv: { ...input.coordination.gitEnv } } : {}) };
  const entries = new Map([...input.portableEntries].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const reason = JSON.parse(JSON.stringify(input.reason ?? { source: 'manual', runs: [] })) as CheckpointReason;
  const head = input.head; const root = input.root; const operationDir = input.operationDir;
  return context.gate.exclusive(async () => {
    await assertBasis(context);
    if (context.basis.localHead !== head) throw changed();
    const before = await inspect(root, head);
    await assertGitIdentity({ cwd: root, ...(context.gitEnv ? { env: context.gitEnv } : {}) });
    const portable = await portablePlan(root, head, entries);
    const sourcePaths = [...new Set([...before.paths, ...portable.reserved, ...entries.keys()])].sort();
    await durableDirectory(operationDir, 0o700);
    const parent = await realpath(operationDir);
    const location = relative(before.root, parent);
    if (!location || (!location.startsWith('../') && location !== '..' && !isAbsolute(location))) throw invalid();
    const operationRoot = await mkdtemp(join(parent, 'checkpoint-'));
    await syncDirectory(parent);
    const privateIndexPath = join(operationRoot, 'candidate.index');
    const env = { ...context.gitEnv, GIT_INDEX_FILE: privateIndexPath };
    await runGit({ cwd: root, args: ['read-tree', head ?? '--empty'], env });
    const records: Buffer[] = [];
    const add = async (path: string, mode: string, bytes: Buffer) => {
      const oid = (await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: bytes })).stdout.toString('ascii').trim();
      records.push(Buffer.from(`${mode} ${oid}\t${path}\0`));
    };
    const portablePaths: CheckpointEvidence['portablePaths'] = [];
    const sourceBytes = new Map<string, Buffer>();
    const sources = await readSources(root, sourcePaths, async (path, mode, bytes) => {
      if (entries.has(path) || portable.obsolete.includes(path)) sourceBytes.set(path, bytes);
      else await add(path, mode, bytes);
    });
    // Ordinary supplied bytes are captured evidence, never authority to create or overwrite user files.
    for (const [path, bytes] of entries) if (!path.startsWith('.open-design/') && sources.digests[path] !== digest(bytes)) {
      throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Ordinary supplied content must match the captured project file.', { paths: [path] });
    }
    for (const path of [...new Set([...entries.keys()].filter(path => path.startsWith('.open-design/')).concat(portable.obsolete))].sort()) {
      const old = sourceBytes.get(path); const next = entries.get(path); const oldDigest = old ? digest(old) : null; const candidateDigest = next ? digest(next) : null;
      if (oldDigest === candidateDigest) continue;
      if (oldDigest !== (portable.base.has(path) ? digest(portable.base.get(path)!) : null)) throw new GitDomainError('PROJECT_STATE_CHANGED', 409,
        'Portable content has external edits requiring reconciliation.', { paths: [path] });
      const stem = join(operationRoot, digest(Buffer.from(path)));
      const backupPath = old ? stem + '.backup' : null; const candidatePath = next ? stem + '.candidate' : null;
      if (backupPath) await durableWrite(backupPath, old!);
      if (candidatePath) await durableWrite(candidatePath, next!);
      portablePaths.push({ path, oldDigest, candidateDigest, backupPath, candidatePath, mode: sources.modes[path] === '100755' ? '100755' : '100644', protected: false, applied: false });
    }
    const zero = '0'.repeat(head?.length ?? ((await runGit({ cwd: root, args: ['rev-parse', '--show-object-format'] })).stdout.toString().trim() === 'sha256' ? 64 : 40));
    for (const path of before.paths) if (sources.modes[path] === '0' && !entries.has(path)) records.push(Buffer.from(`0 ${zero}\t${path}\0`));
    for (const path of portable.obsolete) records.push(Buffer.from(`0 ${zero}\t${path}\0`));
    const portableDigests: Record<string, string> = Object.create(null);
    for (const [path, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : 1)) {
      safePath(path); if (isPrivateProjectGitPath(path)) throw new GitDomainError('VALIDATION_FAILED', 400, 'Private configuration cannot be tracked.', { paths: [path] });
      portableDigests[path] = digest(bytes); await add(path, sources.modes[path] === '100755' ? '100755' : '100644', bytes);
    }
    await runGit({ cwd: root, args: ['update-index', '-z', '--index-info'], env, stdin: Buffer.concat(records) });
    const treeOid = (await runGit({ cwd: root, args: ['write-tree'], env })).stdout.toString('ascii').trim();
    await assertBasis(context);
    const after = await inspect(root, head);
    const finalReserved = entries.size ? await reservedPaths(root) : [];
    const finalSources = await readSources(root, [...new Set([...after.paths, ...finalReserved, ...entries.keys()])].sort());
    if (before.indexDigest !== after.indexDigest || !isDeepStrictEqual(before.paths, after.paths)
      || !isDeepStrictEqual(sources, finalSources)) throw changed();
    await assertBasis(context);
    const baseTree = head ? (await runGit({ cwd: root, args: ['rev-parse', '--verify', `${head}^{tree}`] })).stdout.toString().trim() : null;
    const commitOid = treeOid === baseTree ? null : (await runGit({ cwd: root,
      args: ['commit-tree', treeOid, ...(head ? ['-p', head] : [])], env,
      stdin: Buffer.from(`Open Design checkpoint (${reason.source})\n\nOpen-Design-Checkpoint: ${JSON.stringify(reason)}\n`) })).stdout.toString('ascii').trim();
    const indexBytes = await readFile(privateIndexPath);
    const previewContentDigest = computeCheckpointContentDigest({ sourceDigests: sources.digests, sourceModes: sources.modes,
      portableDigests, removedPaths: portable.obsolete });
    const evidence: CheckpointEvidence = { treeOid, commitOid, baseHead: head, baseIndexDigest: before.indexDigest,
      sourceDigests: sources.digests, sourceModes: sources.modes, portableDigests, removedPaths: portable.obsolete,
      previewContentDigest, candidateIndexDigest: digest(indexBytes), portablePaths };
    await durableWrite(join(operationRoot, 'checkpoint.json'), Buffer.from(JSON.stringify(evidence)));
    if (before.index !== null) await durableWrite(join(operationRoot, 'original.index'), before.index);
    const index = await open(privateIndexPath, 'r'); try { await index.sync(); } finally { await index.close(); }
    await syncDirectory(operationRoot);
    const candidate = Object.freeze({ treeOid, commitOid, baseHead: head, baseIndexDigest: before.indexDigest,
      sourceDigests: Object.freeze({ ...sources.digests }), privateIndexPath, previewContentDigest });
    prepared.set(candidate, { root: before.root, branch: before.branch!, gitDir: before.gitDir, operationRoot,
      coordination: context, evidence, indexBytes, baseIndex: before.index, ownerToken: randomUUID() });
    return candidate;
  });
}

interface PublicationInput { root: string; branch: string; candidate: CheckpointCandidate; operationId: string; store: ProjectGitStore }

async function publicationContext(input: PublicationInput): Promise<Prepared> {
  const state = prepared.get(input.candidate);
  if (!state || await realpath(input.root) !== state.root || input.branch !== state.branch) throw invalid();
  await validateBranch(input.branch);
  const op = input.store.getJournal(input.operationId);
  if (!op || op.kind !== 'checkpoint' || op.projectId !== state.coordination.projectId
    || !isDeepStrictEqual(op.basis, state.coordination.basis)) throw changed();
  return state;
}

async function journal(input: PublicationInput, state: Prepared): Promise<void> {
  const op = input.store.getJournal(input.operationId)!;
  if (op.recoveryData) {
    if (op.recoveryData.operationRoot !== state.operationRoot || op.recoveryData.candidateOid !== input.candidate.commitOid
      || op.recoveryData.index.ownerToken !== state.ownerToken) throw recovery();
    return;
  }
  await assertBasis(state.coordination);
  if (!input.candidate.commitOid) return;
  const data: ProjectGitRecoveryData = { operationRoot: state.operationRoot, baseHead: input.candidate.baseHead,
    previewContentDigest: input.candidate.previewContentDigest, candidateTreeOid: input.candidate.treeOid,
    publishBase: input.candidate.baseHead, publicationParents: input.candidate.baseHead ? [input.candidate.baseHead] : [],
    publishHead: input.candidate.commitOid, candidateOid: input.candidate.commitOid,
    paths: state.evidence.portablePaths.map(({ candidatePath: _candidatePath, mode: _mode, ...path }) => ({ ...path })),
    index: { path: join(state.gitDir, 'index'), oldDigest: input.candidate.baseIndexDigest,
      candidateDigest: state.evidence.candidateIndexDigest,
      backupPath: state.baseIndex === null ? null : join(state.operationRoot, 'original.index'), ownerToken: state.ownerToken, published: false },
    records: null, refPublished: false };
  input.store.setPhase(input.operationId, 'prepared', data);
  input.store.completePhase(input.operationId, 'prepared', data);
}

/** Task 8 journals an owned child here, then calls outer prepareProtection before publishing it. */
export async function journalCheckpoint(input: PublicationInput): Promise<void> {
  const state = await publicationContext(input);
  return state.coordination.gate.exclusive(() => journal(input, state));
}

async function verifySources(state: Prepared, ownedLock?: string, filesApplied = false): Promise<void> {
  await assertBasis(state.coordination);
  const current = await inspect(state.root, state.evidence.baseHead, ownedLock);
  if (current.branch !== state.branch || current.gitDir !== state.gitDir || current.indexDigest !== state.evidence.baseIndexDigest) throw changed();
  const reserved = Object.keys(state.evidence.portableDigests).length ? await reservedPaths(state.root) : [];
  const sources = await readSources(state.root, [...new Set([...current.paths, ...reserved, ...Object.keys(state.evidence.sourceDigests)])].sort());
  const expectedDigests = Object.assign(Object.create(null), state.evidence.sourceDigests) as Record<string, string>;
  const expectedModes = Object.assign(Object.create(null), state.evidence.sourceModes) as Record<string, string>;
  if (filesApplied) for (const path of state.evidence.portablePaths) {
    expectedDigests[path.path] = path.candidateDigest ?? 'missing'; expectedModes[path.path] = path.candidateDigest === null ? '0' : path.mode;
  }
  if (!isDeepStrictEqual(sources.digests, expectedDigests) || !isDeepStrictEqual(sources.modes, expectedModes)) throw changed();
  if (digest(await readFile(join(state.operationRoot, 'candidate.index'))) !== state.evidence.candidateIndexDigest) throw recovery();
  await assertBasis(state.coordination);
}

async function applyPortableFiles(state: Prepared): Promise<void> {
  for (const item of state.evidence.portablePaths) {
    if (!item.path.startsWith('.open-design/')) throw recovery();
    let parent = state.root;
    for (const segment of item.path.split('/').slice(0, -1)) {
      parent = join(parent, segment);
      await durableDirectory(parent, 0o755);
    }
    const path = join(state.root, item.path); const old = await optionalBytes(path);
    if ((old === null ? null : digest(old)) !== item.oldDigest) throw changed();
    if (item.candidatePath === null) { if (old !== null) await unlink(path); }
    else {
      const bytes = await optionalBytes(item.candidatePath);
      if (bytes === null || digest(bytes) !== item.candidateDigest) throw recovery();
      const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | (old === null ? constants.O_CREAT | constants.O_EXCL : 0), item.mode === '100755' ? 0o755 : 0o644);
      try {
        if (old !== null) {
          const info = await handle.stat(); const current = await lstat(path);
          if (!info.isFile() || info.ino !== current.ino || info.dev !== current.dev) throw changed();
        }
        await handle.writeFile(bytes); await handle.truncate(bytes.length); await handle.sync();
      } finally { await handle.close(); }
    }
    await syncDirectory(dirname(path));
  }
}

export interface CheckpointPublicationEvidence {
  journal: ProjectGitJournalRecord;
  evidence: CheckpointEvidence;
  indexBytes: Buffer;
  originalIndexBytes: Buffer | null;
  /** Always the CHILD checkpoint receipt, never current-lock authority under lockOwnerOperationId. */
  lockReceipt: CheckpointIndexLockReceipt | null;
}

/** Read-only restart seam, valid from prepared through complete. Task 8 supplies its own registered
 * gate/revision fence and reconciles the ORIGINAL journal against current files/ref/index before effects.
 * No field read from disk becomes a callback, environment override, gate or filesystem authority.
 */
export async function readCheckpointPublication(input: { root: string; operationId: string; store: ProjectGitStore;
  /** Completed owned child evidence may be read while its exact outer operation owns the normal-index lock. */
  lockOwnerOperationId?: string;
}): Promise<CheckpointPublicationEvidence> {
  try {
    const journal = input.store.getJournal(input.operationId); const data = journal?.recoveryData;
    const binding = journal?.projectId ? input.store.getBinding(journal.projectId) : null;
    const repository = await discoverRepository(input.root);
    if (!journal || journal.kind !== 'checkpoint' || !data || !binding || !journal.journalPhase
      || binding.generation !== journal.basis.bindingGeneration || binding.canonicalRoot !== repository.root
      || binding.commonDir !== repository.commonDir || binding.branch !== repository.branch
      || data.index.path !== join(repository.gitDir, 'index') || data.baseHead !== journal.basis.localHead
      || data.publishBase !== data.baseHead || data.publishHead !== data.candidateOid
      || !isDeepStrictEqual(data.publicationParents, data.baseHead ? [data.baseHead] : [])
      || !isAbsolute(data.operationRoot) || await realpath(data.operationRoot) !== data.operationRoot) throw recovery();
    const location = relative(repository.root, data.operationRoot);
    if (!location || (!location.startsWith('../') && location !== '..' && !isAbsolute(location))) throw recovery();
    const read = async (name: string) => {
      const bytes = await optionalBytes(join(data.operationRoot, name)); if (bytes === null) throw recovery(); return bytes;
    };
    const evidence = JSON.parse((await read('checkpoint.json')).toString('utf8')) as CheckpointEvidence;
    if (evidence.commitOid !== data.candidateOid || evidence.treeOid !== data.candidateTreeOid || evidence.baseHead !== data.baseHead
      || evidence.baseIndexDigest !== data.index.oldDigest || evidence.candidateIndexDigest !== data.index.candidateDigest
      || evidence.previewContentDigest !== data.previewContentDigest || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence.commitOid!)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence.treeOid)
      || !Array.isArray(evidence.portablePaths) || !Array.isArray(evidence.removedPaths)
      || Object.values(evidence.sourceDigests).some(value => typeof value !== 'string')
      || computeCheckpointContentDigest(evidence) !== evidence.previewContentDigest) throw recovery();
    const indexBytes = await read('candidate.index');
    if (digest(indexBytes) !== data.index.candidateDigest) throw recovery();
    const backupPath = data.index.oldDigest === null ? null : join(data.operationRoot, 'original.index');
    if (data.index.backupPath !== backupPath) throw recovery();
    const originalIndexBytes = backupPath === null ? null : await read('original.index');
    if (originalIndexBytes !== null && digest(originalIndexBytes) !== data.index.oldDigest) throw recovery();
    if (evidence.portablePaths.length !== data.paths.length) throw recovery();
    for (const [index, path] of evidence.portablePaths.entries()) {
      safePath(path.path); if (!path.path.startsWith('.open-design/')) throw recovery();
      const stored = data.paths[index]!;
      const stem = join(data.operationRoot, digest(Buffer.from(path.path)));
      if (stored.path !== path.path || stored.oldDigest !== path.oldDigest || stored.candidateDigest !== path.candidateDigest
        || stored.backupPath !== path.backupPath || path.backupPath !== (path.oldDigest === null ? null : stem + '.backup')
        || path.candidatePath !== (path.candidateDigest === null ? null : stem + '.candidate')
        || !['100644', '100755'].includes(path.mode)) throw recovery();
      for (const [file, expected] of [[path.backupPath, path.oldDigest], [path.candidatePath, path.candidateDigest]] as const) {
        if (file !== null && digest(await read(relative(data.operationRoot, file))) !== expected) throw recovery();
      }
    }
    const treeOid = (await runGit({ cwd: repository.root, args: ['rev-parse', '--verify', `${evidence.commitOid}^{tree}`] })).stdout.toString().trim();
    const ancestry = (await runGit({ cwd: repository.root, args: ['rev-list', '--parents', '--max-count=1', evidence.commitOid!] })).stdout.toString().trim().split(' ');
    if (treeOid !== evidence.treeOid || !isDeepStrictEqual(ancestry, [evidence.commitOid, ...data.publicationParents])) throw recovery();
    const tree = await treeEntries(repository.root, treeOid);
    const indexed = decodePaths((await runGit({ cwd: repository.root, args: ['ls-files', '--stage', '-z'],
      env: { GIT_INDEX_FILE: join(data.operationRoot, 'candidate.index') } })).stdout);
    if (tree.size !== indexed.length) throw recovery();
    for (const record of indexed) {
      const tab = record.indexOf('\t'); const [mode, oid, stage] = record.slice(0, tab).split(' '); const entry = tree.get(record.slice(tab + 1));
      if (stage !== '0' || entry?.mode !== mode || entry?.oid !== oid) throw recovery();
    }
    const receiptBytes = await optionalBytes(join(data.operationRoot, 'index-lock.json'));
    const lockReceipt = receiptBytes === null ? null : JSON.parse(receiptBytes.toString('utf8')) as CheckpointIndexLockReceipt;
    if (lockReceipt && (lockReceipt.ownerToken !== data.index.ownerToken || !/^\d+$/u.test(lockReceipt.dev) || !/^\d+$/u.test(lockReceipt.ino))) throw recovery();
    const lockPath = data.index.path + '.lock';
    let currentLockReceipt = lockReceipt;
    if (input.lockOwnerOperationId !== undefined) {
      const owner = input.store.getJournal(input.lockOwnerOperationId); const ownerData = owner?.recoveryData;
      if (journal.journalPhase !== 'complete' || !journal.phaseCompleted || journal.status !== 'succeeded'
        || journal.ownerOperationId !== input.lockOwnerOperationId || !owner || owner.kind === 'checkpoint' || !ownerData
        || owner.projectId !== journal.projectId || !isDeepStrictEqual(owner.basis, journal.basis)
        || ownerData.index.path !== data.index.path || !owner.protection?.completed
        || owner.protection.checkpointOperationId !== journal.id || owner.protection.checkpointOid !== data.publishHead
        || ownerData.baseHead !== data.baseHead || ownerData.previewContentDigest !== data.previewContentDigest
        || !isAbsolute(ownerData.operationRoot) || await realpath(ownerData.operationRoot) !== ownerData.operationRoot
        || dirname(ownerData.operationRoot) !== dirname(data.operationRoot) || ownerData.operationRoot === data.operationRoot) throw recovery();
      const bytes = await optionalBytes(join(ownerData.operationRoot, 'index-lock.json'));
      if (!bytes) throw recovery();
      const receipt: unknown = JSON.parse(bytes.toString('utf8'));
      if (!receipt || typeof receipt !== 'object' || !('ownerToken' in receipt) || typeof receipt.ownerToken !== 'string'
        || receipt.ownerToken !== ownerData.index.ownerToken || !('dev' in receipt) || typeof receipt.dev !== 'string' || !/^\d+$/u.test(receipt.dev)
        || !('ino' in receipt) || typeof receipt.ino !== 'string' || !/^\d+$/u.test(receipt.ino)) throw recovery();
      currentLockReceipt = { ownerToken: receipt.ownerToken, dev: receipt.dev, ino: receipt.ino };
    }
    if (await exists(lockPath)) {
      const info = await lstat(lockPath, { bigint: true });
      if (!currentLockReceipt || !info.isFile() || info.isSymbolicLink() || String(info.dev) !== currentLockReceipt.dev || String(info.ino) !== currentLockReceipt.ino) throw recovery();
    }
    return { journal, evidence, indexBytes, originalIndexBytes, lockReceipt };
  } catch (error) {
    if (error instanceof GitDomainError && error.code === 'GIT_UNAVAILABLE') throw error;
    throw recovery();
  }
}

export async function publishCheckpoint(input: PublicationInput): Promise<string | null> {
  const state = await publicationContext(input);
  return state.coordination.gate.exclusive(async () => {
    const op = input.store.getJournal(input.operationId)!;
    if (op.journalPhase === 'complete') return op.recoveryData?.publishHead ?? null;
    await assertBasis(state.coordination);
    if (!input.candidate.commitOid) {
      await verifySources(state);
      input.store.updateOperation(input.operationId, { status: 'succeeded', phase: 'local_saved',
        result: input.candidate.baseHead === null ? {} : { head: input.candidate.baseHead }, error: null });
      return null;
    }
    await journal(input, state);
    const start = input.store.getJournal(input.operationId)!;
    if (start.journalPhase !== 'prepared' || !start.phaseCompleted) throw recovery();
    if (start.ownerOperationId) {
      const owner = input.store.getJournal(start.ownerOperationId);
      if (owner?.journalPhase !== 'protected' || owner.phaseCompleted || owner.protection?.checkpointOperationId !== start.id
        || owner.protection.checkpointOid !== input.candidate.commitOid) throw recovery();
    }
    const data = start.recoveryData!;
    const lockPath = data.index.path + '.lock';
    let handle;
    try { handle = await open(lockPath, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(); throw error; }
    const inode = await handle.stat({ bigint: true });
    const receipt: CheckpointIndexLockReceipt = { ownerToken: state.ownerToken, dev: String(inode.dev), ino: String(inode.ino) };
    let casAttempted = false;
    const ownsLock = async () => {
      try { const current = await lstat(lockPath, { bigint: true }); return !current.isSymbolicLink() && current.dev === inode.dev && current.ino === inode.ino; }
      catch (error) { if (missing(error)) return false; throw error; }
    };
    try {
      await durableWrite(join(state.operationRoot, 'index-lock.json'), Buffer.from(JSON.stringify(receipt)));
      await syncDirectory(state.operationRoot);
      await verifySources(state, lockPath);
      input.store.setPhase(input.operationId, 'protected', data);
      for (const path of data.paths) path.protected = true;
      input.store.completePhase(input.operationId, 'protected', data);
      input.store.setPhase(input.operationId, 'files_applied', data);
      await applyPortableFiles(state);
      await verifySources(state, lockPath, true);
      for (const path of data.paths) path.applied = true;
      input.store.completePhase(input.operationId, 'files_applied', data);
      input.store.setPhase(input.operationId, 'records_applied', data);
      input.store.completeRecords(input.operationId, { basis: state.coordination.basis, importMarker: null, advanceProjectRevision: false }, () => undefined);
      input.store.setPhase(input.operationId, 'ref_published', data);
      await handle.writeFile(state.indexBytes); await handle.sync();
      await verifySources(state, lockPath, true);
      if (!await ownsLock()) throw busy();
      casAttempted = true;
      await runGit({ cwd: state.root, args: ['update-ref', '--no-deref', `refs/heads/${state.branch}`,
        input.candidate.commitOid!, input.candidate.baseHead ?? '0'.repeat(input.candidate.commitOid!.length)] });
      data.refPublished = true; input.store.completePhase(input.operationId, 'ref_published', data);
      input.store.setPhase(input.operationId, 'index_published', data);
      const actual = await discoverRepository(state.root);
      if (actual.head !== input.candidate.commitOid || actual.branch !== state.branch || actual.gitDir !== state.gitDir) throw recovery();
      if (!await ownsLock() || digest(await optionalBytes(lockPath) ?? Buffer.alloc(0)) !== state.evidence.candidateIndexDigest
        || digest(await optionalBytes(data.index.path) ?? Buffer.alloc(0)) !== (state.evidence.baseIndexDigest ?? digest(Buffer.alloc(0)))) throw recovery();
      // Once CAS succeeds, retain even our own lock on failure: recovery must reconcile the old normal index.
      await handle.close();
      await rename(lockPath, data.index.path); await syncDirectory(state.gitDir);
      data.index.published = true; input.store.completePhase(input.operationId, 'index_published', data);
      input.store.completeMaterialization(input.operationId, { basis: state.coordination.basis, advanceProjectRevision: false });
      return input.candidate.commitOid;
    } finally {
      try {
        // Keep the descriptor open while checking/removing: its inode cannot be recycled for a successor.
        // A command can change HEAD and lose its response. Do not interpret an exception as failed CAS.
        if (!casAttempted && await ownsLock()) await unlink(lockPath);
      } finally { await handle.close(); }
    }
  });
}
