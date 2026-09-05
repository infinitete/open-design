import Database from 'better-sqlite3';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createGitFixture } from '../../helpers/project-git.js';
import { migrateProjectGit } from '../../../src/storage/project-git-migrations.js';
import { createProjectGitStore, type ProjectGitRegistrationIntent } from '../../../src/storage/project-git.js';
import { createProjectGitRegistration, bindingOwnerRef, registrationCheckpointLane, prepareCheckpointRegistrationCompletion,
  type CheckpointRegistrationCapability } from '../../../src/services/project-git/registration.js';
import { createProjectGate } from '../../../src/services/project-git/gate.js';
import { acquireRepositoryLease, getRepositoryOwnerDomain } from '../../../src/services/project-git/repository-lease.js';
import { runGit } from '../../../src/services/project-git/git-process.js';
import { closeDatabase, getProject, listProjects, openDatabase } from '../../../src/db.js';
import { fixtureCommit, fixtureGitEnv, portableSnapshot } from '../../helpers/project-git-crash-worker.js';
import { serializePortableMetadata } from '../../../src/services/project-git/portable.js';
import { computeCheckpointContentDigest, prepareCheckpoint, publishCheckpoint } from '../../../src/services/project-git/checkpoint.js';
import { materializeProject } from '../../../src/services/project-git/materialize.js';
import { recoverProjectOperations } from '../../../src/services/project-git/recovery.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function owners() {
  const f = await createGitFixture(); cleanups.push(f.close);
  const domain = await getRepositoryOwnerDomain() ?? 'fixture-domain';
  async function owner(dataRootId: string, projectId: string, targetBranch: string, initialCandidate?: string,
    previousOwner: ProjectGitRegistrationIntent['previousOwner'] = null, enable?: { head: string | null; previewDigest: string }) {
    const data = join(f.root, dataRootId); await mkdir(data);
    openDatabase(data, { dataDir: data }); closeDatabase();
    const db = new Database(join(data, 'app.sqlite')); migrateProjectGit(db); cleanups.unshift(async () => { db.close(); });
    const operationRoot = join(data, 'operations'); await mkdir(operationRoot);
    const store = createProjectGitStore(db);
    const user = enable ? store.enqueueOperation({ projectId, actorId: 'fixture', kind: 'enable',
      basis: { bindingGeneration: 0, projectRevision: 0, contentRevision: 0, localHead: enable.head, remoteHead: null },
      idempotencyKey: 'enable', requestDigest: 'enable', payload: { previewContentDigest: enable.previewDigest } }) : null;
    const b = store.saveBinding({ projectId, cloneId: projectId, repositoryProjectId: 'repository', canonicalRoot: f.a, commonDir: join(f.a, '.git'),
      branch: targetBranch, localBranch: 'main', remoteUrl: null, generation: 0, autoSync: false,
      projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, localHead: enable?.head ?? null, observedRemoteHead: null,
      confirmedRemoteHead: null, materializedHead: null, dirty: false });
    const basis = { bindingGeneration: b.generation, projectRevision: 0, contentRevision: 0, localHead: enable?.head ?? null, remoteHead: null };
    const kind = enable ? 'enable' as const : initialCandidate ? 'open' as const : 'bind' as const;
    const op = enable ? store.enqueueCheckpoint({ projectId, actorId: 'fixture', basis, idempotencyKey: 'checkpoint', requestDigest: 'checkpoint',
      payload: { previewContentDigest: enable.previewDigest } }) : store.enqueueOperation({ projectId, actorId: 'fixture', kind, basis, idempotencyKey: 'bind', requestDigest: 'bind', payload: {} });
    const blob = { dataRootId, projectId, canonicalRoot: f.a, localBranch: 'main', generation: 2 };
    const oid = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from(JSON.stringify(blob)) })).stdout.toString().trim();
    const rootInfo = await lstat(f.a);
    const intent: ProjectGitRegistrationIntent = { kind, completion: enable ? 'checkpoint' : initialCandidate ? 'materialization' : 'binding_only', userOperationId: user?.id ?? op.id, executionOperationId: op.id,
      projectId, cloneId: projectId, repositoryProjectId: 'repository', dataRootId, canonicalRoot: f.a, commonDir: join(f.a, '.git'),
      localBranch: 'main', targetBranch, remoteUrl: 'https://fixture.invalid/repo', autoSync: true, hidden: !!initialCandidate,
      originalUserBasis: user?.basis ?? basis, executionBasis: basis, previousOwner,
      ...(initialCandidate ? { initialImport: { candidateOid: initialCandidate, rootDev: String(rootInfo.dev), rootIno: String(rootInfo.ino) } } : {}),
      targetOwner: { ref: bindingOwnerRef(targetBranch), expectedOid: null, oid, generation: 2 } };
    store.prepareRegistration(intent);
    const gate = createProjectGate({ acquireLease: () => acquireRepositoryLease({ root: f.a, instanceId: dataRootId, ownerDomain: domain, dataRootId }) });
    const resolveProject = () => ({ root: f.a, branch: 'main', gate, readBasis: () => {
        const current = store.getBinding(projectId)!;
        return { bindingGeneration: current.generation, projectRevision: current.projectRevision, contentRevision: current.contentRevision,
          localHead: current.localHead, remoteHead: current.observedRemoteHead };
      } });
    const registry = createProjectGitRegistration({ db, store, dataRootId, resolveProject });
    return { db, store, registry, intent, gate, op, resolveProject, operationRoot };
  }
  return { f, owner };
}

it('claims one writable owner across independent SQLite data roots even when target branches differ', async () => {
  const { f, owner } = await owners(); const first = await owner('first-data', 'first-project', 'main');
  const second = await owner('second-data', 'second-project', 'release');
  await first.registry.claimOwner(first.op.id);
  await expect(second.registry.claimOwner(second.op.id)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  expect(await f.git(f.a, 'rev-parse', first.intent.targetOwner.ref)).toBe(first.intent.targetOwner.oid);
  expect(second.store.getBinding('second-project')!.generation).toBe(1);
  expect(second.store.getRegistration(second.op.id)!.state).toBe('pending');
  await first.registry.completeBindingOnly(first.op.id);
  expect(first.store.getBinding('first-project')!.generation).toBe(2);
});

it('uses the complete target ref digest rather than a short branch hash', () => {
  expect(bindingOwnerRef('main')).toBe('refs/open-design/bindings/f921bd05e68b03740c450e565e0e6173e546193170b2dd404ddb6f153e9b5bf3');
});

it('does not release another project owner through a forged previous-ref descriptor', async () => {
  const { f, owner } = await owners(); const first = await owner('first', 'first-project', 'main');
  await first.registry.claimOwner(first.op.id);
  const second = await owner('second', 'second-project', 'release', undefined,
    { ref: first.intent.targetOwner.ref, oid: first.intent.targetOwner.oid, generation: 2 });
  await expect(second.registry.claimOwner(second.op.id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(await f.git(f.a, 'rev-parse', first.intent.targetOwner.ref)).toBe(first.intent.targetOwner.oid);
});

it('settles a proven no-effects rejection without leaving an existing project quarantined', async () => {
  const { owner } = await owners(); const existing = await owner('existing', 'project', 'main');
  await existing.registry.abortNoEffects(existing.op.id, { code: 'GIT_IDENTITY_REQUIRED', message: 'Configure identity.' });
  expect(existing.store.getRegistration(existing.op.id)!.state).toBe('aborted');
  expect(existing.store.getOperation(existing.op.id)).toMatchObject({ status: 'failed' });
  expect(existing.store.getBinding('project')!.generation).toBe(1);
  expect(await existing.gate.mutate(async () => 'editable')).toBe('editable');
});

it('retains an uncertain claimed owner and original operation evidence instead of treating it as no effects', async () => {
  const { owner } = await owners(); const existing = await owner('existing', 'project', 'main');
  await existing.registry.claimOwner(existing.op.id);
  await expect(existing.registry.abortNoEffects(existing.op.id, { code: 'GIT_IDENTITY_REQUIRED', message: 'Configure identity.' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(existing.store.getRegistration(existing.op.id)!.state).toBe('pending');
  await expect(existing.gate.mutate(async () => 'unsafe')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});

async function initialOpen() {
  const { f, owner } = await owners(); const snapshot = portableSnapshot('After');
  const entries = serializePortableMetadata(snapshot); entries.set('index.html', Buffer.from('imported'));
  const parent = await fixtureCommit(f.a, join(f.root, 'remote-parent.index'), entries, []);
  const candidateOid = await fixtureCommit(f.a, join(f.root, 'remote-tip.index'), entries, [parent]);
  const opened = await owner('open-data', 'imported-project', 'main', candidateOid);
  await opened.registry.claimOwner(opened.op.id);
  const previewContentDigest = computeCheckpointContentDigest({ sourceDigests: {}, sourceModes: {}, portableDigests: {}, removedPaths: [] });
  const input = { projectId: 'imported-project', root: f.a, branch: 'main', operationId: opened.op.id, operationDir: opened.operationRoot,
    basis: opened.op.basis, candidateOid, snapshot, store: opened.store, db: opened.db, gate: opened.gate, publicationMode: 'initial_import' as const,
    previewContentDigest, readBasis: opened.resolveProject().readBasis, exportCurrentPortable: async () => new Map<string, Uint8Array>(), gitEnv: fixtureGitEnv,
    prepareRegistrationCompletion: opened.registry.prepareRegistrationCompletion };
  const recovery = () => recoverProjectOperations({ db: opened.db, store: opened.store, operationRoot: opened.operationRoot,
    resolveProject: () => ({ ...opened.resolveProject(), prepareRegistrationCompletion: opened.registry.prepareRegistrationCompletion }) });
  return { f, opened, input, candidateOid, recovery };
}

it('imports an empty owned destination at the exact remote tip and reveals it only with final registration', async () => {
  const { f, opened, input, candidateOid, recovery } = await initialOpen();
  let hiddenAfterRecords = false;
  expect(await materializeProject({ ...input,
    afterDurablePhase: async (phase: string) => { if (phase === 'records_applied') { hiddenAfterRecords = true;
      expect(getProject(opened.db, 'imported-project')).toBeNull(); expect(listProjects(opened.db)).toEqual([]); } } })).toBe(candidateOid);
  expect(hiddenAfterRecords).toBe(true);
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(candidateOid);
  expect(opened.store.getJournal(opened.op.id)!.protection).toBeNull();
  expect(opened.store.getRegistration(opened.op.id)!.state).toBe('complete');
  expect(getProject(opened.db, 'imported-project')?.metadata).toMatchObject({ baseDir: f.a });
  expect(listProjects(opened.db)).toHaveLength(1);
  await recovery();
  expect(listProjects(opened.db)).toHaveLength(1);
  expect(opened.store.getBinding('imported-project')!.projectRevision).toBe(1);
});

it('rolls back every terminal DB fact when registration closure fails and resumes the exact original import', async () => {
  const { f, opened, input, candidateOid, recovery } = await initialOpen();
  const original = opened.store.completeRegistration;
  const fault = vi.spyOn(opened.store, 'completeRegistration').mockImplementation(intent => {
    original(intent); throw new Error('fixture terminal rollback');
  });
  await expect(materializeProject(input)).rejects.toThrow('fixture terminal rollback');
  fault.mockRestore();
  expect(opened.store.getJournal(opened.op.id)).toMatchObject({ journalPhase: 'index_published', phaseCompleted: true, status: 'waiting' });
  expect(opened.store.getBinding('imported-project')).toMatchObject({ generation: 1, localHead: null, projectRevision: 1 });
  expect(opened.store.getRegistration(opened.op.id)!.state).toBe('pending');
  expect(getProject(opened.db, 'imported-project')).toBeNull();
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(candidateOid);
  await recovery(); await recovery();
  expect(opened.store.getBinding('imported-project')).toMatchObject({ generation: 2, localHead: candidateOid, projectRevision: 1 });
  expect(listProjects(opened.db)).toHaveLength(1);
  expect(opened.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
});

it('rereads actual imported content after the asynchronous owner verifier before making a project visible', async () => {
  const { f, opened, input, recovery } = await initialOpen();
  await expect(materializeProject({ ...input, prepareRegistrationCompletion: async id => {
    const complete = await opened.registry.prepareRegistrationCompletion(id);
    await writeFile(join(f.a, 'index.html'), 'external edit after owner proof');
    return complete;
  } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(getProject(opened.db, 'imported-project')).toBeNull();
  expect(opened.store.getRegistration(opened.op.id)!.state).toBe('pending');
  await writeFile(join(f.a, 'index.html'), 'imported');
  await recovery(); expect(listProjects(opened.db)).toHaveLength(1);
});

it('keeps post-claim preflight failure quarantined and rejects stale admission instead of releasing the owner barrier', async () => {
  const { f, opened, input } = await initialOpen();
  await expect(materializeProject({ ...input, basis: { ...input.basis, contentRevision: 1 } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await writeFile(join(f.a, 'unexpected.txt'), 'do not overwrite');
  await expect(materializeProject(input)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(opened.store.getJournal(opened.op.id)!.journalPhase).toBeNull();
  await expect(opened.gate.mutate(async () => 'unsafe')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(getProject(opened.db, 'imported-project')).toBeNull();
});

async function enableCheckpoint(noop: boolean) {
  const { f, owner } = await owners();
  await writeFile(join(f.a, 'index.html'), 'same captured bytes');
  if (noop) { await f.git(f.a, 'add', '--', 'index.html'); await f.git(f.a, 'commit', '-m', 'existing'); }
  const head = noop ? await f.git(f.a, 'rev-parse', 'HEAD') : null;
  const hash = (await import('node:crypto')).createHash('sha256').update('same captured bytes').digest('hex');
  const previewDigest = computeCheckpointContentDigest({ sourceDigests: { 'index.html': hash }, sourceModes: { 'index.html': '100644' }, portableDigests: {}, removedPaths: [] });
  const enabled = await owner('enable-data', 'enabled', 'main', undefined, null, { head, previewDigest });
  await enabled.registry.claimOwner(enabled.op.id);
  const registration = enabled.registry.checkpointCapability(enabled.op.id);
  const input = { root: f.a, operationDir: enabled.operationRoot, head, portableEntries: new Map(),
    coordination: { projectId: 'enabled', basis: enabled.op.basis, ...enabled.resolveProject(), gitEnv: fixtureGitEnv, registration } };
  return { f, enabled, registration, input, previewDigest };
}

it.each([false, true])('completes an enable checkpoint and registration together without reimport or epoch advance (noop=%s)', async noop => {
  const { f, enabled, input, previewDigest } = await enableCheckpoint(noop);
  const candidate = await prepareCheckpoint(input);
  expect(candidate.previewContentDigest).toBe(previewDigest);
  expect(candidate.commitOid === null).toBe(noop);
  await publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: enabled.op.id, store: enabled.store });
  expect(enabled.store.getRegistration(enabled.op.id)!.state).toBe('complete');
  expect(enabled.store.getBinding('enabled')).toMatchObject({ generation: 2, projectRevision: 0, contentRevision: 0 });
  expect(enabled.store.getJournal(enabled.intent.userOperationId)).toMatchObject({ basis: { bindingGeneration: 0 }, status: 'succeeded' });
  expect(enabled.store.getJournal(enabled.op.id)).toMatchObject({ status: 'succeeded', ownerOperationId: null,
    journalPhase: noop ? null : 'complete' });
  expect(await enabled.gate.mutate(async () => 'editable')).toBe('editable');
});

it('rejects fabricated capabilities and mismatched gate, store, basis, project or execution identities', async () => {
  const { enabled, registration, input } = await enableCheckpoint(false);
  const context = { ...input.coordination, store: enabled.store, operationId: enabled.op.id };
  expect(() => registrationCheckpointLane({} as CheckpointRegistrationCapability, context)).toThrowError();
  for (const mismatch of [{ gate: createProjectGate() }, { store: createProjectGitStore(enabled.db) },
    { basis: { ...enabled.op.basis, contentRevision: 1 } }, { projectId: 'foreign' }, { operationId: 'foreign' }]) {
    expect(() => registrationCheckpointLane(registration, { ...context, ...mismatch })).toThrowError();
  }
  const terminal = await prepareCheckpointRegistrationCompletion(registration);
  expect(() => terminal.completeNoopCheckpoint('1'.repeat(40), input.coordination.basis.localHead ?? '')).toThrowError();
  expect(() => terminal.completePublishedCheckpoint()).toThrowError();
  expect(enabled.store.getRegistration(enabled.op.id)!.state).toBe('pending');
});

it.each([false, true])('rolls enable terminal facts back and retries the same frozen child (noop=%s)', async noop => {
  const { f, enabled, input, registration } = await enableCheckpoint(noop);
  const candidate = await prepareCheckpoint(input);
  const original = enabled.store.completeRegistration;
  const fault = vi.spyOn(enabled.store, 'completeRegistration').mockImplementation(intent => {
    original(intent); throw new Error('enable terminal rollback');
  });
  await expect(publishCheckpoint({ root: f.a, branch: 'main', candidate, operationId: enabled.op.id, store: enabled.store })).rejects.toThrow('enable terminal rollback');
  fault.mockRestore();
  expect(enabled.store.getRegistration(enabled.op.id)!.state).toBe('pending');
  expect(enabled.store.getJournal(enabled.intent.userOperationId)!.status).toBe('queued');
  expect(enabled.store.getBinding('enabled')).toMatchObject({ generation: 1, localHead: input.head, projectRevision: 0 });
  await expect(enabled.gate.mutate(async () => 'unsafe')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  if (noop) {
    expect(enabled.store.getJournal(enabled.op.id)).toMatchObject({ journalPhase: null, recoveryData: null, status: 'queued' });
    const retry = await prepareCheckpoint(input);
    expect(retry.previewContentDigest).toBe(candidate.previewContentDigest);
    await publishCheckpoint({ root: f.a, branch: 'main', candidate: retry, operationId: enabled.op.id, store: enabled.store });
  } else await recoverProjectOperations({ db: enabled.db, store: enabled.store, operationRoot: enabled.operationRoot,
    resolveProject: () => ({ ...enabled.resolveProject(), prepareRegistrationCompletion: enabled.registry.prepareRegistrationCompletion }) });
  expect(enabled.store.getRegistration(enabled.op.id)!.state).toBe('complete');
  expect(enabled.store.getBinding('enabled')).toMatchObject({ generation: 2, projectRevision: 0 });
  expect(() => registrationCheckpointLane(registration, input.coordination)).toThrowError();
});
