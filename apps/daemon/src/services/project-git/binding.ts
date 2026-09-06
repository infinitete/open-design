import { ProjectGitBindConfirmationSchema, type ProjectGitBindConfirmation, type ProjectGitBindingPreview } from '@open-design/contracts';
import type { JsonValue, PortableSnapshot, ProjectGitBasis, ProjectGitChangeSummary, ProjectGitDependency, ProjectGitOperation, ProjectGitPreview } from '@open-design/contracts';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { GitDomainError } from './errors.js';
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { getSystemErrorMap, isDeepStrictEqual } from 'node:util';
import { assertGitIdentity, initializeRepository, runGit, runGitTransport } from './git-process.js';
import { discoverObjectStore, discoverRepository, resolveCommit, validateBranch, validateRemote, validateTreeEntries } from './repository.js';
import { computeCheckpointContentDigest, isPrivateProjectGitPath, prepareCheckpoint, publishCheckpoint } from './checkpoint.js';
import { durableDirectory, durableWrite, finishRecovery, gitTree, readBytes, recoveryBarrier, safeFile, sha256, within } from './recovery.js';
import { canonicalJson, exportPortableProject, parsePortableEntries, serializePortableMetadata } from './portable.js';
import { getProject } from '../../db.js';
import type { ProjectGitBindingRecord, ProjectGitJournalRecord, ProjectGitRegistrationIntent, ProjectGitStore } from '../../storage/project-git.js';
import type { ProjectGitScheduler } from './scheduler.js';
import type { ProjectGitSyncProject } from './sync.js';
import { getProjectGate, getUnmanagedProjectGate, initializeProjectRepository, resumeInitializedProjectGate, type ProjectGate } from './gate.js';
import type { RepositoryLeaseInput } from './repository-lease.js';
import { bindingOwnerRef, createProjectGitRegistration } from './registration.js';
import { materializeProject } from './materialize.js';
import { mergeFileTrees } from './merge.js';
import { readBindingEvidence, rootInventory, type BindingCapture } from './binding-evidence.js';
import { nativeHistoryRoot, projectGitPathsAtRoot } from './paths.js';

export interface BindingRequestContext { actorId: string; idempotencyKey: string; expectedProjectRevision?: number }
export interface ProjectGitBindingServiceInput {
  db: Database.Database; store: ProjectGitStore; operationRoot: string; preparationRoot: string; ownedProjectsRoot: string;
  ownership: Omit<RepositoryLeaseInput, 'root'>; scheduler: ProjectGitScheduler;
  checkpointCurrent(projectId: string): Promise<string | null>;
  recoveryReady: Promise<void>;
  requireProject(actorId: string, projectId: string): void | Promise<void>;
  requireCreate(actorId: string): void | Promise<void>;
  resolveAvailability(request: { actorId: string; projectId: string; kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string; agentId?: string }): Promise<boolean>;
  resolveProject(projectId: string): ProjectGitSyncProject;
  reserveProject(input: { projectId: string; root: string; localBranch: string; gate: ProjectGate; readBasis(): ProjectGitBasis }): () => void;
  now(): number; newId(): string; gitEnv?: Record<string, string>;
}
const stateChanged = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original project preview changed. Create a new preview.');
const validation = () => new GitDomainError('VALIDATION_FAILED', 400, 'Invalid project repository request.');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const systemErrors = getSystemErrorMap();
function expectedSystemFailure(error: unknown): boolean {
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return false;
  const { code, errno, syscall } = error as NodeJS.ErrnoException;
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code)
    && typeof errno === 'number' && Number.isInteger(errno)
    && typeof syscall === 'string' && syscall.trim().length > 0
    && systemErrors.get(errno)?.[0] === code;
}
const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const requestHash = (value: unknown) => sha256(Buffer.from(canonicalJson(jsonValue(value))));
const emptyChanges = (): ProjectGitChangeSummary => ({ addedPaths: [], modifiedPaths: [], deletedPaths: [], settingsChanged: 0,
  conversationsChanged: 0, ignoredPaths: [], privatePaths: [], missingPaths: [], historyMode: 'complete', collisions: [] });
function nulPaths(bytes: Buffer): string[] {
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || (bytes.length && !text.endsWith('\0'))) throw validation();
  return text.split('\0').filter(Boolean);
}

/** No runtime registry or scheduler is created here; all identities come from the injected owner. */
export function createProjectGitBindingService(input: ProjectGitBindingServiceInput) {
  const { db, store } = input; store.assertDatabase(db);
  async function availability(projectId: string, actorId: string, snapshot: PortableSnapshot): Promise<ProjectGitDependency[]> {
    const identifiers = new Map<string, { kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string; agentId?: string }>();
    const add = (kind: 'agent' | 'model' | 'plugin' | 'linked_folder', id: string | undefined, agentId?: string) => {
      if (id) identifiers.set(JSON.stringify([kind, id, agentId ?? null]), { kind, id, ...(agentId ? { agentId } : {}) });
    };
    for (const preferences of [snapshot.project.preferences, ...snapshot.conversations.map(item => item.preferences)]) {
      add('agent', preferences?.agentId); add('model', preferences?.model, preferences?.agentId);
    }
    for (const resource of snapshot.manifest.resources) if (snapshot.project.contentRefs.includes(resource.digest)) {
      for (const location of resource.locations) if (location.purpose === 'plugin') add('plugin', location.sourceLabel);
    }
    for (const folder of snapshot.project.linkedFolderRequirements) add('linked_folder', folder.label);
    const result: ProjectGitDependency[] = [];
    for (const [, item] of [...identifiers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      let available: boolean; let failed = false;
      const safeId = /^(?:\/|~|[a-zA-Z]:[\\/])|[\u0000-\u001f\u007f]/u.test(item.id) ? 'Unrecognized logical dependency' : item.id;
      try { if (safeId !== item.id) throw validation(); available = await input.resolveAvailability({ actorId, projectId, ...item }); } catch { available = false; failed = true; }
      if (!available) result.push({ kind: item.kind, label: safeId, requiredForContent: item.kind === 'linked_folder',
        nextStep: { action: failed ? 'retry' : item.kind === 'linked_folder' ? 'locate_folder' : 'install_dependency', label: safeId } });
    }
    return result;
  }
  const basis = (id: string): ProjectGitBasis => {
    const b = store.getBinding(id);
    return b ? { bindingGeneration: b.generation, projectRevision: b.projectRevision, contentRevision: b.contentRevision,
      localHead: b.localHead, remoteHead: b.observedRemoteHead } : { bindingGeneration: 0, projectRevision: 0, contentRevision: 0, localHead: null, remoteHead: null };
  };
  const registration = createProjectGitRegistration({ db, store, dataRootId: input.ownership.dataRootId,
    resolveProject: id => ({ ...input.resolveProject(id), readBasis: () => basis(id) }) });
  async function roots(root?: string) {
    for (const path of [input.operationRoot, input.preparationRoot, input.ownedProjectsRoot]) {
      if (!isAbsolute(path) || path !== await realpath(path) || !(await lstat(path)).isDirectory()) throw validation();
      if (root && (path === root || within(root, path))) throw validation();
    }
  }
  async function authorizeRequest(id: string, request: BindingRequestContext) {
    if (!request.actorId || !request.idempotencyKey) throw validation();
    await input.requireProject(request.actorId, id); await input.recoveryReady;
  }
  async function resolveAuthorized(id: string) {
    const project = input.resolveProject(id);
    if (project.root !== await realpath(project.root) || (await lstat(project.root)).isSymbolicLink()) throw validation();
    await roots(project.root); return project;
  }
  function existing(id: string | null, kind: ProjectGitJournalRecord['kind'], request: BindingRequestContext, digest: string) {
    if (kind === 'checkpoint') throw validation();
    const op = store.findOperation({ actorId: request.actorId, projectId: id, kind, idempotencyKey: request.idempotencyKey });
    if (op && op.requestDigest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
    return op;
  }
  async function evidence(value: unknown) {
    const name = input.newId(); if (!/^[a-zA-Z0-9-]+$/u.test(name)) throw validation();
    const path = `binding-${name}.json`; const bytes = Buffer.from(canonicalJson(jsonValue(value)));
    await durableWrite(join(input.operationRoot, path), bytes); return { evidencePath: path, evidenceDigest: sha256(bytes) };
  }
  async function readEvidence(op: ProjectGitJournalRecord): Promise<BindingCapture> {
    const captured = await readBindingEvidence(input.operationRoot, op);
    if (op.projectId) await legacyRoot(input.resolveProject(op.projectId), captured);
    return captured;
  }
  async function legacyRoot(project: ProjectGitSyncProject, captured?: Pick<BindingCapture, 'root' | 'nativeLegacyRoot'>) {
    return nativeHistoryRoot(project.root, project.nativeLegacyRoot, captured ? captured.nativeLegacyRoot ?? captured.root : undefined);
  }
  async function capture(id: string, project: ProjectGitSyncProject, identity?: BindingCapture): Promise<BindingCapture> {
    const nativeLegacyRoot = await legacyRoot(project, identity);
    const start = basis(id); let git: BindingCapture['git'];
    try { git = await discoverRepository(project.root); }
    catch (error) { if (!(error instanceof GitDomainError) || error.details?.reason !== 'not_repository') throw error; git = null; }
    if (git && (git.root !== project.root || !git.branch)) throw validation();
    if (git && store.getBinding(id) && git.head !== start.localHead) throw stateChanged();
    if (!store.getBinding(id)) start.localHead = git?.head ?? null;
    const localBranch = git?.branch ?? project.branch; await validateBranch(localBranch);
    const inventory = await rootInventory(project.root); const beforeRules = new Map<string, Buffer>();
    const rules = inventory.filter(([path, kind]) => kind === 'file' && path.split('/').at(-1) === '.gitignore');
    for (const [path] of rules) beforeRules.set(path, (await safeFile(project.root, path)).bytes!);
    let eligible: string[];
    if (git) {
      for (const marker of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']) {
        try { await lstat(join(git.gitDir, marker)); throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'Finish the existing Git operation first.'); }
        catch (error) { if (!absent(error)) throw error; }
      }
      const staged = (await runGit({ cwd: project.root, args: git.head ? ['diff-index', '--cached', '--raw', '-z', git.head] : ['ls-files', '--stage', '-z'] })).stdout;
      if (staged.length) throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'User-staged changes must be preserved.');
      eligible = await projectGitPathsAtRoot(project.root,
        nulPaths((await runGit({ cwd: project.root, args: ['ls-files', '--cached', '-z'] })).stdout),
        nulPaths((await runGit({ cwd: project.root, args: ['ls-files', '--others', '--exclude-standard', '-z'] })).stdout));
    } else {
      const scratch = await mkdtemp(join(input.preparationRoot, 'binding-preview-'));
      await initializeRepository({ root: scratch, initialBranch: localBranch, objectFormat: 'sha1', ...(input.gitEnv ? { env: input.gitEnv } : {}) });
      for (const [path, kind] of inventory) {
        if (kind === 'directory') { await mkdir(join(scratch, path), { recursive: true });
          if (isPrivateProjectGitPath(path)) await durableWrite(join(scratch, path, 'od-private-placeholder'), Buffer.alloc(0));
        } else if (kind === 'file' || kind === 'symlink') {
          await mkdir(dirname(join(scratch, path)), { recursive: true });
          await durableWrite(join(scratch, path), beforeRules.get(path) ?? Buffer.alloc(0));
        }
      }
      eligible = await projectGitPathsAtRoot(project.root, [],
        nulPaths((await runGit({ cwd: scratch, args: ['ls-files', '--others', '--exclude-standard', '-z'],
          ...(input.gitEnv ? { env: input.gitEnv } : {}) })).stdout));
    }
    const changes = emptyChanges(); const dependencies: ProjectGitDependency[] = [];
    changes.privatePaths = [...new Set(eligible.filter(isPrivateProjectGitPath).map(path => path.replace(/\/od-private-placeholder$/u, '')))];
    for (const [path, kind] of inventory) {
      if (kind !== 'directory' && !eligible.includes(path)) changes.ignoredPaths.push(path);
      if ((kind === 'symlink' || kind === 'unsupported') && eligible.includes(path)) {
        dependencies.push({ kind: 'resource', label: path, requiredForContent: true, nextStep: null });
      }
      if (path.split('/')[0]!.normalize('NFC').toLowerCase() === '.open-design' && !path.startsWith('.open-design/')) {
        if (path !== '.open-design' || kind !== 'directory') throw new GitDomainError('PORTABLE_FORMAT_UNSUPPORTED', 409, 'Unrecognized portable namespace.');
      }
    }
    const reserved = inventory.filter(([path]) => path === '.open-design' || path.startsWith('.open-design/'));
    const privateReserved = reserved.filter(([path]) => isPrivateProjectGitPath(path)).map(([path]) => path);
    if (privateReserved.length) throw new GitDomainError('VALIDATION_FAILED', 400, 'Private reserved content requires manual reconciliation.', { paths: privateReserved });
    const reservedEntries = new Map<string, Uint8Array>();
    for (const [path, kind] of reserved) {
      if (kind === 'directory') continue;
      if (kind !== 'file') throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Linked portable metadata requires separate handling.', { paths: [path] });
      const file = await safeFile(project.root, path); if (!file.bytes) throw stateChanged(); reservedEntries.set(path, file.bytes);
    }
    const diskSnapshot = reserved.length ? parsePortableEntries(reservedEntries) : null;
    const repositoryProjectId = identity?.repositoryProjectId ?? store.getBinding(id)?.repositoryProjectId ?? diskSnapshot?.manifest.repositoryProjectId ?? input.newId();
    const cloneId = identity?.cloneId ?? store.getBinding(id)?.cloneId ?? input.newId();
    const exported = await exportPortableProject({ db, store, projectId: id, repositoryProjectId, cloneId, root: project.root, nativeLegacyRoot,
      ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) });
    const sourceDigests: Record<string, string> = {}; const sourceModes: Record<string, string> = {};
    const paths = [...new Set([...eligible.filter(path => !isPrivateProjectGitPath(path)), ...exported.entries.keys()])].sort();
    for (const path of paths) {
      if (dependencies.some(item => item.label === path)) continue;
      const file = await safeFile(project.root, path); sourceDigests[path] = file.bytes === null ? 'missing' : sha256(file.bytes); sourceModes[path] = file.mode;
    }
    const portableDigests = Object.fromEntries([...exported.entries].map(([path, bytes]) => [path, sha256(bytes)]));
    const contentDigest = computeCheckpointContentDigest({ sourceDigests, sourceModes, portableDigests, removedPaths: [] });
    if (!isDeepStrictEqual(inventory, await rootInventory(project.root))) throw stateChanged();
    for (const [path, bytes] of beforeRules) if (!(await safeFile(project.root, path)).bytes?.equals(bytes)) throw stateChanged();
    for (const path of Object.keys(sourceDigests)) {
      const file = await safeFile(project.root, path);
      if ((file.bytes === null ? 'missing' : sha256(file.bytes)) !== sourceDigests[path] || file.mode !== sourceModes[path]) throw stateChanged();
    }
    const afterExport = await exportPortableProject({ db, store, projectId: id, repositoryProjectId, cloneId, root: project.root, nativeLegacyRoot: await legacyRoot(input.resolveProject(id), { root: project.root, nativeLegacyRoot }),
      ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) });
    if (!isDeepStrictEqual(exported.entries, afterExport.entries) || (store.getBinding(id) && !isDeepStrictEqual(start, basis(id)))) throw stateChanged();
    if (git && !isDeepStrictEqual(git, await discoverRepository(project.root))) throw stateChanged();
    changes.addedPaths = paths; changes.settingsChanged = 1; changes.conversationsChanged = exported.snapshot.conversations.length;
    try { await assertGitIdentity({ cwd: project.root, ...(project.gitEnv ?? input.gitEnv ? { env: project.gitEnv ?? input.gitEnv } : {}) }); }
    catch (error) { if (!(error instanceof GitDomainError) || !['GIT_IDENTITY_REQUIRED', 'GIT_UNAVAILABLE'].includes(error.code)) throw error;
      dependencies.push({ kind: error.code === 'GIT_UNAVAILABLE' ? 'git' : 'identity', label: error.message, requiredForContent: false, nextStep: null }); }
    return { root: project.root, nativeLegacyRoot, localBranch, repositoryProjectId, cloneId, basis: start, git,
      entries: [...exported.entries].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]), sourceDigests, sourceModes,
      inventory, digest: contentDigest, changes, dependencies };
  }
  function unpack(captured: BindingCapture) { return new Map(captured.entries.map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')])); }
  async function prepareIntent(id: string, user: ProjectGitJournalRecord, captured: BindingCapture, completion: ProjectGitRegistrationIntent['completion'],
    remoteUrl: string | null, targetBranch: string, candidateOid?: string, reserved?: ProjectGitSyncProject, publicationMode?: 'commit' | 'fast_forward', existingProjectIds?: string[], dependencies?: ProjectGitDependency[]) {
    const project = reserved ?? input.resolveProject(id); const repo = await discoverRepository(project.root);
    const existingBinding = store.getBinding(id);
    const proposed: ProjectGitBindingRecord = existingBinding ?? { projectId: id, cloneId: captured.cloneId, repositoryProjectId: captured.repositoryProjectId,
      canonicalRoot: project.root, commonDir: repo.commonDir, branch: captured.localBranch, generation: 1, autoSync: false, remoteUrl: null,
      localHead: repo.head, observedRemoteHead: null, confirmedRemoteHead: null, materializedHead: null,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, dirty: false };
    const generation = proposed.generation + Number(proposed.branch !== targetBranch || proposed.remoteUrl !== remoteUrl);
    let previousOwner: ProjectGitRegistrationIntent['previousOwner'] = null;
    if (existingBinding && user.kind !== 'open' && user.kind !== 'enable') {
      const ref = bindingOwnerRef(existingBinding.branch);
      const oid = (await runGit({ cwd: project.root, args: ['rev-parse', '--verify', '--quiet', ref] })).stdout.toString().trim();
      previousOwner = { ref, oid, generation: existingBinding.generation };
    }
    const targetRef = bindingOwnerRef(targetBranch);
    const targetOwner = { ref: targetRef, expectedOid: previousOwner?.ref === targetRef ? previousOwner.oid : null, generation,
      oid: (await runGit({ cwd: project.root, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from(JSON.stringify({ dataRootId: input.ownership.dataRootId,
        projectId: id, canonicalRoot: project.root, localBranch: captured.localBranch, generation })) })).stdout.toString().trim() };
    const info = await lstat(project.root);
    const intent = db.transaction(() => {
      const current = store.getBinding(id);
      if (!isDeepStrictEqual(current, existingBinding)) throw stateChanged();
      const b = current ?? store.saveBinding({ ...proposed, generation: 0 });
      const executionBasis = basis(id);
      if (user.kind === 'open') { store.attachOperationProject(user.id, id, executionBasis); user = store.getJournal(user.id)!; }
      const execution = completion === 'checkpoint' ? store.enqueueCheckpoint({ projectId: id, actorId: user.actorId,
        basis: executionBasis, idempotencyKey: `registration:${user.id}`, requestDigest: captured.digest, payload: { previewContentDigest: captured.digest } }) : user;
      const value: ProjectGitRegistrationIntent = { kind: user.kind as ProjectGitRegistrationIntent['kind'], completion, userOperationId: user.id,
      executionOperationId: execution.id, projectId: id, cloneId: b.cloneId, repositoryProjectId: b.repositoryProjectId,
      dataRootId: input.ownership.dataRootId, canonicalRoot: project.root, commonDir: repo.commonDir, localBranch: captured.localBranch,
      targetBranch, remoteUrl, autoSync: remoteUrl !== null, hidden: user.kind === 'open', originalUserBasis: user.basis, executionBasis,
      previousOwner, targetOwner, ...(candidateOid && user.kind === 'open' ? { initialImport: { candidateOid, rootDev: String(info.dev), rootIno: String(info.ino) } } : {}),
      ...(candidateOid && user.kind === 'bind' && publicationMode ? { materialization: { candidateOid, publicationMode, previewContentDigest: captured.digest } } : {}),
      ...(existingProjectIds === undefined ? {} : { existingProjectIds }), ...(dependencies?.length ? { dependencies } : {}) };
      store.prepareRegistration(value); return value;
    }).immediate();
    recoveryBarrier(project.gate, intent.executionOperationId);
    input.reserveProject({ projectId: id, root: project.root, localBranch: captured.localBranch, gate: project.gate, readBasis: () => basis(id) });
    return intent;
  }
  async function completeEnable(id: string, consumer: ProjectGitJournalRecord, captured: BindingCapture, intent: ProjectGitRegistrationIntent) {
    const project = input.resolveProject(id); recoveryBarrier(project.gate, intent.executionOperationId);
    if (store.getJournal(intent.executionOperationId)!.recoveryData) {
      throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The original startup recovery must complete this journal.');
    } else {
      await registration.claimOwner(intent.executionOperationId);
      await recoveryBarrier(project.gate, intent.executionOperationId).exclusive(async () => {
        if (!isDeepStrictEqual(basis(id), intent.executionBasis)) throw stateChanged();
        const current = await exportPortableProject({ db, store, projectId: id, repositoryProjectId: captured.repositoryProjectId,
          cloneId: captured.cloneId, root: project.root, nativeLegacyRoot: await legacyRoot(input.resolveProject(id), captured), ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) });
        if (!isDeepStrictEqual([...current.entries].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]), captured.entries)) throw stateChanged();
      });
      const candidate = await prepareCheckpoint({ root: project.root, operationDir: input.operationRoot, head: captured.basis.localHead,
        portableEntries: unpack(captured), reason: { source: 'initialize', runs: [] }, coordination: { projectId: id, basis: intent.executionBasis,
          gate: project.gate, readBasis: () => basis(id), registration: registration.checkpointCapability(intent.executionOperationId),
          ...(project.gitEnv ?? input.gitEnv ? { gitEnv: project.gitEnv ?? input.gitEnv } : {}) } });
      if (candidate.previewContentDigest !== captured.digest) throw stateChanged();
      await publishCheckpoint({ root: project.root, branch: captured.localBranch, candidate, operationId: intent.executionOperationId, store });
    }
    return store.getOperation(consumer.id)!;
  }
  async function targetHead(root: string, url: string, branch: string): Promise<string | null> {
    const result = await runGitTransport({ preparationRoot: input.preparationRoot, args: ['ls-remote', url, `refs/heads/${branch}`],
      ...(input.gitEnv ? { env: input.gitEnv } : {}) });
    const rows = result.stdout.toString().trim().split('\n').filter(Boolean);
    if (!rows.length) return null;
    const [oid, ref, extra] = rows[0]!.split(/\s/u);
    if (rows.length !== 1 || ref !== `refs/heads/${branch}` || extra !== undefined || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) throw validation();
    const fetched = await runGitTransport({ preparationRoot: input.preparationRoot, ...await discoverObjectStore(root),
      args: ['fetch', url, `refs/heads/${branch}`], ...(input.gitEnv ? { env: input.gitEnv } : {}) });
    if (fetched.fetchedHead !== oid) throw stateChanged(); return oid;
  }
  function sameCapture(current: BindingCapture, captured: BindingCapture) {
    const { bindingTarget: _target, availabilityDependencies: _availability, ...original } = captured;
    return isDeepStrictEqual(current, { ...original, nativeLegacyRoot: original.nativeLegacyRoot ?? original.root });
  }
  async function completeBindingOnly(id: string, user: ProjectGitJournalRecord, captured: BindingCapture) {
    const project = input.resolveProject(id); await registration.claimOwner(user.id);
    await recoveryBarrier(project.gate, user.id).exclusive(async () => {
      const terminal = await registration.prepareRegistrationCompletion(user.id);
      if (!sameCapture(await capture(id, project, captured), captured)) throw stateChanged();
      terminal.completeBindingOnly();
    });
    finishRecovery({ ...project, readBasis: () => basis(id) }, user.id); return store.getOperation(user.id)!;
  }
  async function bindingCandidate(project: ProjectGitSyncProject, captured: BindingCapture, confirmation: ProjectGitBindConfirmation) {
    const target = captured.bindingTarget!; const local = captured.basis.localHead; const remote = target.remoteHead;
    if (target.candidate !== undefined) {
      if (target.candidate) await inspectBindingCommit(project.root, target.candidate.candidateOid);
      return target.candidate;
    }
    if (remote === null || remote === local) return null;
    if (!local) throw stateChanged();
    const ancestor = async (left: string, right: string) => {
      try { await runGit({ cwd: project.root, args: ['merge-base', '--is-ancestor', left, right] }); return true; }
      catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; return false; }
    };
    if (await ancestor(remote, local)) return null;
    if (await ancestor(local, remote) && (await inspectBindingCommit(project.root, remote)).snapshot) {
      return { candidateOid: remote, publicationMode: 'fast_forward' as const };
    }
    if (target.preview.classification === 'independent_history') {
      const candidate = await prepareIndependentBinding({ root: project.root, local, remote, stagingDir: input.preparationRoot,
        preview: target.preview, confirmation, ...(project.gitEnv ?? input.gitEnv ? { gitEnv: project.gitEnv ?? input.gitEnv } : {}) });
      return { candidateOid: candidate.oid, publicationMode: 'commit' as const };
    }
    const bases = (await runGit({ cwd: project.root, args: ['merge-base', '--all', local, remote] })).stdout.toString().trim().split('\n');
    if (bases.length !== 1 || !bases[0]) throw new GitDomainError('CONFLICT', 409, 'The histories require explicit reconciliation.');
    const merge = await mergeFileTrees({ root: project.root, base: bases[0], local, remote, stagingDir: input.preparationRoot,
      ...(confirmation.metadataSource ? { metadataSource: confirmation.metadataSource } : {}) });
    if (!merge.tree || merge.conflicts.length) throw new GitDomainError('CONFLICT', 409, 'The frozen histories have conflicts.',
      { conflictIds: merge.conflicts.map(item => item.id) });
    const candidateOid = (await runGit({ cwd: project.root, args: ['commit-tree', merge.tree, '-p', local, '-p', remote],
      stdin: Buffer.from('Open Design: bind project histories\n'), ...(project.gitEnv ?? input.gitEnv ? { env: project.gitEnv ?? input.gitEnv } : {}) })).stdout.toString().trim();
    await inspectBindingCommit(project.root, candidateOid); return { candidateOid, publicationMode: 'commit' as const };
  }
  async function completeBinding(id: string, user: ProjectGitJournalRecord, captured: BindingCapture) {
    const intent = store.getRegistration(user.id);
    if (!intent || intent.state !== 'pending') throw stateChanged();
    if (intent.completion === 'binding_only') return completeBindingOnly(id, user, captured);
    const frozen = intent.materialization; if (!frozen) throw stateChanged(); const project = input.resolveProject(id);
    recoveryBarrier(project.gate, user.id);
    if (store.getJournal(user.id)!.recoveryData) {
      throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The original startup recovery must complete this journal.');
    } else {
      const inspected = await inspectBindingCommit(project.root, frozen.candidateOid); if (!inspected.snapshot) throw stateChanged();
      await registration.claimOwner(user.id);
      await materializeProject({ projectId: id, root: project.root, branch: captured.localBranch, operationId: user.id, operationDir: input.operationRoot,
        basis: intent.executionBasis, candidateOid: frozen.candidateOid, publicationMode: frozen.publicationMode, snapshot: inspected.snapshot,
        store, db, gate: project.gate, previewContentDigest: frozen.previewContentDigest, readBasis: () => basis(id),
        exportCurrentPortable: async () => (await exportPortableProject({ db, store, projectId: id, repositoryProjectId: captured.repositoryProjectId,
          cloneId: captured.cloneId, root: project.root, nativeLegacyRoot: await legacyRoot(input.resolveProject(id), captured), ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) })).entries,
        prepareRegistrationCompletion: registration.prepareRegistrationCompletion, ...(project.gitEnv ?? input.gitEnv ? { gitEnv: project.gitEnv ?? input.gitEnv } : {}) });
    }
    return store.getOperation(user.id)!;
  }
  const service = {
    /** Constructor/bootstrap port only; never a public action or serialized capability. */
    prepareRegistrationCompletion: registration.prepareRegistrationCompletion,
    async previewEnable(id: string, request: BindingRequestContext): Promise<ProjectGitOperation> {
      await authorizeRequest(id, request); const digest = requestHash({ kind: 'enable_preview', id, expectedProjectRevision: request.expectedProjectRevision ?? null });
      const prior = existing(id, 'enable_preview', request, digest); if (prior) return store.getOperation(prior.id)!;
      store.assertRevision(id, request.expectedProjectRevision); const project = await resolveAuthorized(id);
      if (store.getBinding(id)) throw new GitDomainError('CONFLICT', 409, 'The project already has versioning enabled.');
      return project.gate.exclusive(async () => {
        const current = existing(id, 'enable_preview', request, digest); if (current) return store.getOperation(current.id)!;
        const captured = await capture(id, project);
        captured.availabilityDependencies = await availability(id, request.actorId, parsePortableEntries(unpack(captured)));
        const payload = await evidence(captured);
        const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'enable_preview', idempotencyKey: request.idempotencyKey,
          requestDigest: digest, basis: captured.basis, payload });
        const preview: ProjectGitPreview = { id: op.id, kind: 'enable', basis: captured.basis, targetOid: null, expiresAt: input.now() + 15 * 60_000,
          changes: captured.changes, dependencies: [...captured.dependencies, ...captured.availabilityDependencies] };
        store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', result: { preview }, error: null }); return store.getOperation(op.id)!;
      }).catch(error => {
        if (!(error instanceof GitDomainError) || error.code !== 'GIT_UNAVAILABLE') throw error;
        const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'enable_preview', idempotencyKey: request.idempotencyKey,
          requestDigest: digest, basis: basis(id), payload: { blockedDependency: 'git' } });
        const preview: ProjectGitPreview = { id: op.id, kind: 'enable', basis: op.basis, targetOid: null, expiresAt: input.now() + 15 * 60_000,
          changes: emptyChanges(), dependencies: [{ kind: 'git', label: error.message, requiredForContent: false, nextStep: null }] };
        store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', result: { preview }, error: null });
        return store.getOperation(op.id)!;
      });
    },
    async enable(id: string, previewId: string, request: BindingRequestContext): Promise<ProjectGitOperation> {
      await authorizeRequest(id, request); const digest = requestHash({ kind: 'enable', id, previewId, expectedProjectRevision: request.expectedProjectRevision ?? null });
      let prior = existing(id, 'enable', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
      if (!prior) store.assertRevision(id, request.expectedProjectRevision);
      const project = await resolveAuthorized(id);
      return input.scheduler.withNetworkPaused(id, async () => {
        prior = existing(id, 'enable', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
        const preview = store.getJournal(previewId);
        const pending = prior && store.listPendingRegistrations().find(item => item.userOperationId === prior!.id);
        if (pending) {
          if (!preview || preview.actorId !== request.actorId || preview.projectId !== id || preview.kind !== 'enable_preview'
            || pending.kind !== 'enable' || pending.completion !== 'checkpoint' || !isDeepStrictEqual(pending.originalUserBasis, preview.basis)) throw stateChanged();
          return completeEnable(id, prior!, await readEvidence(preview), pending);
        }
        if (!preview || preview.actorId !== request.actorId || preview.projectId !== id || preview.kind !== 'enable_preview'
          || preview.status !== 'succeeded' || preview.result?.preview?.id !== previewId || preview.result.preview.expiresAt <= input.now()
          || preview.result.preview.dependencies.some(item => item.requiredForContent || item.nextStep?.action === 'retry' || ['git', 'identity'].includes(item.kind))) throw stateChanged();
        const captured = await readEvidence(preview);
        const initialization = prior && captured.git === null && store.getEnableInitialization(prior.id);
        let initialized = false;
        if (initialization) {
          try { await lstat(join(project.root, '.git')); initialized = true; }
          catch (error) { if (!absent(error)) throw error; }
        }
        if (initialized && await resumeInitializedProjectGate({ root: project.root, ...input.ownership, store, operationRoot: input.operationRoot, operationId: prior!.id }) !== project.gate) throw stateChanged();
        let consumer: ProjectGitJournalRecord;
        await project.gate.exclusive(async () => {
          const current = await capture(id, project, captured);
          if (initialized) current.git = null;
          if (!sameCapture(current, captured) || captured.dependencies.length || captured.changes.privatePaths.length) throw stateChanged();
          const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'enable', basis: preview.basis,
            idempotencyKey: request.idempotencyKey, requestDigest: digest, payload: { previewId, previewContentDigest: captured.digest } });
          consumer = store.getJournal(op.id)!; store.consumePreview(previewId, consumer.id);
          if (captured.git === null) {
            const info = await lstat(project.root);
            store.freezeEnableInitialization(consumer.id, { projectId: id, canonicalRoot: project.root, dev: String(info.dev), ino: String(info.ino),
              branch: captured.localBranch, objectFormat: 'sha1', previewId, previewEvidenceDigest: (preview.payload as { evidenceDigest: string }).evidenceDigest,
              basis: consumer.basis });
          }
        });
        let intent: ProjectGitRegistrationIntent;
        if (captured.git === null && !initialized) await initializeProjectRepository({ root: project.root, ...input.ownership,
          initialBranch: captured.localBranch, objectFormat: 'sha1', ...(input.gitEnv ? { env: input.gitEnv } : {}) }, async () => {
          intent = await prepareIntent(id, consumer!, captured, 'checkpoint', null, captured.localBranch);
        }, async () => {
          const frozen = store.getEnableInitialization(consumer!.id); const durablePreview = store.getJournal(previewId);
          const info = await lstat(project.root);
          if (!frozen || !durablePreview || frozen.previewId !== previewId || frozen.projectId !== id || frozen.canonicalRoot !== project.root
            || frozen.dev !== String(info.dev) || frozen.ino !== String(info.ino) || !info.isDirectory() || info.isSymbolicLink()
            || await realpath(project.root) !== project.root || frozen.branch !== captured.localBranch || frozen.objectFormat !== 'sha1'
            || !isDeepStrictEqual(frozen.basis, captured.basis) || durablePreview.actorId !== request.actorId || durablePreview.projectId !== id
            || durablePreview.kind !== 'enable_preview' || durablePreview.status !== 'succeeded'
            || frozen.previewEvidenceDigest !== (durablePreview.payload as { evidenceDigest?: unknown }).evidenceDigest
            || !isDeepStrictEqual(await readEvidence(durablePreview), captured)
            || !sameCapture(await capture(id, project, captured), captured)) throw stateChanged();
        });
        else await project.gate.exclusive(async () => { intent = await prepareIntent(id, consumer!, captured, 'checkpoint', null, captured.localBranch); });
        return completeEnable(id, consumer!, captured, intent!);
      });
    },
    async previewBinding(id: string, rawUrl: string, rawBranch: string, request: BindingRequestContext): Promise<ProjectGitOperation> {
      await authorizeRequest(id, request); const url = validateRemote(rawUrl); const branch = await validateBranch(rawBranch);
      const digest = requestHash({ kind: 'binding_preview', id, url, branch, expectedProjectRevision: request.expectedProjectRevision ?? null });
      const prior = existing(id, 'binding_preview', request, digest); if (prior) return store.getOperation(prior.id)!;
      store.assertRevision(id, request.expectedProjectRevision); const project = await resolveAuthorized(id);
      const b = store.getBinding(id); if (!b || (b.remoteUrl !== null && b.autoSync)) throw new GitDomainError('CONFLICT', 409, 'Pause automatic synchronization before rebinding.');
      return input.scheduler.withNetworkPaused(id, async () => {
        const winner = existing(id, 'binding_preview', request, digest); if (winner) return store.getOperation(winner.id)!;
        store.assertRevision(id, request.expectedProjectRevision);
        await input.checkpointCurrent(id);
        const remoteHead = await targetHead(project.root, url, branch);
        return project.gate.exclusive(async () => {
          const captured = await capture(id, project);
          captured.availabilityDependencies = await availability(id, request.actorId, parsePortableEntries(unpack(captured)));
          const local = captured.basis.localHead ? await inspectBindingCommit(project.root, captured.basis.localHead) : null;
          const remote = remoteHead ? await inspectBindingCommit(project.root, remoteHead) : null;
          let bases: string[] = [];
          if (captured.basis.localHead && remoteHead) try { bases = (await runGit({ cwd: project.root,
            args: ['merge-base', '--all', captured.basis.localHead, remoteHead] })).stdout.toString().trim().split('\n').filter(Boolean); }
          catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; }
          const classification = classifyBinding({ localProjectId: local?.snapshot?.manifest.repositoryProjectId ?? null,
            remoteProjectId: remote?.snapshot?.manifest.repositoryProjectId ?? null, remoteHead, hasCommonAncestor: bases.length > 0 });
          const preview: ProjectGitBindingPreview = { classification,
            metadataSources: remoteHead && (!local?.snapshot || !remote?.snapshot) ? [local?.snapshot ? 'local' : 'remote'] : [],
            requiredPaths: classification === 'independent_history' ? [...new Set([...local!.files.keys(), ...remote!.files.keys()])].sort() : [] };
          if (bases.length === 1 && local?.snapshot && remote?.snapshot
            && !(await inspectBindingCommit(project.root, bases[0]!)).snapshot
            && canonicalJson(jsonValue(local.snapshot)) === canonicalJson(jsonValue(remote.snapshot))) preview.metadataSources = ['local', 'remote'];
          captured.bindingTarget = { url, branch, remoteHead, preview };
          const changes = { ...captured.changes, addedPaths: [] as string[], modifiedPaths: [] as string[], deletedPaths: [] as string[],
            settingsChanged: 0, conversationsChanged: 0 };
          if (classification === 'independent_history') changes.collisions = preview.requiredPaths.map(path => ({ id: path, kind: 'path' as const, label: path }));
          if (classification === 'empty' || classification === 'shared_history') {
            const candidate = await bindingCandidate(project, captured, preview.metadataSources.length ? { metadataSource: preview.metadataSources[0]! } : {});
            captured.bindingTarget.candidate = candidate;
            const selected = candidate ? await inspectBindingCommit(project.root, candidate.candidateOid) : local;
            if (selected?.snapshot) captured.availabilityDependencies = await availability(id, request.actorId, selected.snapshot);
            const before = local?.files ?? new Map(); const after = selected?.files ?? new Map();
            for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
              const old = before.get(path); const next = after.get(path);
              if (!old) changes.addedPaths.push(path);
              else if (!next) changes.deletedPaths.push(path);
              else if (old.mode !== next.mode || !old.bytes.equals(next.bytes)) changes.modifiedPaths.push(path);
            }
            changes.settingsChanged = Number(!isDeepStrictEqual(local?.snapshot?.project, selected?.snapshot?.project));
            const oldConversations = new Map((local?.snapshot?.conversations ?? []).map(item => [item.id, item]));
            const newConversations = new Map((selected?.snapshot?.conversations ?? []).map(item => [item.id, item]));
            changes.conversationsChanged = [...new Set([...oldConversations.keys(), ...newConversations.keys()])]
              .filter(key => !isDeepStrictEqual(oldConversations.get(key), newConversations.get(key))
                || !isDeepStrictEqual(local?.snapshot?.messages.filter(item => item.conversationId === key),
                  selected?.snapshot?.messages.filter(item => item.conversationId === key))).length;
          }
          captured.bindingTarget.changes = changes;
          const payload = await evidence(captured);
          const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'binding_preview', basis: captured.basis,
            idempotencyKey: request.idempotencyKey, requestDigest: digest, payload });
          store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', error: null, result: { preview: {
            id: op.id, kind: 'bind', basis: captured.basis, targetOid: remoteHead, expiresAt: input.now() + 15 * 60_000,
            changes, dependencies: [...captured.dependencies, ...captured.availabilityDependencies], binding: preview } } });
          return store.getOperation(op.id)!;
        });
      });
    },
    async bind(id: string, previewId: string, request: BindingRequestContext & { confirmation?: ProjectGitBindConfirmation }): Promise<ProjectGitOperation> {
      await authorizeRequest(id, request);
      const digest = requestHash({ kind: 'bind', id, previewId, confirmation: request.confirmation ?? {}, expectedProjectRevision: request.expectedProjectRevision ?? null });
      let prior = existing(id, 'bind', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
      if (!prior) store.assertRevision(id, request.expectedProjectRevision);
      const project = await resolveAuthorized(id);
      return input.scheduler.withNetworkPaused(id, async () => {
        prior = existing(id, 'bind', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
        const preview = store.getJournal(previewId);
        const pending = prior && store.getRegistration(prior.id)?.state === 'pending';
        if (!preview || preview.actorId !== request.actorId || preview.projectId !== id || preview.kind !== 'binding_preview'
          || preview.status !== 'succeeded' || preview.result?.preview?.id !== previewId || (!pending && preview.result.preview.expiresAt <= input.now())) throw stateChanged();
        const captured = await readEvidence(preview); const target = captured.bindingTarget;
        if (!target) throw validation(); validateBindingConfirmation(target.preview, request.confirmation);
        if (prior && pending) return completeBinding(id, prior, captured);
        if (preview.result.preview.dependencies.some(item => item.requiredForContent || item.nextStep?.action === 'retry')) throw stateChanged();
        if (await targetHead(project.root, target.url, target.branch) !== target.remoteHead) throw stateChanged();
        let user: ProjectGitJournalRecord;
        await project.gate.exclusive(async () => {
          if (!sameCapture(await capture(id, project, captured), captured)) throw stateChanged();
          const candidate = await bindingCandidate(project, captured, validateBindingConfirmation(target.preview, request.confirmation));
          if (!sameCapture(await capture(id, project, captured), captured)) throw stateChanged();
          const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'bind', basis: preview.basis,
            idempotencyKey: request.idempotencyKey, requestDigest: digest, payload: { previewId, confirmation: jsonValue(request.confirmation ?? {}), previewContentDigest: captured.digest } });
          user = store.getJournal(op.id)!; store.consumePreview(previewId, user.id);
          await prepareIntent(id, user, captured, candidate ? 'materialization' : 'binding_only', target.url, target.branch,
            candidate?.candidateOid, undefined, candidate?.publicationMode);
        });
        return completeBinding(id, user!, captured);
      });
    },
    async unbind(id: string, request: BindingRequestContext): Promise<ProjectGitOperation> {
      await authorizeRequest(id, request); const digest = requestHash({ kind: 'unbind', id, expectedProjectRevision: request.expectedProjectRevision ?? null });
      let prior = existing(id, 'unbind', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
      if (!prior) store.assertRevision(id, request.expectedProjectRevision);
      const project = await resolveAuthorized(id);
      return input.scheduler.withNetworkPaused(id, async () => {
        prior = existing(id, 'unbind', request, digest); if (prior?.status === 'succeeded') return store.getOperation(prior.id)!;
        if (prior && store.getRegistration(prior.id)?.state === 'pending') return completeBindingOnly(id, prior, await readEvidence(prior));
        let captured: BindingCapture; let user: ProjectGitJournalRecord;
        await project.gate.exclusive(async () => {
          if (!prior) store.assertRevision(id, request.expectedProjectRevision);
          captured = prior ? await readEvidence(prior) : await capture(id, project);
          if (prior && !sameCapture(await capture(id, project, captured), captured)) throw stateChanged();
          const payload = prior?.payload ?? await evidence(captured);
          const b = store.getBinding(id); if (!b) throw stateChanged();
          const op = store.enqueueOperation({ projectId: id, actorId: request.actorId, kind: 'unbind', basis: captured.basis,
            idempotencyKey: request.idempotencyKey, requestDigest: digest, payload });
          user = store.getJournal(op.id)!; await prepareIntent(id, user, captured, 'binding_only', null, b.branch);
        });
        return completeBindingOnly(id, user!, captured!);
      });
    },
    async openRepository(request: BindingRequestContext & { url: string; branch: string }): Promise<ProjectGitOperation> {
      if (!request.actorId || !request.idempotencyKey) throw validation();
      await input.requireCreate(request.actorId); await input.recoveryReady;
      const url = validateRemote(request.url); const branch = await validateBranch(request.branch);
      const digest = requestHash({ kind: 'open', url, branch });
      let user = existing(null, 'open', request, digest);
      if (user?.status === 'succeeded') return store.getOperation(user.id)!;
      await roots();
      if (!user) {
        const queued = store.enqueueOperation({ projectId: null, actorId: request.actorId, kind: 'open', idempotencyKey: request.idempotencyKey,
          requestDigest: digest, payload: { url, branch, reservedProjectId: input.newId(), cloneId: input.newId(),
            plainRepositoryProjectId: input.newId(), createdAt: input.now() } });
        user = store.getJournal(queued.id)!;
      }
      const immutable = user.payload as { reservedProjectId: string; cloneId: string; plainRepositoryProjectId: string; createdAt: number };
      const id = immutable.reservedProjectId;
      if (![id, immutable.cloneId, immutable.plainRepositoryProjectId].every(value => typeof value === 'string' && /^[a-zA-Z0-9-]+$/u.test(value))
        || !Number.isSafeInteger(immutable.createdAt)) throw validation();
      const root = join(input.ownedProjectsRoot, id);
      let dependencies: ProjectGitDependency[] = [];
      try {
        let receipt = store.getOpenPreparation(user.id)?.root;
        if (!receipt) {
          // A pre-existing unreceipted directory is never adopted or removed.
          await mkdir(root, { mode: 0o700 }); await durableDirectory(root);
          const created = await lstat(root);
          store.freezeOpenPreparation(user.id, { root: { dev: String(created.dev), ino: String(created.ino) } });
          receipt = store.getOpenPreparation(user.id)!.root!;
        }
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || root !== await realpath(root)
          || !within(input.ownedProjectsRoot, root) || String(info.dev) !== receipt.dev || String(info.ino) !== receipt.ino) throw stateChanged();
        const pending = store.getRegistration(user.id);
        if (pending?.state === 'pending') {
          const gate = await getProjectGate({ root, ...input.ownership });
          input.reserveProject({ projectId: id, root, localBranch: pending.localBranch, gate, readBasis: () => basis(id) });
          recoveryBarrier(gate, user.id);
          if (!store.getJournal(user.id)!.recoveryData) {
            if (!pending.initialImport || pending.kind !== 'open' || pending.completion !== 'materialization') throw stateChanged();
            const original = await inspectBindingCommit(root, pending.initialImport.candidateOid);
            if (!original.snapshot) throw stateChanged();
            await registration.claimOwner(user.id);
            await materializeProject({ projectId: id, root, branch: pending.localBranch, operationId: user.id, operationDir: input.operationRoot,
              basis: pending.executionBasis, candidateOid: pending.initialImport.candidateOid, snapshot: original.snapshot, store, db, gate,
              publicationMode: 'initial_import', previewContentDigest: computeCheckpointContentDigest({ sourceDigests: {}, sourceModes: {}, portableDigests: {}, removedPaths: [] }),
              readBasis: () => basis(id), exportCurrentPortable: async () => new Map(), prepareRegistrationCompletion: registration.prepareRegistrationCompletion,
              ...(input.gitEnv ? { gitEnv: input.gitEnv } : {}) });
            return store.getOperation(user.id)!;
          }
          throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The original startup recovery must complete this journal.');
        }
        let remote = store.getOpenRemote(user.id);
        if (!remote) {
          const observed = await runGitTransport({ preparationRoot: input.preparationRoot, args: ['ls-remote', url, `refs/heads/${branch}`],
            ...(input.gitEnv ? { env: input.gitEnv } : {}) });
          const line = observed.stdout.toString().trim(); const head = line ? line.split(/\s/u)[0]! : null;
          if (head && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw validation();
          // An empty advertised branch has no object-format proof; this initial empty case is SHA-1 only.
          remote = { head, objectFormat: head?.length === 64 ? 'sha256' : 'sha1' }; store.freezeOpenRemote(user.id, remote);
        }
        const remoteHead = remote.head;
        let gate: ProjectGate;
        try { await lstat(join(root, '.git')); gate = await getProjectGate({ root, ...input.ownership }); }
        catch (error) { if (!absent(error)) throw error;
          gate = await getUnmanagedProjectGate({ root, ...input.ownership });
          await initializeProjectRepository({ root, ...input.ownership, initialBranch: branch, objectFormat: remote.objectFormat,
            ...(input.gitEnv ? { env: input.gitEnv } : {}) }, async () => {});
        }
        const objectStore = await discoverObjectStore(root);
        let tip: string | null = null;
        if (remoteHead) {
          try { tip = await resolveCommit(root, remoteHead); }
          catch (error) {
            if (!(error instanceof GitDomainError) || error.code === 'GIT_UNAVAILABLE') throw error;
            tip = (await runGitTransport({ preparationRoot: input.preparationRoot, ...objectStore, args: ['fetch', url, `refs/heads/${branch}`],
              ...(input.gitEnv ? { env: input.gitEnv } : {}) })).fetchedHead!;
          }
          if (tip !== remoteHead) throw stateChanged();
        }
        const inspected = tip ? await inspectBindingCommit(root, tip) : null;
        const frozen = store.getOpenPreparation(user.id)?.candidate;
        let snapshot = frozen ? (await inspectBindingCommit(root, frozen.candidateOid)).snapshot : inspected?.snapshot;
        let candidateOid = frozen?.candidateOid ?? tip;
        if (frozen && (!snapshot || canonicalJson(jsonValue(snapshot)) !== frozen.canonicalSnapshotJson
          || sha256(Buffer.from(frozen.canonicalSnapshotJson)) !== frozen.snapshotDigest)) throw stateChanged();
        if (!snapshot) {
          snapshot = { manifest: { schemaVersion: 1, repositoryProjectId: immutable.plainRepositoryProjectId, resources: [] },
            project: { schemaVersion: 1, name: 'Imported repository', createdAt: immutable.createdAt, kind: 'prototype', preferences: {},
              contentRefs: [], linkedFolderRequirements: [], ...(inspected?.files.has('index.html') ? { entryFile: 'index.html' } : {}) }, conversations: [], messages: [] };
          const entries = serializePortableMetadata(snapshot);
          const directory = await mkdtemp(join(input.operationRoot, 'plain-open-')); const date = new Date(immutable.createdAt).toISOString();
          const env = { ...input.gitEnv, GIT_INDEX_FILE: join(directory, 'candidate.index'), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
          await assertGitIdentity({ cwd: root, env }); await runGit({ cwd: root, args: ['read-tree', tip ?? '--empty'], env });
          const records: Buffer[] = [];
          for (const [path, bytes] of entries) {
            const oid = (await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: bytes })).stdout.toString().trim();
            records.push(Buffer.from(`100644 ${oid}\t${path}\0`));
          }
          await runGit({ cwd: root, args: ['update-index', '-z', '--index-info'], env, stdin: Buffer.concat(records) });
          const tree = (await runGit({ cwd: root, args: ['write-tree'], env })).stdout.toString().trim();
          candidateOid = (await runGit({ cwd: root, args: ['commit-tree', tree, ...(tip ? ['-p', tip] : [])], env,
            stdin: Buffer.from('Open Design: add portable project metadata\n') })).stdout.toString().trim();
          snapshot = (await inspectBindingCommit(root, candidateOid)).snapshot!;
        }
        const canonicalSnapshotJson = canonicalJson(jsonValue(snapshot));
        if (candidateOid !== remoteHead) {
          const parents = (await runGit({ cwd: root, args: ['rev-list', '--parents', '--max-count=1', candidateOid!] })).stdout.toString().trim().split(' ').slice(1);
          if (!isDeepStrictEqual(parents, remoteHead ? [remoteHead] : []) || snapshot.manifest.repositoryProjectId !== immutable.plainRepositoryProjectId
            || snapshot.project.createdAt !== immutable.createdAt) throw stateChanged();
        }
        store.freezeOpenPreparation(user.id, { candidate: { candidateOid: candidateOid!, repositoryProjectId: snapshot.manifest.repositoryProjectId,
          canonicalSnapshotJson, snapshotDigest: sha256(Buffer.from(canonicalSnapshotJson)) } });
        dependencies = await availability(id, request.actorId, snapshot);
        if (dependencies.some(item => item.requiredForContent || item.nextStep?.action === 'retry')) {
          throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Resolve the listed project dependencies before importing.');
        }
        const project = { root, branch, gate, ...(input.gitEnv ? { gitEnv: input.gitEnv } : {}) };
        const captured: BindingCapture = { root, localBranch: branch, repositoryProjectId: snapshot.manifest.repositoryProjectId,
          cloneId: immutable.cloneId, basis: basis(id), git: await discoverRepository(root), entries: [], sourceDigests: {}, sourceModes: {}, inventory: [],
          digest: computeCheckpointContentDigest({ sourceDigests: {}, sourceModes: {}, portableDigests: {}, removedPaths: [] }), changes: emptyChanges(), dependencies: [] };
        let intent: ProjectGitRegistrationIntent;
        const existingProjectIds: string[] = [];
        for (const binding of store.listBindings()) {
          if (binding.projectId === id || binding.repositoryProjectId !== captured.repositoryProjectId) continue;
          try { await input.requireProject(request.actorId, binding.projectId); existingProjectIds.push(binding.projectId); }
          catch { /* Unauthorized or removed copies are not disclosed. */ }
        }
        existingProjectIds.sort();
        await gate.exclusive(async () => {
          if (!isDeepStrictEqual(await readdir(root), ['.git']) || (await discoverRepository(root)).head !== null) throw stateChanged();
          intent = await prepareIntent(id, user!, captured, 'materialization', url, branch, candidateOid!, project, undefined, existingProjectIds, dependencies);
        });
        await registration.claimOwner(user.id);
        await materializeProject({ projectId: id, root, branch, operationId: user.id, operationDir: input.operationRoot,
          basis: intent!.executionBasis, candidateOid: candidateOid!, snapshot, store, db, gate, publicationMode: 'initial_import',
          previewContentDigest: captured.digest, readBasis: () => basis(id), exportCurrentPortable: async () => new Map(),
          prepareRegistrationCompletion: registration.prepareRegistrationCompletion, ...(input.gitEnv ? { gitEnv: input.gitEnv } : {}) });
        return store.getOperation(user.id)!;
      } catch (error) {
        if (!store.getRegistration(user.id) && store.getJournal(user.id)?.journalPhase === null) {
          const failure = error instanceof GitDomainError ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
            : error instanceof Error && error.name === 'ZodError' ? { code: 'PORTABLE_FORMAT_UNSUPPORTED' as const, message: 'The portable project format is unsupported.' }
            : { code: 'CONFLICT' as const, message: 'Repository preparation failed. Retry the original operation.' };
          const dependency: ProjectGitDependency | null = error instanceof GitDomainError && error.code === 'PORTABLE_RESOURCE_MISSING'
            ? { kind: error.details?.reason === 'submodule' ? 'submodule' : error.message.startsWith('Git LFS') ? 'lfs' : 'resource',
              label: error.message, requiredForContent: true, nextStep: null } : null;
          store.updateOperation(user.id, { status: 'failed', phase: 'failed', result: dependencies.length ? { dependencies } : dependency ? { dependencies: [dependency] } : null, error: failure });
          if (error instanceof GitDomainError || error instanceof Error && error.name === 'ZodError'
            || expectedSystemFailure(error)) return store.getOperation(user.id)!;
        }
        throw error;
      }
    },
  };
  const inFlight = new Map<string, { digest: string; promise: Promise<ProjectGitOperation> }>();
  async function share(id: string | null, kind: string, request: BindingRequestContext, semantics: unknown,
    work: () => Promise<ProjectGitOperation>): Promise<ProjectGitOperation> {
    if (id === null) {
      if (!request.actorId || !request.idempotencyKey) throw validation();
      await input.requireCreate(request.actorId); await input.recoveryReady;
    } else await authorizeRequest(id, request);
    const key = JSON.stringify([request.actorId, id, kind, request.idempotencyKey]);
    const digest = requestHash(typeof semantics === 'function' ? await semantics() : semantics);
    const current = inFlight.get(key);
    if (current) {
      if (current.digest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
      return current.promise;
    }
    const promise = Promise.resolve().then(work); inFlight.set(key, { digest, promise });
    try { return await promise; } finally { if (inFlight.get(key)?.promise === promise) inFlight.delete(key); }
  }
  return { ...service,
    previewEnable: (id: string, request: BindingRequestContext) => share(id, 'enable_preview', request,
      { expectedProjectRevision: request.expectedProjectRevision ?? null }, () => service.previewEnable(id, request)),
    enable: (id: string, previewId: string, request: BindingRequestContext) => share(id, 'enable', request,
      { previewId, expectedProjectRevision: request.expectedProjectRevision ?? null }, () => service.enable(id, previewId, request)),
    previewBinding: (id: string, url: string, branch: string, request: BindingRequestContext) => share(id, 'binding_preview', request,
      async () => ({ url: validateRemote(url), branch: await validateBranch(branch), expectedProjectRevision: request.expectedProjectRevision ?? null }),
      () => service.previewBinding(id, url, branch, request)),
    bind: (id: string, previewId: string, request: BindingRequestContext & { confirmation?: ProjectGitBindConfirmation }) => share(id, 'bind', request,
      { previewId, confirmation: request.confirmation ?? {}, expectedProjectRevision: request.expectedProjectRevision ?? null }, () => service.bind(id, previewId, request)),
    unbind: (id: string, request: BindingRequestContext) => share(id, 'unbind', request,
      { expectedProjectRevision: request.expectedProjectRevision ?? null }, () => service.unbind(id, request)),
    openRepository: (request: BindingRequestContext & { url: string; branch: string }) => share(null, 'open', request,
      async () => ({ url: validateRemote(request.url), branch: await validateBranch(request.branch) }), () => service.openRepository(request)),
  };
}

/** Preflight the immutable tree's entire path set before the first blob/content read. */
export async function inspectBindingCommit(root: string, oid: string) {
  await resolveCommit(root, oid);
  const raw = (await runGit({ cwd: root, args: ['ls-tree', '-r', '-z', '--full-tree', oid] })).stdout;
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw) || (raw.length && !text.endsWith('\0'))) throw new GitDomainError('VALIDATION_FAILED', 400, 'Invalid Git paths.');
  const entries = text.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t(.+)$/su.exec(line);
    if (!match) throw new GitDomainError('VALIDATION_FAILED', 400, 'Invalid Git tree record.');
    return { mode: match[1]!, path: match[3]! };
  });
  const submodules = entries.filter(entry => entry.mode === '160000').map(entry => entry.path);
  if (submodules.length) throw new GitDomainError('PORTABLE_RESOURCE_MISSING', 409, 'Submodule content requires separate handling.',
    { reason: 'submodule', paths: submodules });
  validateTreeEntries(entries);
  const privatePaths = entries.filter(entry => isPrivateProjectGitPath(entry.path)).map(entry => entry.path);
  if (privatePaths.length) throw new GitDomainError('VALIDATION_FAILED', 400, 'Private configuration cannot be imported.', { paths: privatePaths });
  const files = await gitTree(root, oid);
  const reserved = [...files.keys()].some(path => path.split('/')[0]!.normalize('NFC').toLowerCase() === '.open-design');
  const snapshot = reserved ? parsePortableEntries(new Map([...files].map(([path, file]) => [path, file.bytes]))) : null;
  return { files, snapshot };
}

/** An explicitly selected two-parent candidate; no synthetic common ancestor is used. */
export async function prepareIndependentBinding(input: {
  root: string; local: string; remote: string; stagingDir: string;
  preview: ProjectGitBindingPreview; confirmation: ProjectGitBindConfirmation; gitEnv?: Record<string, string>;
}) {
  const repository = await discoverRepository(input.root);
  if (repository.head !== input.local || !isAbsolute(input.stagingDir) || await realpath(input.stagingDir) !== input.stagingDir
    || input.stagingDir === repository.root || within(repository.root, input.stagingDir)
    || input.stagingDir === repository.commonDir || within(repository.commonDir, input.stagingDir)) {
    throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The candidate preparation context changed.');
  }
  const local = await inspectBindingCommit(input.root, input.local);
  const remote = await inspectBindingCommit(input.root, input.remote);
  let hasCommonAncestor: boolean;
  try { hasCommonAncestor = (await runGit({ cwd: input.root, args: ['merge-base', '--all', input.local, input.remote] })).stdout.length > 0; }
  catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; hasCommonAncestor = false; }
  const classification = classifyBinding({ localProjectId: local.snapshot?.manifest.repositoryProjectId ?? null,
    remoteProjectId: remote.snapshot?.manifest.repositoryProjectId ?? null, hasCommonAncestor, remoteHead: input.remote });
  if (classification !== 'independent_history' || (!local.snapshot && !remote.snapshot)) {
    throw new GitDomainError('CONFLICT', 409, 'These histories do not support independent binding.');
  }
  const requiredPaths = [...new Set([...local.files.keys(), ...remote.files.keys()])].sort();
  const metadataSources: ('local' | 'remote')[] = local.snapshot && remote.snapshot ? [] : [local.snapshot ? 'local' : 'remote'];
  if (!isDeepStrictEqual(input.preview, { classification, metadataSources, requiredPaths })) {
    throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original binding path choices changed.');
  }
  const confirmation = validateBindingConfirmation(input.preview, input.confirmation);
  const files: Awaited<ReturnType<typeof gitTree>> = new Map();
  for (const choice of confirmation.paths!) {
    if (choice.selectedSide === 'delete') continue;
    const file = (choice.selectedSide === 'local' ? local.files : remote.files).get(choice.path);
    if (!file) throw new GitDomainError('VALIDATION_FAILED', 400, 'The selected side does not contain this path.', { paths: [choice.path] });
    files.set(choice.path, file);
  }
  validateTreeEntries([...files].map(([path, file]) => ({ path, mode: file.mode })));
  const snapshot = parsePortableEntries(new Map([...files].map(([path, file]) => [path, file.bytes])));
  const directory = await mkdtemp(join(input.stagingDir, 'independent-binding-'));
  const env = { ...input.gitEnv, GIT_INDEX_FILE: join(directory, 'candidate.index') };
  await runGit({ cwd: input.root, args: ['read-tree', '--empty'], env });
  await runGit({ cwd: input.root, args: ['update-index', '-z', '--index-info'], env,
    stdin: Buffer.concat([...files].map(([path, file]) => Buffer.from(`${file.mode} ${file.oid}\t${path}\0`))) });
  const tree = (await runGit({ cwd: input.root, args: ['write-tree'], env })).stdout.toString().trim();
  const oid = (await runGit({ cwd: input.root, args: ['commit-tree', tree, '-p', input.local, '-p', input.remote], env,
    stdin: Buffer.from('Open Design: explicitly combine independent histories\n') })).stdout.toString().trim();
  return { oid, snapshot };
}

/** The supplied preview is the persisted original provenance, never client-reconstructed. */
export function validateBindingConfirmation(preview: ProjectGitBindingPreview, input: unknown): ProjectGitBindConfirmation {
  const parsed = ProjectGitBindConfirmationSchema.safeParse(input ?? {});
  const invalid = () => new GitDomainError('VALIDATION_FAILED', 400, 'Confirm every original binding choice before proceeding.');
  if (!parsed.success) throw invalid();
  if (preview.classification === 'different_project') throw new GitDomainError('CONFLICT', 409, 'Open the other project separately.');
  const confirmation = parsed.data;
  const paths = confirmation.paths ?? [];
  if (paths.length !== preview.requiredPaths.length || paths.some(item => !preview.requiredPaths.includes(item.path))) throw invalid();
  if (preview.metadataSources.length) {
    if (!confirmation.metadataSource || !preview.metadataSources.includes(confirmation.metadataSource)) throw invalid();
  } else if (confirmation.metadataSource !== undefined) throw invalid();
  return { ...(confirmation.paths === undefined ? {} : { paths: confirmation.paths }),
    ...(confirmation.metadataSource === undefined ? {} : { metadataSource: confirmation.metadataSource }) };
}

export function classifyBinding(input: {
  localProjectId: string | null;
  remoteProjectId: string | null;
  hasCommonAncestor: boolean;
  remoteHead: string | null;
}): 'empty' | 'shared_history' | 'independent_history' | 'different_project' {
  if (input.localProjectId && input.remoteProjectId && input.localProjectId !== input.remoteProjectId) {
    return 'different_project';
  }
  if (input.remoteHead === null) return 'empty';
  return input.hasCommonAncestor ? 'shared_history' : 'independent_history';
}
