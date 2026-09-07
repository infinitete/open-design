import {
  ProjectGitCommitSchema,
  ProjectGitAcceptedSchema,
  ProjectGitApiErrorResponseSchema,
  ProjectGitConflictsResponseSchema,
  ProjectGitFileResponseSchema,
  ProjectGitHistoryPageSchema,
  ProjectGitOperationSchema,
  ProjectGitStateSchema,
  parsePortableSnapshot,
  type ApiError,
  type ProjectGitAction,
  type ProjectGitCommit,
  type ProjectGitConflictsResponse,
  type ProjectGitFileResponse,
  type ProjectGitHistoryPage,
  type ProjectGitOperation,
  type ProjectGitState,
  type PortableSnapshot,
} from '@open-design/contracts';
import {
  createProjectGitStateStore,
  type ProjectGitStateSnapshot,
  type ProjectGitStateStore,
} from '../state/project-git';
import {
  invalidateProjectBrowserEpoch,
  registerProjectMutationStore,
  unregisterProjectMutationStore,
} from '../state/project-git';
import { subscribeProjectEvents, type ProjectEvent } from './project-events';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export class ProjectGitHttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiError: ApiError,
  ) {
    super(apiError.message);
    this.name = 'ProjectGitHttpError';
  }
}

type Fetch = typeof fetch;

export interface ProjectGitClientOptions {
  fetchFn?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
}

export interface ProjectGitExecuteOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface ProjectGitClient {
  state(projectId: string, signal?: AbortSignal): Promise<ProjectGitState>;
  execute(
    projectId: string | null,
    action: ProjectGitAction,
    expectedProjectRevision: number | undefined,
    options: ProjectGitExecuteOptions,
  ): Promise<ProjectGitOperation>;
  operation(operationId: string, signal?: AbortSignal): Promise<ProjectGitOperation>;
  history(projectId: string, cursor?: string, path?: string, signal?: AbortSignal): Promise<ProjectGitHistoryPage>;
  commit(projectId: string, oid: string, signal?: AbortSignal): Promise<ProjectGitCommit>;
  file(projectId: string, oid: string, path: string, signal?: AbortSignal): Promise<ProjectGitFileResponse>;
  conversations(projectId: string, oid: string, signal?: AbortSignal): Promise<PortableSnapshot | null>;
  conflicts(projectId: string, signal?: AbortSignal): Promise<ProjectGitConflictsResponse>;
}

function projectPath(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/git${suffix}`;
}

async function responseJson(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (!response.ok) {
    const parsed = ProjectGitApiErrorResponseSchema.safeParse(value);
    const apiError: ApiError = parsed.success
      ? parsed.data.error
      : { code: 'INTERNAL_ERROR', message: `Request failed (${response.status})` };
    throw new ProjectGitHttpError(response.status, apiError);
  }
  return value;
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('Invalid project Git response');
  return result.data;
}

async function waitForPoll(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(milliseconds),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createProjectGitClient(options: ProjectGitClientOptions = {}): ProjectGitClient {
  const fetchFn: Fetch = options.fetchFn ?? ((...args) => fetch(...args));
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  const get = async (url: string, signal?: AbortSignal): Promise<unknown> => responseJson(await fetchFn(url, { signal }));
  const mutate = async (
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    expectedProjectRevision: number | undefined,
    executeOptions: ProjectGitExecuteOptions,
  ): Promise<string> => {
    const response = await fetchFn(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': executeOptions.idempotencyKey,
        ...(expectedProjectRevision === undefined
          ? {}
          : { 'X-OD-Project-Revision': String(expectedProjectRevision) }),
      },
      body: JSON.stringify({
        ...body,
        ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }),
      }),
      signal: executeOptions.signal,
    });
    const accepted = await responseJson(response);
    if (response.status !== 202) {
      throw new Error(`Invalid project Git response: expected HTTP 202, received ${response.status}`);
    }
    return parse(ProjectGitAcceptedSchema, accepted).operationId;
  };

  const operationMatchesAction = (
    action: ProjectGitAction,
    operation: ProjectGitOperation,
  ): boolean => {
    if (action.kind !== 'retry') return operation.kind === action.kind;
    return ['enable', 'bind', 'open', 'restore', 'resolve', 'sync'].includes(operation.kind);
  };

  const client: ProjectGitClient = {
    async state(projectId, signal) {
      return parse(ProjectGitStateSchema, await get(projectPath(projectId), signal));
    },
    async operation(operationId, signal) {
      return parse(ProjectGitOperationSchema, await get(`/api/project-git-operations/${encodeURIComponent(operationId)}`, signal));
    },
    async execute(projectId, action, expectedProjectRevision, executeOptions) {
      let url: string;
      let method: 'POST' | 'PATCH' = 'POST';
      let body: Record<string, unknown>;
      switch (action.kind) {
        case 'enable_preview':
          url = projectPath(projectId!, '/enable'); body = { mode: 'preview' }; break;
        case 'enable':
          url = projectPath(projectId!, '/enable'); body = { mode: 'confirm', previewId: action.previewId }; break;
        case 'binding_preview':
          url = projectPath(projectId!, '/binding-preview'); body = { url: action.url, branch: action.branch }; break;
        case 'bind':
          url = projectPath(projectId!, '/bind'); body = { previewId: action.previewId, ...(action.confirmation ? { confirmation: action.confirmation } : {}) }; break;
        case 'unbind':
          url = projectPath(projectId!, '/unbind'); body = {}; break;
        case 'pause': case 'resume':
          url = projectPath(projectId!); method = 'PATCH'; body = { action: action.kind }; break;
        case 'sync':
          url = projectPath(projectId!, '/sync'); body = {}; break;
        case 'open':
          url = '/api/import/git'; body = { url: action.url, branch: action.branch }; break;
        case 'restore_preview':
          url = projectPath(projectId!, '/restore-preview'); body = { oid: action.oid }; break;
        case 'restore':
          url = projectPath(projectId!, '/restore'); body = { previewId: action.previewId }; break;
        case 'resolve':
          url = projectPath(projectId!, '/conflicts/resolve');
          body = { operationId: action.operationId, resolutions: action.resolutions, basis: action.basis };
          break;
        case 'retry':
          url = `/api/project-git-operations/${encodeURIComponent(action.operationId)}/retry`;
          body = { operationId: action.operationId };
          break;
      }
      const operationId = await mutate(
        url,
        method,
        body,
        action.kind === 'open' ? undefined : expectedProjectRevision,
        executeOptions,
      );
      for (;;) {
        const operation = await client.operation(operationId, executeOptions.signal);
        if (operation.id !== operationId) {
          throw new Error('Project Git operation id mismatch');
        }
        if (projectId !== null && operation.projectId !== projectId) {
          throw new Error('Project Git operation project mismatch');
        }
        if (!operationMatchesAction(action, operation)) {
          throw new Error('Project Git operation action mismatch');
        }
        if (operation.status !== 'queued' && operation.status !== 'running') return operation;
        await waitForPoll(sleep, pollIntervalMs, executeOptions.signal);
      }
    },
    async history(projectId, cursor, path, signal) {
      const query = new URLSearchParams();
      if (cursor) query.set('cursor', cursor);
      if (path) query.set('path', path);
      const suffix = query.size ? `?${query.toString()}` : '';
      return parse(ProjectGitHistoryPageSchema, await get(projectPath(projectId, `/history${suffix}`), signal));
    },
    async commit(projectId, oid, signal) {
      return parse(ProjectGitCommitSchema, await get(projectPath(projectId, `/commits/${encodeURIComponent(oid)}`), signal));
    },
    async file(projectId, oid, path, signal) {
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      return parse(ProjectGitFileResponseSchema, await get(projectPath(projectId, `/commits/${encodeURIComponent(oid)}/files/${encodedPath}`), signal));
    },
    async conversations(projectId, oid, signal) {
      const value = await get(projectPath(projectId, `/commits/${encodeURIComponent(oid)}/conversations`), signal);
      if (value === null) return null;
      return parsePortableSnapshot(value);
    },
    async conflicts(projectId, signal) {
      return parse(ProjectGitConflictsResponseSchema, await get(projectPath(projectId, '/conflicts'), signal));
    },
  };
  return client;
}

export interface ProjectGitHubOptions {
  subscribeEvents?: (
    projectId: string,
    listener: (event: ProjectEvent) => void,
    options?: { onReady?: () => void },
  ) => () => void;
}

export interface ProjectGitHub {
  subscribe(projectId: string, listener: (snapshot: ProjectGitStateSnapshot) => void): () => void;
  refresh(projectId: string, options?: { fresh?: boolean; generation?: number }): Promise<void>;
  store(projectId: string): ProjectGitStateStore;
  snapshot(projectId: string): ProjectGitStateSnapshot;
  capture(projectId: string): import('../state/project-git').ProjectMutationContext | undefined;
}

const EMPTY_PROJECT_GIT_SNAPSHOT: ProjectGitStateSnapshot = {
  state: null,
  loading: false,
  error: null,
  writeLocked: false,
  generation: 0,
};

interface HubEntry {
  listeners: Set<(snapshot: ProjectGitStateSnapshot) => void>;
  store: ProjectGitStateStore;
  stopEvents: (() => void) | null;
  inFlight: Promise<void> | null;
  readController: AbortController | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

export function createProjectGitHub(
  client: Pick<ProjectGitClient, 'state'>,
  options: ProjectGitHubOptions = {},
): ProjectGitHub {
  const entries = new Map<string, HubEntry>();

  const getEntry = (projectId: string): HubEntry => {
    const existing = entries.get(projectId);
    if (existing) return existing;
    const store = createProjectGitStateStore(null, {
      onRevisionAdvance: () => invalidateProjectBrowserEpoch(projectId),
    });
    const entry: HubEntry = {
      listeners: new Set(),
      store,
      stopEvents: null,
      inFlight: null,
      readController: null,
      cleanupTimer: null,
    };
    store.subscribe(() => {
      for (const listener of entry.listeners) listener(store.snapshot());
    });
    registerProjectMutationStore(projectId, store);
    entries.set(projectId, entry);
    return entry;
  };

  const refresh = async (
    projectId: string,
    options?: { fresh?: boolean; generation?: number },
  ): Promise<void> => {
    const entry = getEntry(projectId);
    if (
      options?.generation !== undefined
      && entry.store.snapshot().generation !== options.generation
    ) {
      throw new Error('Project Git read generation changed before refresh');
    }
    const token = entry.store.beginRead();
    if (options?.generation !== undefined && token.generation !== options.generation) {
      throw new Error('Project Git read generation changed before refresh');
    }
    if (options?.fresh) {
      entry.readController?.abort();
      entry.readController = null;
      entry.inFlight = null;
    }
    if (entry.inFlight) return entry.inFlight;
    const controller = new AbortController();
    entry.readController = controller;
    const pending = client.state(projectId, controller.signal)
      .then(state => {
        if (!controller.signal.aborted && entry.store.acceptRead(token, state) === 'stale') {
          throw new Error('Stale project Git state response');
        }
      })
      .catch(error => {
        if (controller.signal.aborted) throw error;
        const failure = error instanceof Error ? error : new Error(String(error));
        entry.store.failRead(token, failure);
        throw failure;
      })
      .finally(() => {
        if (entry.inFlight === pending) entry.inFlight = null;
        if (entry.readController === controller) entry.readController = null;
      });
    entry.inFlight = pending;
    return pending;
  };

  return {
    refresh,
    store: projectId => entries.get(projectId)?.store ?? createProjectGitStateStore(),
    snapshot: projectId => entries.get(projectId)?.store.snapshot() ?? EMPTY_PROJECT_GIT_SNAPSHOT,
    capture: projectId => entries.get(projectId)?.store.capture(),
    subscribe(projectId, listener) {
      const entry = getEntry(projectId);
      if (entry.cleanupTimer !== null) {
        clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = null;
      }
      entry.listeners.add(listener);
      listener(entry.store.snapshot());
      if (entry.listeners.size === 1 && entry.stopEvents === null) {
        void refresh(projectId).catch(() => {});
        const subscribeEvents = options.subscribeEvents ?? subscribeProjectEvents;
        if (subscribeEvents) {
          entry.stopEvents = subscribeEvents(projectId, event => {
            if (event.type === 'project-git-state') entry.store.accept(event.state, 'event');
          }, {
            onReady: () => {
              const pending = entry.inFlight;
              if (!pending) {
                void refresh(projectId).catch(() => {});
                return;
              }
              // The ready handshake closes the initial GET/SSE race. If that
              // GET is still running, a shared follow-up read must happen
              // after it settles rather than merely joining the older read.
              void pending.catch(() => {}).then(() => {
                if (entry.listeners.size > 0) return refresh(projectId);
              }).catch(() => {});
            },
          });
        }
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size !== 0 || entry.cleanupTimer !== null) return;
        entry.cleanupTimer = setTimeout(() => {
          entry.cleanupTimer = null;
          if (entries.get(projectId) !== entry || entry.listeners.size !== 0) return;
          entry.stopEvents?.();
          entry.stopEvents = null;
          entry.readController?.abort();
          entry.readController = null;
          entry.inFlight = null;
          entry.store.dispose();
          unregisterProjectMutationStore(projectId, entry.store);
          entries.delete(projectId);
        }, 0);
      };
    },
  };
}

const defaultProjectGitClient = createProjectGitClient();
const defaultProjectGitHub = createProjectGitHub(defaultProjectGitClient);
export function useProjectGit(projectId: string | null | undefined) {
  const subscribe = useCallback((listener: () => void) => {
    if (!projectId) return () => {};
    return defaultProjectGitHub.subscribe(projectId, listener);
  }, [projectId]);
  const getSnapshot = useCallback(() => projectId
    ? defaultProjectGitHub.snapshot(projectId)
    : EMPTY_PROJECT_GIT_SNAPSHOT, [projectId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => ({
    ...snapshot,
    refresh: (options?: { fresh?: boolean; generation?: number }) => projectId
      ? defaultProjectGitHub.refresh(projectId, options)
      : Promise.resolve(),
    capture: () => projectId ? defaultProjectGitHub.capture(projectId) : undefined,
    isCurrent: (context: import('../state/project-git').ProjectMutationContext) => projectId
      ? defaultProjectGitHub.store(projectId).isCurrent(context)
      : false,
    completeReconciliation: (generation: number) => projectId
      ? defaultProjectGitHub.store(projectId).completeReconciliation(
          { generation },
        )
      : false,
    execute: (action: ProjectGitAction, options?: Partial<ProjectGitExecuteOptions>) => {
      const context = projectId ? defaultProjectGitHub.store(projectId).capture() : undefined;
      const idempotencyKey = options?.idempotencyKey
        ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`);
      return defaultProjectGitClient.execute(
        action.kind === 'open' ? null : projectId ?? null,
        action,
        context?.expectedProjectRevision,
        {
          idempotencyKey,
          signal: context?.signal && options?.signal
            ? AbortSignal.any([context.signal, options.signal])
            : context?.signal ?? options?.signal,
        },
      );
    },
  }), [projectId, snapshot]);
}

/**
 * Keeps a bounded set of project authorities loaded while list-level Home
 * actions are mounted. The hub still owns connection sharing and last-user
 * disposal; this hook only mirrors snapshots for action readiness.
 */
export function useProjectGitAuthoritySet(projectIds: readonly string[]) {
  const projectIdsKey = JSON.stringify([...new Set(projectIds)].sort());
  const configuredProjectIds = useMemo<string[]>(() => JSON.parse(projectIdsKey), [projectIdsKey]);
  const [intentProjectIds, setIntentProjectIds] = useState<string[]>([]);
  useEffect(() => {
    const sources = new Map<string, string[]>();
    const onIntent = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: unknown; projectIds?: unknown }>).detail;
      if (typeof detail?.source !== 'string' || !Array.isArray(detail.projectIds)) return;
      const projectIds = detail.projectIds.filter((id): id is string => typeof id === 'string');
      if (projectIds.length === 0) sources.delete(detail.source);
      else sources.set(detail.source, projectIds);
      setIntentProjectIds([...new Set([...sources.values()].flat())].sort());
    };
    window.addEventListener('open-design:project-mutation-targets', onIntent);
    return () => window.removeEventListener('open-design:project-mutation-targets', onIntent);
  }, []);
  const stableProjectIds = useMemo(
    () => [...new Set([...configuredProjectIds, ...intentProjectIds])].sort(),
    [configuredProjectIds, intentProjectIds],
  );
  const [snapshots, setSnapshots] = useState<Record<string, ProjectGitStateSnapshot>>({});
  const reconcilingRef = useRef(new Set<string>());

  useEffect(() => {
    setSnapshots((current) => {
      const next: Record<string, ProjectGitStateSnapshot> = {};
      for (const projectId of stableProjectIds) {
        if (current[projectId]) next[projectId] = current[projectId];
      }
      return next;
    });
    const unsubscribes = stableProjectIds.map((projectId) => defaultProjectGitHub.subscribe(
      projectId,
      (snapshot) => {
        setSnapshots((current) => (
          current[projectId] === snapshot ? current : { ...current, [projectId]: snapshot }
        ));
        if (!snapshot.writeLocked) return;
        const reconciliationKey = `${projectId}:${snapshot.generation}`;
        if (reconcilingRef.current.has(reconciliationKey)) return;
        reconcilingRef.current.add(reconciliationKey);
        void defaultProjectGitHub.refresh(projectId, {
          fresh: true,
          generation: snapshot.generation,
        }).then(() => {
          const current = defaultProjectGitHub.snapshot(projectId);
          if (
            current.generation === snapshot.generation
            && current.state
            && !current.error
          ) {
            defaultProjectGitHub.store(projectId).completeReconciliation({
              generation: snapshot.generation,
            });
          }
        }).catch(() => {
          // Fail closed. A later authoritative event/read may retry.
        }).finally(() => {
          reconcilingRef.current.delete(reconciliationKey);
        });
      },
    ));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [stableProjectIds]);

  return useMemo(() => ({
    snapshots,
    isReady: (projectId: string) => {
      const snapshot = snapshots[projectId];
      return Boolean(snapshot?.state && !snapshot.loading && !snapshot.error && !snapshot.writeLocked);
    },
  }), [snapshots]);
}
