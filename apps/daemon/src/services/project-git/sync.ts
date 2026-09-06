import { randomUUID, createHash } from 'node:crypto';
import { realpath, readFile, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { ApiError, ProjectGitBasis, ProjectGitPhase } from '@open-design/contracts';
import type { ProjectGitBindingRecord, ProjectGitStore } from '../../storage/project-git.js';
import type { ProjectGate } from './gate.js';
import { GitDomainError } from './errors.js';
import { runGit, runGitTransport } from './git-process.js';
import { discoverObjectStore, discoverRepository, validateTreeEntries } from './repository.js';
import { prepareCheckpoint, publishCheckpoint, isPrivateProjectGitPath, computeCheckpointContentDigest } from './checkpoint.js';
import { exportPortableProject, parsePortableEntries } from './portable.js';
import { nativeHistoryRoot, projectGitPathsAtRoot } from './paths.js';
import { readBindingEvidence } from './binding-evidence.js';
import { mergeFileTrees } from './merge.js';
import { materializeProject } from './materialize.js';
import { gitTree, safeFile, recoverProjectOperations, within, sha256 } from './recovery.js';

const actorId = 'project-git-background';
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The project state changed. Refresh and retry.');
const pendingRecovery = () => new GitDomainError('RECOVERY_REQUIRED', 409, 'Recover the original project operation before starting new work.');
function basisFor(binding: ProjectGitBindingRecord): ProjectGitBasis {
  return { projectRevision: binding.projectRevision, contentRevision: binding.contentRevision,
    bindingGeneration: binding.generation, localHead: binding.localHead, remoteHead: binding.observedRemoteHead };
}

export function chooseSyncAction(input: {
  local: string; remote: string | null; localIsAncestor: boolean; remoteIsAncestor: boolean; remoteWasRewritten: boolean;
}): 'equal' | 'push' | 'fast_forward' | 'merge' | 'remote_rewritten' {
  if (input.remoteWasRewritten) return 'remote_rewritten';
  if (input.local === input.remote) return 'equal';
  if (input.remote === null || input.remoteIsAncestor) return 'push';
  return input.localIsAncestor ? 'fast_forward' : 'merge';
}

/** Trusted composition ports; none are request, repository-config, or journal-supplied callbacks. */
export interface ProjectGitSyncDeps {
  store: ProjectGitStore;
  now(): number;
  random(): number;
  checkpoint(projectId: string): Promise<string | null>;
  fetchTarget(projectId: string): Promise<string | null>;
  mergeAndMaterialize(projectId: string, local: string, remote: string): Promise<string>;
  pushTarget(projectId: string, oid: string, generation: number): Promise<void>;
  confirmTarget(projectId: string): Promise<string | null>;
  isAncestor(projectId: string, ancestor: string, descendant: string): Promise<boolean>;
  detect(projectId: string): Promise<void>;
  /** Coherent automatic detection/checkpoint, sharing the sole observed-content quiet clock. */
  automaticReady(projectId: string): Promise<boolean>;
}
export interface ProjectGitSyncRuntime extends ProjectGitSyncDeps { readonly recoveryReady: Promise<void> }

function networkOperations(store: ProjectGitStore, projectId: string) {
  return store.listPendingOperations().filter(op => op.projectId === projectId && op.actorId === actorId
    && op.kind === 'sync' && op.journalPhase === null && op.payload !== null
    && typeof op.payload === 'object' && !Array.isArray(op.payload) && op.payload.lane === 'network');
}
function assertNoRecovery(store: ProjectGitStore, projectId: string): void {
  if (store.listRecoverable().some(op => op.projectId === projectId && op.recoveryData !== null)) throw pendingRecovery();
}
function publicError(error: unknown): ApiError {
  if (error instanceof GitDomainError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  return { code: 'CONFLICT', message: 'Project synchronization failed. Check connectivity and retry.' };
}
function errorPhase(error: unknown): ProjectGitPhase {
  if (!(error instanceof GitDomainError)) return 'pending_push';
  if (error.code === 'GIT_AUTH_REQUIRED' || error.code === 'GIT_PERMISSION_DENIED') return 'auth_required';
  if (error.code === 'RECOVERY_REQUIRED' || error.code === 'PROJECT_BUSY') return 'waiting_idle';
  if (error.code === 'EXTERNAL_GIT_BUSY') return 'external_git_busy';
  if (error.details?.reason === 'remote_rewritten' || error.details?.reason === 'merge_conflict' || error.details?.reason === 'external_head_conflict'
    || error.code === 'PORTABLE_FORMAT_UNSUPPORTED' || error.code === 'PORTABLE_RESOURCE_MISSING'
    || error.code === 'VALIDATION_FAILED') return 'conflict';
  return 'pending_push';
}

/** A single reconciliation pass. Success requires exact remote confirmation and exact outbox ACK. */
export async function syncProject(input: { projectId: string; oneShot: boolean; deps: ProjectGitSyncDeps }): Promise<void> {
  const { projectId, oneShot, deps } = input; const { store } = deps;
  assertNoRecovery(store, projectId);
  if (oneShot) await deps.checkpoint(projectId);
  else if (!await deps.automaticReady(projectId)) return;
  let binding = store.getBinding(projectId);
  if (!binding?.localHead || !binding.remoteUrl || (!oneShot && !binding.autoSync)) return;
  const previous = networkOperations(store, projectId).filter(op => op.basis.bindingGeneration === binding!.generation);
  if (!oneShot && previous.some(op => ['auth_required', 'conflict'].includes(op.phase))) return;
  const queued = store.queuePush(projectId, binding.generation, binding.localHead);
  if (!oneShot && queued.nextAttemptAt > deps.now()) return;
  const original = binding; const generation = binding.generation;
  const operation = store.enqueueOperation({ projectId, actorId, kind: 'sync', basis: basisFor(binding),
    idempotencyKey: randomUUID(), requestDigest: randomUUID(), payload: { lane: 'network' } });
  for (const op of previous) store.updateOperation(op.id, { status: 'failed', phase: op.phase, result: op.result, error: op.error });
  store.updateOperation(operation.id, { status: 'running', phase: 'syncing', result: null, error: null });
  const current = () => {
    const latest = store.getBinding(projectId);
    if (!latest || latest.generation !== generation || latest.branch !== original.branch || latest.remoteUrl !== original.remoteUrl) throw changed();
    assertNoRecovery(store, projectId); return latest;
  };
  let target = binding.localHead;
  const paused = () => {
    if (oneShot || current().autoSync) return false;
    store.updateOperation(operation.id, { status: 'waiting', phase: 'paused', result: { head: target }, error: null }); return true;
  };
  try {
    const remote = await deps.fetchTarget(projectId); binding = current();
    if (binding.localHead !== target) throw changed();
    if (paused()) return;
    const observed = binding.observedRemoteHead;
    const rewritten = observed !== null && (remote === null || !await deps.isAncestor(projectId, observed, remote));
    if (current().localHead !== target) throw changed();
    const action = chooseSyncAction({ local: target, remote, remoteWasRewritten: rewritten,
      localIsAncestor: remote !== null && await deps.isAncestor(projectId, target, remote),
      remoteIsAncestor: remote !== null && await deps.isAncestor(projectId, remote, target) });
    if (current().localHead !== target) throw changed();
    if (action === 'remote_rewritten') throw new GitDomainError('CONFLICT', 409,
      'The previously observed remote history was rewritten or deleted. Review both histories before resolving.',
      { reason: 'remote_rewritten', nextStep: 'Review and resolve the remote history change.' });
    store.observeRemote(projectId, generation, remote);
    if (action === 'merge' || action === 'fast_forward') {
      target = await deps.mergeAndMaterialize(projectId, target, remote!); current();
    }
    if (current().localHead !== target) throw changed();
    store.queuePush(projectId, generation, target);
    if (target !== remote) {
      if (paused()) return;
      try { await deps.pushTarget(projectId, target, generation); }
      catch (error) {
        // A rejection can race another writer. Fetch and compare; never blindly repeat the push.
        if (error instanceof GitDomainError && error.code === 'CONFLICT') {
          if (paused()) return;
          const advanced = await deps.fetchTarget(projectId); current();
          if (advanced !== remote) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The remote changed during push. Reconcile again.');
        }
        throw error;
      }
    }
    if (paused()) return;
    const confirmed = await deps.confirmTarget(projectId); current();
    if (confirmed !== target) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The remote changed before confirmation. Reconcile again.');
    if (!store.ackPush(projectId, generation, target)) throw changed();
    store.observeRemote(projectId, generation, confirmed);
    store.updateOperation(operation.id, { status: 'succeeded', phase: 'synced', result: { head: target }, error: null });
  } catch (error) {
    const phase = errorPhase(error);
    const queue = store.listDuePushes(Number.MAX_SAFE_INTEGER).find(item => item.projectId === projectId && item.generation === generation);
    if (queue?.targetOid === target) store.deferPush(projectId, generation, target,
      ['auth_required', 'conflict'].includes(phase) ? Number.MAX_SAFE_INTEGER : deps.now() + retryDelayMs(queue.attempts, deps.random));
    store.updateOperation(operation.id, { status: 'waiting', phase, result: { head: target }, error: publicError(error) });
    throw error;
  }
}

export interface ProjectGitSyncProject {
  nativeLegacyRoot?: string;
  root: string; branch: string; gate: ProjectGate; gitEnv?: Record<string, string>;
  readOwnedResource?: (reference: string) => Promise<Uint8Array | null>;
  prepareRegistrationCompletion?: (operationId: string) => Promise<import('./registration.js').RegistrationTerminalCapability>;
}

/** Resolved daemon roots and pre-registered lease-backed gates are required before construction. */
export function createProjectGitSyncDeps(input: {
  db: Database.Database; store: ProjectGitStore; operationRoot: string; preparationRoot: string;
  resolveProject(projectId: string): ProjectGitSyncProject;
  now(): number; random(): number;
}): ProjectGitSyncRuntime {
  const { store } = input; store.assertDatabase(input.db);
  function binding(id: string) { const found = store.getBinding(id); if (!found) throw changed(); return found; }
  const readBasis = (id: string) => basisFor(binding(id));
  // This public recovery entry seeds every prepared hold synchronously, before its first await.
  const recoveryInput = { ...input, resolveProject: (id: string) => ({ ...input.resolveProject(id), readBasis: () => readBasis(id),
    exportCurrentPortable: () => exported(id, binding(id), input.resolveProject(id)) }) };
  const ready = recoverProjectOperations(recoveryInput); void ready.catch(() => {});
  async function context(id: string) {
    await ready; assertNoRecovery(store, id);
    const b = binding(id); const project = input.resolveProject(id);
    const repository = await discoverRepository(project.root);
    if (repository.root !== b.canonicalRoot || project.root !== repository.root || repository.commonDir !== b.commonDir
      || repository.branch !== (b.localBranch ?? b.branch) || project.branch !== (b.localBranch ?? b.branch)) throw changed();
    for (const root of [input.operationRoot, input.preparationRoot]) {
      if (!isAbsolute(root) || root !== await realpath(root) || within(project.root, root) || within(repository.commonDir, root)) {
        throw new GitDomainError('VALIDATION_FAILED', 400, 'Preparation roots must be canonical injected directories outside the project.');
      }
    }
    return { b, project, repository };
  }
  function unchanged(id: string, basis: ProjectGitBasis) { if (!isDeepStrictEqual(readBasis(id), basis)) throw changed(); }
  async function exported(id: string, b: ProjectGitBindingRecord, project: ProjectGitSyncProject) {
    const nativeLegacyRoot = await nativeHistoryRoot(project.root, project.nativeLegacyRoot);
    // Recovery must not re-export from a newly resolved native archive identity.
    for (const operation of store.listPendingOperations().filter(op => op.projectId === id)) {
      const payload = operation.payload as { evidencePath?: unknown; previewId?: string };
      const preview = payload.previewId ? store.getJournal(payload.previewId) : operation;
      if (preview && (preview.payload as { evidencePath?: unknown }).evidencePath) {
        const captured = await readBindingEvidence(input.operationRoot, preview);
        await nativeHistoryRoot(project.root, nativeLegacyRoot, captured.nativeLegacyRoot ?? captured.root);
      }
    }
    return (await exportPortableProject({ db: input.db, store, projectId: id, repositoryProjectId: b.repositoryProjectId,
      cloneId: b.cloneId, root: project.root, nativeLegacyRoot, ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) })).entries;
  }
  async function capture(id: string) {
    let captured = await context(id);
    if (captured.repository.head !== captured.b.localHead) {
      await adoptExternal(id, captured.project); captured = await context(id);
    }
    const { b, project } = captured;
    const basis = basisFor(b);
    const entries = await project.gate.exclusive(async () => {
      if (basis.localHead) {
        const tree = await gitTree(project.root, basis.localHead);
        const reserved = new Map<string, { bytes: Buffer | null; mode: string }>();
        for (const path of await pathsAt(project.root)) {
          if (path.startsWith('.open-design/') && !isPrivateProjectGitPath(path)) reserved.set(path, await safeFile(project.root, path));
        }
        assertReservedUnchanged(tree, reserved);
      }
      unchanged(id, basis); const result = await exported(id, b, project); unchanged(id, basis); return result;
    });
    const candidate = await prepareCheckpoint({ root: project.root, operationDir: input.operationRoot,
      head: basis.localHead, portableEntries: entries, coordination: { projectId: id, basis, gate: project.gate,
        readBasis: () => readBasis(id), ...(project.gitEnv ? { gitEnv: project.gitEnv } : {}) } });
    return { b, project, basis, candidate };
  }
  async function adoptExternal(id: string, project: ProjectGitSyncProject): Promise<void> {
    await project.gate.exclusive(async () => {
      const { b, repository } = await context(id); const basis = basisFor(b);
      if (repository.head === b.localHead) return;
      const conflict = () => new GitDomainError('CONFLICT', 409, 'External Git history or portable metadata requires reconciliation.',
        { reason: 'external_head_conflict', nextStep: 'Review external changes before resuming automatic versioning.' });
      if (!b.localHead || !repository.head) throw conflict();
      for (const name of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'sequencer']) {
        try { await lstat(join(repository.gitDir, name)); throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'Finish the external Git operation first.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if ((await runGit({ cwd: project.root, args: ['diff-index', '--cached', '--raw', '-z', repository.head] })).stdout.length) {
        throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'Preserve and finish the user-staged index before adopting external history.');
      }
      const index = await readFile(join(repository.gitDir, 'index'));
      try { await runGit({ cwd: project.root, args: ['merge-base', '--is-ancestor', b.localHead, repository.head] }); }
      catch { throw conflict(); }
      const before = await gitTree(project.root, b.localHead); const after = await gitTree(project.root, repository.head);
      for (const tree of [before, after]) {
        if ([...tree.keys()].some(isPrivateProjectGitPath)) throw conflict();
        const snapshot = parsePortableEntries(new Map([...tree].map(([path, file]) => [path, file.bytes])));
        if (snapshot.manifest.repositoryProjectId !== b.repositoryProjectId) throw conflict();
      }
      const reserved = (tree: typeof before) => [...tree].filter(([path]) => path.startsWith('.open-design/')).map(([path, file]) => [path, file.oid, file.mode]);
      if (!isDeepStrictEqual(reserved(before), reserved(after))) throw conflict();
      const actual = await discoverRepository(project.root);
      if (!isDeepStrictEqual(repository, actual) || !index.equals(await readFile(join(repository.gitDir, 'index')))) throw changed();
      unchanged(id, basis); assertNoRecovery(store, id); store.adoptExternalHead(id, basis, repository.head);
    });
  }
  async function pathsAt(root: string): Promise<string[]> {
    const listed = await Promise.all([['ls-files', '--cached', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']].map(async args => {
      const raw = (await runGit({ cwd: root, args })).stdout; const text = raw.toString();
      if (!Buffer.from(text).equals(raw) || (raw.length && !text.endsWith('\0'))) throw changed();
      return text.split('\0').filter(Boolean);
    }));
    // Ignore rules cannot hide reserved files. Walk only this namespace, without
    // following symlinks or reading private bytes; safeFile validates each leaf.
    const reserved: string[] = [];
    const visit = async (path: string): Promise<void> => {
      if (isPrivateProjectGitPath(path)) throw new GitDomainError('CONFLICT', 409,
        'A private-named member in the reserved portable namespace requires reconciliation.',
        { reason: 'external_head_conflict', nextStep: 'Review reserved paths without importing private content.' });
      let info;
      try { info = await lstat(join(root, path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) { reserved.push(path); return; }
      for (const name of await readdir(join(root, path))) await visit(`${path}/${name}`);
    };
    await visit('.open-design');
    const paths = [...new Set([...await projectGitPathsAtRoot(root, listed[0]!, listed[1]!), ...reserved])].sort();
    validateTreeEntries(paths.map(path => ({ path, mode: '100644' }))); return paths;
  }
  function assertReservedUnchanged(tree: Map<string, { bytes: Buffer; mode: string }>, files: Map<string, { bytes: Buffer | null; mode: string }>) {
    const reserved = (entries: typeof files) => [...entries].filter(([path]) => path.startsWith('.open-design/') && !isPrivateProjectGitPath(path))
      .map(([path, file]) => [path, file.mode, file.bytes === null ? null : sha256(file.bytes)]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    if (!isDeepStrictEqual(reserved(tree), reserved(files))) throw new GitDomainError('CONFLICT', 409,
      'External portable files require reconciliation before exporting database content.',
      { reason: 'external_head_conflict', nextStep: 'Review the reserved-file changes before resuming automatic versioning.' });
  }
  async function cleanNoop(id: string, project: ProjectGitSyncProject, basis: ProjectGitBasis, candidate: Awaited<ReturnType<typeof prepareCheckpoint>>) {
    await project.gate.exclusive(async () => {
      unchanged(id, basis); assertNoRecovery(store, id);
      const repository = await discoverRepository(project.root);
      if (repository.head !== basis.localHead || repository.branch !== project.branch) throw changed();
      const paths = await pathsAt(project.root);
      if (paths.some(path => !Object.hasOwn(candidate.sourceDigests, path))) throw changed();
      const sourceDigests: Record<string, string> = Object.create(null); const sourceModes: Record<string, string> = Object.create(null);
      for (const path of Object.keys(candidate.sourceDigests)) {
        const file = await safeFile(project.root, path); sourceDigests[path] = file.bytes === null ? 'missing' : sha256(file.bytes); sourceModes[path] = file.mode;
      }
      if (!isDeepStrictEqual(sourceDigests, Object.assign(Object.create(null), candidate.sourceDigests))
        || computeCheckpointContentDigest({ sourceDigests, sourceModes, portableDigests: {}, removedPaths: [] }) !== candidate.previewContentDigest) throw changed();
      let index: Buffer | null = null;
      try { index = await readFile(join(repository.gitDir, 'index')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((index === null ? null : sha256(index)) !== candidate.baseIndexDigest
        || !isDeepStrictEqual(paths, await pathsAt(project.root)) || !isDeepStrictEqual(repository, await discoverRepository(project.root))) throw changed();
      unchanged(id, basis); store.markExported(id, basis, basis.contentRevision);
    });
  }
  const observations = new Map<string, { fingerprint: string; changedAt: number; saved: boolean }>();
  const detecting = new Map<string, Promise<void>>();
  async function fingerprint(id: string): Promise<{ fingerprint: string; clean: boolean }> {
    await ready;
    const project = input.resolveProject(id);
    return project.gate.exclusive(async () => {
      const { b, repository } = await context(id); const basis = basisFor(b);
      const paths = await pathsAt(project.root);
      const hash = createHash('sha256').update(JSON.stringify([basisFor(b), repository.head, repository.branch]));
      const sourceDigests: Record<string, string> = Object.create(null); const sourceModes: Record<string, string> = Object.create(null);
      const files = new Map<string, { bytes: Buffer | null; mode: string }>();
      for (const path of paths) {
        if (isPrivateProjectGitPath(path)) continue;
        const file = await safeFile(project.root, path); hash.update(JSON.stringify([path, file.mode]));
        files.set(path, file);
        if (file.bytes) hash.update(file.bytes); hash.update('\0');
        sourceDigests[path] = file.bytes === null ? 'missing' : sha256(file.bytes); sourceModes[path] = file.mode;
      }
      const readIndex = async () => {
        try { return await readFile(join(repository.gitDir, 'index')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; }
      };
      const index = await readIndex(); if (index) hash.update(index);
      const tree = repository.head ? await gitTree(project.root, repository.head) : new Map<string, { bytes: Buffer; mode: string; oid: string }>();
      if (repository.head) assertReservedUnchanged(tree, files);
      const entries = await exported(id, b, project);
      const portableDigests = Object.fromEntries([...entries].map(([path, bytes]) => [path, sha256(bytes)]));
      const semantic = computeCheckpointContentDigest({ sourceDigests, sourceModes, portableDigests,
        removedPaths: [...tree.keys()].filter(path => path.startsWith('.open-design/') && !entries.has(path)) });
      const baseDigest = computeCheckpointContentDigest({ sourceDigests: Object.fromEntries([...tree].map(([path, file]) => [path, sha256(file.bytes)])),
        sourceModes: Object.fromEntries([...tree].map(([path, file]) => [path, file.mode])), portableDigests: {}, removedPaths: [] });
      const staged = (await runGit({ cwd: project.root, args: repository.head ? ['diff-index', '--cached', '--raw', '-z', repository.head]
        : ['ls-files', '--stage', '-z'] })).stdout.length > 0;
      // External writers do not acquire our gate. Re-read the complete captured state;
      // a SQLite-only fence cannot turn old bytes into a coherent new observation.
      for (const [path, file] of files) {
        if (!isDeepStrictEqual(file, await safeFile(project.root, path))) throw changed();
      }
      if (!isDeepStrictEqual(paths, await pathsAt(project.root)) || !isDeepStrictEqual(index, await readIndex())
        || !isDeepStrictEqual(repository, await discoverRepository(project.root))) throw changed();
      hash.update(semantic); unchanged(id, basis);
      return { fingerprint: hash.digest('hex'), clean: repository.head === b.localHead && !b.dirty
        && !staged && b.contentRevision === b.exportedContentRevision && semantic === baseDigest };
    });
  }
  function localStatus(id: string, error: unknown): void {
    if (store.listRecoverable().some(op => op.projectId === id && op.recoveryData)) return;
    const previous = store.listPendingOperations().find(op => op.projectId === id && op.actorId === actorId && op.kind === 'sync'
      && op.basis.bindingGeneration === binding(id).generation
      && op.journalPhase === null && typeof op.payload === 'object' && op.payload !== null && !Array.isArray(op.payload) && op.payload.lane === 'local');
    const operation = previous ?? store.enqueueOperation({ projectId: id, actorId, kind: 'sync', basis: readBasis(id),
      idempotencyKey: randomUUID(), requestDigest: randomUUID(), payload: { lane: 'local' } });
    const phase = errorPhase(error); const safeError = publicError(error);
    if (previous?.phase !== phase || !isDeepStrictEqual(previous.error, safeError)) {
      store.updateOperation(operation.id, { status: 'waiting', phase, result: null, error: safeError });
    }
  }
  const deps: ProjectGitSyncDeps = {
    store, now: input.now, random: input.random,
    async checkpoint(id) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let operationId: string | undefined;
        try {
          const captured = await capture(id); const { project, basis, candidate } = captured;
          operationId = store.enqueueCheckpoint({ projectId: id, actorId, basis, idempotencyKey: randomUUID(),
            requestDigest: candidate.previewContentDigest, payload: {} }).id;
          const oid = await publishCheckpoint({ root: project.root, branch: project.branch, candidate, operationId, store });
          if (!oid) await cleanNoop(id, project, basis, candidate);
          for (const op of store.listPendingOperations()) {
            if (op.projectId === id && op.actorId === actorId && op.kind === 'sync' && op.journalPhase === null
              && typeof op.payload === 'object' && op.payload !== null && !Array.isArray(op.payload) && op.payload.lane === 'local') {
              const head = oid ?? candidate.baseHead;
              store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', result: head ? { head } : {}, error: null });
            }
          }
          return oid ?? candidate.baseHead;
        } catch (error) {
          if (operationId && store.getJournal(operationId)?.recoveryData) {
            await recoverProjectOperations(recoveryInput); throw error;
          }
          if (operationId) store.updateOperation(operationId, { status: 'failed', phase: 'failed', result: null, error: publicError(error) });
          if (attempt === 0 && error instanceof GitDomainError && error.code === 'PROJECT_STATE_CHANGED') continue;
          localStatus(id, error);
          throw error;
        }
      }
      throw changed();
    },
    async confirmTarget(id) {
      const { b, project } = await context(id); if (!b.remoteUrl) return null;
      const ref = `refs/heads/${b.branch}`;
      const result = await runGitTransport({ preparationRoot: input.preparationRoot, args: ['ls-remote', b.remoteUrl, ref], ...(project.gitEnv ? { env: project.gitEnv } : {}) });
      if (binding(id).generation !== b.generation) throw changed();
      const matches = result.stdout.toString().trim().split('\n').filter(Boolean).map(line => line.split('\t')).filter(([, name]) => name === ref);
      if (!matches.length) return null;
      if (matches.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(matches[0]![0]!)) throw changed();
      return matches[0]![0]!;
    },
    async fetchTarget(id) {
      const { b, project } = await context(id); if (!b.remoteUrl) return null;
      if (await deps.confirmTarget(id) === null) return null;
      if (binding(id).generation !== b.generation) throw changed();
      const result = await runGitTransport({ preparationRoot: input.preparationRoot, ...await discoverObjectStore(project.root),
        args: ['fetch', b.remoteUrl, `refs/heads/${b.branch}`], ...(project.gitEnv ? { env: project.gitEnv } : {}) });
      if (binding(id).generation !== b.generation || !result.fetchedHead) throw changed();
      await runGit({ cwd: project.root, args: ['update-ref', '--no-deref', `refs/open-design/fetch/${randomUUID()}`, result.fetchedHead, '0'.repeat(result.fetchedHead.length)] });
      return result.fetchedHead;
    },
    async pushTarget(id, oid, generation) {
      const { b, project } = await context(id); if (!b.remoteUrl || b.generation !== generation) throw changed();
      await runGitTransport({ preparationRoot: input.preparationRoot, ...await discoverObjectStore(project.root),
        args: ['push', b.remoteUrl, `${oid}:refs/heads/${b.branch}`], ...(project.gitEnv ? { env: project.gitEnv } : {}) });
      if (binding(id).generation !== generation) throw changed();
    },
    async isAncestor(id, ancestor, descendant) {
      const { project } = await context(id);
      try { await runGit({ cwd: project.root, args: ['merge-base', '--is-ancestor', ancestor, descendant] }); return true; }
      catch (error) { if (error instanceof GitDomainError && error.details?.exitCode === 1) return false; throw error; }
    },
    async mergeAndMaterialize(id, local, remote) {
      const { b, project, basis, candidate: preview } = await capture(id);
      if (basis.localHead !== local) throw changed();
      const fastForward = await deps.isAncestor(id, local, remote); let candidateOid = remote;
      if (!fastForward) {
        const baseResult = await runGit({ cwd: project.root, args: ['merge-base', '--all', local, remote] }).catch(() => null);
        const bases = baseResult?.stdout.toString().trim().split('\n');
        if (bases?.length !== 1 || !bases[0]) throw new GitDomainError('CONFLICT', 409, 'History has no unique common ancestor.', { reason: 'merge_conflict' });
        const merged = await mergeFileTrees({ root: project.root, stagingDir: input.preparationRoot, base: bases[0], local, remote });
        if (!merged.tree || merged.conflicts.length) throw new GitDomainError('CONFLICT', 409, 'Project histories require conflict resolution.',
          { reason: 'merge_conflict', conflictIds: merged.conflicts.map(conflict => conflict.id) });
        candidateOid = (await runGit({ cwd: project.root, args: ['commit-tree', merged.tree, '-p', local, '-p', remote],
          stdin: Buffer.from('Open Design merge\n'), ...(project.gitEnv ? { env: project.gitEnv } : {}) })).stdout.toString().trim();
      }
      const tree = await gitTree(project.root, candidateOid);
      const snapshot = parsePortableEntries(new Map([...tree].map(([path, file]) => [path, file.bytes])));
      unchanged(id, basis);
      const operation = store.enqueueOperation({ projectId: id, actorId, kind: 'sync', basis,
        idempotencyKey: randomUUID(), requestDigest: preview.previewContentDigest, payload: { lane: 'materialize', local, remote } });
      return materializeProject({ projectId: id, root: project.root, branch: project.branch, operationId: operation.id,
        operationDir: input.operationRoot, publicationMode: fastForward ? 'fast_forward' : 'commit', basis, candidateOid, snapshot, store, db: input.db, gate: project.gate,
        previewContentDigest: preview.previewContentDigest, readBasis: () => readBasis(id), ...(project.gitEnv ? { gitEnv: project.gitEnv } : {}),
        exportCurrentPortable: () => exported(id, b, project) });
    },
    detect(id) {
      const existing = detecting.get(id); if (existing) return existing;
      const work = (async () => { try {
        const current = await fingerprint(id); const previous = observations.get(id);
        if (current.clean || !previous || previous.fingerprint !== current.fingerprint) {
          observations.set(id, { fingerprint: current.fingerprint, changedAt: input.now(), saved: current.clean }); return;
        }
        if (previous.saved || input.now() - previous.changedAt < 5_000) return;
        await deps.checkpoint(id);
        const after = await fingerprint(id);
        observations.set(id, { fingerprint: after.fingerprint, changedAt: input.now(), saved: after.clean });
      } catch (error) {
        observations.delete(id);
        if (error instanceof GitDomainError && error.code === 'PROJECT_STATE_CHANGED') return;
        localStatus(id, error); throw error;
      } })().finally(() => { detecting.delete(id); });
      detecting.set(id, work); return work;
    },
    async automaticReady(id) { await deps.detect(id); return observations.get(id)?.saved === true; },
  };
  return Object.assign(deps, { recoveryReady: ready });
}

export function retryDelayMs(attempt: number, random: () => number): number {
  const index = Number.isFinite(attempt) ? Math.min(Math.max(0, Math.floor(attempt)), 3) : 3;
  const base = [5_000, 30_000, 120_000, 300_000][index]!;
  return Math.min(300_000, Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.4)));
}
