import type { ApiError, ProjectGitState } from '@open-design/contracts';

export interface ProjectRevisionTracker {
  accept(revision: number): boolean;
  capture(): { expectedProjectRevision: number };
  current(): number;
  isCurrent(revision: number): boolean;
}

export function createProjectRevisionTracker(initialRevision: number): ProjectRevisionTracker {
  let revision = initialRevision;
  return {
    accept(nextRevision) {
      if (nextRevision <= revision) return false;
      revision = nextRevision;
      return true;
    },
    capture: () => ({ expectedProjectRevision: revision }),
    current: () => revision,
    isCurrent: candidate => candidate === revision,
  };
}

export interface ProjectMutationContext {
  expectedProjectRevision?: number;
  signal: AbortSignal;
  generation: number;
}

export interface ProjectGitStateSnapshot {
  state: ProjectGitState | null;
  loading: boolean;
  error: Error | null;
  writeLocked: boolean;
  generation: number;
}

export interface ProjectGitReadToken {
  generation: number;
  sequence: number;
}

export interface ProjectGitReconciliationToken {
  generation: number;
}

export interface ProjectGitStateStore {
  accept(state: ProjectGitState, source: 'event' | 'read'): 'advanced' | 'updated' | 'stale';
  acceptRead(token: ProjectGitReadToken, state: ProjectGitState): 'advanced' | 'updated' | 'stale';
  beginRead(): ProjectGitReadToken;
  capture(): ProjectMutationContext;
  completeReconciliation(token: ProjectGitReconciliationToken): boolean;
  failRead(token: ProjectGitReadToken, error: Error): boolean;
  isCurrent(context: ProjectMutationContext): boolean;
  reconciliationToken(): ProjectGitReconciliationToken;
  snapshot(): ProjectGitStateSnapshot;
  subscribe(listener: () => void): () => void;
}

const projectMutationStores = new Map<string, ProjectGitStateStore>();
const projectEpochInvalidators = new Map<string, Set<() => void>>();

export function registerProjectMutationStore(projectId: string, store: ProjectGitStateStore): void {
  projectMutationStores.set(projectId, store);
}

export function unregisterProjectMutationStore(projectId: string, store: ProjectGitStateStore): void {
  if (projectMutationStores.get(projectId) === store) projectMutationStores.delete(projectId);
}

export function registerProjectEpochInvalidator(projectId: string, invalidate: () => void): () => void {
  const listeners = projectEpochInvalidators.get(projectId) ?? new Set<() => void>();
  listeners.add(invalidate);
  projectEpochInvalidators.set(projectId, listeners);
  return () => {
    listeners.delete(invalidate);
    if (listeners.size === 0) projectEpochInvalidators.delete(projectId);
  };
}

export function invalidateProjectBrowserEpoch(projectId: string): void {
  for (const invalidate of projectEpochInvalidators.get(projectId) ?? []) invalidate();
}

/** Capture once at the user/queue boundary and carry this object to fetch. */
export function captureProjectMutation(projectId: string): ProjectMutationContext | undefined {
  return projectMutationStores.get(projectId)?.capture();
}

export function isProjectMutationCurrent(
  projectId: string,
  context: ProjectMutationContext | undefined,
): context is ProjectMutationContext {
  return Boolean(context && projectMutationStores.get(projectId)?.isCurrent(context));
}

export function projectMutationHeaders(context?: ProjectMutationContext): Record<string, string> {
  return context?.expectedProjectRevision === undefined
    ? {}
    : { 'X-OD-Project-Revision': String(context.expectedProjectRevision) };
}

export function projectMutationBody<T extends Record<string, unknown>>(
  body: T,
  context?: ProjectMutationContext,
): T & { expectedProjectRevision?: number } {
  return {
    ...body,
    ...(context?.expectedProjectRevision === undefined
      ? {}
      : { expectedProjectRevision: context.expectedProjectRevision }),
  };
}

export class ProjectStateChangedError extends Error {
  readonly status = 409;
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
    this.name = 'ProjectStateChangedError';
  }
}

export async function throwIfProjectStateChanged(response: Response): Promise<void> {
  if (response.status !== 409) return;
  const clone = response.clone();
  const value = await clone.json().catch(() => null) as { error?: Partial<ApiError> } | null;
  if (value?.error?.code !== 'PROJECT_STATE_CHANGED') return;
  throw new ProjectStateChangedError({
    code: 'PROJECT_STATE_CHANGED',
    message: typeof value.error.message === 'string'
      ? value.error.message
      : 'Project history changed. Reload before applying this draft.',
    ...(value.error.details === undefined ? {} : { details: value.error.details }),
    ...(value.error.retryable === undefined ? {} : { retryable: value.error.retryable }),
  });
}

export function rethrowProjectStateChanged(error: unknown): void {
  if (error instanceof ProjectStateChangedError) throw error;
}

export function createProjectGitStateStore(
  initialState: ProjectGitState | null = null,
  options: { onRevisionAdvance?: (state: ProjectGitState) => void } = {},
): ProjectGitStateStore {
  let currentState = initialState;
  let generation = 0;
  let sequence = 0;
  let loading = initialState === null;
  let error: Error | null = null;
  let writeLocked = false;
  let epochController = new AbortController();
  const listeners = new Set<() => void>();
  let cachedSnapshot: ProjectGitStateSnapshot = {
    state: currentState,
    loading,
    error,
    writeLocked,
    generation,
  };

  const emit = () => {
    cachedSnapshot = { state: currentState, loading, error, writeLocked, generation };
    for (const listener of listeners) listener();
  };

  const accept = (nextState: ProjectGitState): 'advanced' | 'updated' | 'stale' => {
    if (currentState && nextState.projectRevision < currentState.projectRevision) return 'stale';
    if (
      currentState
      && nextState.projectRevision === currentState.projectRevision
      && (
        nextState.contentRevision < currentState.contentRevision
        || nextState.bindingGeneration < currentState.bindingGeneration
      )
    ) return 'stale';
    const advanced = currentState !== null
      && nextState.projectRevision > currentState.projectRevision;
    currentState = nextState;
    loading = false;
    error = null;
    sequence += 1;
    if (advanced) {
      epochController.abort();
      epochController = new AbortController();
      generation += 1;
      writeLocked = true;
      // Browser intent invalidation is deliberately synchronous with accepting
      // the new revision. Consumers cannot observe the new epoch while old
      // queued work is still considered valid.
      options.onRevisionAdvance?.(nextState);
    }
    emit();
    return advanced ? 'advanced' : 'updated';
  };

  return {
    accept: (nextState) => accept(nextState),
    acceptRead(token, nextState) {
      const currentRevision = currentState?.projectRevision ?? -1;
      if ((token.generation !== generation || token.sequence !== sequence)
        && nextState.projectRevision <= currentRevision) return 'stale';
      return accept(nextState);
    },
    beginRead: () => ({ generation, sequence }),
    capture: () => ({
      ...(currentState?.enabled
        ? { expectedProjectRevision: currentState.projectRevision }
        : {}),
      signal: epochController.signal,
      generation,
    }),
    completeReconciliation(token) {
      if (token.generation !== generation) return false;
      writeLocked = false;
      error = null;
      emit();
      return true;
    },
    failRead(token, nextError) {
      if (token.generation !== generation || token.sequence !== sequence) return false;
      loading = false;
      error = nextError;
      emit();
      return true;
    },
    isCurrent: context => context.generation === generation
      && !context.signal.aborted
      && (context.expectedProjectRevision === undefined
        || context.expectedProjectRevision === currentState?.projectRevision),
    reconciliationToken: () => ({ generation }),
    snapshot: () => cachedSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
