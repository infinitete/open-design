import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { PortableSnapshot, ProjectGitBasis } from '@open-design/contracts';
import type { ProjectGitRecoveryData, ProjectGitStore } from '../../storage/project-git.js';
import type { ProjectGate, ProjectRecoveryBarrier } from './gate.js';
import { GitDomainError } from './errors.js';
import { assertGitIdentity, runGit } from './git-process.js';
import { discoverRepository, validateBranch, validateTreeEntries } from './repository.js';
import { computeCheckpointContentDigest, isPrivateProjectGitPath, journalCheckpoint, prepareCheckpoint, publishCheckpoint } from './checkpoint.js';
import { parsePortableEntries, portableImportMarker } from './portable.js';
import { assertOperationBasis, durableDirectory, durableWrite, finishRecovery, gitTree, readBytes, readMaterialization,
  readRecoveryCheckpoint, recoveryBarrier, recoveryRequired, replayOperation, safeFile, sha256, syncDirectory, within } from './recovery.js';
import type { MaterializationEvidence, MaterializationPath, RecoveryContext } from './recovery.js';

export type MaterializePhase = 'prepared' | 'protected' | 'files_applied' | 'records_applied' | 'ref_published' | 'index_published' | 'complete';
export type MaterializeEffect = 'file_applied' | 'before_records_commit' | 'after_records_commit' | 'before_ref_update'
  | 'after_ref_update' | 'before_index_rename' | 'after_index_rename' | 'index_lock_acquired' | 'index_lock_receipted';
export interface MaterializeInput {
  projectId: string; root: string; branch: string; operationId: string; operationDir: string;
  basis: ProjectGitBasis; candidateOid: string; snapshot: PortableSnapshot; store: ProjectGitStore; db: Database.Database; gate: ProjectGate;
  /** Frozen caller-captured semantic content identity, never refreshed for an old request. */
  previewContentDigest: string;
  readBasis(): ProjectGitBasis | Promise<ProjectGitBasis>;
  exportCurrentPortable(): Promise<Map<string, Uint8Array>>;
  gitEnv?: Record<string, string>;
  afterDurablePhase?: (phase: MaterializePhase) => Promise<void>;
  afterEffect?: (point: MaterializeEffect, path?: string) => Promise<void>;
}
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original project basis or content changed.');
const busy = () => new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'External Git work requires attention.');

async function sourcePaths(root: string): Promise<string[]> {
  const outputs = await Promise.all([['ls-files', '--cached', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']].map(args => runGit({ cwd: root, args })));
  const paths = outputs.flatMap(({ stdout }) => {
    const text = stdout.toString('utf8'); if (!Buffer.from(text).equals(stdout) || (stdout.length && !text.endsWith('\0'))) throw recoveryRequired();
    return stdout.length ? text.slice(0, -1).split('\0') : [];
  });
  const unique = [...new Set(paths)].sort(); validateTreeEntries(unique.map(path => ({ path, mode: '100644' }))); return unique;
}
async function capture(root: string, paths: string[]) {
  const sourceDigests: Record<string, string> = Object.create(null); const sourceModes: Record<string, string> = Object.create(null);
  const bytes = new Map<string, Buffer>();
  for (const path of paths) {
    const current = await safeFile(root, path); sourceDigests[path] = current.bytes === null ? 'missing' : sha256(current.bytes); sourceModes[path] = current.mode;
    if (current.bytes !== null) bytes.set(path, current.bytes);
  }
  return { sourceDigests, sourceModes, bytes };
}

async function prepare(input: MaterializeInput): Promise<void> {
  input.store.assertDatabase(input.db);
  if (!/^[a-f0-9]{64}$/u.test(input.previewContentDigest)) throw changed();
  const journal = input.store.getJournal(input.operationId);
  if (!journal || journal.kind === 'checkpoint' || journal.projectId !== input.projectId || !isDeepStrictEqual(journal.basis, input.basis)
    || !isDeepStrictEqual(await input.readBasis(), input.basis)) throw changed();
  if (journal.recoveryData || input.store.listRecoverable().some(op => op.id !== input.operationId && op.projectId === input.projectId && op.recoveryData)) throw recoveryRequired();
  await validateBranch(input.branch);
  const repository = await discoverRepository(input.root); const binding = input.store.getBinding(input.projectId);
  if (!binding || binding.canonicalRoot !== repository.root || binding.commonDir !== repository.commonDir || binding.branch !== input.branch
    || repository.branch !== input.branch || repository.head !== input.basis.localHead) throw changed();
  for (const path of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'sequencer']) {
    try { await lstat(join(repository.gitDir, path)); throw busy(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw busy(); }
  }
  if (repository.head && (await runGit({ cwd: input.root, args: ['diff-index', '--cached', '--raw', '-z', repository.head] })).stdout.length) throw busy();
  if (repository.head === null && (await runGit({ cwd: input.root, args: ['ls-files', '--stage', '-z'] })).stdout.length) throw busy();
  await assertGitIdentity({ cwd: input.root, ...(input.gitEnv ? { env: input.gitEnv } : {}) });
  const target = await gitTree(input.root, input.candidateOid);
  const privatePaths = [...target.keys()].filter(isPrivateProjectGitPath);
  if (privatePaths.length) throw new GitDomainError('VALIDATION_FAILED', 400, 'Private configuration cannot be materialized.', { paths: privatePaths });
  const snapshot = parsePortableEntries(new Map([...target].map(([path, entry]) => [path, entry.bytes])));
  if (portableImportMarker(snapshot) !== portableImportMarker(input.snapshot) || snapshot.manifest.repositoryProjectId !== binding.repositoryProjectId) throw changed();
  const treeOid = (await runGit({ cwd: input.root, args: ['rev-parse', '--verify', `${input.candidateOid}^{tree}`] })).stdout.toString().trim();
  const parents = (await runGit({ cwd: input.root, args: ['rev-list', '--parents', '--max-count=1', input.candidateOid] })).stdout.toString().trim().split(' ').slice(1);
  if (new Set(parents).size !== parents.length || (repository.head && parents.filter(parent => parent === repository.head).length !== 1)) throw changed();
  const base = repository.head ? await gitTree(input.root, repository.head) : new Map<string, { bytes: Buffer; mode: string }>();
  const portable = new Map([...await input.exportCurrentPortable()].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  parsePortableEntries(portable);
  for (const path of portable.keys()) if (!path.startsWith('.open-design/')) throw changed();
  const beforePaths = await sourcePaths(input.root);
  const allPaths = [...new Set([...beforePaths, ...base.keys(), ...target.keys(), ...portable.keys()])].sort();
  validateTreeEntries(allPaths.map(path => ({ path, mode: '100644' })));
  const source = await capture(input.root, allPaths);
  const portableDigests: Record<string, string> = Object.create(null);
  for (const [path, bytes] of portable) portableDigests[path] = sha256(bytes);
  const removedPaths = [...base.keys()].filter(path => path.startsWith('.open-design/') && !portable.has(path));
  for (const path of [...portable.keys(), ...removedPaths]) {
    const old = source.bytes.get(path); const oldBase = base.get(path)?.bytes;
    if ((old ? sha256(old) : null) !== (oldBase ? sha256(oldBase) : null)) throw changed();
  }
  const previewContentDigest = input.previewContentDigest;
  if (computeCheckpointContentDigest({ ...source, portableDigests, removedPaths }) !== previewContentDigest) throw changed();
  const baseDigests = Object.fromEntries([...base].map(([path, item]) => [path, sha256(item.bytes)]));
  const baseModes = Object.fromEntries([...base].map(([path, item]) => [path, item.mode]));
  const protectionRequired = computeCheckpointContentDigest({ sourceDigests: baseDigests, sourceModes: baseModes, portableDigests: {}, removedPaths: [] }) !== previewContentDigest;
  if (!isAbsolute(input.operationDir)) throw recoveryRequired();
  await durableDirectory(input.operationDir); const operationParent = await realpath(input.operationDir);
  if (operationParent !== input.operationDir || operationParent === repository.root || within(repository.root, operationParent)) throw recoveryRequired();
  const operationRoot = await mkdtemp(join(operationParent, 'materialize-')); await syncDirectory(operationParent);
  const ownerToken = randomUUID(); const paths: MaterializationPath[] = [];
  // Original tracked, explicit target and current portable paths only. Other untracked files remain untouched.
  for (const path of [...new Set([...base.keys(), ...target.keys(), ...portable.keys()])].sort()) {
    const old = source.bytes.get(path); const next = target.get(path); const oldDigest = old === undefined ? null : sha256(old);
    const candidateDigest = next ? sha256(next.bytes) : null;
    const protectedDigest = path.startsWith('.open-design/') ? portableDigests[path] ?? null : oldDigest;
    if (oldDigest === candidateDigest && (next?.mode ?? '0') === source.sourceModes[path] && protectedDigest === candidateDigest) continue;
    const stem = join(operationRoot, sha256(Buffer.from(path)));
    const backupPath = old === undefined ? null : stem + '.backup'; const candidatePath = next ? stem + '.candidate' : null;
    if (backupPath) await durableWrite(backupPath, old!); if (candidatePath) await durableWrite(candidatePath, next!.bytes);
    paths.push({ path, oldDigest, candidateDigest, backupPath, candidatePath, protected: false, applied: false,
      oldMode: source.sourceModes[path] ?? '0', mode: next?.mode ?? '100644',
      temporaryReceiptPath: next ? stem + '.temporary.json' : null,
      temporaryPath: next ? join(repository.root, path.split('/').slice(0, -1).join('/'), `.od-materialize-${ownerToken}-${sha256(Buffer.from(path))}.tmp`) : null });
  }
  const indexPath = join(repository.gitDir, 'index'); const originalIndex = await readBytes(indexPath);
  if (originalIndex) await durableWrite(join(operationRoot, 'original.index'), originalIndex);
  const privateIndex = join(operationRoot, 'candidate.index');
  await runGit({ cwd: input.root, args: ['read-tree', input.candidateOid], env: { ...input.gitEnv, GIT_INDEX_FILE: privateIndex } });
  const candidateIndex = await readBytes(privateIndex); if (!candidateIndex) throw recoveryRequired();
  const indexHandle = await open(privateIndex, 'r'); try { await indexHandle.sync(); } finally { await indexHandle.close(); }
  const evidence: MaterializationEvidence = { operationId: input.operationId, projectId: input.projectId, treeOid, candidateOid: input.candidateOid,
    sourceDigests: source.sourceDigests, sourceModes: source.sourceModes, portableDigests, removedPaths, previewContentDigest, protectionRequired,
    currentPortable: [...portable].map(([path, bytes]) => [path, bytes.toString('base64')]), paths };
  await durableWrite(join(operationRoot, 'materialization.json'), Buffer.from(JSON.stringify(evidence)));
  if (!isDeepStrictEqual(beforePaths, await sourcePaths(input.root))
    || !isDeepStrictEqual(source, await capture(input.root, allPaths)) || !isDeepStrictEqual(input.basis, await input.readBasis())
    || (await discoverRepository(input.root)).head !== input.basis.localHead
    || !isDeepStrictEqual(originalIndex, await readBytes(indexPath))) throw changed();
  const data: ProjectGitRecoveryData = { operationRoot, baseHead: input.basis.localHead, previewContentDigest, candidateTreeOid: treeOid,
    publishBase: input.basis.localHead, publicationParents: parents, publishHead: input.candidateOid, candidateOid: input.candidateOid,
    paths: paths.map(({ candidatePath: _candidate, mode: _mode, oldMode: _oldMode, temporaryPath: _temporary, temporaryReceiptPath: _receipt, ...path }) => path),
    index: { path: indexPath, oldDigest: originalIndex === null ? null : sha256(originalIndex), candidateDigest: sha256(candidateIndex),
      backupPath: originalIndex === null ? null : join(operationRoot, 'original.index'), ownerToken, published: false },
    records: { importMarker: portableImportMarker(snapshot), applied: false }, refPublished: false };
  recoveryBarrier(input.gate, input.operationId);
  input.store.setPhase(input.operationId, 'prepared', data); input.store.completePhase(input.operationId, 'prepared', data);
  await input.afterDurablePhase?.('prepared');
}

/** Reuses original child journals on restart; only an as-yet unstarted protection creates a candidate.
 * Every checkpoint call is separately gated through an operation-owned live capability facade.
 */
export async function ensureMaterializationProtection(context: RecoveryContext, operationId: string, barrier: ProjectRecoveryBarrier): Promise<void> {
  let journal = context.store.getJournal(operationId)!;
  if (journal.protection?.sealedCandidate) return;
  if (journal.journalPhase !== 'prepared' && journal.journalPhase !== 'protected') return;
  let evidence!: MaterializationEvidence;
  await barrier.exclusive(async () => {
    journal = context.store.getJournal(operationId)!;
    if (journal.protection && !journal.protection.completed) {
      const completed = context.store.getJournal(journal.protection.checkpointOperationId);
      if (completed?.journalPhase === 'complete') {
        await readRecoveryCheckpoint(context, completed.id);
        context.store.completeProtection(operationId, { basis: journal.basis, checkpointOperationId: completed.id, checkpointOid: journal.protection.checkpointOid });
        journal = context.store.getJournal(operationId)!;
      }
    }
    await assertOperationBasis(context, journal);
    evidence = await readMaterialization(context, operationId);
    if (journal.journalPhase === 'prepared') context.store.setPhase(operationId, 'protected', journal.recoveryData!);
  });
  if (!evidence.protectionRequired) return;
  let child = context.store.listRecoverable().find(op => op.ownerOperationId === operationId);
  journal = context.store.getJournal(operationId)!;
  if (journal.protection) child = context.store.getJournal(journal.protection.checkpointOperationId)!;
  if (child && (child.ownerOperationId !== journal.id || child.projectId !== journal.projectId || !isDeepStrictEqual(child.basis, journal.basis)
    || (journal.protection && journal.protection.checkpointOid !== child.recoveryData?.publishHead))) throw recoveryRequired();
  if (child && !child.recoveryData) throw recoveryRequired();
  if (!child) {
    await barrier.exclusive(async () => {
      child = context.store.enqueueCheckpoint({ projectId: journal.projectId!, actorId: journal.actorId, idempotencyKey: `protect:${operationId}`,
        requestDigest: evidence.previewContentDigest, payload: {}, basis: journal.basis, ownerOperationId: operationId });
    });
    const childId = child!.id;
    const scopedGate: ProjectGate = { ...context.gate, exclusive: work => barrier.exclusive(async () => {
      const outer = context.store.getJournal(operationId)!; const current = context.store.getJournal(childId);
      if (!current || current.ownerOperationId !== barrier.operationId || current.projectId !== outer.projectId
        || !isDeepStrictEqual(current.basis, outer.basis) || outer.journalPhase !== 'protected' || outer.phaseCompleted
        || (outer.protection && outer.protection.checkpointOperationId !== childId)) throw recoveryRequired();
      return work();
    }) };
    const candidate = await prepareCheckpoint({ root: context.root, operationDir: context.operationRoot, head: journal.basis.localHead,
      portableEntries: new Map(evidence.currentPortable.map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')])),
      coordination: { projectId: journal.projectId!, basis: journal.basis, gate: scopedGate, readBasis: context.readBasis, ...(context.gitEnv ? { gitEnv: context.gitEnv } : {}) } });
    if (!candidate.commitOid || candidate.previewContentDigest !== evidence.previewContentDigest) throw recoveryRequired();
    const publication = { root: context.root, branch: context.branch, operationId: childId, candidate, store: context.store };
    await journalCheckpoint(publication);
    await barrier.exclusive(async () => context.store.prepareProtection(operationId, { basis: journal.basis, checkpointOperationId: childId, checkpointOid: candidate.commitOid! }));
    await publishCheckpoint(publication); child = context.store.getJournal(childId)!;
  } else if (child.journalPhase !== 'complete') {
    if (!journal.protection) await barrier.exclusive(async () => context.store.prepareProtection(operationId,
      { basis: journal.basis, checkpointOperationId: child!.id, checkpointOid: child!.recoveryData!.publishHead }));
    await barrier.exclusive(() => replayOperation(context, child!.id)); child = context.store.getJournal(child.id)!;
  }
  await barrier.exclusive(async () => {
    const receipt = await readRecoveryCheckpoint(context, child!.id);
    if (receipt.journal.ownerOperationId !== operationId) throw recoveryRequired();
    context.store.completeProtection(operationId, { basis: journal.basis, checkpointOperationId: child!.id, checkpointOid: child!.recoveryData!.publishHead });
    journal = context.store.getJournal(operationId)!;
    const paths = [...new Set([...await sourcePaths(context.root), ...Object.keys(evidence.sourceDigests)])].sort();
    const current = await capture(context.root, paths);
    if (computeCheckpointContentDigest({ ...current, portableDigests: evidence.portableDigests, removedPaths: evidence.removedPaths }) !== evidence.previewContentDigest) throw recoveryRequired();
    if (!journal.protection!.sealedCandidate) {
      const data = journal.recoveryData!; const protectedOid = child!.recoveryData!.publishHead;
      const parents = journal.basis.localHead === null ? [protectedOid, ...data.publicationParents]
        : data.publicationParents.map(parent => parent === journal.basis.localHead ? protectedOid : parent);
      const oid = (await runGit({ cwd: context.root, args: ['commit-tree', data.candidateTreeOid, ...parents.flatMap(parent => ['-p', parent])],
        ...(context.gitEnv ? { env: context.gitEnv } : {}), stdin: Buffer.from('Open Design materialization\n') })).stdout.toString().trim();
      context.store.sealProtectedCandidate(operationId, journal.basis, { previewContentDigest: data.previewContentDigest, candidateTreeOid: data.candidateTreeOid,
        publishBase: protectedOid, publicationParents: parents, candidateOid: oid, publishHead: oid });
    }
  });
}

export async function materializeProject(input: MaterializeInput): Promise<string> {
  const context: RecoveryContext = { ...input, operationRoot: input.operationDir };
  try {
    await input.gate.exclusive(() => prepare(input));
    const barrier = recoveryBarrier(input.gate, input.operationId);
    await ensureMaterializationProtection(context, input.operationId, barrier);
    const oid = await barrier.exclusive(() => replayOperation(context, input.operationId));
    finishRecovery(context, input.operationId); await input.afterDurablePhase?.('complete'); return oid;
  } catch (error) {
    const journal = input.store.getJournal(input.operationId);
    if (journal?.recoveryData && journal.journalPhase !== 'complete') input.store.updateOperation(input.operationId,
      { status: 'waiting', phase: 'waiting_idle', result: null, error: { code: 'RECOVERY_REQUIRED', message: 'Retained materials need recovery before project access.' } });
    // Definitive no-intent readback means no project effects were admitted; uncertain/persisted intent stays held.
    else if (journal && !journal.recoveryData) finishRecovery(context, input.operationId);
    throw error;
  }
}
