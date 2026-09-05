import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { ProjectGitBasis } from '@open-design/contracts';
import type { ProjectGitJournalRecord, ProjectGitRecoveryPath, ProjectGitStore } from '../../storage/project-git.js';
import type { ProjectGate, ProjectRecoveryBarrier } from './gate.js';
import { GitDomainError } from './errors.js';
import { runGit } from './git-process.js';
import { discoverRepository, validateTreeEntries } from './repository.js';
import { computeCheckpointContentDigest, readCheckpointPublication } from './checkpoint.js';
import { parsePortableEntries, portableImportMarker } from './portable.js';
import { importPortableRecords, readPortableRecords } from './portable-db.js';
import { ensureMaterializationProtection } from './materialize.js';
import type { MaterializeEffect, MaterializePhase } from './materialize.js';

export interface RecoveryProject {
  root: string; branch: string; gate: ProjectGate;
  readBasis(): ProjectGitBasis | Promise<ProjectGitBasis>;
  gitEnv?: Record<string, string>;
  /** Trusted original-registration verifier, invoked only under this operation's real exclusive lease. */
  prepareRegistrationCompletion?: (operationId: string) => Promise<import('./registration.js').RegistrationTerminalCapability>;
}
export interface RecoveryContext extends RecoveryProject {
  db: Database.Database; store: ProjectGitStore; operationRoot: string;
  afterDurablePhase?: (phase: MaterializePhase) => Promise<void>;
  afterEffect?: (point: MaterializeEffect, path?: string) => Promise<void>;
}
export interface MaterializationPath extends ProjectGitRecoveryPath {
  candidatePath: string | null; mode: string; oldMode: string; temporaryPath: string | null; temporaryReceiptPath: string | null;
}
export interface MaterializationEvidence {
  publicationMode?: 'commit' | 'fast_forward' | 'initial_import';
  operationId: string; projectId: string; treeOid: string; candidateOid: string;
  sourceDigests: Record<string, string>; sourceModes: Record<string, string>;
  portableDigests: Record<string, string>; removedPaths: string[];
  previewContentDigest: string; protectionRequired: boolean;
  currentPortable: [string, string][];
  paths: MaterializationPath[];
}
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const recoveryRequired = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'The retained operation requires recovery before project access.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const handles = new WeakMap<ProjectGate, Map<string, ProjectRecoveryBarrier>>();

export function recoveryBarrier(gate: ProjectGate, operationId: string): ProjectRecoveryBarrier {
  let owned = handles.get(gate); if (!owned) { owned = new Map(); handles.set(gate, owned); }
  let barrier = owned.get(operationId);
  if (!barrier) { barrier = gate.holdRecovery(operationId); owned.set(operationId, barrier); }
  return barrier;
}
function releaseBarrier(gate: ProjectGate, operationId: string): void {
  const owned = handles.get(gate); owned?.get(operationId)?.release(); owned?.delete(operationId);
}
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await handle.stat()).isDirectory()) throw recoveryRequired(); await handle.sync(); } finally { await handle.close(); }
}
export async function durableDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw recoveryRequired(); }
  catch (error) {
    if (!missing(error) || parent === path) throw error;
    await durableDirectory(parent); await mkdir(path, { mode: 0o700 });
  }
  if (parent !== path) await syncDirectory(parent);
}
export async function readBytes(path: string): Promise<Buffer | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await handle.stat()).isFile()) throw recoveryRequired(); return await handle.readFile(); } finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}
export async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
export function within(parent: string, child: string): boolean {
  const path = relative(parent, child); return !!path && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}
export async function safeFile(root: string, path: string): Promise<{ bytes: Buffer | null; mode: string }> {
  validateTreeEntries([{ path, mode: '100644' }]);
  let current = root;
  const components = path.split('/');
  for (const [index, part] of components.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < components.length - 1 ? !info.isDirectory() : !info.isFile())) throw recoveryRequired();
    } catch (error) { if (missing(error)) return { bytes: null, mode: '0' }; throw error; }
  }
  const bytes = await readBytes(current); const info = await lstat(current);
  return { bytes, mode: info.mode & 0o111 ? '100755' : '100644' };
}
export async function gitTree(root: string, oid: string): Promise<Map<string, { bytes: Buffer; mode: string; oid: string }>> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) throw recoveryRequired();
  const raw = (await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', oid] })).stdout;
  const text = raw.toString('utf8'); if (!Buffer.from(text).equals(raw) || (raw.length && !text.endsWith('\0'))) throw recoveryRequired();
  const records = raw.length ? text.slice(0, -1).split('\0') : [];
  const result = new Map<string, { bytes: Buffer; mode: string; oid: string }>();
  const entries = records.map(record => { const tab = record.indexOf('\t'); const [mode, type, object] = record.slice(0, tab).split(' ');
    if (tab < 0 || !type || !mode || !object) throw recoveryRequired(); return { path: record.slice(tab + 1), mode, oid: object, type }; });
  validateTreeEntries(entries);
  for (const entry of entries) {
    if (entry.type !== 'blob') throw recoveryRequired();
    const output = (await runGit({ cwd: root, args: ['cat-file', '--batch'], stdin: Buffer.from(entry.oid + '\n') })).stdout;
    const line = output.indexOf(10); const [object, type, length] = output.subarray(0, line).toString().split(' ');
    if (object !== entry.oid || type !== 'blob' || output.length !== line + 2 + Number(length)) throw recoveryRequired();
    const bytes = output.subarray(line + 1, -1);
    if (bytes.subarray(0, 200).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409,
      'Git LFS content requires its actual payload before materialization.', { paths: [entry.path] });
    result.set(entry.path, { bytes, mode: entry.mode, oid: entry.oid });
  }
  return result;
}
export async function assertOperationBasis(context: RecoveryProject, journal: ProjectGitJournalRecord): Promise<void> {
  const expected = { ...journal.basis, projectRevision: journal.recordsTransition?.projectRevision ?? journal.basis.projectRevision,
    localHead: journal.protection?.completed ? journal.protection.checkpointOid : journal.basis.localHead };
  if (!isDeepStrictEqual(await context.readBasis(), expected)) throw recoveryRequired();
}

async function assertArtifactBoundary(context: RecoveryContext, journal: ProjectGitJournalRecord): Promise<void> {
  const artifactRoot = journal.recoveryData?.operationRoot;
  if (!artifactRoot || !isAbsolute(context.operationRoot) || await realpath(context.operationRoot) !== context.operationRoot
    || !isAbsolute(artifactRoot) || !within(context.operationRoot, artifactRoot) || await realpath(artifactRoot) !== artifactRoot
    || within(context.root, artifactRoot) || artifactRoot === context.root) throw recoveryRequired();
}

/** The producer reader validates evidence; this consumer additionally enforces the injected recovery boundary. */
export async function readRecoveryCheckpoint(context: RecoveryContext, operationId: string, lockOwnerOperationId?: string) {
  const journal = context.store.getJournal(operationId); if (!journal) throw recoveryRequired();
  await assertArtifactBoundary(context, journal);
  if (journal.ownerOperationId || lockOwnerOperationId) {
    const owner = context.store.getJournal(lockOwnerOperationId ?? journal.ownerOperationId!); if (!owner) throw recoveryRequired();
    await assertArtifactBoundary(context, owner);
  }
  return readCheckpointPublication({ ...context, operationId, ...(lockOwnerOperationId ? { lockOwnerOperationId } : {}) });
}

export async function readMaterialization(context: RecoveryContext, operationId: string): Promise<MaterializationEvidence> {
  const journal = context.store.getJournal(operationId)!; const data = journal.recoveryData;
  await assertArtifactBoundary(context, journal); if (!data) throw recoveryRequired();
  const registration = context.store.getRegistration(operationId);
  if (registration?.materialization && (data.candidateOid !== registration.materialization.candidateOid
    || data.publicationMode !== registration.materialization.publicationMode || data.previewContentDigest !== registration.materialization.previewContentDigest)) throw recoveryRequired();
  const bytes = await readBytes(join(data.operationRoot, 'materialization.json')); if (!bytes) throw recoveryRequired();
  const evidence = JSON.parse(bytes.toString()) as MaterializationEvidence;
  const mode = data.publicationMode ?? 'commit';
  if (!['commit', 'fast_forward', 'initial_import'].includes(mode) || mode !== (evidence.publicationMode ?? 'commit')
    || (mode !== 'commit' && (evidence.protectionRequired || journal.protection))
    || evidence.operationId !== journal.id || evidence.projectId !== journal.projectId || evidence.treeOid !== data.candidateTreeOid
    || evidence.candidateOid !== data.candidateOid || computeCheckpointContentDigest(evidence) !== data.previewContentDigest
    || evidence.previewContentDigest !== data.previewContentDigest || !Array.isArray(evidence.paths) || evidence.paths.length !== data.paths.length
    || typeof evidence.protectionRequired !== 'boolean' || !Array.isArray(evidence.currentPortable)) throw recoveryRequired();
  if (mode === 'initial_import') {
    await assertInitialImportRegistration(context, operationId, data.candidateOid);
    if (data.baseHead !== null || data.index.oldDigest !== null || evidence.currentPortable.length || evidence.removedPaths.length
      || Object.keys(evidence.portableDigests).length || Object.values(evidence.sourceDigests).some(value => value !== 'missing')
      || Object.values(evidence.sourceModes).some(value => value !== '0')) throw recoveryRequired();
  }
  const tree = await gitTree(context.root, data.candidateTreeOid);
  const snapshot = parsePortableEntries(new Map([...tree].map(([path, entry]) => [path, entry.bytes])));
  if (portableImportMarker(snapshot) !== data.records?.importMarker) throw recoveryRequired();
  const originalIndex = data.index.oldDigest === null ? null : await readBytes(join(data.operationRoot, 'original.index'));
  if (data.index.backupPath !== (data.index.oldDigest === null ? null : join(data.operationRoot, 'original.index'))
    || (originalIndex === null ? null : sha256(originalIndex)) !== data.index.oldDigest) throw recoveryRequired();
  const base = data.baseHead ? await gitTree(context.root, data.baseHead) : new Map<string, { bytes: Buffer; mode: string }>();
  const baseDigest = computeCheckpointContentDigest({ sourceDigests: Object.fromEntries([...base].map(([path, item]) => [path, sha256(item.bytes)])),
    sourceModes: Object.fromEntries([...base].map(([path, item]) => [path, item.mode])), portableDigests: {}, removedPaths: [] });
  if (evidence.protectionRequired !== (baseDigest !== evidence.previewContentDigest)) throw recoveryRequired();
  for (const [index, item] of evidence.paths.entries()) {
    validateTreeEntries([{ path: item.path, mode: item.mode }]);
    const persisted = data.paths[index]!; const stem = join(data.operationRoot, sha256(Buffer.from(item.path)));
    if (item.path !== persisted.path || item.oldDigest !== persisted.oldDigest || item.candidateDigest !== persisted.candidateDigest
      || item.backupPath !== persisted.backupPath || item.backupPath !== (item.oldDigest === null ? null : stem + '.backup')
      || item.candidatePath !== (item.candidateDigest === null ? null : stem + '.candidate')
      || item.temporaryPath !== (item.candidateDigest === null ? null : join(dirname(join(context.root, item.path)), `.od-materialize-${data.index.ownerToken}-${sha256(Buffer.from(item.path))}.tmp`))
      || item.temporaryReceiptPath !== (item.candidateDigest === null ? null : stem + '.temporary.json')
      || (tree.get(item.path) ? sha256(tree.get(item.path)!.bytes) : null) !== item.candidateDigest
      || item.mode !== (tree.get(item.path)?.mode ?? '100644') || item.oldMode !== evidence.sourceModes[item.path]) throw recoveryRequired();
    for (const [path, digest] of [[item.backupPath, item.oldDigest], [item.candidatePath, item.candidateDigest]] as const) {
      if (path && sha256(await readBytes(path) ?? Buffer.alloc(0)) !== digest) throw recoveryRequired();
    }
  }
  return evidence;
}

export async function assertInitialImportRegistration(context: { root: string; store: ProjectGitStore }, operationId: string, candidateOid: string): Promise<void> {
  const registration = context.store.getRegistration(operationId); const journal = context.store.getJournal(operationId);
  const info = await lstat(context.root);
  if (!registration || registration.state === 'aborted' || registration.kind !== 'open' || !registration.hidden
    || registration.completion !== 'materialization' || registration.initialImport?.candidateOid !== candidateOid
    || registration.canonicalRoot !== context.root || registration.executionOperationId !== operationId
    || registration.executionBasis.localHead !== null || journal?.kind !== 'open' || journal.projectId !== registration.projectId
    || !isDeepStrictEqual(journal.basis, registration.executionBasis) || !info.isDirectory() || info.isSymbolicLink()
    || String(info.dev) !== registration.initialImport.rootDev || String(info.ino) !== registration.initialImport.rootIno) throw recoveryRequired();
}

async function validateContext(context: RecoveryContext, journal: ProjectGitJournalRecord) {
  context.store.assertDatabase(context.db);
  await assertArtifactBoundary(context, journal);
  const binding = journal.projectId ? context.store.getBinding(journal.projectId) : null;
  const repository = await discoverRepository(context.root);
  if (!binding || binding.canonicalRoot !== repository.root || binding.commonDir !== repository.commonDir
    || (binding.localBranch ?? binding.branch) !== context.branch || repository.branch !== context.branch
    || binding.generation !== journal.basis.bindingGeneration || journal.recoveryData?.index.path !== join(repository.gitDir, 'index')) throw recoveryRequired();
  await assertOperationBasis(context, journal); return repository;
}
async function actualCommit(context: RecoveryContext, journal: ProjectGitJournalRecord): Promise<void> {
  const data = journal.protection?.sealedCandidate ?? journal.recoveryData!;
  const tree = (await runGit({ cwd: context.root, args: ['rev-parse', '--verify', `${data.candidateOid}^{tree}`] })).stdout.toString().trim();
  const ancestry = (await runGit({ cwd: context.root, args: ['rev-list', '--parents', '--max-count=1', data.candidateOid] })).stdout.toString().trim().split(' ');
  if (tree !== data.candidateTreeOid || !isDeepStrictEqual(ancestry, [data.candidateOid, ...data.publicationParents])) throw recoveryRequired();
  const mode = journal.recoveryData!.publicationMode ?? 'commit';
  if (mode === 'fast_forward') {
    if (!data.publishBase || journal.protection || data.publishBase === data.candidateOid) throw recoveryRequired();
    try { await runGit({ cwd: context.root, args: ['merge-base', '--is-ancestor', data.publishBase, data.candidateOid] }); }
    catch { throw recoveryRequired(); }
  } else if (mode === 'initial_import') {
    await assertInitialImportRegistration(context, journal.id, data.candidateOid);
    if (data.publishBase !== null || journal.protection) throw recoveryRequired();
  } else if (mode !== 'commit' || (data.publishBase && data.publicationParents.filter(parent => parent === data.publishBase).length !== 1)) throw recoveryRequired();
}
const phaseOrder: MaterializePhase[] = ['prepared', 'protected', 'files_applied', 'records_applied', 'ref_published', 'index_published', 'complete'];

/** Caller owns the live barrier's exclusive slot. This function never re-enters a gate. */
export async function replayOperation(context: RecoveryContext, operationId: string): Promise<string> {
  let journal = context.store.getJournal(operationId)!; const data = journal.recoveryData!;
  const repository = await validateContext(context, journal); await actualCommit(context, journal);
  const checkpoint = journal.kind === 'checkpoint' ? await readRecoveryCheckpoint(context, operationId) : null;
  const evidence = checkpoint ? null : await readMaterialization(context, operationId);
  const paths: MaterializationPath[] = checkpoint ? checkpoint.evidence.portablePaths.map(path => ({ ...path,
    oldMode: checkpoint.evidence.sourceModes[path.path] ?? '0', temporaryPath: null, temporaryReceiptPath: null })) : evidence!.paths;
  const publication = journal.protection?.sealedCandidate ?? data;
  const indexBytes = await readBytes(join(data.operationRoot, 'candidate.index'));
  if (!indexBytes || sha256(indexBytes) !== data.index.candidateDigest) throw recoveryRequired();
  let oldIndexDigest = data.index.oldDigest;
  const oldPaths = new Map(paths.map(path => [path.path, { digest: path.oldDigest, mode: path.oldMode }]));
  if (journal.protection?.completed) {
    const ownerReceipt = await readBytes(join(data.operationRoot, 'index-lock.json'));
    const child = await readRecoveryCheckpoint(context, journal.protection.checkpointOperationId, ownerReceipt !== null ? journal.id : undefined);
    if (child.journal.journalPhase !== 'complete' || child.journal.ownerOperationId !== journal.id) throw recoveryRequired();
    oldIndexDigest = child.evidence.candidateIndexDigest;
    for (const path of child.evidence.portablePaths) oldPaths.set(path.path, { digest: path.candidateDigest, mode: path.candidateDigest === null ? '0' : path.mode });
  }
  const fileState = async (item: MaterializationPath) => {
    const file = await safeFile(context.root, item.path); return { digest: file.bytes === null ? null : sha256(file.bytes), mode: file.mode };
  };
  const targetState = (item: MaterializationPath) => ({ digest: item.candidateDigest, mode: item.candidateDigest === null ? '0' : item.mode });
  const source = checkpoint?.evidence ?? evidence!;
  const planned = new Set(paths.map(path => path.path));
  const checkFiles = async (applied: boolean) => {
    for (const item of paths) {
      const actual = await fileState(item);
      const fileIntent = phaseOrder.indexOf(journal.journalPhase!) >= 2;
      if (applied ? !isDeepStrictEqual(actual, targetState(item))
        : !isDeepStrictEqual(actual, oldPaths.get(item.path)) && (!fileIntent || !isDeepStrictEqual(actual, targetState(item)))) throw recoveryRequired();
    }
    // Unchanged captured paths are not write targets, but remain part of every publication fence.
    for (const path of Object.keys(source.sourceDigests)) if (!planned.has(path)) {
      const current = await safeFile(context.root, path);
      if ((current.bytes === null ? 'missing' : sha256(current.bytes)) !== source.sourceDigests[path] || current.mode !== source.sourceModes[path]) throw recoveryRequired();
    }
  };
  await checkFiles(phaseOrder.indexOf(journal.journalPhase!) > 2 || (journal.journalPhase === 'files_applied' && journal.phaseCompleted));
  if (repository.head !== publication.publishBase && repository.head !== publication.publishHead) throw recoveryRequired();
  const normal = await readBytes(data.index.path); const normalDigest = normal === null ? null : sha256(normal);
  if (normalDigest !== oldIndexDigest && normalDigest !== data.index.candidateDigest) throw recoveryRequired();
  const lockPath = data.index.path + '.lock'; const receiptPath = join(data.operationRoot, 'index-lock.json');
  const rawReceipt = await readBytes(receiptPath);
  let receipt: { ownerToken: string; dev: string; ino: string } | null = null;
  if (rawReceipt !== null) {
    const value: unknown = JSON.parse(rawReceipt.toString());
    if (!value || typeof value !== 'object' || !('ownerToken' in value) || typeof value.ownerToken !== 'string' || value.ownerToken !== data.index.ownerToken
      || !('dev' in value) || typeof value.dev !== 'string' || !/^\d+$/u.test(value.dev)
      || !('ino' in value) || typeof value.ino !== 'string' || !/^\d+$/u.test(value.ino)) throw recoveryRequired();
    receipt = { ownerToken: value.ownerToken as string, dev: value.dev, ino: value.ino };
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const owns = async (path: string) => {
    try { const info = await lstat(path, { bigint: true }); return info.isFile() && !info.isSymbolicLink() && receipt !== null
      && String(info.dev) === receipt.dev && String(info.ino) === receipt.ino; } catch (error) { if (missing(error)) return false; throw error; }
  };
  try {
    let lockExists = false;
    try { await lstat(lockPath); lockExists = true; } catch (error) { if (!missing(error)) throw error; }
    const indexAlreadyPublished = repository.head === publication.publishHead && normalDigest === data.index.candidateDigest && !lockExists;
    if (indexAlreadyPublished) { if (!receipt || !await owns(data.index.path)) throw recoveryRequired(); }
    else {
      if (lockExists) {
        if (!receipt || !await owns(lockPath)) throw recoveryRequired();
        handle = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
        const info = await handle.stat({ bigint: true });
        if (String(info.dev) !== receipt.dev || String(info.ino) !== receipt.ino) throw recoveryRequired();
        const bytes = await handle.readFile();
        if (bytes.length && sha256(bytes) !== data.index.candidateDigest) throw recoveryRequired();
      } else {
        if (normalDigest !== oldIndexDigest || repository.head !== publication.publishBase) throw recoveryRequired();
        handle = await open(lockPath, 'wx', 0o600);
        await context.afterEffect?.('index_lock_acquired');
        const info = await handle.stat({ bigint: true }); receipt = { ownerToken: data.index.ownerToken, dev: String(info.dev), ino: String(info.ino) };
        if (rawReceipt === null) await durableWrite(receiptPath, Buffer.from(JSON.stringify(receipt)));
        else {
          const receiptFile = await open(receiptPath, constants.O_WRONLY | constants.O_NOFOLLOW);
          try { const bytes = Buffer.from(JSON.stringify(receipt)); await receiptFile.writeFile(bytes); await receiptFile.truncate(bytes.length); await receiptFile.sync(); } finally { await receiptFile.close(); }
          await syncDirectory(data.operationRoot);
        }
        await syncDirectory(repository.gitDir); await context.afterEffect?.('index_lock_receipted');
      }
    }
    for (const phase of phaseOrder.slice(0, -1) as Exclude<MaterializePhase, 'complete'>[]) {
      journal = context.store.getJournal(operationId)!;
      const current = phaseOrder.indexOf(journal.journalPhase!); const next = phaseOrder.indexOf(phase);
      if (next < current || (next === current && journal.phaseCompleted)) continue;
      let state = journal.recoveryData!;
      context.store.setPhase(operationId, phase, state);
      if (phase === 'protected') {
        if (evidence?.protectionRequired && !journal.protection?.sealedCandidate) throw recoveryRequired();
        for (const item of state.paths) item.protected = true;
      }
      if (phase === 'files_applied') {
        for (const item of paths) {
          if (isDeepStrictEqual(await fileState(item), targetState(item))) {
            // Target bytes do not prove the preceding write/rename durability barrier completed.
            if (checkpoint && item.candidateDigest !== null) {
              const output = await open(join(context.root, item.path), constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const info = await output.stat();
                if (!info.isFile() || (info.mode & 0o111 ? '100755' : '100644') !== item.mode
                  || sha256(await output.readFile()) !== item.candidateDigest) throw recoveryRequired();
                await output.sync();
              } finally { await output.close(); }
            }
            await syncDirectory(dirname(join(context.root, item.path))); continue;
          }
          if (!isDeepStrictEqual(await fileState(item), oldPaths.get(item.path))) throw recoveryRequired();
          const target = join(context.root, item.path);
          if (item.candidatePath === null) { await unlink(target); await syncDirectory(dirname(target)); }
          else {
            const bytes = await readBytes(item.candidatePath); if (!bytes || sha256(bytes) !== item.candidateDigest) throw recoveryRequired();
            await durableDirectory(dirname(target));
            // Checkpoint candidates predate per-file sibling names; copy through their retained candidate only
            // when actual bytes still exactly match their old digest. A torn old write remains quarantined.
            if (checkpoint) {
              const output = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | (item.oldDigest === null ? constants.O_CREAT | constants.O_EXCL : 0), item.mode === '100755' ? 0o755 : 0o644);
              try { await output.writeFile(bytes); await output.truncate(bytes.length); await output.sync(); } finally { await output.close(); }
              await syncDirectory(dirname(target));
              await context.afterEffect?.('file_applied', item.path); continue;
            }
            const temporary = item.temporaryPath!;
            const existing = await readBytes(temporary);
            const temporaryReceipt = await readBytes(item.temporaryReceiptPath!);
            if (existing !== null) {
              if (!temporaryReceipt || sha256(existing) !== item.candidateDigest) throw recoveryRequired();
              const receipt: unknown = JSON.parse(temporaryReceipt.toString()); const info = await lstat(temporary, { bigint: true });
              if (!receipt || typeof receipt !== 'object' || !('ownerToken' in receipt) || typeof receipt.ownerToken !== 'string' || receipt.ownerToken !== state.index.ownerToken
                || !('dev' in receipt) || typeof receipt.dev !== 'string' || receipt.dev !== String(info.dev)
                || !('ino' in receipt) || typeof receipt.ino !== 'string' || receipt.ino !== String(info.ino)
                || info.isSymbolicLink() || !info.isFile()) throw recoveryRequired();
            } else {
              if (temporaryReceipt !== null) throw recoveryRequired();
              const output = await open(temporary, 'wx', item.mode === '100755' ? 0o755 : 0o644);
              try {
                const info = await output.stat({ bigint: true });
                await durableWrite(item.temporaryReceiptPath!, Buffer.from(JSON.stringify({ ownerToken: state.index.ownerToken, dev: String(info.dev), ino: String(info.ino) })));
                await output.writeFile(bytes); await output.sync();
              } finally { await output.close(); }
            }
            await syncDirectory(dirname(temporary));
            if (!isDeepStrictEqual(await fileState(item), oldPaths.get(item.path))) throw recoveryRequired();
            await rename(temporary, target); await syncDirectory(dirname(target));
          }
          await context.afterEffect?.('file_applied', item.path);
        }
        await checkFiles(true); for (const path of state.paths) path.applied = true;
      }
      if (phase === 'records_applied') {
        await checkFiles(true); await context.afterEffect?.('before_records_commit');
        if (checkpoint) context.store.completeRecords(operationId, { basis: journal.basis, importMarker: null, advanceProjectRevision: false }, () => undefined);
        else {
          const entries = await gitTree(context.root, state.candidateTreeOid); const snapshot = parsePortableEntries(new Map([...entries].map(([path, item]) => [path, item.bytes])));
          importPortableRecords({ db: context.db, store: context.store, operationId, projectId: journal.projectId!,
            cloneId: context.store.getBinding(journal.projectId!)!.cloneId, snapshot });
        }
        await context.afterEffect?.('after_records_commit');
        await context.afterDurablePhase?.(phase); continue;
      }
      if (phase === 'ref_published') {
        await checkFiles(true);
        if (handle) { await handle.write(indexBytes, 0, indexBytes.length, 0); await handle.truncate(indexBytes.length); await handle.sync(); }
        const currentHead = (await discoverRepository(context.root)).head;
        if (currentHead !== publication.publishHead) {
          if (currentHead !== publication.publishBase || !await owns(lockPath)) throw recoveryRequired();
          await context.afterEffect?.('before_ref_update');
          await checkFiles(true);
          const currentIndex = await readBytes(state.index.path);
          if ((currentIndex === null ? null : sha256(currentIndex)) !== oldIndexDigest || !await owns(lockPath)
            || sha256(await readBytes(lockPath) ?? Buffer.alloc(0)) !== state.index.candidateDigest) throw recoveryRequired();
          await runGit({ cwd: context.root, args: ['update-ref', '--no-deref', `refs/heads/${context.branch}`, publication.publishHead,
            publication.publishBase ?? '0'.repeat(publication.publishHead.length)] });
          await context.afterEffect?.('after_ref_update');
        }
        state.refPublished = true;
      }
      if (phase === 'index_published') {
        if ((await discoverRepository(context.root)).head !== publication.publishHead) throw recoveryRequired();
        await checkFiles(true);
        if (!indexAlreadyPublished) {
          const currentIndex = await readBytes(state.index.path);
          if (!await owns(lockPath) || sha256(await readBytes(lockPath) ?? Buffer.alloc(0)) !== state.index.candidateDigest
            || (currentIndex === null ? null : sha256(currentIndex)) !== oldIndexDigest) throw recoveryRequired();
          await context.afterEffect?.('before_index_rename');
          await checkFiles(true);
          if (!await owns(lockPath) || (await discoverRepository(context.root)).head !== publication.publishHead
            || sha256(await readBytes(lockPath) ?? Buffer.alloc(0)) !== state.index.candidateDigest
            || !isDeepStrictEqual(currentIndex, await readBytes(state.index.path))) throw recoveryRequired();
          await handle?.close(); handle = undefined;
          await rename(lockPath, state.index.path); await syncDirectory(repository.gitDir); await context.afterEffect?.('after_index_rename');
        }
        else await syncDirectory(repository.gitDir);
        state.index.published = true;
      }
      context.store.completePhase(operationId, phase, state); await context.afterDurablePhase?.(phase);
    }
    journal = context.store.getJournal(operationId)!;
    await checkFiles(true);
    if ((await discoverRepository(context.root)).head !== publication.publishHead
      || sha256(await readBytes(data.index.path) ?? Buffer.alloc(0)) !== data.index.candidateDigest) throw recoveryRequired();
    if (journal.kind !== 'checkpoint') {
      const snapshot = readPortableRecords(context.db, journal.projectId!);
      if (!snapshot || portableImportMarker(snapshot) !== journal.recoveryData!.records!.importMarker) throw recoveryRequired();
    }
    const registration = context.store.getRegistration(operationId);
    let completeRegistration: import('./registration.js').RegistrationTerminalCapability | undefined;
    if (registration?.state === 'pending') {
      if (!context.prepareRegistrationCompletion) throw recoveryRequired();
      completeRegistration = await context.prepareRegistrationCompletion(operationId);
      // The owner verifier is asynchronous: reprove actual final content after it settles.
      await checkFiles(true);
      if ((await discoverRepository(context.root)).head !== publication.publishHead
        || sha256(await readBytes(data.index.path) ?? Buffer.alloc(0)) !== data.index.candidateDigest) throw recoveryRequired();
      if (journal.kind !== 'checkpoint') {
        const current = readPortableRecords(context.db, journal.projectId!);
        if (!current || portableImportMarker(current) !== journal.recoveryData!.records!.importMarker) throw recoveryRequired();
      }
    }
    if (completeRegistration) completeRegistration.completeMaterialization();
    else context.store.completeMaterialization(operationId, { basis: journal.basis, advanceProjectRevision: journal.kind !== 'checkpoint' });
    return publication.publishHead;
  } finally { await handle?.close(); }
}

/** Synchronous trusted registration resolution seeds all barriers before the first asynchronous step.
 * Bootstrap must await this before exposing current-state reads or mutation/automatic scheduling.
 */
export async function recoverProjectOperations(input: {
  db: Database.Database; store: ProjectGitStore; operationRoot: string;
  resolveProject(projectId: string): RecoveryProject;
}): Promise<void> {
  input.store.assertDatabase(input.db);
  const pending = input.store.listRecoverable().filter(op => op.journalPhase !== null && op.recoveryData !== null);
  const projects = new Map<string, RecoveryProject>();
  for (const op of pending) if (op.projectId && !projects.has(op.projectId)) projects.set(op.projectId, input.resolveProject(op.projectId));
  for (const op of pending) if (op.projectId) recoveryBarrier(projects.get(op.projectId)!.gate, op.ownerOperationId ?? op.id);
  for (const child of pending) if (child.ownerOperationId) {
    const owner = input.store.getJournal(child.ownerOperationId);
    if (!owner?.recoveryData || owner.kind === 'checkpoint' || owner.journalPhase === 'complete' || owner.projectId !== child.projectId
      || !isDeepStrictEqual(owner.basis, child.basis)) throw recoveryRequired();
  }
  for (const op of pending.filter(item => !item.ownerOperationId)) {
    if (!op.projectId) throw recoveryRequired();
    const context = { ...input, ...projects.get(op.projectId)! }; const barrier = recoveryBarrier(context.gate, op.id);
    try {
      if (!op.recoveryData) throw recoveryRequired();
      if (op.kind !== 'checkpoint') await ensureMaterializationProtection(context, op.id, barrier);
      await barrier.exclusive(() => replayOperation(context, op.id));
      releaseBarrier(context.gate, op.id);
    } catch {
      input.store.updateOperation(op.id, { status: 'waiting', phase: 'waiting_idle', result: null,
        error: { code: 'RECOVERY_REQUIRED', message: 'Retained materials need recovery before project access.' } });
      throw recoveryRequired();
    }
  }
}

export function finishRecovery(context: RecoveryProject, operationId: string): void { releaseBarrier(context.gate, operationId); }
