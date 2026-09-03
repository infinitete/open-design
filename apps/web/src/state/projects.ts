// Project / conversation / message / tab persistence — backed by the
// daemon's SQLite store. All writes round-trip through HTTP so projects
// stay coherent across multiple browser tabs and across restarts.
//
// Most helpers fail soft (returning null / [] on transport errors) so the UI
// can stay rendered when the daemon is briefly unreachable. Reads whose empty
// result changes behavior must preserve failure as a typed error instead.

import { coalescedGet, evictCoalescedGet } from '../lib/coalesced-get';
import { isDaemonProxyConnectionFailure } from '../runtime/daemon-proxy-failure';
import { BackoffController, type BackoffOptions } from '../lib/backoff';
import { API_ERROR_CODES, type ApiErrorCode } from '@open-design/contracts';
import type {
  AppliedPluginSnapshot,
  ApplyResult,
  ChatSessionMode,
  CreateConversationRequest,
  CreateDesignSystemProjectFromProjectResponse,
  CreateProjectExampleReference,
  DuplicateProjectResponse,
  CreatePluginShareProjectResponse,
  CreateTerminalRequest,
  ImportFolderRequest,
  ImportFolderResponse,
  InstalledPluginRecord,
  PluginDuplicateProjectResponse,
  PluginInstallOutcome,
  PluginShareAction,
  ProjectPluginFolderInstallRequest,
  ProjectScenarioTaskProfile,
  TerminalSession,
} from '@open-design/contracts';
import { randomUUID } from '../utils/uuid';
import type {
  ChatMessage,
  Conversation,
  OpenTabsState,
  Project,
  ProjectMetadata,
  ProjectTemplate,
} from '../types';
import { removeDesignBrowserProjectCache } from '../components/design-browser-storage';
import { boundedRequestErrorCode } from '../analytics/workspace';

export type { PluginInstallOutcome } from '@open-design/contracts';
export type { PluginShareAction } from '@open-design/contracts';

/** A refused project delete with the daemon's stable status/code preserved. */
export class ProjectDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ProjectDeleteError';
  }
}

export async function listProjects(options?: {
  throwOnError?: boolean;
}): Promise<Project[]> {
  try {
    return await coalescedGet('local-projects', async () => {
      const resp = await fetch('/api/projects');
      // Throw inside the coalesced run so a failed read is not cached — the next
      // caller/poll retries immediately (see coalesced-get.ts).
      if (!resp.ok) throw new Error(`projects ${resp.status}`);
      const json = (await resp.json()) as { projects: Project[] };
      return json.projects ?? [];
    });
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

export async function getProject(id: string): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    return json.project;
  } catch {
    return null;
  }
}

export type ProjectRouteBootstrapResult =
  | {
      kind: 'found';
      project: Project;
      resolvedDir: string | null;
    }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };

/**
 * Bootstrap a fresh project deep link. Reads the project row directly; the
 * daemon is the single local authority, so there is no separate scope
 * negotiation on a single-machine install.
 */
export async function bootstrapProjectRoute(
  projectId: string,
  options: {
    accountGeneration: number;
  },
): Promise<ProjectRouteBootstrapResult> {
  const key = [
    'project-route-bootstrap',
    options.accountGeneration,
    projectId,
  ].join(':');
  const result = await coalescedGet(key, async (): Promise<ProjectRouteBootstrapResult> => {
    try {
      const projectResponse = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}`,
        {
          cache: 'no-store',
        },
      );
      if (!projectResponse.ok) {
        if (projectResponse.status === 404) return { kind: 'not-found' };
        if (projectResponse.status === 403) return { kind: 'forbidden' };
        return { kind: 'unavailable' };
      }
      const projectBody = (await projectResponse.json()) as {
        project?: Project;
        resolvedDir?: unknown;
      };
      if (!projectBody.project || projectBody.project.id !== projectId) {
        return { kind: 'unavailable' };
      }
      return {
        kind: 'found',
        project: projectBody.project,
        resolvedDir:
          typeof projectBody.resolvedDir === 'string'
            ? projectBody.resolvedDir
            : typeof projectBody.project.metadata?.baseDir === 'string'
              ? projectBody.project.metadata.baseDir
              : null,
      };
    } catch {
      return { kind: 'unavailable' };
    }
  });
  if (result.kind === 'unavailable') evictCoalescedGet(key);
  return result;
}

export async function getProjectDetail(
  id: string,
  opts?: { ensureDir?: boolean },
): Promise<{ project: Project; resolvedDir: string | null } | null> {
  try {
    // `ensureDir` asks the daemon to materialize a managed project's folder
    // before resolving it, so referencing a brand-new (empty) project yields a
    // real on-disk directory instead of a path that fails existence checks.
    const query = opts?.ensureDir ? '?ensureDir=1' : '';
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(id)}${query}`,
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project; resolvedDir?: unknown };
    return {
      project: json.project,
      resolvedDir: typeof json.resolvedDir === 'string' ? json.resolvedDir : null,
    };
  } catch {
    return null;
  }
}

/**
 * Bounded-retry knobs for {@link createProject}. Production callers omit this
 * and get the default 1s→…-jittered backoff; tests inject a no-op `sleep` (and
 * usually a small `maxRetries`) so the schedule is instant and deterministic.
 */
export interface CreateProjectRetryOptions {
  /** Additional attempts after the first. Default 3 (so up to 4 requests). */
  maxRetries?: number;
  /** Backoff shape between retries. Defaults to 500ms→4s ×2 jittered. */
  backoff?: BackoffOptions;
  /** Test seam for the inter-retry wait. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CREATE_PROJECT_RETRY_BACKOFF: BackoffOptions = {
  initialMs: 500,
  maxMs: 4_000,
  factor: 2,
  jitter: true,
};

function defaultRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/** Parse a create/write error body into a UI message + the retryable flag. */
async function readWorkspaceWriteError(
  resp: Response,
  fallbackMessage: string,
): Promise<{
  message: string;
  retryable: boolean;
  code: ApiErrorCode | null;
  requestId: string | null;
}> {
  let message = fallbackMessage;
  let retryable = false;
  let code: ApiErrorCode | null = null;
  let requestId: string | null = null;
  try {
    const body = (await resp.json()) as { error?: unknown };
    if (body.error && typeof body.error === 'object') {
      const error = body.error as {
        code?: unknown;
        message?: unknown;
        requestId?: unknown;
        retryable?: unknown;
      };
      if (typeof error.message === 'string' && error.message.trim()) {
        message = error.message;
      }
      if (error.retryable === true) retryable = true;
      if (
        typeof error.code === 'string'
        && (API_ERROR_CODES as readonly string[]).includes(error.code)
      ) code = error.code as ApiErrorCode;
      if (typeof error.requestId === 'string' && error.requestId.trim()) {
        requestId = error.requestId;
      }
    }
  } catch {
    // Keep the generic fallback when the error body is absent or invalid.
  }
  return { message, retryable, code, requestId };
}

export class ProjectCreateError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: ApiErrorCode | null,
    readonly retryable: boolean,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ProjectCreateError';
  }
}

export async function createProject(
  input: {
    /** Optional caller-minted id used for an optimistic route handoff. */
    id?: string;
    name: string;
    projectLocationId?: string;
    skillId: string | null;
    designSystemId: string | null;
    pendingPrompt?: string;
    metadata?: ProjectMetadata;
    conversationMode?: ChatSessionMode;
    // Plan §3.A1 / spec §11.5 — POST /api/projects accepts a pluginId
    // (or pre-applied snapshot id) to resolve and pin a plugin to the new
    // project. Used by the PluginLoopHome flow on Home.
    pluginId?: string;
    pluginSource?: string;
    appliedPluginSnapshotId?: string;
    pluginInputs?: Record<string, unknown>;
    automaticStrategyTaskProfile?: ProjectScenarioTaskProfile;
    /**
     * Identity of the official example card the user picked under an automatic
     * OD Next route. A claim, not content: the daemon re-resolves it through
     * the local catalogue. Never accompanies `pluginId`/`appliedPluginSnapshotId`.
     */
    exampleReference?: CreateProjectExampleReference;
  },
  retryOptions: CreateProjectRetryOptions = {},
): Promise<{ project: Project; conversationId: string; appliedPluginSnapshotId?: string }> {
  const maxRetries = retryOptions.maxRetries ?? 3;
  const sleep = retryOptions.sleep ?? defaultRetrySleep;
  const backoff = new BackoffController(
    retryOptions.backoff ?? DEFAULT_CREATE_PROJECT_RETRY_BACKOFF,
  );
  try {
    // `randomUUID` falls back to `crypto.getRandomValues` / `Math.random`
    // when `crypto.randomUUID` is unavailable. OpenDesign served over
    // plain HTTP on a LAN IP (Docker / unRAID self-hosting) is a
    // non-secure context, where `crypto.randomUUID` is undefined and
    // calling it directly throws — the surrounding try/catch then turns
    // the Create button into a silent no-op (issue #849).
    //
    // The id is minted ONCE and reused across retries: a retryable 503 fails
    // vela's authority check before any row is inserted, so replaying the same
    // client-provided id is idempotent, never a duplicate project.
    const id = input.id ?? randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, ...input }),
      });
      if (resp.ok) {
        const created = (await resp.json()) as {
          project: Project;
          conversationId: string;
          appliedPluginSnapshotId?: string;
        };
        return created;
      }
      if (await isDaemonProxyConnectionFailure(resp)) {
        throw new ProjectCreateError(
          'Could not reach the local OpenDesign service',
          null,
          null,
          true,
          null,
        );
      }
      const { message, retryable, code, requestId } = await readWorkspaceWriteError(
        resp,
        'Could not create project',
      );
      if (resp.status === 503 && retryable && attempt < maxRetries) {
        await sleep(backoff.nextDelay());
        continue;
      }
      throw new ProjectCreateError(message, resp.status, code, retryable, requestId);
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not create project');
  }
}

export async function createDesignSystemProjectFromProject(
  projectId: string,
  input: { name?: string; pendingPrompt?: string } = {},
): Promise<CreateDesignSystemProjectFromProjectResponse> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/design-system-copy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      let message = 'Could not create design system';
      try {
        const body = await resp.json() as { error?: unknown };
        if (
          body.error &&
          typeof body.error === 'object' &&
          'message' in body.error &&
          typeof body.error.message === 'string' &&
          body.error.message.trim()
        ) {
          message = body.error.message;
        } else if (typeof body.error === 'string' && body.error.trim()) {
          message = body.error;
        }
      } catch {
        // Keep the generic fallback when the error body is absent or invalid.
      }
      throw new Error(message);
    }
    return (await resp.json()) as CreateDesignSystemProjectFromProjectResponse;
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not create design system');
  }
}

export async function duplicateProject(
  projectId: string,
  input: { name?: string } = {},
): Promise<DuplicateProjectResponse> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      let message = 'Could not duplicate project';
      try {
        const body = await resp.json() as { error?: unknown };
        if (
          body.error &&
          typeof body.error === 'object' &&
          'message' in body.error &&
          typeof body.error.message === 'string' &&
          body.error.message.trim()
        ) {
          message = body.error.message;
        } else if (typeof body.error === 'string' && body.error.trim()) {
          message = body.error;
        }
      } catch {
        // Keep the generic fallback when the error body is absent or invalid.
      }
      throw new Error(message);
    }
    return (await resp.json()) as DuplicateProjectResponse;
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not duplicate project');
  }
}

export async function pickLocalFolderPath(): Promise<string | null> {
  const resp = await fetch('/api/dialog/open-folder', {
    method: 'POST',
  });
  if (!resp.ok) {
    let message = 'Could not open folder picker';
    try {
      const body = await resp.json() as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) {
        message = body.error;
      } else if (
        body.error
        && typeof body.error === 'object'
        && 'message' in body.error
        && typeof body.error.message === 'string'
        && body.error.message.trim()
      ) {
        message = body.error.message;
      }
    } catch { /* use default message */ }
    throw new Error(message);
  }

  const body = await resp.json() as { path?: unknown };
  if (body.path == null) return null;
  if (typeof body.path !== 'string') {
    throw new Error('Could not open folder picker');
  }
  return body.path.length > 0 ? body.path : null;
}

export async function importFolderProject(
  input: ImportFolderRequest,
): Promise<ImportFolderResponse> {
  const resp = await fetch('/api/import/folder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    let message = 'Failed to import folder';
    try {
      const body = await resp.json();
      if (body?.error?.message) message = body.error.message;
    } catch { /* use default message */ }
    throw new Error(message);
  }
  return (await resp.json()) as ImportFolderResponse;
}

export async function importClaudeDesignZip(
  file: File,
): Promise<{ project: Project; conversationId: string; entryFile: string }> {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch('/api/import/claude-design', {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null);
    const message =
      payload != null &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Import failed (${resp.status})`;
    throw new Error(message);
  }
  return (await resp.json()) as {
    project: Project;
    conversationId: string;
    entryFile: string;
  };
}

// ---------- templates ----------

/**
 * Bumped by every successful local template mutation, and part of the read key.
 *
 * `ttl = 0` stops a settled result from being reused; it does not stop a new
 * caller from JOINING a request that is still in flight — and the caller that
 * follows a mutation is exactly the one that must not join. `handleDeleteTemplate`
 * awaits `deleteTemplate` and then refreshes, and the daemon answers
 * `/api/templates` from a snapshot taken when the request arrived, so joining a
 * pre-delete GET would leave the deleted template on screen until something
 * else happened to refetch.
 */
let templateListMutationGeneration = 0;

function noteTemplateListMutation(): void {
  templateListMutationGeneration += 1;
}

export async function listTemplates(): Promise<ProjectTemplate[]> {
  // Same launch-burst shape as the design-system catalog: App's one-shot
  // bootstrap and the home-route effect both want this list on the same pass,
  // and both must keep their own read — one settles the entry view, the other
  // exists to pick up a template saved inside a project. Neither can drop its
  // read; on the wire they are one request, and on a cold Home load they land
  // together and take two of the browser's ~6 connection slots.
  //
  // SINGLE-FLIGHT ONLY (ttl 0). The home-route effect and the save handler's
  // own refresh both exist to observe a change that just happened, so a shared
  // settled answer would hand them the list they were fired to replace.
  //
  // One global key, deliberately not partitioned by Workspace identity: the
  // daemon handler ignores the request entirely (`(_req, res) =>`) and answers
  // from its local store, so this response cannot vary by caller identity.
  // Throwing inside keeps a transient failure out of the shared entry, so the
  // next caller retries instead of joining a dead read.
  try {
    return await coalescedGet(`project-templates:${templateListMutationGeneration}`, async () => {
      const resp = await fetch('/api/templates');
      if (!resp.ok) throw new Error(`templates ${resp.status}`);
      const json = (await resp.json()) as { templates: ProjectTemplate[] };
      return json.templates ?? [];
    }, 0);
  } catch {
    return [];
  }
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function saveTemplate(input: {
  name: string;
  description?: string;
  sourceProjectId: string;
}): Promise<ProjectTemplate | null> {
  try {
    const resp = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    noteTemplateListMutation();
    const json = (await resp.json()) as { template: ProjectTemplate };
    return json.template;
  } catch {
    return null;
  }
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (resp.ok) noteTemplateListMutation();
    return resp.ok;
  } catch {
    return false;
  }
}

type ProjectPatch = Omit<Partial<Project>, 'pendingPrompt' | 'customInstructions'> & {
  pendingPrompt?: Project['pendingPrompt'] | null;
  customInstructions?: string | null;
};

export async function patchProject(
  id: string,
  patch: ProjectPatch,
): Promise<Project | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { project: Project };
    // Any successful project patch can change fields rendered by the project
    // lists (name, metadata, updatedAt, bindings displayed on cards). A list
    // read started immediately after this write must not reuse the settled
    // pre-write value from coalescedGet's one-second burst window.
    evictCoalescedGet('local-projects');
    return json.project;
  } catch {
    return null;
  }
}

/**
 * Delete a project. The local daemon is the single authority, so the DELETE
 * goes straight to the project row.
 */
export async function deleteProject(id: string): Promise<true> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      let message = `project delete failed with status ${resp.status}`;
      let code: string | undefined;
      try {
        const payload = await resp.json() as {
          error?: string | { code?: unknown; message?: unknown };
          code?: unknown;
          message?: unknown;
        };
        const envelope = payload.error && typeof payload.error === 'object'
          ? payload.error
          : null;
        const rawCode = envelope?.code ?? payload.code;
        const rawMessage = envelope?.message
          ?? payload.message
          ?? (typeof payload.error === 'string' ? payload.error : undefined);
        code = boundedRequestErrorCode(rawCode);
        if (typeof rawMessage === 'string' && rawMessage.trim()) {
          message = rawMessage;
        }
      } catch {
        // Keep the stable HTTP fallback when a legacy daemon returns no JSON.
      }
      // DELETE is idempotent for the web client. A second tab, a stale project
      // list, or a retry whose first response was lost can legitimately reach
      // the daemon after the project row is already gone. Only accept the
      // daemon's structured PROJECT_NOT_FOUND response here — a generic 404
      // can still mean the route itself is unavailable on an incompatible
      // daemon and must remain visible as a failure.
      if (resp.status === 404 && code === 'PROJECT_NOT_FOUND') {
        removeCachedTabs(id);
        removeDesignBrowserProjectCache(id);
        return true;
      }
      throw new ProjectDeleteError(message, resp.status, code);
    }
    // Drop per-project browser caches once the project is gone server-side so
    // they do not accumulate in localStorage for the lifetime of the profile.
    removeCachedTabs(id);
    removeDesignBrowserProjectCache(id);
    return true;
  } catch (error) {
    if (error instanceof ProjectDeleteError) throw error;
    throw new ProjectDeleteError(
      error instanceof Error ? error.message : 'Project delete request failed.',
      undefined,
      'network_error',
    );
  }
}

// ---------- conversations ----------

export class ProjectConversationsHttpError extends Error {
  constructor(
    readonly status: number,
    message = `conversations ${status}`,
  ) {
    super(message);
    this.name = 'ProjectConversationsHttpError';
  }
}

type CreateConversationOptions = {
  seedFromConversationId?: string | null;
  forkAfterMessageId?: string | null;
  sessionMode?: ChatSessionMode;
  // The one in-memory fork point to retry with when it never reached the DB.
  forkFallbackMessage?: ChatMessage;
  forkFallbackPredecessorMessageId?: string | null;
  throwOnError?: boolean;
};

export async function listConversations(
  projectId: string,
  options?: {
    throwOnError?: boolean;
  },
): Promise<Conversation[]> {
  const readKey = `project-conversations:${projectId}`;
  try {
    // Concurrent consumers of one project's conversation list share a single
    // request per burst (Batch A §4.3); conversation writes below evict.
    const json = await coalescedGet(
      readKey,
      async () => {
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/conversations`,
        );
        if (!resp.ok) throw new ProjectConversationsHttpError(resp.status);
        return (await resp.json()) as { conversations: Conversation[] };
      },
    );
    return json.conversations ?? [];
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

/** Thin invalidation for the shared conversations read after a write. */
function evictConversationsRead(projectId: string): void {
  evictCoalescedGet(`project-conversations:${projectId}`);
}

export async function createConversation(
  projectId: string,
  title?: string,
  // Side Chat: seed the new conversation with another conversation's context
  // by copying its messages. `forkAfterMessageId` narrows that copy to a
  // specific point in the source history.
  opts?: CreateConversationOptions,
): Promise<Conversation | null> {
  try {
    const body: CreateConversationRequest = { title };
    if (opts?.sessionMode) {
      body.sessionMode = opts.sessionMode;
    }
    if (opts?.seedFromConversationId) {
      body.seedFromConversationId = opts.seedFromConversationId;
    }
    if (opts?.forkAfterMessageId) {
      body.forkAfterMessageId = opts.forkAfterMessageId;
    }
    let resp = await postConversation(projectId, body);
    if (!resp.ok) {
      const message = await readErrorMessage(resp);
      const fallbackMessage = compactForkFallbackMessage(opts);
      if (resp.status === 404 && message === 'fork message not found' && fallbackMessage) {
        resp = await postConversation(
          projectId,
          {
            ...body,
            forkFallbackMessage: fallbackMessage,
            forkFallbackPredecessorMessageId: opts?.forkFallbackPredecessorMessageId,
          },
        );
      } else {
        throw new ProjectConversationsHttpError(resp.status, message);
      }
    }
    if (!resp.ok) {
      throw new ProjectConversationsHttpError(resp.status, await readErrorMessage(resp));
    }
    const json = (await resp.json()) as { conversation: Conversation };
    evictConversationsRead(projectId);
    return json.conversation;
  } catch (error) {
    if (opts?.throwOnError) throw error;
    return null;
  }
}

function postConversation(
  projectId: string,
  body: CreateConversationRequest,
): Promise<Response> {
  return fetch(
    `/api/projects/${encodeURIComponent(projectId)}/conversations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

function compactForkFallbackMessage(
  opts: CreateConversationOptions | undefined,
): ChatMessage | null {
  const forkMessage = opts?.forkFallbackMessage;
  if (!forkMessage || opts?.forkFallbackPredecessorMessageId === undefined) return null;
  return {
    id: forkMessage.id,
    role: forkMessage.role,
    content: forkMessage.content,
  };
}

export async function patchConversation(
  projectId: string,
  conversationId: string,
  patch: Partial<Conversation>,
): Promise<Conversation | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { conversation: Conversation };
    evictConversationsRead(projectId);
    return json.conversation;
  } catch {
    return null;
  }
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE' },
    );
    if (resp.ok) evictConversationsRead(projectId);
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- messages ----------

/**
 * A failed authoritative transcript read. Callers must not reinterpret this
 * as an empty conversation: Home auto-send and recovery flows make decisions
 * from that distinction.
 */
export class ProjectMessageListError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProjectMessageListError';
  }
}

async function readProjectMessageListError(resp: Response): Promise<{
  message: string;
  code: string | null;
  retryable: boolean;
}> {
  let message = `Could not load messages for this conversation (${resp.status}).`;
  let code: string | null = null;
  let retryable = false;
  try {
    const payload = await resp.json() as {
      error?: string | {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
      };
    };
    if (payload.error && typeof payload.error === 'object') {
      const rawCode = payload.error.code;
      code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode)
        ? rawCode
        : null;
      if (typeof payload.error.message === 'string' && payload.error.message.trim()) {
        message = payload.error.message;
      }
      retryable = payload.error.retryable === true;
    } else if (typeof payload.error === 'string' && payload.error.trim()) {
      message = payload.error;
    }
  } catch {
    // Keep the stable HTTP fallback for legacy/non-JSON responses.
  }
  return { message, code, retryable };
}

export async function listMessages(
  projectId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    if (!resp.ok) {
      const failure = await readProjectMessageListError(resp);
      throw new ProjectMessageListError(
        failure.message,
        resp.status,
        failure.code,
        failure.retryable,
      );
    }
    const json = (await resp.json()) as { messages: ChatMessage[] };
    return json.messages ?? [];
  } catch (error) {
    if (error instanceof ProjectMessageListError) throw error;
    throw new ProjectMessageListError(
      error instanceof Error ? error.message : 'Could not load messages for this conversation.',
      null,
      null,
      true,
    );
  }
}

export interface SaveMessageOptions {
  telemetryFinalized?: boolean;
  /** Claim the row once: the daemon keeps an existing row and returns it. */
  createOnly?: boolean;
  // Set during page-unload paths (pagehide / visibilitychange→hidden) so
  // the in-flight PUT survives even if the document tears down before the
  // response arrives. Without keepalive the browser cancels the fetch
  // and the daemon never sees the final buffered text chunk.
  keepalive?: boolean;
}

export async function saveMessage(
  projectId: string,
  conversationId: string,
  message: ChatMessage,
  options: SaveMessageOptions = {},
): Promise<ChatMessage | null> {
  try {
    const body = {
      ...message,
      ...(options.telemetryFinalized ? { telemetryFinalized: true } : {}),
      ...(options.createOnly ? { createOnly: true } : {}),
    };
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(options.keepalive ? { keepalive: true } : {}),
      },
    );
    if (!response.ok) return null;
    // The stored row, which a create-only claim may have kept from an earlier
    // writer. Callers that care compare it against what they sent.
    const saved = (await response.json()) as { message?: ChatMessage };
    return saved.message ?? null;
  } catch {
    // best-effort persistence — UI keeps the message in-memory either way
    return null;
  }
}

// ---------- terminals ----------
//
// Interactive PTY sessions rooted at the project working directory. The daemon
// streams output down over SSE (`GET .../stream`) and accepts keystrokes /
// resizes back up over plain POST — see `packages/contracts/src/api/terminals.ts`.
// `<TerminalViewer>` drives `terminalStreamUrl` directly via EventSource; these
// helpers cover the request/response endpoints.

export async function createTerminal(
  projectId: string,
  init?: CreateTerminalRequest,
): Promise<TerminalSession | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(init ?? {}),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { terminal: TerminalSession };
    return json.terminal ?? null;
  } catch {
    return null;
  }
}

/** SSE endpoint a `<TerminalViewer>` subscribes to for raw PTY output. */
export function terminalStreamUrl(
  projectId: string,
  terminalId: string,
): string {
  return `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/stream`;
}

export async function sendTerminalStdin(
  projectId: string,
  terminalId: string,
  data: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/stdin`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function resizeTerminal(
  projectId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/resize`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cols, rows }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function killTerminal(
  projectId: string,
  terminalId: string,
  // Page-unload paths set keepalive so the kill survives document teardown,
  // mirroring `saveMessage`. Without it the browser cancels the fetch and the
  // PTY leaks until the daemon GCs it.
  options: {
    keepalive?: boolean;
  } = {},
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}/kill`,
      {
        method: 'POST',
        ...(options.keepalive ? { keepalive: true } : {}),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------- tabs ----------

const PROJECT_TABS_CACHE_PREFIX = 'open-design:project-tabs:v1:';

function tabsCacheKey(projectId: string): string {
  return `${PROJECT_TABS_CACHE_PREFIX}${projectId}`;
}

function normalizeTabsState(value: unknown): OpenTabsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs) || !record.tabs.every((tab) => typeof tab === 'string')) {
    return null;
  }
  const browserTabs = Array.isArray(record.browserTabs)
    ? record.browserTabs.filter(
        (tab) =>
          Boolean(tab) &&
          typeof tab === 'object' &&
          !Array.isArray(tab) &&
          typeof (tab as Record<string, unknown>).id === 'string' &&
          typeof (tab as Record<string, unknown>).label === 'string',
      ) as OpenTabsState['browserTabs']
    : undefined;
  const state: OpenTabsState = {
    tabs: record.tabs.slice() as string[],
    active: typeof record.active === 'string' ? record.active : null,
  };
  if (browserTabs && browserTabs.length > 0) state.browserTabs = browserTabs;
  if (record.hasSavedState === true) state.hasSavedState = true;
  if (typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)) {
    state.updatedAt = record.updatedAt;
  }
  return state;
}

function readCachedTabs(projectId: string): OpenTabsState | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeTabsState(JSON.parse(
      window.localStorage.getItem(tabsCacheKey(projectId)) ?? 'null',
    ));
  } catch {
    return null;
  }
}

function removeCachedTabs(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(tabsCacheKey(projectId));
  } catch {
    // Ignore private-mode/quota errors; the cache entry is best-effort.
  }
}

function writeCachedTabs(
  projectId: string,
  state: OpenTabsState,
): OpenTabsState {
  const next: OpenTabsState = {
    ...state,
    updatedAt: Date.now(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        tabsCacheKey(projectId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore quota/private-mode failures. The daemon save below is canonical.
    }
  }
  return next;
}

function newestTabsState(
  first: OpenTabsState | null,
  second: OpenTabsState | null,
): OpenTabsState {
  if (!first && !second) return { tabs: [], active: null };
  if (!first) return second!;
  if (!second) return first;
  return (second.updatedAt ?? 0) > (first.updatedAt ?? 0) ? second : first;
}

async function persistTabsToDaemon(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  const requestKey = `project-tabs:${projectId}`;
  // Thin invalidation: a write makes any burst-shared read stale.
  evictCoalescedGet(requestKey);
  await fetch(`/api/projects/${encodeURIComponent(projectId)}/tabs`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(state),
    keepalive: true,
  });
}

export async function loadTabs(
  projectId: string,
  options: {
    reconcileNewerCacheToDaemon?: boolean;
  } = {},
): Promise<OpenTabsState> {
  const cached = readCachedTabs(projectId);
  const requestKey = `project-tabs:${projectId}`;
  try {
    // Concurrent mounts share one daemon read per burst (Batch A §4.3); the
    // per-caller cache reconciliation below still runs for every caller.
    const saved = await coalescedGet(requestKey, async () => {
      const resp = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/tabs`,
      );
      if (!resp.ok) throw new Error(`tabs ${resp.status}`);
      return normalizeTabsState(await resp.json());
    });
    const latest = newestTabsState(cached, saved);
    if (
      options.reconcileNewerCacheToDaemon !== false
      && cached
      && latest === cached
      && (cached.updatedAt ?? 0) > (saved?.updatedAt ?? 0)
    ) {
      void persistTabsToDaemon(projectId, cached).catch(() => {});
    }
    return latest;
  } catch {
    return cached ?? { tabs: [], active: null };
  }
}

export async function saveTabs(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  const next = writeCachedTabs(projectId, state);
  try {
    await persistTabsToDaemon(projectId, next);
  } catch {
    // best-effort
  }
}

/**
 * Write tab state to the local cache ONLY (synchronous localStorage), returning
 * the `updatedAt`-stamped state. Callers that debounce the canonical daemon
 * write use this so the cache is always current — `loadTabs` reconciles cache
 * vs daemon by `updatedAt`, so a debounced (or dropped) daemon PUT never loses
 * data: a newer cache is re-pushed on next load.
 */
export function cacheTabsLocally(
  projectId: string,
  state: OpenTabsState,
): OpenTabsState {
  return writeCachedTabs(projectId, state);
}

/** Persist already-stamped tab state to the daemon (the debounced write). */
export async function persistTabsToDaemonNow(
  projectId: string,
  state: OpenTabsState,
): Promise<void> {
  try {
    await persistTabsToDaemon(projectId, state);
  } catch {
    // best-effort; the local cache (written via cacheTabsLocally) is canonical
    // and will re-push on the next loadTabs reconciliation.
  }
}

// ---------- plugins ----------
// Plan §3.C1 — plugin discovery + apply.
//
// applyPlugin() is the canonical entry point for both the inline rail
// (NewProjectPanel + ChatComposer) and the marketplace detail page. A caller
// with a catalogue record supplies its exact local source; id-only callers
// retain the Workspace-scoped compatibility route. Both return everything the
// composer needs:
//   - query (pre-filled brief)
//   - contextItems (chip strip)
//   - inputs (form fields)
//   - appliedPlugin (snapshot id; sent back on POST /api/runs to pin
//     the prompt block to the frozen view)

export interface ListPluginsOptions {
  includeHidden?: boolean;
}

interface CachedVisiblePlugins {
  plugins: InstalledPluginRecord[];
  cachedAt: number;
}

// Warm snapshot that avoids Home's 1-2s remount stall.
const cachedVisiblePlugins = new Map<string, CachedVisiblePlugins>();
// Every request start and explicit invalidation advances the cache generation.
// Deleting the settled value alone is insufficient: an older `listPlugins()`
// can resolve after a replacement read and otherwise put its stale snapshot
// back into this cache. Latest-started-wins also covers ordinary request races
// that do not pass through invalidation.
const pluginCatalogCacheGenerations = new Map<string, number>();
const PLUGINS_CACHE_TTL_MS = 10_000;
const MAX_PLUGIN_CATALOG_CACHE_ENTRIES = 24;

export function pluginCatalogCacheKey(): string {
  return 'plugin-catalog';
}

function cacheVisiblePlugins(
  key: string,
  plugins: InstalledPluginRecord[],
): void {
  cachedVisiblePlugins.delete(key);
  cachedVisiblePlugins.set(key, { plugins, cachedAt: Date.now() });
  while (cachedVisiblePlugins.size > MAX_PLUGIN_CATALOG_CACHE_ENTRIES) {
    const oldest = cachedVisiblePlugins.keys().next().value as string | undefined;
    if (!oldest) break;
    cachedVisiblePlugins.delete(oldest);
  }
}

export async function listPlugins(
  options: ListPluginsOptions = {},
): Promise<InstalledPluginRecord[]> {
  const cacheKey = pluginCatalogCacheKey();
  const requestGeneration = (pluginCatalogCacheGenerations.get(cacheKey) ?? 0) + 1;
  pluginCatalogCacheGenerations.set(cacheKey, requestGeneration);
  try {
    const resp = await fetch('/api/plugins');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { plugins?: InstalledPluginRecord[] };
    const plugins = json.plugins ?? [];
    const visible = plugins.filter(isVisiblePlugin);
    if (pluginCatalogCacheGenerations.get(cacheKey) === requestGeneration) {
      cacheVisiblePlugins(cacheKey, visible);
    }
    return options.includeHidden ? plugins : visible;
  } catch {
    return [];
  }
}

// Return the cached visible plugins without hitting the network when the cache
// is still within its TTL; otherwise fetch (which refreshes the cache). Used by
// surfaces that mount often (Home) where a slightly stale list is fine and the
// heavy `/api/plugins` round trip per mount is not.
export async function listPluginsFresh(
  options: ListPluginsOptions = {},
): Promise<InstalledPluginRecord[]> {
  const cached = cachedVisiblePlugins.get(pluginCatalogCacheKey());
  if (cached && Date.now() - cached.cachedAt < PLUGINS_CACHE_TTL_MS) {
    return cached.plugins;
  }
  return listPlugins(options);
}

/**
 * Return the last successful unscoped plugin catalog regardless of its refresh
 * age. Frequently remounted surfaces use this snapshot for their first render
 * while `listPluginsFresh()` revalidates an expired catalog in the background.
 * A null result is the only state that still requires the cold-start loading
 * guard: once a catalog has loaded, network latency must not make known plugin
 * actions temporarily unactionable again.
 */
export function readCachedVisiblePlugins(): InstalledPluginRecord[] | null {
  return cachedVisiblePlugins.get(pluginCatalogCacheKey())?.plugins ?? null;
}

/**
 * Evict the warm plugin catalog after a mutation or thin invalidation.
 */
export function invalidatePluginCatalogCache(): void {
  const cacheKey = pluginCatalogCacheKey();
  cachedVisiblePlugins.delete(cacheKey);
  pluginCatalogCacheGenerations.set(
    cacheKey,
    (pluginCatalogCacheGenerations.get(cacheKey) ?? 0) + 1,
  );
}

// Test-only: drop the warm visible-plugins cache so each case starts cold. The
// module-level cache intentionally survives Home remounts in the app, but that
// same persistence leaks across test cases in a worker (a case's mocked
// `/api/plugins` payload would satisfy the next case via `listPluginsFresh`).
// The web vitest setup calls this in a global `afterEach`.
export function resetPluginsCache(): void {
  cachedVisiblePlugins.clear();
  pluginCatalogCacheGenerations.clear();
}

export function isVisiblePlugin(plugin: InstalledPluginRecord): boolean {
  const od = (plugin.manifest?.od ?? {}) as Record<string, unknown>;
  return od.hidden !== true;
}

export async function duplicatePluginAsProject(
  pluginId: string,
  input: { name?: string } = {},
): Promise<PluginDuplicateProjectResponse> {
  const resp = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/duplicate-project`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  );
  if (!resp.ok) {
    throw new Error(await readErrorMessage(resp));
  }
  const json = (await resp.json()) as PluginDuplicateProjectResponse;
  if (!json?.ok || !json.projectId) {
    throw new Error('Could not duplicate this template.');
  }
  return json;
}

interface PluginInstallEvent {
  kind?: 'progress' | 'success' | 'error';
  phase?: string;
  message?: string;
  code?: string;
  plugin?: InstalledPluginRecord;
  warnings?: string[];
}

export async function installPluginSource(
  source: string,
): Promise<PluginInstallOutcome> {
  const log: string[] = [];
  try {
    const resp = await fetch('/api/plugins/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source }),
    });
    if (!resp.ok) {
      const message = await readErrorMessage(resp);
      return { ok: false, warnings: [], message, status: resp.status, log };
    }
    if (!resp.body) {
      return {
        ok: false,
        warnings: [],
        message: 'Install stream did not start.',
        log,
      };
    }

    let success: InstalledPluginRecord | undefined;
    let warnings: string[] = [];
    let errorMessage: string | undefined;
    let errorCode: string | undefined;
    for await (const ev of readServerSentEvents(resp.body)) {
      if (ev.message) log.push(ev.message);
      if (ev.warnings) warnings = ev.warnings;
      if (ev.kind === 'success') success = ev.plugin;
      if (ev.kind === 'error') {
        errorMessage = ev.message ?? 'Install failed.';
        errorCode = boundedRequestErrorCode(ev.code);
      }
    }
    return {
      ok: Boolean(success) && !errorMessage,
      plugin: success,
      warnings,
      message: errorMessage ?? (success ? `Installed ${success.title}.` : 'Install finished.'),
      ...(errorCode ? { errorCode } : {}),
      log,
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      errorCode: 'network_error',
      log,
    };
  }
}

export async function uploadPluginZip(file: File): Promise<PluginInstallOutcome> {
  const form = new FormData();
  form.append('file', file);
  return postPluginUpload('/api/plugins/upload-zip', form);
}

export async function uploadPluginFolder(files: File[]): Promise<PluginInstallOutcome> {
  const form = new FormData();
  for (const file of files) {
    const relativePath = getUploadRelativePath(file);
    form.append('files', file, file.name);
    form.append('paths', relativePath);
  }
  return postPluginUpload('/api/plugins/upload-folder', form);
}

export async function installGeneratedPluginFolder(
  projectId: string,
  relativePath: string,
): Promise<PluginInstallOutcome> {
  try {
    const request: ProjectPluginFolderInstallRequest = { path: relativePath };
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/plugins/install-folder`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
    );
    const outcome = await readPluginInstallOutcome(resp);
    if (outcome.ok) {
      // The event refreshes mounted consumers, but it is not durable: Home may
      // be unmounted while a project installs its generated plugin. Evict the
      // warm catalog first so a later mount cannot reuse the pre-install
      // catalog for the full TTL.
      invalidatePluginCatalogCache();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('open-design:plugins-changed'));
      }
    }
    return outcome;
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log: [],
    };
  }
}

export interface PluginShareOutcome {
  ok: boolean;
  message: string;
  url?: string;
  log?: string[];
  code?: string;
}

export interface PluginShareTaskStart {
  taskId: string;
  action: 'publish-github' | 'contribute-open-design';
  path: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt: number;
}

export interface PluginShareTaskResult {
  message: string;
  url?: string;
  log?: string[];
}

export interface PluginShareTaskError {
  message: string;
  code?: string;
  log?: string[];
}

export interface PluginShareTaskSnapshot {
  taskId: string;
  action: 'publish-github' | 'contribute-open-design';
  path: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number | null;
  progress: string[];
  nextSince: number;
  result?: PluginShareTaskResult;
  error?: PluginShareTaskError;
}

export async function publishGeneratedPluginToGitHub(
  projectId: string,
  relativePath: string,
): Promise<PluginShareOutcome> {
  return postGeneratedPluginShareAction(projectId, relativePath, 'publish-github');
}

export async function contributeGeneratedPluginToOpenDesign(
  projectId: string,
  relativePath: string,
): Promise<PluginShareOutcome> {
  return postGeneratedPluginShareAction(projectId, relativePath, 'contribute-open-design');
}

export async function startGeneratedPluginShareTask(
  projectId: string,
  relativePath: string,
  action: 'publish-github' | 'contribute-open-design',
): Promise<PluginShareTaskStart> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/plugins/share-tasks`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: relativePath, action }),
    },
  );
  const body = await resp.json().catch(() => null) as Partial<PluginShareTaskStart> & {
    error?: string | { message?: string };
    message?: string;
  } | null;
  if (!resp.ok || !body?.taskId || !body?.action || !body?.path || !body?.status || !body?.startedAt) {
    const errorMessage =
      body?.message
      ?? (typeof body?.error === 'string' ? body.error : body?.error?.message)
      ?? 'Could not start plugin share task.';
    throw new Error(errorMessage);
  }
  return {
    taskId: body.taskId,
    action: body.action,
    path: body.path,
    status: body.status,
    startedAt: body.startedAt,
  };
}

export async function waitGeneratedPluginShareTask(
  taskId: string,
  since: number,
  timeoutMs = 25_000,
): Promise<PluginShareTaskSnapshot> {
  const resp = await fetch(`/api/plugins/share-tasks/${encodeURIComponent(taskId)}/wait`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ since, timeoutMs }),
  });
  const body = await resp.json().catch(() => null) as PluginShareTaskSnapshot & {
    error?: string | { message?: string };
    message?: string;
  } | null;
  if (!resp.ok || !body?.taskId) {
    const errorMessage =
      body?.message
      ?? (typeof body?.error === 'string' ? body.error : body?.error?.message)
      ?? 'Could not fetch plugin share task.';
    throw new Error(errorMessage);
  }
  return body;
}

export type PluginShareProjectOutcome =
  | (CreatePluginShareProjectResponse & { ok: true })
  | {
      ok: false;
      message: string;
      code?: string;
    };

/**
 * Start a plugin share task, which stands up a real chat project server-side.
 */
export async function createPluginShareProject(
  pluginId: string,
  action: PluginShareAction,
  locale?: string,
): Promise<PluginShareProjectOutcome> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/share-project`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          ...(locale ? { locale } : {}),
        }),
      },
    );
    const body = (await resp.json().catch(() => null)) as
      | (Partial<CreatePluginShareProjectResponse> & {
          error?: string | { code?: string; message?: string };
          code?: string;
        })
      | null;
    if (resp.ok && body?.ok && body.project && body.conversationId) {
      return body as CreatePluginShareProjectResponse & { ok: true };
    }
    const errorMessage =
      typeof body?.error === 'string' ? body.error : body?.error?.message;
    const fallbackMessage = resp.statusText || 'Could not create plugin share project.';
    const message = body?.message ?? errorMessage ?? fallbackMessage;
    const code =
      body?.code ?? (typeof body?.error === 'object' ? body.error.code : undefined);
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
    };
  }
}

async function postGeneratedPluginShareAction(
  projectId: string,
  relativePath: string,
  action: 'publish-github' | 'contribute-open-design',
): Promise<PluginShareOutcome> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/plugins/${action}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: relativePath }),
      },
    );
    const body = (await resp.json().catch(() => null)) as Partial<PluginShareOutcome> | null;
    return {
      ok: Boolean(resp.ok && body?.ok),
      message: body?.message ?? (resp.ok ? 'Action finished.' : 'Plugin share action failed.'),
      ...(body?.url ? { url: body.url } : {}),
      ...(body?.log ? { log: body.log } : {}),
      ...(body?.code ? { code: body.code } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
      log: [],
    };
  }
}

export async function upgradePlugin(id: string): Promise<PluginInstallOutcome> {
  const log: string[] = [];
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(id)}/upgrade`, {
      method: 'POST',
    });
    if (!resp.ok) {
      const message = await readErrorMessage(resp);
      return { ok: false, warnings: [], message, log };
    }
    if (!resp.body) {
      return {
        ok: false,
        warnings: [],
        message: 'Upgrade stream did not start.',
        log,
      };
    }
    let success: InstalledPluginRecord | undefined;
    let warnings: string[] = [];
    let errorMessage: string | undefined;
    for await (const ev of readServerSentEvents(resp.body)) {
      if (ev.message) log.push(ev.message);
      if (ev.warnings) warnings = ev.warnings;
      if (ev.kind === 'success') success = ev.plugin;
      if (ev.kind === 'error') errorMessage = ev.message ?? 'Upgrade failed.';
    }
    return {
      ok: Boolean(success) && !errorMessage,
      plugin: success,
      warnings,
      message: errorMessage ?? (success ? `Upgraded ${success.title}.` : 'Upgrade finished.'),
      log,
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      log,
    };
  }
}

async function postPluginUpload(url: string, form: FormData): Promise<PluginInstallOutcome> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: form,
    });
    const json = (await resp.json()) as Partial<PluginInstallOutcome> & {
      error?: string | { code?: unknown; message?: string };
    };
    if (resp.ok && json.ok) {
      return {
        ok: true,
        plugin: json.plugin,
        warnings: json.warnings ?? [],
        message: json.message ?? 'Plugin installed.',
        log: json.log ?? [],
      };
    }
    const message =
      json.message ??
      (typeof json.error === 'string' ? json.error : json.error?.message) ??
      resp.statusText;
    const errorCode = boundedRequestErrorCode(
      json.errorCode ?? (typeof json.error === 'object' ? json.error?.code : undefined),
    );
    return {
      ok: false,
      warnings: json.warnings ?? [],
      message,
      status: resp.status,
      ...(errorCode ? { errorCode } : {}),
      log: json.log ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      message: (err as Error).message,
      errorCode: 'network_error',
      log: [],
    };
  }
}

async function readPluginInstallOutcome(resp: Response): Promise<PluginInstallOutcome> {
  const json = (await resp.json()) as Partial<PluginInstallOutcome> & {
    error?: string | { message?: string };
  };
  if (resp.ok && json.ok) {
    return {
      ok: true,
      ...(json.plugin ? { plugin: json.plugin } : {}),
      warnings: json.warnings ?? [],
      message: json.message ?? 'Plugin installed.',
      log: json.log ?? [],
    };
  }
  const message =
    json.message ??
    (typeof json.error === 'string' ? json.error : json.error?.message) ??
    resp.statusText;
  return {
    ok: false,
    ...(json.plugin ? { plugin: json.plugin } : {}),
    warnings: json.warnings ?? [],
    message,
    log: json.log ?? [],
  };
}

function getUploadRelativePath(file: File): string {
  const withRelativePath = file as File & { webkitRelativePath?: string };
  return withRelativePath.webkitRelativePath || file.name;
}

export async function uninstallPlugin(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface PluginMarketplace {
  id: string;
  url: string;
  trust: PluginMarketplaceTrust;
  specVersion?: string;
  version?: string;
  addedAt?: number;
  refreshedAt?: number;
  manifest: {
    name?: string;
    version?: string;
    plugins?: PluginMarketplaceEntry[];
  };
}

export type PluginMarketplaceTrust = 'official' | 'trusted' | 'restricted';

export interface PluginMarketplaceEntry {
  name: string;
  source: string;
  version?: string;
  ref?: string;
  dist?: {
    type?: string;
    archive?: string;
    integrity?: string;
    manifestDigest?: string;
  };
  versions?: Array<{
    version: string;
    source?: string;
    ref?: string;
    dist?: {
      type?: string;
      archive?: string;
      integrity?: string;
      manifestDigest?: string;
    };
    integrity?: string;
    manifestDigest?: string;
    deprecated?: boolean | string;
    yanked?: boolean;
    yankedAt?: string;
    yankReason?: string;
  }>;
  distTags?: Record<string, string>;
  integrity?: string;
  manifestDigest?: string;
  publisher?: {
    id?: string;
    github?: string;
    url?: string;
  };
  homepage?: string;
  license?: string;
  permissions?: string[];
  capabilitiesSummary?: string[];
  deprecated?: boolean | string;
  yanked?: boolean;
  yankedAt?: string;
  yankReason?: string;
  tags?: string[];
  title?: string;
  title_i18n?: Record<string, string>;
  description?: string;
  description_i18n?: Record<string, string>;
  icon?: string;
}

export interface PluginMarketplaceMutationOutcome {
  ok: boolean;
  marketplace?: PluginMarketplace;
  message: string;
}

export async function listPluginMarketplaces(): Promise<PluginMarketplace[]> {
  try {
    const resp = await fetch('/api/marketplaces');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { marketplaces?: PluginMarketplace[] };
    return json.marketplaces ?? [];
  } catch {
    return [];
  }
}

export async function addPluginMarketplace(input: {
  url: string;
  trust: PluginMarketplaceTrust;
}): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch('/api/marketplaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace source added.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function refreshPluginMarketplace(
  id: string,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace source refreshed.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function removePluginMarketplace(
  id: string,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      return { ok: false, message: await readErrorMessage(resp) };
    }
    return { ok: true, message: 'Marketplace source removed.' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function setPluginMarketplaceTrust(
  id: string,
  trust: PluginMarketplaceTrust,
): Promise<PluginMarketplaceMutationOutcome> {
  try {
    const resp = await fetch(`/api/marketplaces/${encodeURIComponent(id)}/trust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trust }),
    });
    return readPluginMarketplaceOutcome(resp, 'Marketplace trust updated.');
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function readPluginMarketplaceOutcome(
  resp: Response,
  successMessage: string,
): Promise<PluginMarketplaceMutationOutcome> {
  if (!resp.ok) {
    return { ok: false, message: await readErrorMessage(resp) };
  }
  const marketplace = (await resp.json().catch(() => null)) as PluginMarketplace | null;
  return {
    ok: true,
    ...(marketplace ? { marketplace } : {}),
    message: successMessage,
  };
}

export async function applyPlugin(
  pluginId: string,
  options: {
    inputs?: Record<string, unknown>;
    projectId?: string;
    grantCaps?: string[];
    locale?: string;
    pluginSource?: string;
  } = {},
): Promise<ApplyResult | null> {
  try {
    const requestBody = JSON.stringify({
      ...(options.pluginSource ? { source: options.pluginSource } : {}),
      inputs: options.inputs ?? {},
      projectId: options.projectId,
      grantCaps: options.grantCaps ?? [],
      locale: options.locale,
    });
    const pluginUrl = `/api/plugins/${encodeURIComponent(pluginId)}`;
    const resp = await fetch(
      `${pluginUrl}/${options.pluginSource ? 'apply-local' : 'apply'}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestBody,
      },
    );
    // Exact-source requests must never degrade to the legacy ID-only route:
    // its response cannot prove which same-ID local record it applied. New
    // daemons still accept old ID-only clients through /apply; during the brief
    // new-Web/old-daemon upgrade window, omitting the plugin is safer than
    // silently substituting different local bytes.
    if (!resp.ok) return null;
    const json = (await resp.json()) as ApplyResult & { ok?: boolean };
    return json;
  } catch {
    return null;
  }
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const json = (await resp.json()) as {
      error?: string | { message?: string; data?: { errors?: unknown } };
      errors?: unknown;
      message?: string;
    };
    const message =
      json.message ??
      (typeof json.error === 'string' ? json.error : json.error?.message);
    const details = extractErrorDetails(
      typeof json.error === 'object' ? json.error.data?.errors : undefined,
      json.errors,
    );
    if (message && details.length > 0) return `${message}: ${details.join('; ')}`;
    if (message) return message;
  } catch {
    // Fall through to the status text below.
  }
  return resp.statusText || `HTTP ${resp.status}`;
}

function extractErrorDetails(...values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item.trim()];
      if (item && typeof item === 'object' && 'message' in item) {
        const message = (item as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) return [message.trim()];
      }
      return [];
    });
  });
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<PluginInstallEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const event = parseServerSentEvent(part);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const event = parseServerSentEvent(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

function parseServerSentEvent(raw: string): PluginInstallEvent | null {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as PluginInstallEvent;
  } catch {
    return null;
  }
}

// Fetch the immutable snapshot pinned to a project / conversation.
// Used by ProjectView to surface the active plugin as a context chip
// on user messages instead of re-rendering the inline plugin rail
// (the user already picked a plugin on Home — re-prompting is noise).
export async function fetchAppliedPluginSnapshot(
  snapshotId: string,
): Promise<AppliedPluginSnapshot | null> {
  try {
    const resp = await fetch(
      `/api/applied-plugins/${encodeURIComponent(snapshotId)}`,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as AppliedPluginSnapshot;
  } catch {
    return null;
  }
}

// Render the brief that the composer should display for the active
// applied plugin. Substitutes `{{var}}` placeholders inside
// useCase.query against the user-supplied inputs map; missing values
// stay as `{{var}}` so the gating "fill required" hint stays visible.
export function renderPluginBriefTemplate(
  template: string,
  inputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (full, key) => {
    if (key in inputs) {
      const v = inputs[key];
      if (v === undefined || v === null || v === '') return full;
      return String(v);
    }
    return full;
  });
}

export function resolvePluginQueryFallback(
  value: unknown,
  locale?: string,
  fallbackLocale: string = 'en',
): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (!isStringMap(value)) return '';

  const candidates = [
    locale,
    locale?.split('-')[0],
    fallbackLocale,
    fallbackLocale.split('-')[0],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = value[candidate];
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  }

  return Object.values(value).find((entry) => entry.length > 0) ?? '';
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}
