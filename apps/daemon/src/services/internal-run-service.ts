/**
 * Daemon-internal seam for preparing and starting one physical chat Run.
 *
 * HTTP routes remain responsible for parsing, authorization, snapshot
 * resolution, response formatting, and lifecycle observers. Callers hand this
 * service the already-resolved run identity/prompt/session inputs so a future
 * coordinator can reuse the same create -> claim -> start transaction without
 * calling the daemon through HTTP.
 */
import type { RunAnalyticsFacts } from './run-analytics-lifecycle.js';
import type { ProjectRunAdmission as ProjectRunAdmissionHandle } from './project-mutation.js';

/**
 * `RunAnalyticsFacts` is a REQUIRED argument of `start` on purpose. Analytics
 * used to be installed by whichever caller remembered to do it, and four
 * daemon-internal Run creators silently reported nothing (OPEND-2365). Making
 * the facts part of the start contract means a new caller has to state its
 * analytics identity — including stating that it has none — instead of dropping
 * the Run. The type is owned by the lifecycle so the choke point and the
 * lifecycle cannot drift apart.
 */
export interface InternalRunCreateInput extends Record<string, unknown> {
  projectId?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  clientRequestId?: string;
  requestFingerprint?: string;
  agentId?: string;
  pluginId?: string;
  appliedPluginSnapshotId?: string;
  message?: string;
  currentPrompt?: string;
  sessionMode?: string;
  analyticsHints?: Record<string, unknown>;
  /** Daemon-owned immutable OD Next task input descriptor; never accepted from callers. */
  odNextTaskInputSnapshot?: {
    taskExecutionId: string;
    snapshotDir: string;
    manifestSha256: string;
  } | null;
}

export interface InternalPhysicalRun {
  id: string;
  status: string;
  projectId?: string | null;
  manualResumeAttemptCount?: number;
  pendingManualResumeAttemptCount?: number;
}

export interface InternalRunAnalyticsLifecycle<TRun> {
  install(input: RunAnalyticsFacts & { run: TRun }): void;
}

export interface InternalRunRegistry<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
> {
  createOrReuse(meta: TMeta):
    | { kind: 'created'; run: TRun }
    | { kind: 'reused'; run: TRun }
    | { kind: 'conflict'; run: TRun };
  prepareRestart(run: TRun): TRun | null;
  reserveRestartAttempt(run: TRun, executionAttempt: number): boolean;
  clearRestartAttempt(run: TRun, executionAttempt: number): void;
  get(id: string): TRun | null;
  drop(run: TRun): void;
  fail(run: TRun, errorCode: string, errorMessage: string): void;
  persistState(run: TRun): void;
  start(run: TRun, starter: () => Promise<unknown>): TRun;
  isTerminal(status: TRun['status']): boolean;
}

export interface AssistantRunClaimOptions {
  status?: string;
  beforeClaimCommit?: () => void;
  isRunActive?: (runId: string) => boolean;
}

export type AssistantRunClaimResult = {
  ok: boolean;
  reason?: 'active' | 'scope';
};

export interface PrepareInternalRunInput<TMeta extends InternalRunCreateInput, TRun> {
  meta: TMeta;
  projectAdmission?: PreRunProjectAdmission;
  /**
   * Runs inside the assistant-message claim transaction. The newly allocated
   * physical Run is supplied so a logical coordinator can CAS-claim that exact
   * id before either record becomes visible.
   */
  beforeClaimCommit?: (run: TRun) => void;
  resume?: {
    requested: boolean;
    canResume: (run: TRun) => boolean;
  };
}

export type PreparedInternalRunResult<TRun> =
  | { kind: 'ready'; run: TRun; creationKind: 'created' | 'reused'; resumed: boolean }
  | { kind: 'reused'; run: TRun }
  | { kind: 'idempotency_conflict'; run: TRun }
  | { kind: 'resume_not_allowed'; run: TRun }
  | { kind: 'assistant_claim_conflict'; run: TRun; reason?: 'active' | 'scope' };

const preRunProjectAdmissionBrand: unique symbol = Symbol('pre-run-project-admission');

/** Opaque capability held before snapshot/pre-claim project mutations. */
export interface PreRunProjectAdmission {
  readonly projectId: string;
  readonly [preRunProjectAdmissionBrand]: true;
}

export interface InternalRunCreationService<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
> {
  preAdmitProjectRun(projectId: string): Promise<PreRunProjectAdmission>;
  withProjectMutation<T>(
    admission: PreRunProjectAdmission,
    source: string,
    work: () => Promise<T>,
  ): Promise<T>;
  releaseProjectRunAdmission(admission: PreRunProjectAdmission): void;
  prepare(input: PrepareInternalRunInput<TMeta, TRun>): Promise<PreparedInternalRunResult<TRun>>;
  /** Release admission and remove a ready physical Run that will not be started. */
  discard(run: TRun): void;
  start(
    run: TRun,
    analytics: RunAnalyticsFacts,
    starter: (run: TRun) => Promise<unknown>,
  ): TRun;
}

export function createInternalRunCreationService<
  TMeta extends InternalRunCreateInput,
  TRun extends InternalPhysicalRun,
>(deps: {
  runs: InternalRunRegistry<TMeta, TRun>;
  claimAssistantMessage: (
    run: TRun,
    options?: AssistantRunClaimOptions,
  ) => AssistantRunClaimResult;
  /**
   * Armed for every physical Run this service starts, whoever asked for it.
   * Required: an optional dependency would let a future factory construct this
   * service, satisfy the `.runs.start` guard, and still emit nothing. A harness
   * that wants silence injects a no-op lifecycle and says so.
   */
  analyticsLifecycle: InternalRunAnalyticsLifecycle<TRun>;
  beginProjectRunAdmission: (projectId: string) => Promise<ProjectRunAdmissionHandle>;
  attachProjectRun: (
    runId: string,
    projectId: string,
    admission: ProjectRunAdmissionHandle,
    executionAttempt: number,
  ) => null;
  detachProjectRun(runId: string, admission: ProjectRunAdmissionHandle): void;
  coordinateProjectMutation<T>(
    admission: ProjectRunAdmissionHandle,
    source: string,
    work: () => Promise<T>,
  ): Promise<T>;
  releaseProjectRun(runId: string): void;
}): InternalRunCreationService<TMeta, TRun> {
  const preRunAdmissions = new WeakMap<
    PreRunProjectAdmission,
    {
      handle: ProjectRunAdmissionHandle;
      attachedRunId: string | null;
      released: boolean;
      transferred: boolean;
    }
  >();
  const preparedRuns = new Map<TRun, { admitted: boolean }>();
  const isRunActive = (runId: string): boolean => {
    const existing = deps.runs.get(runId);
    return Boolean(existing && !deps.runs.isTerminal(existing.status));
  };

  const preAdmitProjectRun = async (projectId: string): Promise<PreRunProjectAdmission> => {
    const handle = await deps.beginProjectRunAdmission(projectId);
    const admission = Object.freeze({
      projectId,
      [preRunProjectAdmissionBrand]: true as const,
    });
    preRunAdmissions.set(admission, {
      handle,
      attachedRunId: null,
      released: false,
      transferred: false,
    });
    return admission;
  };

  const admissionState = (admission: PreRunProjectAdmission) => {
    const state = preRunAdmissions.get(admission);
    if (!state) throw new Error('Pre-run project admission is not owned by this service.');
    if (state.released) throw new Error('Pre-run project admission is already released.');
    return state;
  };

  const releaseProjectRunAdmission = (admission: PreRunProjectAdmission): void => {
    const state = preRunAdmissions.get(admission);
    if (!state || state.released || state.transferred) return;
    state.released = true;
    if (state.attachedRunId) deps.releaseProjectRun(state.attachedRunId);
    else state.handle.release();
  };

  const releaseAttachedAdmission = (
    admission: PreRunProjectAdmission,
    runId: string,
  ): void => {
    const state = preRunAdmissions.get(admission);
    if (!state || state.released) return;
    state.released = true;
    state.transferred = false;
    deps.releaseProjectRun(runId);
  };

  const prepare = async (
    input: PrepareInternalRunInput<TMeta, TRun>,
  ): Promise<PreparedInternalRunResult<TRun>> => {
    const creation = deps.runs.createOrReuse(input.meta);
    if (creation.kind === 'conflict') {
      return { kind: 'idempotency_conflict', run: creation.run };
    }

    const run = creation.run;
    if (creation.kind === 'reused') {
      if (!input.resume?.requested) {
        return { kind: 'reused', run };
      }
      if (!input.resume.canResume(run)) {
        return { kind: 'resume_not_allowed', run };
      }
    }

    let admitted = false;
    const suppliedAdmission = input.projectAdmission !== undefined;
    let projectAdmission = input.projectAdmission;
    const releaseAdmission = (): void => {
      if (!admitted) return;
      admitted = false;
      if (suppliedAdmission && projectAdmission) {
        const state = admissionState(projectAdmission);
        deps.detachProjectRun(run.id, state.handle);
        state.attachedRunId = null;
        return;
      }
      if (projectAdmission) releaseAttachedAdmission(projectAdmission, run.id);
    };
    let claim: AssistantRunClaimResult;
    const executionAttempt = creation.kind === 'reused'
      ? (run.manualResumeAttemptCount ?? 0) + 1
      : (run.manualResumeAttemptCount ?? 0);
    let reservedResumeAttempt = false;
    let resumeClaimCommitted = false;
    const clearReservedResumeAttempt = (): void => {
      if (!reservedResumeAttempt) return;
      reservedResumeAttempt = false;
      try { deps.runs.clearRestartAttempt(run, executionAttempt); }
      catch { /* The stale private marker is ignored without an active claim on restart. */ }
    };
    try {
      if (creation.kind === 'reused') {
        if (!deps.runs.reserveRestartAttempt(run, executionAttempt)) {
          throw new Error('Failed to persist the resumed run execution attempt.');
        }
        reservedResumeAttempt = true;
      }
      if (typeof input.meta.projectId === 'string' && input.meta.projectId) {
        projectAdmission ??= await preAdmitProjectRun(input.meta.projectId);
        if (projectAdmission.projectId !== input.meta.projectId) {
          releaseProjectRunAdmission(projectAdmission);
          throw new Error('Pre-run project admission does not match the run project.');
        }
        const state = admissionState(projectAdmission);
        deps.attachProjectRun(
          run.id,
          input.meta.projectId,
          state.handle,
          executionAttempt,
        );
        state.attachedRunId = run.id;
        admitted = true;
      } else if (projectAdmission) {
        releaseProjectRunAdmission(projectAdmission);
        throw new Error('A project admission cannot be attached to a projectless run.');
      }

      if (creation.kind === 'reused') {
        const resumeClaim = deps.claimAssistantMessage(run, {
          status: 'queued',
          isRunActive,
        });
        if (!resumeClaim.ok) {
          clearReservedResumeAttempt();
          releaseAdmission();
          return {
            kind: 'assistant_claim_conflict',
            run,
            ...(resumeClaim.reason ? { reason: resumeClaim.reason } : {}),
          };
        }
        resumeClaimCommitted = true;
        if (!deps.runs.prepareRestart(run)) {
          releaseAdmission();
          return { kind: 'resume_not_allowed', run };
        }
        preparedRuns.set(run, { admitted });
        if (projectAdmission) admissionState(projectAdmission).transferred = true;
        return { kind: 'ready', run, creationKind: 'reused', resumed: true };
      }

      claim = deps.claimAssistantMessage(run, {
        ...(input.beforeClaimCommit
          ? { beforeClaimCommit: () => input.beforeClaimCommit?.(run) }
          : {}),
        isRunActive,
      });
    } catch (error) {
      // The registry create is optimistic. A failed ownership transaction must
      // not leave a physical Run that can be listed, streamed, or reconciled.
      if (!resumeClaimCommitted) clearReservedResumeAttempt();
      releaseAdmission();
      if (creation.kind === 'created') deps.runs.drop(run);
      throw error;
    }
    if (!claim.ok) {
      releaseAdmission();
      deps.runs.drop(run);
      return {
        kind: 'assistant_claim_conflict',
        run,
        ...(claim.reason ? { reason: claim.reason } : {}),
      };
    }
    preparedRuns.set(run, { admitted });
    if (projectAdmission) admissionState(projectAdmission).transferred = true;
    return { kind: 'ready', run, creationKind: 'created', resumed: false };
  };

  return {
    preAdmitProjectRun,
    withProjectMutation(admission, source, work) {
      const state = admissionState(admission);
      if (state.transferred) {
        throw new Error('Pre-run project admission has already transferred to a Run.');
      }
      return deps.coordinateProjectMutation(state.handle, source, work);
    },
    releaseProjectRunAdmission,
    prepare,
    discard(run) {
      const prepared = preparedRuns.get(run);
      if (!prepared) return;
      preparedRuns.delete(run);
      if (prepared.admitted) deps.releaseProjectRun(run.id);
      deps.runs.drop(run);
    },
    start(run, analytics, starter) {
      const prepared = preparedRuns.get(run);
      if (!prepared) {
        throw new Error(`Run ${run.id} must be prepared before start`);
      }
      preparedRuns.delete(run);
      // Before the child is spawned: `run_created` describes a Run that has
      // been accepted, and the terminal half must already be attached when the
      // Run settles — including a Run that fails on its first tick.
      try {
        deps.analyticsLifecycle.install({ ...analytics, run });
        return deps.runs.start(run, () => starter(run));
      } catch (error) {
        try {
          deps.runs.fail(
            run,
            'RUN_START_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          if (prepared.admitted) deps.releaseProjectRun(run.id);
          deps.runs.drop(run);
        }
        throw error;
      }
    },
  };
}
