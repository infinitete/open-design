import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { JsonValue, PortableSnapshot, ProjectGitAccepted, ProjectGitBasis, ProjectGitChangeSummary, ProjectGitPreview } from '@open-design/contracts';
import type { ProjectGitStore } from '../../storage/project-git.js';
import { computeCheckpointContentDigest, isPrivateProjectGitPath } from './checkpoint.js';
import { GitDomainError } from './errors.js';
import { assertGitIdentity, runGit } from './git-process.js';
import type { ProjectGate } from './gate.js';
import { assertHistoryCommit, assertHistoryPath, readHistoryEntries } from './history.js';
import { readLegacyProjectFile, type ProjectFileHistoryId } from '../../project-file-versions.js';
import { materializeProject, type MaterializeEffect, type MaterializePhase } from './materialize.js';
import { canonicalJson, exportPortableProject, parsePortableEntries } from './portable.js';
import { discoverRepository, validateTreeEntries } from './repository.js';
import { durableDirectory, safeFile, sha256, within } from './recovery.js';
import { isNativeProjectHistoryPath, nativeHistoryRoot, projectGitPaths } from './paths.js';

export interface RestoreRequestContext { actorId: string; idempotencyKey: string; expectedProjectRevision?: number }
export interface ProjectGitRestoreServiceInput {
  db: Database.Database; store: ProjectGitStore; operationRoot: string; recoveryReady: Promise<void>;
  now(): number;
  requireProject(actorId: string, projectId: string): void | Promise<void>;
  resolveProject(projectId: string): { root: string; nativeLegacyRoot?: string; branch: string; gate: ProjectGate; gitEnv?: Record<string, string>;
    readOwnedResource?: (reference: string) => Promise<Uint8Array | null> };
  afterEffect?: (point: MaterializeEffect, path?: string) => Promise<void>;
  afterDurablePhase?: (phase: MaterializePhase) => Promise<void>;
}
interface Capture {
  nativeLegacyRoot: string;
  recordsMode: 'replace' | 'preserve';
  file: { path: string; history: ProjectFileHistoryId } | null;
  targetOid: string; candidateOid: string; contentDigest: string; sourceDigests: Record<string, string>; sourceModes: Record<string, string>;
  portable: [string, string][]; paths: string[]; indexDigest: string | null; snapshot: PortableSnapshot;
}
const changed = () => new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Restore preview is no longer current. Create a new preview.');
const invalid = () => new GitDomainError('VALIDATION_FAILED', 400, 'Invalid restore request.');
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const digest = (value: unknown): string => sha256(Buffer.from(canonicalJson(json(value))));

export function createProjectGitRestoreService(input: ProjectGitRestoreServiceInput) {
  const { db, store } = input; store.assertDatabase(db);
  const basis = (id: string): ProjectGitBasis => {
    const b = store.getBinding(id); if (!b) throw new GitDomainError('NOT_FOUND', 404, 'Managed project not found.');
    return { bindingGeneration: b.generation, projectRevision: b.projectRevision, contentRevision: b.contentRevision,
      localHead: b.localHead, remoteHead: b.observedRemoteHead };
  };
  async function authorized(id: string, request: RestoreRequestContext) {
    await input.requireProject(request.actorId, id); await input.recoveryReady;
    if (!request.idempotencyKey || !request.actorId) throw invalid();
    return input.resolveProject(id);
  }
  function assertIdle(id: string, project: ReturnType<ProjectGitRestoreServiceInput['resolveProject']>) {
    if (project.gate.activeRuns()) throw new GitDomainError('PROJECT_BUSY', 409, 'Wait for the active project run.');
    if (store.listPendingOperations().some(op => op.projectId === id && op.phase === 'conflict')) throw new GitDomainError('GIT_CONFLICT', 409, 'Resolve the current project conflict first.');
  }
  async function inspect(id: string, expected: ProjectGitBasis) {
    const project = input.resolveProject(id); const b = store.getBinding(id)!;
    const repository = await discoverRepository(project.root);
    if (!isDeepStrictEqual(basis(id), expected) || !repository.head || repository.head !== expected.localHead
      || repository.branch !== project.branch || repository.root !== b.canonicalRoot || repository.commonDir !== b.commonDir
      || (b.localBranch ?? b.branch) !== project.branch) throw changed();
    for (const name of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'sequencer']) {
      try { await lstat(join(repository.gitDir, name)); throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'External Git operation requires attention.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if ((await runGit({ cwd: project.root, args: ['diff-index', '--cached', '--raw', '-z', repository.head] })).stdout.length) throw new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'Staged changes require attention.');
    const listed = await Promise.all([['ls-files', '--cached', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']].map(async args => {
      const raw = (await runGit({ cwd: project.root, args })).stdout; const text = raw.toString();
      if (!Buffer.from(text).equals(raw) || (raw.length && !text.endsWith('\0'))) throw invalid();
      return text.split('\0').filter(Boolean);
    }));
    const paths = projectGitPaths(listed[0]!, listed[1]!);
    validateTreeEntries(paths.map(path => ({ path, mode: '100644' })));
    const index = await safeFile(repository.gitDir, 'index');
    return { paths, indexDigest: index.bytes ? sha256(index.bytes) : null };
  }
  async function exported(id: string, expectedRoot?: string) {
    const b = store.getBinding(id)!; const project = input.resolveProject(id);
    return exportPortableProject({ db, store, projectId: id, root: project.root, nativeLegacyRoot: await nativeHistoryRoot(project.root, project.nativeLegacyRoot, expectedRoot), repositoryProjectId: b.repositoryProjectId, cloneId: b.cloneId,
      ...(project.readOwnedResource ? { readOwnedResource: project.readOwnedResource } : {}) });
  }
  async function sources(root: string, paths: string[]) {
    const sourceDigests: Record<string, string> = {}; const sourceModes: Record<string, string> = {};
    for (const path of paths) {
      const file = await safeFile(root, path); sourceDigests[path] = file.bytes ? sha256(file.bytes) : 'missing'; sourceModes[path] = file.mode;
    }
    return { sourceDigests, sourceModes };
  }
  async function verify(id: string, expected: ProjectGitBasis, captured: Capture) {
    const project = input.resolveProject(id); const current = await inspect(id, expected);
    await nativeHistoryRoot(project.root, project.nativeLegacyRoot, captured.nativeLegacyRoot ?? project.root);
    if (!isDeepStrictEqual(current.paths, captured.paths) || current.indexDigest !== captured.indexDigest
      || !isDeepStrictEqual(await sources(project.root, Object.keys(captured.sourceDigests)), { sourceDigests: captured.sourceDigests, sourceModes: captured.sourceModes })
      || !isDeepStrictEqual([...((await exported(id, captured.nativeLegacyRoot ?? project.root)).entries)].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]), captured.portable)) throw changed();
    if (!isDeepStrictEqual(basis(id), expected)) throw changed();
  }
  async function candidate(root: string, head: string, entries: Map<string, { bytes: Buffer; mode: string }>, targetOid: string, gitEnv?: Record<string, string>) {
    if (!isAbsolute(input.operationRoot)) throw invalid();
    await durableDirectory(input.operationRoot);
    if (await realpath(input.operationRoot) !== input.operationRoot || input.operationRoot === root || within(root, input.operationRoot)) throw invalid();
    const scratch = await mkdtemp(join(input.operationRoot, 'restore-preview-'));
    const env = { ...gitEnv, GIT_INDEX_FILE: join(scratch, 'candidate.index') };
    await runGit({ cwd: root, args: ['read-tree', '--empty'], env }); const records: Buffer[] = [];
    for (const [path, item] of entries) {
      const oid = (await runGit({ cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: item.bytes })).stdout.toString().trim();
      records.push(Buffer.from(`${item.mode} ${oid}\t${path}\0`));
    }
    await runGit({ cwd: root, args: ['update-index', '-z', '--index-info'], env, stdin: Buffer.concat(records) });
    const tree = (await runGit({ cwd: root, args: ['write-tree'], env })).stdout.toString().trim();
    return (await runGit({ cwd: root, args: ['commit-tree', tree, '-p', head], env,
      stdin: Buffer.from(`Open Design restore\n\nrestoreTarget: ${targetOid}\n`) })).stdout.toString().trim();
  }
  async function capturePreview(id: string, targetOid: string, request: RestoreRequestContext, file?: { path: string; history: ProjectFileHistoryId }): Promise<ProjectGitPreview> {
    const project = await authorized(id, request);
    assertIdle(id, project);
    return project.gate.exclusive(async () => {
      const nativeLegacyRoot = await nativeHistoryRoot(project.root, project.nativeLegacyRoot);
      const expected = basis(id); store.assertRevision(id, request.expectedProjectRevision);
      const current = await inspect(id, expected); await assertGitIdentity({ cwd: project.root, ...(project.gitEnv ? { env: project.gitEnv } : {}) });
      let target = await readHistoryEntries(project.root, targetOid);
      const base = await readHistoryEntries(project.root, expected.localHead!);
      const portable = (await exported(id, nativeLegacyRoot)).entries;
      if (file) {
        assertHistoryPath(file.path);
        if (isNativeProjectHistoryPath(file.path) || file.path.split('/').some(part => part.normalize('NFC').toLowerCase() === '.open-design')) throw invalid();
        if (file.history.source === 'legacy' && file.history.path !== file.path) throw invalid();
        const historical = file.history.source === 'git' ? target.get(file.path)
          : { bytes: Buffer.from((await readLegacyProjectFile(project.root, file.path, file.history.legacyId, nativeLegacyRoot)).content),
            mode: (await safeFile(project.root, file.path)).mode === '100755' ? '100755' : '100644' };
        if (!historical) throw new GitDomainError('NOT_FOUND', 404, 'Historical file not found.');
        target = new Map();
        for (const path of current.paths) {
          const value = await safeFile(project.root, path);
          if (value.bytes && !path.startsWith('.open-design/')) target.set(path, { bytes: value.bytes, mode: value.mode });
        }
        target.set(file.path, historical);
      }
      const hasMetadata = !file && [...target.keys()].some(path => path.split('/')[0]!.normalize('NFC').toLowerCase() === '.open-design');
      const snapshot = hasMetadata ? parsePortableEntries(new Map([...target].map(([path, item]) => [path, item.bytes]))) : parsePortableEntries(portable);
      if (snapshot.manifest.repositoryProjectId !== store.getBinding(id)!.repositoryProjectId) throw invalid();
      if (!hasMetadata) for (const [path, bytes] of portable) target.set(path, { bytes: Buffer.from(bytes), mode: (await safeFile(project.root, path)).mode === '100755' ? '100755' : '100644' });
      // Native single-file history is local evidence, never an historical restore destination.
      for (const path of target.keys()) if (isNativeProjectHistoryPath(path)) target.delete(path);
      for (const path of current.paths) if (isNativeProjectHistoryPath(path)) {
        const value = await safeFile(project.root, path); if (value.bytes) target.set(path, { bytes: value.bytes, mode: value.mode });
      }
      const paths = [...new Set([...current.paths, ...base.keys(), ...target.keys(), ...portable.keys()])].sort();
      if (paths.some(isPrivateProjectGitPath)) throw invalid();
      validateTreeEntries(paths.map(path => ({ path, mode: '100644' })));
      const source = await sources(project.root, paths);
      for (const path of target.keys()) if (!base.has(path) && !current.paths.includes(path) && source.sourceDigests[path] !== 'missing') throw changed();
      const removedPaths = [...base.keys()].filter(path => path.startsWith('.open-design/') && !portable.has(path));
      const contentDigest = computeCheckpointContentDigest({ ...source, portableDigests: Object.fromEntries([...portable].map(([path, bytes]) => [path, sha256(bytes)])), removedPaths });
      const candidateOid = await candidate(project.root, expected.localHead!, target, targetOid, project.gitEnv);
      const captured: Capture = { nativeLegacyRoot, file: file ?? null, recordsMode: hasMetadata ? 'replace' : 'preserve', targetOid, candidateOid, contentDigest, ...source, ...current, snapshot,
        portable: [...portable].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]) };
      await verify(id, expected, captured);
      const changes: ProjectGitChangeSummary = { addedPaths: [], modifiedPaths: [], deletedPaths: [], settingsChanged: 0, conversationsChanged: 0,
        ignoredPaths: [], privatePaths: [], missingPaths: [], collisions: [], historyMode: hasMetadata ? 'complete' : 'files_only' };
      for (const path of new Set([...current.paths, ...base.keys(), ...target.keys()])) {
        const next = target.get(path); const previous = source.sourceDigests[path];
        if (!next) changes.deletedPaths.push(path);
        else if (previous === 'missing') changes.addedPaths.push(path);
        else if (previous !== sha256(next.bytes) || source.sourceModes[path] !== next.mode) changes.modifiedPaths.push(path);
      }
      if (hasMetadata) {
        const currentSnapshot = parsePortableEntries(portable);
        changes.settingsChanged = Number(!isDeepStrictEqual(currentSnapshot.project, snapshot.project));
        const before = new Map(currentSnapshot.conversations.map(item => [item.id, item]));
        const after = new Map(snapshot.conversations.map(item => [item.id, item]));
        changes.conversationsChanged = [...new Set([...before.keys(), ...after.keys()])].filter(id =>
          !isDeepStrictEqual(before.get(id), after.get(id)) || !isDeepStrictEqual(currentSnapshot.messages.filter(item => item.conversationId === id),
            snapshot.messages.filter(item => item.conversationId === id))).length;
      }
      return db.transaction(() => {
        const op = store.enqueueOperation({ projectId: id, kind: 'restore_preview', ...request, basis: expected,
          requestDigest: digest({ targetOid, file: file ?? null }), payload: json({ captured, evidenceDigest: digest(captured) }) });
        const existing = store.getJournal(op.id)!;
        if (existing.result?.preview) return existing.result.preview;
        const preview: ProjectGitPreview = { id: op.id, kind: 'restore', basis: expected, targetOid, expiresAt: input.now() + 5 * 60_000, changes, dependencies: [] };
        store.updateOperation(op.id, { status: 'succeeded', phase: 'local_saved', result: { preview }, error: null }); return preview;
      }).immediate();
    });
  }
  async function previewRestore(id: string, targetOid: string, request: RestoreRequestContext): Promise<ProjectGitPreview> {
    return capturePreview(id, targetOid, request);
  }
  async function previewFileRestore(id: string, path: string, history: ProjectFileHistoryId, request: RestoreRequestContext): Promise<ProjectGitPreview> {
    await authorized(id, request);
    if (!history || !['git', 'legacy'].includes(history.source)) throw invalid();
    const head = basis(id).localHead; if (!head) throw changed();
    return capturePreview(id, history.source === 'git' ? history.oid : head, request, { path, history });
  }
  async function restoreProject(id: string, previewId: string, request: RestoreRequestContext): Promise<ProjectGitAccepted> {
    const project = await authorized(id, request); const requestDigest = digest({ previewId });
    const prior = store.findOperation({ projectId: id, kind: 'restore', ...request });
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw new GitDomainError('CONFLICT', 409, 'Restore idempotency key was already used.');
      if (prior.status === 'succeeded' || prior.recoveryData) return { operationId: prior.id };
    }
    assertIdle(id, project);
    const prepared = await project.gate.exclusive(async () => {
      const op = store.getJournal(previewId); const preview = op?.result?.preview;
      const payload = op?.payload as { captured?: Capture; evidenceDigest?: string } | undefined;
      if (!op || op.kind !== 'restore_preview' || op.actorId !== request.actorId || op.projectId !== id || op.scope !== `project:${id}`
        || op.status !== 'succeeded' || !preview || preview.id !== previewId || preview.kind !== 'restore'
        || preview.expiresAt <= input.now() || !isDeepStrictEqual(preview.basis, op.basis) || !isDeepStrictEqual(basis(id), op.basis)
        || !payload?.captured || payload.evidenceDigest !== digest(payload.captured) || payload.captured.targetOid !== preview.targetOid) throw changed();
      store.assertRevision(id, request.expectedProjectRevision); await assertHistoryCommit(project.root, payload.captured.targetOid);
      await verify(id, op.basis, payload.captured);
      if (preview.expiresAt <= input.now()) throw changed();
      const consumer = db.transaction(() => {
        const accepted = store.enqueueOperation({ projectId: id, kind: 'restore', ...request, basis: op.basis, requestDigest,
          payload: json({ previewId, targetOid: preview.targetOid, candidateOid: payload.captured!.candidateOid, previewContentDigest: payload.captured!.contentDigest }) });
        store.consumePreview(previewId, accepted.id); return accepted;
      }).immediate();
      return { consumer, expected: op.basis, captured: payload.captured };
    });
    assertIdle(id, project);
    await materializeProject({ recordsMode: prepared.captured.recordsMode, projectId: id, root: project.root, branch: project.branch, operationId: prepared.consumer.id, operationDir: input.operationRoot,
      nativeLegacyRoot: await nativeHistoryRoot(input.resolveProject(id).root, input.resolveProject(id).nativeLegacyRoot, prepared.captured.nativeLegacyRoot ?? project.root),
      db, store, gate: project.gate, basis: prepared.expected, candidateOid: prepared.captured.candidateOid, snapshot: prepared.captured.snapshot,
      previewContentDigest: prepared.captured.contentDigest, readBasis: () => basis(id), exportCurrentPortable: async () => (await exported(id, prepared.captured.nativeLegacyRoot ?? project.root)).entries,
      ...(project.gitEnv ? { gitEnv: project.gitEnv } : {}), ...(input.afterEffect ? { afterEffect: input.afterEffect } : {}),
      ...(input.afterDurablePhase ? { afterDurablePhase: input.afterDurablePhase } : {}) });
    return { operationId: prepared.consumer.id };
  }
  return { previewRestore, previewFileRestore, restoreProject };
}
