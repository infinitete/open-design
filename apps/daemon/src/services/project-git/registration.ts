import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { ApiError, ProjectGitBasis } from '@open-design/contracts';
import type { ProjectGate } from './gate.js';
import type { ProjectGitStore, ProjectGitRegistrationIntent } from '../../storage/project-git.js';
import type { RecoveryProject } from './recovery.js';
import { recoveryBarrier, finishRecovery, recoveryRequired } from './recovery.js';
import { discoverRepository, validateBranch } from './repository.js';
import { runGit } from './git-process.js';
import { GitDomainError } from './errors.js';

interface BindingOwner { dataRootId: string; projectId: string; canonicalRoot: string; localBranch: string; generation: number }
declare const checkpointBrand: unique symbol;
export interface CheckpointRegistrationCapability { readonly [checkpointBrand]: true }
declare const terminalBrand: unique symbol;
export interface RegistrationTerminalCapability {
  readonly [terminalBrand]: true;
  completeMaterialization(): void;
  completeBindingOnly(): void;
}
interface CheckpointAdmission {
  intent: ProjectGitRegistrationIntent; store: ProjectGitStore; project: RecoveryProject;
  prepareCompletion(): Promise<{ completePublishedCheckpoint(): void; completeNoopCheckpoint(head: string | null, previewDigest: string): void }>;
}
const checkpointAdmissions = new WeakMap<CheckpointRegistrationCapability, CheckpointAdmission>();
function admission(capability: CheckpointRegistrationCapability): CheckpointAdmission {
  const owned = checkpointAdmissions.get(capability);
  if (!owned || owned.intent.kind !== 'enable' || owned.intent.completion !== 'checkpoint'
    || owned.store.getRegistration(owned.intent.executionOperationId)?.state !== 'pending') throw recoveryRequired();
  return owned;
}
export function registrationCheckpointLane(capability: CheckpointRegistrationCapability, context: {
  gate: ProjectGate; projectId: string; basis: ProjectGitBasis; operationId?: string; store?: ProjectGitStore;
}) {
  const owned = admission(capability); const intent = owned.intent;
  if (context.gate !== owned.project.gate || context.projectId !== intent.projectId
    || !isDeepStrictEqual(context.basis, intent.executionBasis)
    || (context.operationId !== undefined && context.operationId !== intent.executionOperationId)
    || (context.store !== undefined && context.store !== owned.store)) throw recoveryRequired();
  return recoveryBarrier(owned.project.gate, intent.executionOperationId);
}
export function prepareCheckpointRegistrationCompletion(capability: CheckpointRegistrationCapability) {
  return admission(capability).prepareCompletion();
}
export function finishCheckpointRegistration(capability: CheckpointRegistrationCapability): void {
  const owned = checkpointAdmissions.get(capability);
  if (!owned || owned.store.getRegistration(owned.intent.executionOperationId)?.state !== 'complete') throw recoveryRequired();
  checkpointAdmissions.delete(capability); finishRecovery(owned.project, owned.intent.executionOperationId);
}
const ownerPrefix = 'refs/open-design/bindings/';
export function bindingOwnerRef(branch: string): string {
  return ownerPrefix + createHash('sha256').update(`refs/heads/${branch}`).digest('hex');
}
const busy = () => new GitDomainError('EXTERNAL_GIT_BUSY', 409, 'The repository already has a writable owner or needs registration recovery.');
function parseOwner(bytes: Buffer): BindingOwner {
  if (bytes.length > 16_384) throw busy();
  let owner: BindingOwner;
  try { owner = JSON.parse(bytes.toString('utf8')) as BindingOwner; } catch { throw busy(); }
  if (!owner || typeof owner !== 'object' || Object.keys(owner).sort().join(',') !== 'canonicalRoot,dataRootId,generation,localBranch,projectId'
    || [owner.dataRootId, owner.projectId, owner.canonicalRoot, owner.localBranch].some(value => typeof value !== 'string' || !value || value.length > 4096)
    || !Number.isSafeInteger(owner.generation) || owner.generation < 1) throw busy();
  return owner;
}
async function readOwner(root: string, oid: string): Promise<BindingOwner> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) throw recoveryRequired();
  const size = Number((await runGit({ cwd: root, args: ['cat-file', '-s', oid] })).stdout.toString().trim());
  if (!Number.isSafeInteger(size) || size < 1 || size > 16_384) throw busy();
  return parseOwner((await runGit({ cwd: root, args: ['cat-file', 'blob', oid] })).stdout);
}

/** Uses the runtime's existing trusted project/gate registry, never creates a second registry. */
export function createProjectGitRegistration(input: {
  db: Database.Database; store: ProjectGitStore; dataRootId: string;
  resolveProject(projectId: string): RecoveryProject;
}) {
  input.store.assertDatabase(input.db);
  function original(id: string) {
    const record = input.store.getRegistration(id); if (!record || record.state === 'aborted') throw recoveryRequired();
    const { state: _state, ...intent } = record;
    return intent;
  }
  async function context(intent: ProjectGitRegistrationIntent) {
    if (intent.dataRootId !== input.dataRootId) throw recoveryRequired();
    const project = input.resolveProject(intent.projectId); const repository = await discoverRepository(project.root);
    if (project.root !== await realpath(project.root) || repository.root !== intent.canonicalRoot || repository.commonDir !== intent.commonDir
      || project.branch !== intent.localBranch || repository.branch !== intent.localBranch) throw recoveryRequired();
    await validateBranch(intent.localBranch); await validateBranch(intent.targetBranch);
    if (intent.targetOwner.ref !== bindingOwnerRef(intent.targetBranch)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(intent.targetOwner.oid)) throw recoveryRequired();
    const target = await readOwner(project.root, intent.targetOwner.oid);
    if (!isDeepStrictEqual(target, { dataRootId: intent.dataRootId, projectId: intent.projectId, canonicalRoot: intent.canonicalRoot,
      localBranch: intent.localBranch, generation: intent.targetOwner.generation })) throw recoveryRequired();
    if (intent.previousOwner) {
      if (!/^refs\/open-design\/bindings\/[a-f0-9]{64}$/u.test(intent.previousOwner.ref)
        || intent.previousOwner.generation !== intent.executionBasis.bindingGeneration) throw recoveryRequired();
      const previous = await readOwner(project.root, intent.previousOwner.oid);
      if (!isDeepStrictEqual(previous, { dataRootId: intent.dataRootId, projectId: intent.projectId, canonicalRoot: intent.canonicalRoot,
        localBranch: intent.localBranch, generation: intent.previousOwner.generation })) throw recoveryRequired();
    }
    if (intent.targetOwner.expectedOid !== (intent.previousOwner?.ref === intent.targetOwner.ref ? intent.previousOwner.oid : null)) throw recoveryRequired();
    if (intent.materialization) {
      const materialization = intent.materialization; const op = input.store.getJournal(intent.executionOperationId);
      const previewId = (op?.payload as { previewId?: unknown } | undefined)?.previewId;
      const preview = typeof previewId === 'string' ? input.store.getJournal(previewId)?.result?.preview : null;
      if (!preview || intent.kind !== 'bind' || intent.completion !== 'materialization') throw recoveryRequired();
      if (op?.recoveryData && (op.recoveryData.candidateOid !== materialization.candidateOid
        || op.recoveryData.publicationMode !== materialization.publicationMode || op.recoveryData.previewContentDigest !== materialization.previewContentDigest)) throw recoveryRequired();
      if (materialization.publicationMode === 'fast_forward') {
        if (materialization.candidateOid !== preview.targetOid || !intent.executionBasis.localHead) throw recoveryRequired();
        await runGit({ cwd: project.root, args: ['merge-base', '--is-ancestor', intent.executionBasis.localHead, materialization.candidateOid] });
      } else {
        const parents = (await runGit({ cwd: project.root, args: ['rev-list', '--parents', '--max-count=1', materialization.candidateOid] })).stdout.toString().trim().split(' ').slice(1);
        if (!isDeepStrictEqual(parents, [intent.executionBasis.localHead, preview.targetOid])) throw recoveryRequired();
      }
    }
    return project;
  }
  async function readRef(root: string, ref: string): Promise<string | null> {
    if (!/^refs\/open-design\/bindings\/[a-f0-9]{64}$/u.test(ref)) throw recoveryRequired();
    try { return (await runGit({ cwd: root, args: ['rev-parse', '--verify', '--quiet', ref] })).stdout.toString().trim(); }
    catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; return null; }
  }
  async function validateOtherOwners(root: string, intent: ProjectGitRegistrationIntent) {
    let output: Buffer;
    try { output = (await runGit({ cwd: root, args: ['show-ref'] })).stdout; }
    catch (error) { if (!(error instanceof GitDomainError) || error.details?.exitCode !== 1) throw error; return; }
    const refs = output.toString().trim().split('\n').filter(Boolean);
    if (refs.length > 10_000) throw busy();
    for (const line of refs) {
      const [oid, ref] = line.split(' '); if (!ref?.startsWith(ownerPrefix)) continue;
      if (!oid || !/^refs\/open-design\/bindings\/[a-f0-9]{64}$/u.test(ref)) throw busy();
      const owner = await readOwner(root, oid);
      const ownRef = ref === intent.targetOwner.ref && oid === intent.targetOwner.oid
        || ref === intent.previousOwner?.ref && oid === intent.previousOwner.oid;
      if (ownRef) continue;
      if (owner.canonicalRoot === intent.canonicalRoot || owner.localBranch === intent.localBranch || ref === intent.targetOwner.ref) throw busy();
    }
  }
  async function proveTarget(intent: ProjectGitRegistrationIntent) {
    const project = await context(intent);
    await validateOtherOwners(project.root, intent);
    if (await readRef(project.root, intent.targetOwner.ref) !== intent.targetOwner.oid
      || (intent.previousOwner && intent.previousOwner.ref !== intent.targetOwner.ref && await readRef(project.root, intent.previousOwner.ref) !== null)) throw recoveryRequired();
    return project;
  }
  async function prepareRegistrationCompletion(id: string): Promise<RegistrationTerminalCapability> {
    const intent = original(id); await proveTarget(intent); let used = false;
    function once() { if (used) throw recoveryRequired(); used = true; input.store.assertDatabase(input.db); }
    return Object.freeze({
      completeMaterialization() {
        once(); const op = input.store.getJournal(id);
        if (intent.completion === 'binding_only' || op?.journalPhase !== 'index_published' || !op.phaseCompleted) throw recoveryRequired();
        input.db.transaction(() => {
          input.store.completeMaterialization(id, { basis: intent.executionBasis, advanceProjectRevision: intent.completion === 'materialization' });
          input.store.completeRegistration(intent);
        }).immediate();
      },
      completeBindingOnly() {
        once(); if (intent.completion !== 'binding_only') throw recoveryRequired();
        input.db.transaction(() => input.store.completeRegistration(intent)).immediate();
      },
    }) as RegistrationTerminalCapability;
  }
  return {
    prepareRegistrationCompletion,
    checkpointCapability(id: string): CheckpointRegistrationCapability {
      const intent = original(id); const project = input.resolveProject(intent.projectId);
      if (intent.kind !== 'enable' || intent.completion !== 'checkpoint' || input.store.getRegistration(id)?.state !== 'pending') throw recoveryRequired();
      const capability = Object.freeze({}) as CheckpointRegistrationCapability;
      checkpointAdmissions.set(capability, { intent, store: input.store, project, prepareCompletion: async () => {
        admission(capability); await proveTarget(intent); let used = false;
        const once = () => { if (used) throw recoveryRequired(); used = true; admission(capability); };
        const expectedDigest = (value: unknown) => value && typeof value === 'object' && 'previewContentDigest' in value
          ? value.previewContentDigest : undefined;
        function assertDigest(previewDigest: string) {
          if (!/^[a-f0-9]{64}$/u.test(previewDigest) || expectedDigest(input.store.getJournal(id)?.payload) !== previewDigest
            || expectedDigest(input.store.getJournal(intent.userOperationId)?.payload) !== previewDigest) throw recoveryRequired();
        }
        return Object.freeze({
          completePublishedCheckpoint() {
            once(); const op = input.store.getJournal(id);
            if (op?.journalPhase !== 'index_published' || !op.phaseCompleted || op.ownerOperationId !== null) throw recoveryRequired();
            assertDigest(op.recoveryData!.previewContentDigest);
            input.db.transaction(() => {
              input.store.completeMaterialization(id, { basis: intent.executionBasis, advanceProjectRevision: false }); input.store.completeRegistration(intent);
            }).immediate();
          },
          completeNoopCheckpoint(head: string | null, previewDigest: string) {
            once(); const op = input.store.getJournal(id); assertDigest(previewDigest);
            if (!op || op.journalPhase !== null || op.recoveryData !== null || op.ownerOperationId !== null
              || head !== intent.executionBasis.localHead) throw recoveryRequired();
            input.db.transaction(() => {
              input.store.updateOperation(id, { status: 'succeeded', phase: 'local_saved', result: head === null ? {} : { head }, error: null }); input.store.completeRegistration(intent);
            }).immediate();
          },
        });
      } });
      return capability;
    },
    async abortNoEffects(id: string, error: ApiError): Promise<void> {
      const intent = original(id); const project = input.resolveProject(intent.projectId);
      await recoveryBarrier(project.gate, id).exclusive(async () => {
        await context(intent);
        const op = input.store.getJournal(id);
        if (!op || op.journalPhase !== null || op.recoveryData !== null
          || await readRef(project.root, intent.targetOwner.ref) !== intent.targetOwner.expectedOid
          || (intent.previousOwner && intent.previousOwner.ref !== intent.targetOwner.ref
            && await readRef(project.root, intent.previousOwner.ref) !== intent.previousOwner.oid)) throw recoveryRequired();
        input.store.abortRegistration(intent, error);
      });
      finishRecovery(project, id);
    },
    async claimOwner(id: string): Promise<void> {
      const intent = original(id); const project = input.resolveProject(intent.projectId);
      await recoveryBarrier(project.gate, id).exclusive(async () => {
        await context(intent); await validateOtherOwners(project.root, intent);
        const target = await readRef(project.root, intent.targetOwner.ref);
        const old = intent.previousOwner && intent.previousOwner.ref !== intent.targetOwner.ref
          ? await readRef(project.root, intent.previousOwner.ref) : null;
        if (target === intent.targetOwner.oid && old === null) return;
        if (target !== intent.targetOwner.expectedOid || (intent.previousOwner && intent.previousOwner.ref !== intent.targetOwner.ref && old !== intent.previousOwner.oid)) throw busy();
        const commands = [intent.targetOwner.expectedOid === null ? `create ${intent.targetOwner.ref} ${intent.targetOwner.oid}`
          : `update ${intent.targetOwner.ref} ${intent.targetOwner.oid} ${intent.targetOwner.expectedOid}`];
        if (intent.previousOwner && intent.previousOwner.ref !== intent.targetOwner.ref) commands.push(`delete ${intent.previousOwner.ref} ${intent.previousOwner.oid}`);
        await runGit({ cwd: project.root, args: ['update-ref', '--no-deref', '--stdin'],
          stdin: Buffer.from(`start\n${commands.join('\n')}\nprepare\ncommit\n`) });
        await proveTarget(intent);
      });
    },
    async completeBindingOnly(id: string): Promise<void> {
      const intent = original(id); if (intent.completion !== 'binding_only') throw recoveryRequired();
      const project = input.resolveProject(intent.projectId);
      await recoveryBarrier(project.gate, id).exclusive(async () => {
        const complete = await prepareRegistrationCompletion(id);
        if (!isDeepStrictEqual(await project.readBasis(), intent.executionBasis)) throw recoveryRequired();
        complete.completeBindingOnly();
      });
      finishRecovery(project, id);
    },
  };
}
