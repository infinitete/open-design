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
import type { ProjectGitStore } from '../../storage/project-git.js';
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
    return runtime;
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
  for (const binding of input.store.listBindings()) await resolveRuntime(binding.projectId);
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
  });
  const recoveryReady = syncRuntime.recoveryReady;
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
    if (!binding) return {
      enabled: false,
      phase: 'enable_pending',
      localHead: null,
      observedRemoteHead: null,
      confirmedRemoteHead: null,
      projectRevision: 0,
      contentRevision: 0,
      bindingGeneration: 0,
      dirty: false,
      pendingPush: false,
      autoSync: false,
      operationId: null,
      error: null,
      binding: { remoteConfigured: false, remoteLabel: null, branch: null },
      dependencies: [],
    };
    const operations = input.store.listPendingOperations().filter(operation => operation.projectId === projectId);
    const conflict = operations.filter(operation => operation.phase === 'conflict').at(-1);
    const active = conflict ?? operations.at(-1);
    const latest = input.store.getLatestProjectOperation(projectId);
    const operation = active ?? latest;
    const recovering = input.store.listRecoverable().some(item => item.projectId === projectId);
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
    await emitOperation(operation);
    if (operation.projectId) await emitState(operation.projectId);
    return { operationId: operation.id };
  }
  const contextRequest = (context: ProjectGitRequestContext) => ({
    actorId: context.actorId,
    idempotencyKey: context.idempotencyKey,
    ...(context.expectedProjectRevision === undefined ? {} : { expectedProjectRevision: context.expectedProjectRevision }),
  });

  async function shortOperation(action: Extract<ProjectGitAction, { kind: 'pause' | 'resume' | 'sync' | 'resolve' | 'retry' }>, context: ProjectGitRequestContext) {
    if (!context.projectId && action.kind !== 'retry') throw new GitDomainError('VALIDATION_FAILED', 400, 'A project is required.');
    if (action.kind === 'resolve') {
      const projectId = context.projectId!;
      if (!input.store.getBinding(projectId)) throw new GitDomainError('NOT_FOUND', 404, 'Managed project not found.');
      input.store.assertRevision(projectId, context.expectedProjectRevision);
      const digest = requestDigest({ action, expectedProjectRevision: context.expectedProjectRevision ?? null });
      return scheduler.withNetworkPaused(projectId, () => syncRuntime.resolveConflict({
        projectId,
        conflictOperationId: action.operationId,
        actorId: context.actorId,
        idempotencyKey: context.idempotencyKey,
        requestDigest: digest,
        basis: action.basis,
        resolutions: action.resolutions,
      }));
    }
    if (action.kind === 'retry') {
      const target = input.store.getJournal(action.operationId);
      if (!target || target.actorId !== context.actorId || target.projectId !== context.projectId || target.kind === 'checkpoint') {
        throw new GitDomainError('NOT_FOUND', 404, 'Project Git operation not found.');
      }
      const retryableSync = target.kind === 'sync' && ['failed', 'waiting'].includes(target.status)
        && ['auth_required', 'pending_push', 'external_git_busy', 'waiting_idle', 'failed'].includes(target.phase);
      if (!(target.status === 'failed' && ['enable', 'bind', 'open', 'restore'].includes(target.kind)) && !retryableSync) {
        throw new GitDomainError('CONFLICT', 409, 'This operation cannot be retried safely. Create a new preview.');
      }
      const payload = target.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new GitDomainError('CONFLICT', 409, 'This operation cannot be retried safely.');
      }
      const original = { actorId: target.actorId, idempotencyKey: target.idempotencyKey,
        expectedProjectRevision: target.basis.projectRevision };
      if (target.kind === 'sync') {
        if (!target.projectId || target.scope !== `project:${target.projectId}` || !isDeepStrictEqual(basis(target.projectId), target.basis)
          || payload.lane !== 'network') throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'The original synchronization is no longer current.');
        const retried = await syncProject({ projectId: target.projectId, oneShot: true, deps: syncRuntime,
          request: { actorId: target.actorId, idempotencyKey: target.idempotencyKey, requestDigest: target.requestDigest } });
        return retried;
      }
      const resume = async (work: () => Promise<ProjectGitOperation>): Promise<ProjectGitOperation> => {
        input.store.updateOperation(target.id, { status: 'running', phase: 'waiting_idle', result: target.result, error: null });
        try { return await work(); }
        catch (error) {
          const current = input.store.getJournal(target.id);
          if (current?.journalPhase === null) input.store.updateOperation(target.id, {
            status: 'failed', phase: target.phase, result: target.result, error: target.error,
          });
          throw error;
        }
      };
      if (target.kind === 'open') {
        if (target.scope !== 'import' || typeof payload.url !== 'string' || typeof payload.branch !== 'string') {
          throw new GitDomainError('CONFLICT', 409, 'This import cannot be retried safely.');
        }
        const url = payload.url; const branch = payload.branch;
        return resume(() => bindingService.openRepository({ actorId: original.actorId, idempotencyKey: original.idempotencyKey,
          url, branch }));
      }
      if (!target.projectId || target.scope !== `project:${target.projectId}` || !isDeepStrictEqual(basis(target.projectId), target.basis)
        || typeof payload.previewId !== 'string') throw new GitDomainError('PREVIEW_STALE', 409, 'The original operation is no longer current.');
      if (target.kind === 'enable') return resume(() => bindingService.enable(target.projectId!, payload.previewId as string, original));
      if (target.kind === 'bind') {
        const confirmation = payload.confirmation;
        if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
          throw new GitDomainError('CONFLICT', 409, 'This binding operation cannot be retried safely.');
        }
        return resume(() => bindingService.bind(target.projectId!, payload.previewId as string, { ...original,
          confirmation: confirmation as import('@open-design/contracts').ProjectGitBindConfirmation }));
      }
      return resume(async () => input.store.getOperation((await restoreService.restoreProject(target.projectId!, payload.previewId as string, original)).operationId)!);
    }
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

  async function manualSync(context: ProjectGitRequestContext): Promise<ProjectGitOperation> {
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
    try {
      const operation = await syncProject({ projectId: context.projectId, oneShot: true, deps: syncRuntime,
        request: { actorId: context.actorId, idempotencyKey: context.idempotencyKey, requestDigest: digest } });
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
  const inFlight = new Set<Promise<unknown>>();
  const admit = <T>(work: () => T | Promise<T>): Promise<T> => {
    if (stopping || stopped) return Promise.reject(new GitDomainError('PROJECT_BUSY', 409, 'Project versioning is stopping.'));
    const promise = Promise.resolve().then(work);
    inFlight.add(promise);
    void promise.then(() => { inFlight.delete(promise); }, () => { inFlight.delete(promise); });
    return promise;
  };
  const service: ProjectGitService = {
    getState(projectId) {
      return admit(() => state(projectId));
    },
    execute(action, context) {
      return admit(async () => {
        await recoveryReady;
        let operation: ProjectGitOperation;
        const request = contextRequest(context);
        switch (action.kind) {
          case 'enable_preview': operation = await bindingService.previewEnable(context.projectId!, request); break;
          case 'enable': operation = await bindingService.enable(context.projectId!, action.previewId, request); break;
          case 'binding_preview': operation = await bindingService.previewBinding(context.projectId!, action.url, action.branch, request); break;
          case 'bind': operation = await bindingService.bind(context.projectId!, action.previewId, { ...request, ...(action.confirmation ? { confirmation: action.confirmation } : {}) }); break;
          case 'unbind': operation = await bindingService.unbind(context.projectId!, request); break;
          case 'open': operation = await bindingService.openRepository({ ...request, url: action.url, branch: action.branch }); break;
          case 'restore_preview': {
            const preview = await restoreService.previewRestore(context.projectId!, action.oid, request);
            operation = input.store.getOperation(preview.id)!;
            break;
          }
          case 'restore': {
            const result = await restoreService.restoreProject(context.projectId!, action.previewId, request);
            operation = input.store.getOperation(result.operationId)!;
            break;
          }
          case 'sync': operation = await manualSync(context); break;
          default: operation = await shortOperation(action, context);
        }
        return accepted(operation);
      });
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
        if (operation.projectId === projectId && operation.phase === 'conflict') {
          conflicts.push(...(await readProjectGitConflictEvidence(operationRoot, operation)).conflicts);
        }
      }
      return conflicts;
    }); },
    async start() {
      if (started || stopping || stopped) return;
      await recoveryReady;
      scheduler.start();
      started = true;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        await scheduler.stop();
        await Promise.allSettled([...inFlight]);
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
