import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApiError,
  PortableSnapshot,
  ProjectGitAccepted,
  ProjectGitAction,
  ProjectGitCommit,
  ProjectGitConflict,
  ProjectGitEvent,
  ProjectGitFileResponse,
  ProjectGitHistoryPage,
  ProjectGitOperation,
  ProjectGitRequestContext,
  ProjectGitState,
} from '@open-design/contracts';
import type { ProjectGitBindingRecord, ProjectGitStore } from '../../storage/project-git.js';
import { createProjectGitBindingService } from './binding.js';
import { GitDomainError } from './errors.js';
import { getProjectGate, getUnmanagedProjectGate, type ProjectGate } from './gate.js';
import { readCommit, readCommitConversations, readCommitFile, readHistory } from './history.js';
import {
  createProjectGitMutationAdapter,
  type ProjectGitCoordination,
} from './mutation-adapter.js';
import { getRepositoryOwnerDomain } from './repository-lease.js';
import { discoverRepository, redactGitText } from './repository.js';
import { createProjectGitRestoreService } from './restore.js';
import type { MaterializePhase } from './materialize.js';
import { createProjectGitRuntimeAdapter, type ProjectRunPermit } from './runtime-adapter.js';
import { createProjectGitScheduler, type ProjectGitScheduler } from './scheduler.js';
import { createProjectGitSyncDeps, readProjectGitConflictEvidence, syncProject, type ProjectGitSyncProject } from './sync.js';

export interface ProjectGitService {
  getState(projectId: string): Promise<ProjectGitState>;
  execute(action: ProjectGitAction, context: ProjectGitRequestContext): Promise<ProjectGitAccepted>;
  getOperation(id: string): Promise<ProjectGitOperation>;
  history(projectId: string, cursor?: string, path?: string): Promise<ProjectGitHistoryPage>;
  commit(projectId: string, oid: string): Promise<ProjectGitCommit>;
  file(projectId: string, oid: string, path: string): Promise<ProjectGitFileResponse>;
  conversations(projectId: string, oid: string): Promise<PortableSnapshot | null>;
  conflicts(projectId: string): Promise<ProjectGitConflict[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProjectGitServiceComposition {
  service: ProjectGitService;
  coordination: ProjectGitCoordination;
}

export interface CreateProjectGitServiceInput {
  db: Database.Database;
  store: ProjectGitStore;
  operationRoot: string;
  /** Stable for the lifetime of the owning daemon process, including in-process server restarts. */
  instanceId?: string;
  resolveProjectRoot(projectId: string): Promise<string>;
  prepareProjectRoot?(projectId: string): Promise<string>;
  gitEnv?: Record<string, string>;
  emit(projectId: string, event: ProjectGitEvent): void;
  requireProject?(actorId: string, projectId: string): void | Promise<void>;
  requireCreate?(actorId: string): void | Promise<void>;
  resolveAvailability?(request: { actorId: string; projectId: string; kind: 'agent' | 'model' | 'plugin' | 'linked_folder'; id: string; agentId?: string }): Promise<boolean>;
  subscribeProject?(projectId: string, onChange: () => void): { ready: Promise<void>; unsubscribe(): void | Promise<void> };
  afterDurablePhase?(phase: MaterializePhase): Promise<void>;
}

type RuntimeProject = ProjectGitSyncProject & { readBasis(): import('@open-design/contracts').ProjectGitBasis };

const unmanagedBasis = () => ({
  projectRevision: 0,
  contentRevision: 0,
  localHead: null,
  remoteHead: null,
  bindingGeneration: 0,
});

function publicError(error: unknown): ApiError {
  if (error instanceof GitDomainError) {
    return { code: error.code, message: redactGitText(error.message), ...(error.details ? { details: error.details } : {}) };
  }
  return { code: 'INTERNAL_ERROR', message: 'Project versioning operation failed.' };
}

function requestDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Owns the daemon's single project-Git runtime. The returned coordination and
 * service share one recovery promise, scheduler, gate registry and permit map.
 */
export async function createProjectGitServiceComposition(
  input: CreateProjectGitServiceInput,
): Promise<ProjectGitServiceComposition> {
  input.store.assertDatabase(input.db);
  const dataRoot = dirname(input.operationRoot);
  const preparationRoot = join(dataRoot, 'project-git-preparation');
  const ownedProjectsRoot = join(dataRoot, 'projects');
  await Promise.all([
    mkdir(input.operationRoot, { recursive: true, mode: 0o700 }),
    mkdir(preparationRoot, { recursive: true, mode: 0o700 }),
    mkdir(ownedProjectsRoot, { recursive: true, mode: 0o700 }),
  ]);
  const [operationRoot, canonicalPreparationRoot, dataRootId] = await Promise.all([
    realpath(input.operationRoot),
    realpath(preparationRoot),
    realpath(dataRoot),
  ]);
  const ownership = {
    instanceId: input.instanceId ?? randomUUID(),
    ownerDomain: await getRepositoryOwnerDomain() ?? 'unverifiable-local-domain',
    dataRootId,
  };
  const projects = new Map<string, RuntimeProject>();
  const resolving = new Map<string, Promise<RuntimeProject>>();
  const watchers = new Map<string, { unsubscribe(): void | Promise<void> }>();
  const unavailableRootCodes = new Set(['ENOENT', 'EACCES', 'ENOTDIR', 'ESTALE', 'EIO']);

  const basis = (projectId: string) => {
    const binding = input.store.getBinding(projectId);
    return binding ? {
      projectRevision: binding.projectRevision,
      contentRevision: binding.contentRevision,
      localHead: binding.localHead,
      remoteHead: binding.observedRemoteHead,
      bindingGeneration: binding.generation,
    } : unmanagedBasis();
  };

  const retainedConflict = (projectId: string) => input.store.listPendingOperations().find(operation =>
    operation.projectId === projectId && operation.phase === 'conflict');

  const assertNetworkAdmissionUnfenced = (operationId: string): void => {
    const operation = input.store.getJournal(operationId);
    if (!operation?.projectId || operation.payload === null || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) return;
    const conflict = retainedConflict(operation.projectId);
    if (!conflict || operation.payload.retainedConflictId === conflict.id) return;
    const error = new GitDomainError('GIT_CONFLICT', 409, 'Resolve the current project conflict first.');
    input.store.settleAdmittedOperationFailure(operation.id, publicError(error));
    throw error;
  };

  const register = (projectId: string, root: string, branch: string, gate: ProjectGate): RuntimeProject => {
    const runtime: RuntimeProject = {
      root,
      branch,
      gate,
      ...(input.gitEnv ? { gitEnv: input.gitEnv } : {}),
      readBasis: () => basis(projectId),
      prepareRegistrationCompletion: operationId => bindingService.prepareRegistrationCompletion(operationId),
    };
    projects.set(projectId, runtime);
    const quarantine = input.store.listPendingOperations().find(operation => operation.projectId === projectId
      && operation.actorId === 'project-git-background' && operation.kind === 'sync'
      && typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
      && operation.payload.lane === 'quarantine');
    if (quarantine) input.store.updateOperation(quarantine.id, { status: 'succeeded', phase: 'local_saved', result: null, error: null });
    return runtime;
  };

  const quarantine = (binding: ProjectGitBindingRecord, error: unknown): void => {
    const cause = error instanceof GitDomainError ? error.code : (error as NodeJS.ErrnoException).code;
    if (!(error instanceof GitDomainError) && (!cause || !unavailableRootCodes.has(cause))) throw error;
    const operation = input.store.enqueueOperation({ projectId: binding.projectId, actorId: 'project-git-background', kind: 'sync',
      idempotencyKey: `quarantine:${binding.generation}`, requestDigest: requestDigest({ root: binding.canonicalRoot, generation: binding.generation }),
      basis: basis(binding.projectId), payload: { lane: 'quarantine' } });
    input.store.updateOperation(operation.id, { status: 'waiting', phase: 'waiting_idle', result: null,
      error: { code: 'RECOVERY_REQUIRED', message: 'The managed project repository is unavailable.',
        details: { reason: 'project_root_unavailable', ...(cause ? { cause } : {}) } } });
  };

  const resolveRuntime = async (projectId: string, prepare = false): Promise<RuntimeProject> => {
    const found = projects.get(projectId);
    if (found) return found;
    const resolvingKey = `${projectId}:${prepare ? 'prepare' : 'read'}`;
    const current = resolving.get(resolvingKey);
    if (current) return current;
    const work = (async () => {
      const binding = input.store.getBinding(projectId);
      const requestedRoot = await (prepare && input.prepareProjectRoot ? input.prepareProjectRoot : input.resolveProjectRoot)(projectId);
      let root: string; let rootExists = true;
      try { root = await realpath(requestedRoot); }
      catch (error) {
        if (binding || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        root = requestedRoot; rootExists = false;
      }
      if (binding && root !== binding.canonicalRoot) {
        throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The registered project root changed.');
      }
      let repository: Awaited<ReturnType<typeof discoverRepository>> | null = null;
      try { if (rootExists) repository = await discoverRepository(root); }
      catch (error) {
        if (binding || error instanceof GitDomainError && error.code === 'GIT_UNAVAILABLE') throw error;
      }
      const gate = repository
        ? await getProjectGate({ root, ...ownership })
        : await getUnmanagedProjectGate({ root, ...ownership });
      return register(projectId, root, binding?.localBranch ?? binding?.branch ?? repository?.branch ?? 'main', gate);
    })();
    resolving.set(resolvingKey, work);
    try { return await work; } finally { resolving.delete(resolvingKey); }
  };

  // Recovery's resolver is deliberately synchronous. Resolve every durable
  // binding/registration before constructing the one recovery runtime.
  for (const binding of input.store.listBindings()) {
    try { await resolveRuntime(binding.projectId); }
    catch (error) { quarantine(binding, error); }
  }
  for (const registration of input.store.listPendingRegistrations()) {
    if (!projects.has(registration.projectId)) {
      const gate = await getProjectGate({ root: registration.canonicalRoot, ...ownership });
      register(registration.projectId, registration.canonicalRoot, registration.localBranch, gate);
    }
  }
  const requireRuntime = (projectId: string): RuntimeProject => {
    const project = projects.get(projectId);
    if (!project) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The project runtime is not registered.');
    return project;
  };

  let scheduler: ProjectGitScheduler;
  let bindingService: ReturnType<typeof createProjectGitBindingService>;
  const schedulerPort: ProjectGitScheduler = {
    start: () => scheduler.start(),
    notify: id => scheduler.notify(id),
    requestSync: (id, oneShot) => scheduler.requestSync(id, oneShot),
    withNetworkPaused: (id, work) => scheduler.withNetworkPaused(id, work),
    stop: () => scheduler.stop(),
  };
  let syncRuntime: ReturnType<typeof createProjectGitSyncDeps>;
  bindingService = createProjectGitBindingService({
    db: input.db,
    store: input.store,
    operationRoot,
    preparationRoot: canonicalPreparationRoot,
    ownedProjectsRoot,
    ownership,
    scheduler: schedulerPort,
    checkpointCurrent: projectId => syncRuntime.checkpoint(projectId),
    recoveryReady: Promise.resolve(),
    requireProject: async (actorId, projectId) => {
      await input.requireProject?.(actorId, projectId);
      await resolveRuntime(projectId, true);
    },
    requireCreate: input.requireCreate ?? (actorId => {
      if (!actorId) throw new GitDomainError('FORBIDDEN', 403, 'Project creation is not allowed.');
    }),
    resolveAvailability: input.resolveAvailability ?? (async () => false),
    resolveProject: requireRuntime,
    reserveProject: reserved => {
      register(reserved.projectId, reserved.root, reserved.localBranch, reserved.gate);
      return () => { if (projects.get(reserved.projectId)?.gate === reserved.gate) projects.delete(reserved.projectId); };
    },
    now: Date.now,
    newId: randomUUID,
    ...(input.gitEnv ? { gitEnv: input.gitEnv } : {}),
  });
  syncRuntime = createProjectGitSyncDeps({
    db: input.db,
    store: input.store,
    operationRoot,
    preparationRoot: canonicalPreparationRoot,
    resolveProject: requireRuntime,
    now: Date.now,
    random: Math.random,
    ...(input.afterDurablePhase ? { afterDurablePhase: input.afterDurablePhase } : {}),
  });
  const recoveryReady = syncRuntime.recoveryReady;
  const interruptedAdmissions = new Set(input.store.listPendingOperations()
    .filter(operation => operation.journalPhase === null && operation.recoveryData === null)
    .map(operation => operation.id));
  const interruptedRetryAttempts = new Set(input.store.listActiveRetryAttempts().map(attempt => attempt.operationId));
  scheduler = createProjectGitScheduler({
    store: input.store,
    now: Date.now,
    random: Math.random,
    detect: async projectId => {
      await syncRuntime.detect(projectId);
      const operation = input.store.getLatestProjectOperation(projectId);
      if (operation) await emitOperation(operation);
      await emitState(projectId);
    },
    sync: async (projectId, oneShot) => {
      try { await syncProject({ projectId, oneShot, deps: syncRuntime }); }
      finally {
        const operation = input.store.getLatestProjectOperation(projectId);
        if (operation) await emitOperation(operation);
        await emitState(projectId);
      }
    },
  });
  const ensureWatcher = (projectId: string): void => {
    if (!input.subscribeProject || watchers.has(projectId) || !projects.has(projectId)) return;
    const watcher = input.subscribeProject(projectId, () => scheduler.notify(projectId));
    watchers.set(projectId, watcher);
    void watcher.ready.catch(() => {});
  };
  const restoreService = createProjectGitRestoreService({
    db: input.db,
    store: input.store,
    operationRoot,
    recoveryReady,
    now: Date.now,
    requireProject: async (actorId, projectId) => {
      await input.requireProject?.(actorId, projectId);
      await resolveRuntime(projectId, true);
    },
    resolveProject: requireRuntime,
  });

  const permits = new Map<string, ProjectRunPermit>();
  const notify = (projectId: string) => scheduler.notify(projectId);
  const mutation = createProjectGitMutationAdapter({ store: input.store, gateFor: async id => (await resolveRuntime(id)).gate, recoveryReady, notify });
  const runtime = createProjectGitRuntimeAdapter({ store: input.store, gateFor: async id => (await resolveRuntime(id)).gate, recoveryReady, notify, permits });
  const coordination: ProjectGitCoordination = { ...mutation, recoveryReady, runtime };

  function state(projectId: string): ProjectGitState {
    const binding = input.store.getBinding(projectId);
    if (!binding) {
      const pending = input.store.listPendingOperations().filter(operation => operation.projectId === projectId).at(-1);
      const latest = input.store.getLatestProjectOperation(projectId);
      const operation = pending ?? (latest?.status === 'failed' ? latest : null);
      return {
      enabled: false,
      phase: pending?.phase ?? (latest?.status === 'failed' ? 'failed' : 'enable_pending'),
      localHead: null,
      observedRemoteHead: null,
      confirmedRemoteHead: null,
      projectRevision: 0,
      contentRevision: 0,
      bindingGeneration: 0,
      dirty: false,
      pendingPush: false,
      autoSync: false,
      operationId: operation?.id ?? null,
      error: operation?.error ?? null,
      binding: { remoteConfigured: false, remoteLabel: null, branch: null },
      dependencies: operation?.result?.dependencies ?? [],
      };
    }
    const operations = input.store.listPendingOperations().filter(operation => operation.projectId === projectId);
    const conflict = operations.filter(operation => operation.phase === 'conflict').at(-1);
    const active = conflict ?? operations.at(-1);
    const latest = input.store.getLatestProjectOperation(projectId);
    const operation = active ?? latest;
    const recovering = input.store.listRecoverable().some(item => item.projectId === projectId && item.recoveryData !== null);
    const pendingPush = binding.localHead !== binding.confirmedRemoteHead && binding.remoteUrl !== null;
    const phase = recovering ? 'recovering'
      : conflict ? 'conflict'
        : active ? active.phase
          : binding.dirty ? 'dirty'
            : pendingPush ? 'pending_push'
              : !binding.autoSync && binding.remoteUrl ? 'paused'
                : latest?.status === 'failed' ? 'failed'
                  : binding.localHead && binding.remoteUrl ? 'synced' : 'local_saved';
    return {
      enabled: true,
      phase,
      localHead: binding.localHead,
      observedRemoteHead: binding.observedRemoteHead,
      confirmedRemoteHead: binding.confirmedRemoteHead,
      projectRevision: binding.projectRevision,
      contentRevision: binding.contentRevision,
      bindingGeneration: binding.generation,
      dirty: binding.dirty,
      pendingPush,
      autoSync: binding.autoSync,
      operationId: operation?.id ?? null,
      error: active?.error ?? (latest?.status === 'failed' ? latest.error : null),
      binding: {
        remoteConfigured: binding.remoteUrl !== null,
        remoteLabel: binding.remoteUrl ? redactGitText(binding.remoteUrl) : null,
        branch: binding.branch,
      },
      dependencies: operation?.result?.dependencies ?? [],
    };
  }

  async function emitOperation(operation: ProjectGitOperation): Promise<void> {
    if (operation.projectId) input.emit(operation.projectId, { type: 'project-git-operation', projectId: operation.projectId, operation });
  }
  async function emitState(projectId: string): Promise<void> {
    input.emit(projectId, { type: 'project-git-state', projectId, state: state(projectId) });
  }
  async function accepted(operation: ProjectGitOperation): Promise<ProjectGitAccepted> {
    if (operation.projectId && input.store.getBinding(operation.projectId)) ensureWatcher(operation.projectId);
    await emitOperation(operation);
    if (operation.projectId) await emitState(operation.projectId);
    return { operationId: operation.id };
  }
  const contextRequest = (context: ProjectGitRequestContext) => ({
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    ...(context.expectedProjectRevision === undefined ? {} : { expectedProjectRevision: context.expectedProjectRevision }),
  });

  async function admitResolve(
    action: Extract<ProjectGitAction, { kind: 'resolve' }>,
    context: ProjectGitRequestContext,
  ): Promise<{ operation: ProjectGitOperation; worker: Promise<ProjectGitOperation> | null }> {
    if (!context.projectId) throw new GitDomainError('VALIDATION_FAILED', 400, 'A project is required.');
    const projectId = context.projectId;
    await input.requireProject?.(context.actorId, projectId);
    const digest = requestDigest({ action, expectedProjectRevision: context.expectedProjectRevision ?? null });
    const existing = input.store.findOperation({ actorId: context.actorId, projectId, kind: 'resolve', idempotencyKey: context.idempotencyKey });
    if (existing) {
      if (existing.requestDigest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
      return { operation: input.store.getOperation(existing.id)!, worker: null };
    }
    await resolveRuntime(projectId);
    if (!input.store.getBinding(projectId)) throw new GitDomainError('NOT_FOUND', 404, 'Managed project not found.');
    input.store.assertRevision(projectId, context.expectedProjectRevision);
    let resolveAdmission!: (operation: ProjectGitOperation) => void;
    let rejectAdmission!: (error: unknown) => void;
    const admission = new Promise<ProjectGitOperation>((resolve, reject) => {
      resolveAdmission = resolve; rejectAdmission = reject;
    });
    const worker = scheduler.withNetworkPaused(projectId, () => syncRuntime.resolveConflict({
        projectId,
        conflictOperationId: action.operationId,
        actorId: context.actorId,
        idempotencyKey: context.idempotencyKey,
        requestDigest: digest,
        basis: action.basis,
        resolutions: action.resolutions,
      }, resolveAdmission));
    void worker.catch(rejectAdmission);
    return { operation: await admission, worker };
  }

  async function shortOperation(action: Extract<ProjectGitAction, { kind: 'pause' | 'resume' | 'sync' }>, context: ProjectGitRequestContext) {
    if (!context.projectId) throw new GitDomainError('VALIDATION_FAILED', 400, 'A project is required.');
    await input.requireProject?.(context.actorId, context.projectId);
    await resolveRuntime(context.projectId);
    const existing = input.store.findOperation({ actorId: context.actorId, projectId: context.projectId, kind: action.kind, idempotencyKey: context.idempotencyKey });
    const digest = requestDigest({ action, expectedProjectRevision: context.expectedProjectRevision ?? null });
    if (existing) {
      if (existing.requestDigest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
      return input.store.getOperation(existing.id)!;
    }
    const binding = context.projectId ? input.store.getBinding(context.projectId) : null;
    if (context.projectId && !binding) throw new GitDomainError('NOT_FOUND', 404, 'Managed project not found.');
    if (context.projectId) input.store.assertRevision(context.projectId, context.expectedProjectRevision);
    const operation = input.store.enqueueOperation({
      projectId: context.projectId,
      actorId: context.actorId,
      kind: action.kind,
      idempotencyKey: context.idempotencyKey,
      requestDigest: digest,
      basis: basis(context.projectId!),
      payload: JSON.parse(JSON.stringify(action)) as import('@open-design/contracts').JsonValue,
    });
    input.store.updateOperation(operation.id, { status: 'running', phase: action.kind === 'sync' ? 'syncing' : 'waiting_idle', result: null, error: null });
    try {
      if (action.kind === 'pause' || action.kind === 'resume') {
        await scheduler.withNetworkPaused(context.projectId!, async () => {
          const current = input.store.getBinding(context.projectId!);
          if (!current) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The project binding changed.');
          input.store.saveBinding({ ...current, autoSync: action.kind === 'resume' });
        });
      } else if (action.kind === 'sync') {
        await syncProject({ projectId: context.projectId!, oneShot: true, deps: syncRuntime });
      }
      input.store.updateOperation(operation.id, {
        status: 'succeeded',
        phase: action.kind === 'pause' ? 'paused' : action.kind === 'resume' ? 'local_saved' : 'synced',
        result: null,
        error: null,
      });
    } catch (error) {
      const safe = publicError(error);
      input.store.updateOperation(operation.id, { status: 'failed', phase: error instanceof GitDomainError && error.status === 409 ? 'conflict' : 'failed', result: null, error: safe });
      if (error instanceof GitDomainError && ['PREVIEW_STALE', 'VALIDATION_FAILED'].includes(error.code)) throw error;
    }
    return input.store.getOperation(operation.id)!;
  }

  async function admitRetry(
    action: Extract<ProjectGitAction, { kind: 'retry' }>,
    context: ProjectGitRequestContext,
  ): Promise<{ operation: ProjectGitOperation; startWorker: boolean; attempt: number | null }> {
    if (context.projectId) await input.requireProject?.(context.actorId, context.projectId);
    const digest = requestDigest({ action, expectedProjectRevision: context.expectedProjectRevision ?? null });
    const replay = input.store.findOperationRequest({ actorId: context.actorId, projectId: context.projectId,
      action: 'retry', idempotencyKey: context.idempotencyKey });
    if (replay) {
      if (replay.requestDigest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
      const operation = input.store.getOperation(replay.operationId);
      if (!operation) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The retried operation is unavailable.');
      const journal = input.store.getJournal(operation.id)!;
      if (operation.status === 'succeeded' || ['queued', 'running'].includes(operation.status) || journal.recoveryData !== null) {
        return { operation, startWorker: false, attempt: null };
      }
    }
    const target = input.store.getJournal(action.operationId);
    if (!target || target.projectId !== context.projectId || target.kind === 'checkpoint'
      || target.projectId === null && target.actorId !== context.actorId) {
      throw new GitDomainError('NOT_FOUND', 404, 'Project Git operation not found.');
    }
    const retryableSync = target.kind === 'sync' && ['failed', 'waiting'].includes(target.status)
      && ['auth_required', 'pending_push', 'external_git_busy', 'waiting_idle', 'failed'].includes(target.phase);
    if (!(target.status === 'failed' && ['enable', 'bind', 'open', 'restore', 'resolve'].includes(target.kind)) && !retryableSync) {
      throw new GitDomainError('CONFLICT', 409, 'This operation cannot be retried safely. Create a new preview.');
    }
    const payload = target.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new GitDomainError('CONFLICT', 409, 'This operation cannot be retried safely.');
    }
    if (target.kind === 'sync') {
      if (!target.projectId || target.scope !== `project:${target.projectId}`) {
        throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original synchronization is no longer current.');
      }
      if (payload.lane !== 'quarantine' && (payload.lane !== 'network' || !isDeepStrictEqual(basis(target.projectId), target.basis))) {
        throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original synchronization is no longer current.');
      }
    } else if (target.kind === 'open') {
      if (target.scope !== 'import' || typeof payload.url !== 'string' || typeof payload.branch !== 'string') {
        throw new GitDomainError('CONFLICT', 409, 'This import cannot be retried safely.');
      }
    } else if (target.kind === 'resolve') {
      if (!target.projectId || target.scope !== `project:${target.projectId}` || !isDeepStrictEqual(basis(target.projectId), target.basis)
        || typeof payload.conflictOperationId !== 'string') {
        throw new GitDomainError('PREVIEW_STALE', 409, 'The original conflict resolution is no longer current.');
      }
    } else if (!target.projectId || target.scope !== `project:${target.projectId}` || !isDeepStrictEqual(basis(target.projectId), target.basis)
      || typeof payload.previewId !== 'string') {
      throw new GitDomainError('PREVIEW_STALE', 409, 'The original operation is no longer current.');
    } else if (target.kind === 'bind' && (!payload.confirmation || typeof payload.confirmation !== 'object' || Array.isArray(payload.confirmation))) {
      throw new GitDomainError('CONFLICT', 409, 'This binding operation cannot be retried safely.');
    }
    if (target.projectId && payload.lane !== 'quarantine') await resolveRuntime(target.projectId);
    const claim = input.store.claimOperationRequest({ actorId: context.actorId, projectId: context.projectId,
      action: 'retry', idempotencyKey: context.idempotencyKey, requestDigest: digest, operationId: target.id });
    return { operation: input.store.getOperation(target.id)!, startWorker: claim.admitted,
      attempt: claim.admitted ? claim.attempt : null };
  }

  async function retryOperation(operationId: string, attempt: number): Promise<ProjectGitOperation> {
    if (!input.store.startRetryAttempt(operationId, attempt)) {
      throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted retry worker is unavailable.');
    }
    const target = input.store.getJournal(operationId);
    const payload = target?.payload;
    if (!target || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted retry is unavailable.');
    }
    const original = { actorId: target.actorId, idempotencyKey: target.idempotencyKey,
      expectedProjectRevision: target.basis.projectRevision };
    if (target.kind === 'sync') {
      if (!target.projectId) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted retry is unavailable.');
      if (payload.lane === 'quarantine') {
        const binding = input.store.getBinding(target.projectId);
        if (!binding) throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original synchronization is no longer current.');
        try { await resolveRuntime(target.projectId); }
        catch (error) { quarantine(binding, error); }
        return input.store.getOperation(target.id)!;
      }
      return scheduler.withNetworkPaused(target.projectId, () => {
        assertNetworkAdmissionUnfenced(target.id);
        return syncProject({ projectId: target.projectId!, oneShot: true, deps: syncRuntime,
          request: { actorId: target.actorId, idempotencyKey: target.idempotencyKey, requestDigest: target.requestDigest } })
        .then(operation => {
          if (!operation) throw new GitDomainError('CONFLICT', 409, 'Project synchronization was not admitted.');
          return operation;
        });
      });
    }
    const resume = (work: () => Promise<ProjectGitOperation>): Promise<ProjectGitOperation> => work();
    if (target.kind === 'open') {
      return resume(() => bindingService.openRepository({ actorId: original.actorId, idempotencyKey: original.idempotencyKey,
        url: payload.url as string, branch: payload.branch as string }));
    }
    if (target.kind === 'resolve') return syncRuntime.retryConflictResolution(target.id);
    if (!target.projectId) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted retry is unavailable.');
    if (target.kind === 'enable') return resume(() => bindingService.enable(target.projectId!, payload.previewId as string, original));
    if (target.kind === 'bind') return resume(() => bindingService.bind(target.projectId!, payload.previewId as string, { ...original,
      confirmation: payload.confirmation as import('@open-design/contracts').ProjectGitBindConfirmation }));
    return resume(async () => input.store.getOperation((await restoreService.restoreProject(
      target.projectId!, payload.previewId as string, original)).operationId)!);
  }

  async function admitManualSync(context: ProjectGitRequestContext): Promise<ProjectGitOperation> {
    if (!context.projectId) throw new GitDomainError('VALIDATION_FAILED', 400, 'A project is required.');
    await input.requireProject?.(context.actorId, context.projectId);
    await resolveRuntime(context.projectId);
    const digest = requestDigest({ kind: 'sync', expectedProjectRevision: context.expectedProjectRevision ?? null });
    const existing = input.store.findOperation({ actorId: context.actorId, projectId: context.projectId,
      kind: 'sync', idempotencyKey: context.idempotencyKey });
    if (existing) {
      if (existing.requestDigest !== digest) throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
      return input.store.getOperation(existing.id)!;
    }
    if (!input.store.getBinding(context.projectId)) throw new GitDomainError('NOT_FOUND', 404, 'Managed project not found.');
    input.store.assertRevision(context.projectId, context.expectedProjectRevision);
    return input.store.getOperation(input.store.enqueueOperation({ projectId: context.projectId, actorId: context.actorId, kind: 'sync',
      idempotencyKey: context.idempotencyKey, requestDigest: digest, basis: basis(context.projectId),
      payload: { lane: 'network', retainedConflictId: retainedConflict(context.projectId)?.id ?? null } }).id)!;
  }

  async function manualSync(context: ProjectGitRequestContext): Promise<ProjectGitOperation> {
    if (!context.projectId) throw new GitDomainError('VALIDATION_FAILED', 400, 'A project is required.');
    const digest = requestDigest({ kind: 'sync', expectedProjectRevision: context.expectedProjectRevision ?? null });
    try {
      const operation = await scheduler.withNetworkPaused(context.projectId, () => {
        const admitted = input.store.findOperation({ actorId: context.actorId, projectId: context.projectId,
          kind: 'sync', idempotencyKey: context.idempotencyKey });
        if (!admitted) throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted synchronization is unavailable.');
        assertNetworkAdmissionUnfenced(admitted.id);
        return syncProject({ projectId: context.projectId!, oneShot: true, deps: syncRuntime,
          request: { actorId: context.actorId, idempotencyKey: context.idempotencyKey, requestDigest: digest } });
      });
      if (!operation) throw new GitDomainError('CONFLICT', 409, 'Project synchronization was not admitted.');
      return operation;
    } catch (error) {
      const operation = input.store.findOperation({ actorId: context.actorId, projectId: context.projectId,
        kind: 'sync', idempotencyKey: context.idempotencyKey });
      if (operation) return input.store.getOperation(operation.id)!;
      throw error;
    }
  }

  let started = false;
  let stopping = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let startPromise: Promise<void> | null = null;
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    void promise.then(() => { inFlight.delete(promise); }, () => { inFlight.delete(promise); });
    return promise;
  };
  const admit = <T>(work: () => T | Promise<T>): Promise<T> => {
    if (stopping || stopped) return Promise.reject(new GitDomainError('PROJECT_BUSY', 409, 'Project versioning is stopping.'));
    return track(Promise.resolve().then(work));
  };
  const operationForRequest = (action: ProjectGitAction, context: ProjectGitRequestContext): ProjectGitOperation | null => {
    if (action.kind === 'retry') {
      const request = input.store.findOperationRequest({ actorId: context.actorId, projectId: context.projectId,
        action: 'retry', idempotencyKey: context.idempotencyKey });
      return request ? input.store.getOperation(request.operationId) : null;
    }
    const operation = input.store.findOperation({ actorId: context.actorId, projectId: context.projectId,
      kind: action.kind, idempotencyKey: context.idempotencyKey });
    return operation ? input.store.getOperation(operation.id) : null;
  };
  const requestAdmissions = new Map<string, Promise<void>>();
  const requestWorkers = new Map<string, { fingerprint: string; promise: Promise<ProjectGitOperation> }>();
  const service: ProjectGitService = {
    getState(projectId) {
      return admit(() => state(projectId));
    },
    execute(action, context) {
      const requestScope = context.projectId === null ? 'import' : `project:${context.projectId}`;
      const requestKey = `${context.actorId}\0${requestScope}\0${action.kind}\0${context.idempotencyKey}`;
      const priorAdmission = requestAdmissions.get(requestKey) ?? Promise.resolve();
      const execution = admit(async () => {
        await priorAdmission;
        await recoveryReady;
        const fingerprint = requestDigest({ action, expectedProjectRevision: context.expectedProjectRevision ?? null });
        const shareWorker = ['enable_preview', 'enable', 'binding_preview', 'bind', 'unbind', 'open', 'restore_preview', 'restore',
          'pause', 'resume', 'sync', 'resolve', 'retry'].includes(action.kind);
        const activeWorker = shareWorker ? requestWorkers.get(requestKey) : undefined;
        if (activeWorker) {
          if (activeWorker.fingerprint !== fingerprint) {
            throw new GitDomainError('CONFLICT', 409, 'The idempotency key belongs to a different request.');
          }
          const activeOperation = operationForRequest(action, context);
          if (activeOperation) return accepted(activeOperation);
          const operation = await activeWorker.promise;
          return accepted(operation);
        }
        const request = contextRequest(context);
        let operationAtAdmission: ProjectGitOperation | null = null;
        let prestartedWorker: Promise<ProjectGitOperation> | null = null;
        let retryAttempt: number | null = null;
        let startWorker = true;
        switch (action.kind) {
          case 'enable_preview': operationAtAdmission = await bindingService.admitPreviewEnable(context.projectId!, request); break;
          case 'enable': operationAtAdmission = await bindingService.admitEnable(context.projectId!, action.previewId, request); break;
          case 'binding_preview': operationAtAdmission = await bindingService.admitPreviewBinding(context.projectId!, action.url, action.branch, request); break;
          case 'bind': operationAtAdmission = await bindingService.admitBind(context.projectId!, action.previewId,
            { ...request, ...(action.confirmation ? { confirmation: action.confirmation } : {}) }); break;
          case 'unbind': operationAtAdmission = await bindingService.admitUnbind(context.projectId!, request); break;
          case 'open': operationAtAdmission = await bindingService.admitOpenRepository({ ...request, url: action.url, branch: action.branch }); break;
          case 'restore_preview': operationAtAdmission = input.store.getOperation((await restoreService.admitRestorePreview(
            context.projectId!, action.oid, request)).operationId); break;
          case 'restore': operationAtAdmission = input.store.getOperation((await restoreService.admitRestore(
            context.projectId!, action.previewId, request)).operationId); break;
          case 'sync': operationAtAdmission = await admitManualSync(context); break;
          case 'resolve': {
            const resolution = await admitResolve(action, context);
            operationAtAdmission = resolution.operation;
            prestartedWorker = resolution.worker;
            startWorker = resolution.worker !== null;
            break;
          }
          case 'retry': {
            const retry = await admitRetry(action, context);
            operationAtAdmission = retry.operation;
            startWorker = retry.startWorker;
            retryAttempt = retry.attempt;
            break;
          }
        }
        if (operationAtAdmission && !startWorker) {
          return accepted(operationAtAdmission);
        }
        if (operationAtAdmission && operationAtAdmission.status !== 'queued'
          && action.kind !== 'retry' && action.kind !== 'resolve') {
          return accepted(operationAtAdmission);
        }
        const worker = track(prestartedWorker ?? (async (): Promise<ProjectGitOperation> => {
          switch (action.kind) {
            case 'enable_preview': return bindingService.previewEnable(context.projectId!, request);
            case 'enable': return bindingService.enable(context.projectId!, action.previewId, request);
            case 'binding_preview': return bindingService.previewBinding(context.projectId!, action.url, action.branch, request);
            case 'bind': return bindingService.bind(context.projectId!, action.previewId, { ...request, ...(action.confirmation ? { confirmation: action.confirmation } : {}) });
            case 'unbind': return bindingService.unbind(context.projectId!, request);
            case 'open': return bindingService.openRepository({ ...request, url: action.url, branch: action.branch });
            case 'restore_preview': {
              const preview = await restoreService.previewRestore(context.projectId!, action.oid, request);
              return input.store.getOperation(preview.id)!;
            }
            case 'restore': {
              const result = await restoreService.restoreProject(context.projectId!, action.previewId, request);
              return input.store.getOperation(result.operationId)!;
            }
            case 'sync': return manualSync(context);
            case 'retry': return retryOperation(action.operationId, retryAttempt!);
            case 'resolve': throw new GitDomainError('RECOVERY_REQUIRED', 409, 'The admitted conflict resolution worker is unavailable.');
            default: return shortOperation(action, context);
          }
        })());
        if (shareWorker) {
          requestWorkers.set(requestKey, { fingerprint, promise: worker });
          void worker.then(() => {
            if (requestWorkers.get(requestKey)?.promise === worker) requestWorkers.delete(requestKey);
          }, () => {
            if (requestWorkers.get(requestKey)?.promise === worker) requestWorkers.delete(requestKey);
          });
        }
        const completed = worker.then(async operation => {
          if (retryAttempt !== null) input.store.settleRetryAttempt(operation.id, retryAttempt);
          await accepted(operation);
          return { ok: true as const, operation };
        }, async error => {
          const operation = operationForRequest(action, context);
          if (operation) {
            input.store.settleAdmittedOperationFailure(operation.id, publicError(error));
            if (retryAttempt !== null) input.store.settleRetryAttempt(operation.id, retryAttempt);
            await accepted(input.store.getOperation(operation.id)!);
          }
          return { ok: false as const, error };
        });
        if (operationAtAdmission) {
          return accepted(operationAtAdmission);
        }
        const result = await completed;
        if (result.ok) return { operationId: result.operation.id };
        throw result.error;
      });
      const admissionSettled = execution.then(() => {}, () => {});
      requestAdmissions.set(requestKey, admissionSettled);
      void admissionSettled.then(() => {
        if (requestAdmissions.get(requestKey) === admissionSettled) requestAdmissions.delete(requestKey);
      });
      return execution;
    },
    getOperation(id) {
      return admit(() => {
        const operation = input.store.getOperation(id);
        if (!operation) throw new GitDomainError('NOT_FOUND', 404, 'Project Git operation not found.');
        return operation;
      });
    },
    history(projectId, cursor, path) { return admit(async () => {
      const project = await resolveRuntime(projectId);
      return readHistory(project.root, cursor ?? null, path);
    }); },
    commit(projectId, oid) { return admit(async () => {
      const project = await resolveRuntime(projectId);
      return readCommit(project.root, oid);
    }); },
    file(projectId, oid, path) { return admit(async () => {
      const project = await resolveRuntime(projectId);
      return readCommitFile(project.root, oid, path);
    }); },
    conversations(projectId, oid) { return admit(async () => {
      const project = await resolveRuntime(projectId);
      return readCommitConversations(project.root, oid);
    }); },
    conflicts(projectId) { return admit(async () => {
      const conflicts: ProjectGitConflict[] = [];
      for (const operation of input.store.listPendingOperations()) {
        const payload = operation.payload;
        if (operation.projectId === projectId && operation.phase === 'conflict'
          && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          && payload.conflictEvidence !== null && typeof payload.conflictEvidence === 'object'
          && !Array.isArray(payload.conflictEvidence)) {
          conflicts.push(...(await readProjectGitConflictEvidence(operationRoot, operation)).conflicts);
        }
      }
      return conflicts;
    }); },
    start() {
      if (started || stopping || stopped) return Promise.resolve();
      if (startPromise) return startPromise;
      startPromise = (async () => {
        await recoveryReady;
        if (stopping || stopped) return;
        const settledRetries = input.store.reconcileInterruptedRetryAttempts(interruptedRetryAttempts);
        for (const operationId of settledRetries) {
          const operation = input.store.getOperation(operationId);
          if (!operation) continue;
          await emitOperation(operation);
          if (operation.projectId) await emitState(operation.projectId);
        }
        if (stopping || stopped) return;
        input.store.reconcileInterruptedAdmissions(interruptedAdmissions);
        if (stopping || stopped) return;
        scheduler.start();
        for (const binding of input.store.listBindings()) {
          if (stopping || stopped) break;
          try {
            await resolveRuntime(binding.projectId);
            if (stopping || stopped) break;
            ensureWatcher(binding.projectId);
          } catch (error) { quarantine(binding, error); }
        }
        if (!stopping && !stopped) started = true;
      })();
      return startPromise;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        if (startPromise) await Promise.allSettled([startPromise]);
        while (inFlight.size) await Promise.allSettled([...inFlight]);
        await Promise.allSettled([...watchers.values()].map(watcher => Promise.resolve(watcher.unsubscribe())));
        watchers.clear();
        await scheduler.stop();
        for (const permit of permits.values()) permit.release();
        permits.clear();
        stopped = true;
      })();
      return stopPromise;
    },
  };
  return { service, coordination };
}

export async function createProjectGitService(input: CreateProjectGitServiceInput): Promise<ProjectGitService> {
  return (await createProjectGitServiceComposition(input)).service;
}
