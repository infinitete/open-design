import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  ProjectGitBindingPreviewRequestSchema,
  ProjectGitBindRequestSchema,
  ProjectGitEnableRequestSchema,
  ProjectGitBasisSchema,
  ProjectGitConflictSchema,
  ProjectGitDependencySchema,
  ProjectGitOperationResultSchema,
  ProjectGitOpenRequestSchema,
  ProjectGitResolveRequestSchema,
  ProjectGitRestoreRequestSchema,
  ProjectGitRestorePreviewRequestSchema,
  ProjectGitRetryRequestSchema,
  ProjectGitSyncRequestSchema,
  ProjectGitCheckRequestSchema,
  ProjectGitUnbindRequestSchema,
  ProjectGitUpdateRequestSchema,
  parsePortableSnapshot,
  type JsonValue,
  type ProjectGitOperation,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';
import { redactGitText } from '../services/project-git/repository.js';

export interface ProjectGitCliRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: Record<string, JsonValue>;
  json: boolean;
  promptFile?: string;
  outputPath?: string;
  overwrite?: boolean;
  text?: boolean;
  daemonUrl?: string;
  idempotencyKey?: string;
}

const STRING_FLAGS = new Set([
  'project',
  'preview',
  'url',
  'branch',
  'commit',
  'path',
  'cursor',
  'operation',
  'prompt-file',
  'output',
  'daemon-url',
  'idempotency-key',
]);

const BOOLEAN_FLAGS = new Set([
  'json',
  'conversations',
  'overwrite',
  'text',
  'help',
  'h',
]);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const COMMON_FLAGS = ['json', 'daemon-url'] as const;
const MUTATION_FLAGS = [...COMMON_FLAGS, 'prompt-file', 'idempotency-key'] as const;
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  status: new Set([...COMMON_FLAGS, 'project']),
  check: new Set([...MUTATION_FLAGS, 'project']),
  enable: new Set([...MUTATION_FLAGS, 'project', 'preview']),
  'bind-preview': new Set([...MUTATION_FLAGS, 'project', 'url', 'branch']),
  bind: new Set([...MUTATION_FLAGS, 'project', 'preview']),
  unbind: new Set([...MUTATION_FLAGS, 'project']),
  pause: new Set([...MUTATION_FLAGS, 'project']),
  resume: new Set([...MUTATION_FLAGS, 'project']),
  sync: new Set([...MUTATION_FLAGS, 'project']),
  open: new Set([...MUTATION_FLAGS, 'url', 'branch']),
  log: new Set([...COMMON_FLAGS, 'project', 'cursor', 'path']),
  show: new Set([...COMMON_FLAGS, 'project', 'commit', 'path', 'conversations', 'output', 'overwrite', 'text']),
  'restore-preview': new Set([...MUTATION_FLAGS, 'project', 'commit']),
  restore: new Set([...MUTATION_FLAGS, 'project', 'preview']),
  conflicts: new Set([...COMMON_FLAGS, 'project']),
  resolve: new Set([...MUTATION_FLAGS, 'project', 'operation']),
  operation: new Set(COMMON_FLAGS),
  retry: new Set([...MUTATION_FLAGS, 'operation']),
};

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? '';
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < args.length; index += 1) {
    const item = args[index]!;
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const equals = item.indexOf('=');
    const name = equals >= 0 ? item.slice(2, equals) : item.slice(2);
    if (!STRING_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
      throw new Error(`unknown flag: --${name}`);
    }
    if (Object.hasOwn(flags, name)) throw new Error(`duplicate flag: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals >= 0) throw new Error(`flag --${name} does not take a value`);
      flags[name] = true;
      continue;
    }
    const value = equals >= 0 ? item.slice(equals + 1) : args[index + 1];
    if (value === undefined || equals < 0 && value.startsWith('--')) {
      throw new Error(`flag --${name} requires a value`);
    }
    if (value.length === 0) throw new Error(`flag --${name} cannot be empty`);
    if (equals < 0) index += 1;
    flags[name] = value;
  }
  return { command, positionals, flags };
}

function validateCommandFlags(parsed: ParsedArgs): void {
  const allowed = COMMAND_FLAGS[parsed.command];
  if (!allowed) return;
  for (const flag of Object.keys(parsed.flags)) {
    if (!allowed.has(flag)) {
      const qualifier = flag === 'prompt-file' || flag === 'idempotency-key'
        ? 'mutation-only flag and '
        : '';
      throw new Error(`--${flag} is a ${qualifier}not valid for od git ${parsed.command}`);
    }
  }
}

function required(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function encodedProjectPath(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/git${suffix}`;
}

function validateHistoricalPath(path: string): void {
  if (path.startsWith('/')
    || /^[a-z]:/iu.test(path)
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('--path must be a confined project-relative path');
  }
}

function encodedFilePath(path: string): string {
  validateHistoricalPath(path);
  return path.split('/').map(encodeURIComponent).join('/');
}

function makeRequest(
  parsed: ParsedArgs,
  input: Omit<ProjectGitCliRequest, 'json' | 'promptFile' | 'daemonUrl' | 'idempotencyKey'>,
): ProjectGitCliRequest {
  const promptFile = parsed.flags['prompt-file'];
  const daemonUrl = parsed.flags['daemon-url'];
  const idempotencyKey = parsed.flags['idempotency-key'];
  if (input.method === 'GET' && typeof promptFile === 'string') {
    throw new Error('--prompt-file is only valid for a mutation');
  }
  return {
    ...input,
    json: parsed.flags.json === true,
    ...(typeof promptFile === 'string' ? { promptFile } : {}),
    ...(typeof daemonUrl === 'string' ? { daemonUrl } : {}),
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
  };
}

function noExtraPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new Error(`unexpected positional argument: ${parsed.positionals[0]}`);
  }
}

export function parseProjectGitCommand(args: string[]): ProjectGitCliRequest {
  const parsed = parseArgs(args);
  validateCommandFlags(parsed);
  const projectRequest = (
    suffix: string,
    input: Omit<ProjectGitCliRequest, 'path' | 'json' | 'promptFile' | 'daemonUrl' | 'idempotencyKey'>,
  ) => {
    noExtraPositionals(parsed);
    return makeRequest(parsed, {
      ...input,
      path: encodedProjectPath(required(parsed.flags, 'project'), suffix),
    });
  };

  switch (parsed.command) {
    case 'status':
      return projectRequest('', { method: 'GET' });
    case 'check':
      return projectRequest('/check', { method: 'POST', body: {} });
    case 'enable': {
      const preview = parsed.flags.preview;
      return projectRequest('/enable', {
        method: 'POST',
        body: typeof preview === 'string'
          ? { mode: 'confirm', previewId: preview }
          : { mode: 'preview' },
      });
    }
    case 'bind-preview':
      return projectRequest('/binding-preview', {
        method: 'POST',
        body: { url: required(parsed.flags, 'url'), branch: required(parsed.flags, 'branch') },
      });
    case 'bind':
      return projectRequest('/bind', {
        method: 'POST',
        body: { previewId: required(parsed.flags, 'preview') },
      });
    case 'unbind':
      return projectRequest('/unbind', { method: 'POST', body: {} });
    case 'pause':
    case 'resume':
      return projectRequest('', { method: 'PATCH', body: { action: parsed.command } });
    case 'sync':
      return projectRequest('/sync', { method: 'POST', body: {} });
    case 'open':
      noExtraPositionals(parsed);
      return makeRequest(parsed, {
        method: 'POST',
        path: '/api/import/git',
        body: { url: required(parsed.flags, 'url'), branch: required(parsed.flags, 'branch') },
      });
    case 'log': {
      noExtraPositionals(parsed);
      const query: string[] = [];
      if (typeof parsed.flags.cursor === 'string') query.push(`cursor=${encodeURIComponent(parsed.flags.cursor)}`);
      if (typeof parsed.flags.path === 'string') {
        validateHistoricalPath(parsed.flags.path);
        query.push(`path=${encodeURIComponent(parsed.flags.path)}`);
      }
      return makeRequest(parsed, {
        method: 'GET',
        path: `${encodedProjectPath(required(parsed.flags, 'project'), '/history')}${query.length ? `?${query.join('&')}` : ''}`,
      });
    }
    case 'show': {
      noExtraPositionals(parsed);
      const project = required(parsed.flags, 'project');
      const oid = encodeURIComponent(required(parsed.flags, 'commit'));
      const historicalPath = parsed.flags.path;
      const conversations = parsed.flags.conversations === true;
      if (typeof historicalPath === 'string' && conversations) {
        throw new Error('--path and --conversations cannot be combined');
      }
      if (typeof historicalPath !== 'string'
        && (parsed.flags.output || parsed.flags.overwrite || parsed.flags.text)) {
        throw new Error('--output, --overwrite, and --text require --path');
      }
      if (parsed.flags.overwrite === true && typeof parsed.flags.output !== 'string') {
        throw new Error('--overwrite requires --output');
      }
      if (parsed.flags.text === true
        && (parsed.flags.json === true || typeof parsed.flags.output === 'string')) {
        throw new Error('--text cannot be combined with --json or --output');
      }
      const path = typeof historicalPath === 'string'
        ? encodedProjectPath(project, `/commits/${oid}/files/${encodedFilePath(historicalPath)}`)
        : conversations
          ? encodedProjectPath(project, `/commits/${oid}/conversations`)
          : encodedProjectPath(project, `/commits/${oid}`);
      const outputPath = parsed.flags.output;
      return makeRequest(parsed, {
        method: 'GET',
        path,
        ...(typeof outputPath === 'string' ? { outputPath } : {}),
        ...(parsed.flags.overwrite === true ? { overwrite: true } : {}),
        ...(parsed.flags.text === true ? { text: true } : {}),
      });
    }
    case 'restore-preview':
      return projectRequest('/restore-preview', {
        method: 'POST',
        body: { oid: required(parsed.flags, 'commit') },
      });
    case 'restore':
      return projectRequest('/restore', {
        method: 'POST',
        body: { previewId: required(parsed.flags, 'preview') },
      });
    case 'conflicts':
      return projectRequest('/conflicts', { method: 'GET' });
    case 'resolve':
      if (typeof parsed.flags['prompt-file'] !== 'string') throw new Error('--prompt-file is required');
      return projectRequest('/conflicts/resolve', {
        method: 'POST',
        body: { operationId: required(parsed.flags, 'operation') },
      });
    case 'operation': {
      if (parsed.positionals.length !== 1) throw new Error('operation id is required');
      return makeRequest(parsed, {
        method: 'GET',
        path: `/api/project-git-operations/${encodeURIComponent(parsed.positionals[0]!)}`,
      });
    }
    case 'retry': {
      noExtraPositionals(parsed);
      const operationId = required(parsed.flags, 'operation');
      return makeRequest(parsed, {
        method: 'POST',
        path: `/api/project-git-operations/${encodeURIComponent(operationId)}/retry`,
        body: { operationId },
      });
    }
    default:
      throw new Error(parsed.command ? `unknown command: od git ${parsed.command}` : 'od git command is required');
  }
}

export async function readProjectGitPromptFile(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

class ProjectGitCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details?: JsonValue,
    readonly retryable?: boolean,
    readonly requestId?: string,
    readonly taskId?: string,
  ) {
    super(message);
  }
}

function redactText(value: string, secrets: string[]): string {
  let message = value;
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return redactGitText(message)
    .replace(/\b(Bearer|Basic)\s+\S+/giu, '$1 [redacted]');
}

function safeMessage(value: unknown, secrets: string[]): string {
  const message = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'Project Git request failed.';
  return redactText(message, secrets);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value).every(isJsonValue);
}

function redactJsonValue(value: JsonValue, secrets: string[]): JsonValue {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key, secrets),
        isSensitiveDetailKey(key) ? '[redacted]' : redactJsonValue(item, secrets),
      ]),
    );
  }
  return value;
}

const SENSITIVE_DETAIL_KEY_WORDS = new Set([
  'password', 'passwd', 'token', 'key', 'secret', 'credential', 'credentials',
  'authorization',
]);

function isSensitiveDetailKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const normalized = words.join('');
  return normalized === 'password'
    || normalized === 'passwd'
    || normalized === 'accesstoken'
    || normalized === 'apikey'
    || words.some(word => SENSITIVE_DETAIL_KEY_WORDS.has(word));
}

async function requestJson(
  base: string,
  request: ProjectGitCliRequest,
  body?: Record<string, JsonValue>,
  expectedStatus?: number,
): Promise<unknown> {
  const token = process.env.OD_TOOL_TOKEN;
  let response: Response;
  try {
    response = await fetch(`${base}${request.path}`, {
      method: request.method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(request.method === 'GET' ? {} : { 'idempotency-key': request.idempotencyKey ?? randomUUID() }),
        ...(body?.expectedProjectRevision === undefined
          ? {}
          : { 'x-od-project-revision': String(body.expectedProjectRevision) }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ProjectGitCliError('DAEMON_UNREACHABLE', 'Unable to reach the Open Design daemon.', 3);
  }
  let payload: unknown = {};
  try { payload = await response.json(); } catch { /* Never surface raw daemon response bytes. */ }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: unknown }).error
      : null;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : `HTTP_${response.status}`;
    const message = error && typeof error === 'object' && 'message' in error
      ? error.message
      : 'Project Git request failed.';
    const details = error && typeof error === 'object' && 'details' in error && isJsonValue(error.details)
      ? error.details
      : undefined;
    const retryable = error && typeof error === 'object' && 'retryable' in error
      && typeof error.retryable === 'boolean' ? error.retryable : undefined;
    const requestId = error && typeof error === 'object' && 'requestId' in error
      && typeof error.requestId === 'string' ? error.requestId : undefined;
    const taskId = error && typeof error === 'object' && 'taskId' in error
      && typeof error.taskId === 'string' ? error.taskId : undefined;
    throw new ProjectGitCliError(
      code,
      safeMessage(message, [token ?? '']),
      1,
      details,
      retryable,
      requestId,
      taskId,
    );
  }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new ProjectGitCliError(
      'INVALID_RESPONSE',
      `The daemon returned HTTP ${response.status}; expected ${expectedStatus}.`,
      1,
    );
  }
  return request.method === 'GET'
    ? validateProjectGitReadResponse(request.path, payload)
    : payload;
}

async function readPromptBody(promptFile: string): Promise<Record<string, JsonValue>> {
  const raw = await readProjectGitPromptFile(promptFile);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectGitCliError('BAD_REQUEST', '--prompt-file must contain valid JSON.', 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectGitCliError('BAD_REQUEST', '--prompt-file must contain a JSON object.', 2);
  }
  return parsed as Record<string, JsonValue>;
}

function mergePromptBody(
  body: Record<string, JsonValue>,
  fromFile: Record<string, JsonValue>,
): Record<string, JsonValue> {
  for (const key of Object.keys(fromFile)) {
    if (Object.hasOwn(body, key)) {
      throw new ProjectGitCliError(
        'BAD_REQUEST',
        `Field ${key} is present in both flags and --prompt-file; duplicate fields are not allowed.`,
        2,
      );
    }
  }
  return { ...body, ...fromFile };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

const PROJECT_GIT_PHASES = new Set([
  'enable_pending', 'waiting_idle', 'dirty', 'checkpointing', 'local_saved',
  'pending_push', 'syncing', 'synced', 'paused', 'conflict', 'auth_required',
  'external_git_busy', 'recovering', 'failed',
]);
const PROJECT_GIT_OPERATION_STATUSES = new Set([
  'queued', 'running', 'waiting', 'succeeded', 'failed',
]);
const PROJECT_GIT_OPERATION_KINDS = new Set([
  'enable_preview', 'enable', 'binding_preview', 'bind', 'unbind', 'pause', 'resume',
  'sync', 'open', 'restore_preview', 'restore', 'resolve', 'retry',
]);

function isApiError(value: unknown): boolean {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') return false;
  return (value.details === undefined || isJsonValue(value.details))
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && (value.taskId === undefined || typeof value.taskId === 'string');
}

function invalidResponse(noun: string): never {
  throw new ProjectGitCliError('INVALID_RESPONSE', `The daemon returned an invalid ${noun}.`, 1);
}

function projectGitOperation(payload: unknown): ProjectGitOperation {
  if (!isRecord(payload)
    || typeof payload.id !== 'string' || payload.id.length === 0
    || typeof payload.kind !== 'string' || !PROJECT_GIT_OPERATION_KINDS.has(payload.kind)
    || typeof payload.status !== 'string' || !PROJECT_GIT_OPERATION_STATUSES.has(payload.status)
    || typeof payload.phase !== 'string' || !PROJECT_GIT_PHASES.has(payload.phase)
    || !isNullableString(payload.projectId)
    || !ProjectGitBasisSchema.safeParse(payload.basis).success
    || !(payload.result === null || ProjectGitOperationResultSchema.safeParse(payload.result).success)
    || !(payload.error === null || isApiError(payload.error))) {
    return invalidResponse('project Git operation');
  }
  return payload as unknown as ProjectGitOperation;
}

function projectGitState(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)
    || typeof payload.enabled !== 'boolean'
    || typeof payload.phase !== 'string' || !PROJECT_GIT_PHASES.has(payload.phase)
    || !isNullableString(payload.localHead)
    || !isNullableString(payload.observedRemoteHead)
    || !isNullableString(payload.confirmedRemoteHead)
    || !isNonnegativeSafeInteger(payload.projectRevision)
    || !isNonnegativeSafeInteger(payload.contentRevision)
    || !isNonnegativeSafeInteger(payload.bindingGeneration)
    || typeof payload.dirty !== 'boolean'
    || typeof payload.pendingPush !== 'boolean'
    || typeof payload.autoSync !== 'boolean'
    || !isNullableString(payload.operationId)
    || !(payload.error === null || isApiError(payload.error))
    || !isRecord(payload.binding)
    || typeof payload.binding.remoteConfigured !== 'boolean'
    || !isNullableString(payload.binding.remoteLabel)
    || !isNullableString(payload.binding.branch)
    || !Array.isArray(payload.dependencies)
    || !payload.dependencies.every(item => ProjectGitDependencySchema.safeParse(item).success)) {
    return invalidResponse('project Git status');
  }
  return payload;
}

function isProjectGitCommit(payload: unknown): boolean {
  return isRecord(payload)
    && typeof payload.oid === 'string' && payload.oid.length > 0
    && isStringArray(payload.parents)
    && isRecord(payload.author)
    && typeof payload.author.name === 'string'
    && isNullableString(payload.author.email)
    && typeof payload.authoredAt === 'number' && Number.isFinite(payload.authoredAt)
    && typeof payload.message === 'string'
    && (payload.source === 'open-design' || payload.source === 'external')
    && (payload.snapshotKind === 'complete' || payload.snapshotKind === 'files_only')
    && isRecord(payload.changedPaths)
    && isStringArray(payload.changedPaths.added)
    && isStringArray(payload.changedPaths.modified)
    && isStringArray(payload.changedPaths.deleted);
}

function projectGitHistory(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)
    || !Array.isArray(payload.commits) || !payload.commits.every(isProjectGitCommit)
    || !isNullableString(payload.nextCursor)) {
    return invalidResponse('project Git history');
  }
  return payload;
}

function projectGitCommit(payload: unknown): Record<string, unknown> {
  if (!isProjectGitCommit(payload)) return invalidResponse('project Git commit');
  return payload as Record<string, unknown>;
}

function projectGitConflicts(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.conflicts)
    || !payload.conflicts.every(item => ProjectGitConflictSchema.safeParse(item).success)) {
    return invalidResponse('project Git conflicts');
  }
  return payload;
}

function projectGitConversations(payload: unknown): unknown {
  if (payload === null) return payload;
  try {
    return parsePortableSnapshot(payload);
  } catch {
    return invalidResponse('project Git conversations');
  }
}

function validateProjectGitReadResponse(path: string, payload: unknown): unknown {
  const operationMatch = /^\/api\/project-git-operations\/([^/]+)$/u.exec(path);
  if (operationMatch) {
    const operation = projectGitOperation(payload);
    let requestedOperationId: string;
    try {
      requestedOperationId = decodeURIComponent(operationMatch[1]!);
    } catch {
      return invalidResponse('project Git operation identity');
    }
    if (operation.id !== requestedOperationId) {
      return invalidResponse('project Git operation identity');
    }
    return operation;
  }
  if (/\/git$/u.test(path)) return projectGitState(payload);
  if (/\/history(?:\?|$)/u.test(path)) return projectGitHistory(payload);
  if (/\/files\//u.test(path)) return historicalFile(payload);
  if (/\/conversations$/u.test(path)) return projectGitConversations(payload);
  if (/\/conflicts$/u.test(path)) return projectGitConflicts(payload);
  if (/\/commits\/[^/]+$/u.test(path)) return projectGitCommit(payload);
  return invalidResponse('project Git read response');
}

function operationRevision(payload: unknown): number {
  const basis = projectGitOperation(payload).basis;
  const revision = basis && typeof basis === 'object' && 'projectRevision' in basis
    ? (basis as { projectRevision?: unknown }).projectRevision
    : null;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new ProjectGitCliError('INVALID_OPERATION', 'The preview operation has no valid project revision.', 1);
  }
  return Number(revision);
}

function projectIdFromRequest(request: ProjectGitCliRequest): string | null {
  const match = /^\/api\/projects\/([^/]+)\/git(?:\/|$)/u.exec(request.path);
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

async function currentProjectRevision(
  base: string,
  projectId: string,
  request: ProjectGitCliRequest,
): Promise<number> {
  const state = await requestJson(base, {
    method: 'GET',
    path: encodedProjectPath(projectId),
    json: true,
    ...(request.daemonUrl ? { daemonUrl: request.daemonUrl } : {}),
  });
  const revision = state && typeof state === 'object' && 'projectRevision' in state
    ? (state as { projectRevision?: unknown }).projectRevision
    : null;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new ProjectGitCliError('INVALID_RESPONSE', 'The daemon returned an invalid project revision.', 1);
  }
  return Number(revision);
}

type BodySchema = { parse(value: unknown): unknown };

function schemaForCommand(command: string): BodySchema {
  switch (command) {
    case 'enable': return ProjectGitEnableRequestSchema;
    case 'bind-preview': return ProjectGitBindingPreviewRequestSchema;
    case 'bind': return ProjectGitBindRequestSchema;
    case 'unbind': return ProjectGitUnbindRequestSchema;
    case 'pause':
    case 'resume': return ProjectGitUpdateRequestSchema;
    case 'sync': return ProjectGitSyncRequestSchema;
    case 'check': return ProjectGitCheckRequestSchema;
    case 'open': return ProjectGitOpenRequestSchema;
    case 'restore-preview': return ProjectGitRestorePreviewRequestSchema;
    case 'restore': return ProjectGitRestoreRequestSchema;
    case 'resolve': return ProjectGitResolveRequestSchema;
    case 'retry': return ProjectGitRetryRequestSchema;
    default: throw new ProjectGitCliError('BAD_REQUEST', `Unsupported mutation: ${command}`, 2);
  }
}

async function prepareMutationBody(
  command: string,
  base: string,
  request: ProjectGitCliRequest,
): Promise<Record<string, JsonValue>> {
  let body = { ...(request.body ?? {}) };
  let expectedProjectRevision: number | undefined;
  const previewId = body.previewId;
  const operationId = body.operationId;

  if (command === 'enable' && typeof previewId === 'string'
    || command === 'bind' && typeof previewId === 'string'
    || command === 'restore' && typeof previewId === 'string') {
    const preview = await requestJson(base, {
      method: 'GET',
      path: `/api/project-git-operations/${encodeURIComponent(previewId as string)}`,
      json: true,
      ...(request.daemonUrl ? { daemonUrl: request.daemonUrl } : {}),
    });
    expectedProjectRevision = operationRevision(preview);
  } else if (command === 'retry' && typeof operationId === 'string') {
    const prior = await requestJson(base, {
      method: 'GET',
      path: `/api/project-git-operations/${encodeURIComponent(operationId)}`,
      json: true,
      ...(request.daemonUrl ? { daemonUrl: request.daemonUrl } : {}),
    });
    expectedProjectRevision = operationRevision(prior);
  } else if (command !== 'open' && command !== 'resolve' && command !== 'check') {
    const projectId = projectIdFromRequest(request);
    if (!projectId) throw new ProjectGitCliError('BAD_REQUEST', '--project is required', 2);
    // Capture once before reading a long prompt or constructing the final body.
    expectedProjectRevision = await currentProjectRevision(base, projectId, request);
  }

  if (request.promptFile) body = mergePromptBody(body, await readPromptBody(request.promptFile));

  if (command === 'resolve') {
    const basis = body.basis;
    const basisRevision = basis && typeof basis === 'object' && !Array.isArray(basis)
      ? (basis as Record<string, JsonValue>).projectRevision
      : undefined;
    if (!Number.isSafeInteger(basisRevision) || Number(basisRevision) < 0) {
      throw new ProjectGitCliError('BAD_REQUEST', 'Resolution JSON must contain a valid frozen basis.', 2);
    }
    expectedProjectRevision = Number(basisRevision);
  }

  if (expectedProjectRevision !== undefined) {
    const supplied = body.expectedProjectRevision;
    if (supplied !== undefined && supplied !== expectedProjectRevision) {
      throw new ProjectGitCliError('PROJECT_STATE_CHANGED', 'The supplied project revision does not match the frozen basis.', 2);
    }
    body.expectedProjectRevision = expectedProjectRevision;
  }

  try {
    return schemaForCommand(command).parse(body) as Record<string, JsonValue>;
  } catch (error) {
    if (error instanceof ProjectGitCliError) throw error;
    throw new ProjectGitCliError('BAD_REQUEST', 'Invalid project Git request body.', 2);
  }
}

async function pollOperation(base: string, operationId: string, request: ProjectGitCliRequest): Promise<ProjectGitOperation> {
  const operationRequest: ProjectGitCliRequest = {
    method: 'GET',
    path: `/api/project-git-operations/${encodeURIComponent(operationId)}`,
    json: true,
    ...(request.daemonUrl ? { daemonUrl: request.daemonUrl } : {}),
  };
  let latestStatus = 'unknown';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operation = projectGitOperation(await requestJson(base, operationRequest));
    latestStatus = operation.status;
    if (operation.status === 'succeeded' || operation.status === 'waiting') return operation;
    if (operation.status === 'failed') {
      throw new ProjectGitCliError(
        operation.error?.code ?? 'OPERATION_FAILED',
        safeMessage(operation.error?.message, [process.env.OD_TOOL_TOKEN ?? '']),
        1,
        operation.error?.details,
        operation.error?.retryable,
        operation.error?.requestId,
        operation.error?.taskId,
      );
    }
    if (attempt === 0) {
      const progress = redactText(
        `Project Git operation ${operationId} is ${operation.status}.`,
        [process.env.OD_TOOL_TOKEN ?? ''],
      );
      process.stderr.write(`${progress}\n`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new ProjectGitCliError(
    'OPERATION_PENDING',
    `Project Git operation ${operationId} is still ${latestStatus}.`,
    2,
    { operationId, latestStatus },
    true,
  );
}

function printResult(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const operation = payload as Partial<ProjectGitOperation>;
  if (operation?.id && operation?.status) {
    process.stdout.write(`${operation.id}\t${operation.status}\t${operation.phase ?? '-'}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function historicalFile(payload: unknown): { encoding: 'base64'; content: string; mediaType: string } {
  if (!payload || typeof payload !== 'object'
    || (payload as { encoding?: unknown }).encoding !== 'base64'
    || typeof (payload as { content?: unknown }).content !== 'string'
    || typeof (payload as { mediaType?: unknown }).mediaType !== 'string'
    || !isStrictBase64((payload as { content: string }).content)) {
    throw new ProjectGitCliError('INVALID_RESPONSE', 'The daemon returned an invalid historical file.', 1);
  }
  return payload as { encoding: 'base64'; content: string; mediaType: string };
}

function isStrictBase64(value: string): boolean {
  if (value === '') return true;
  if (value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

async function printReadResult(request: ProjectGitCliRequest, payload: unknown): Promise<void> {
  if (/^\/api\/project-git-operations\/[^/]+$/u.test(request.path)) {
    printResult(payload, true);
    return;
  }
  if (!/\/commits\/[^/]+\/files\//u.test(request.path)) {
    printResult(payload, request.json);
    return;
  }
  const file = historicalFile(payload);
  if (request.outputPath) {
    const bytes = Buffer.from(file.content, 'base64');
    try {
      await writeFile(request.outputPath, bytes, { flag: request.overwrite ? 'w' : 'wx' });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === 'EEXIST') {
        throw new ProjectGitCliError('OUTPUT_EXISTS', 'Output file exists; pass --overwrite to replace it.', 2);
      }
      throw new ProjectGitCliError('OUTPUT_FAILED', 'Unable to write the historical file.', 1);
    }
    if (request.json) {
      printResult({ outputPath: request.outputPath, bytes: bytes.length, mediaType: file.mediaType }, true);
    } else {
      process.stdout.write(`Wrote ${bytes.length} bytes to ${request.outputPath}.\n`);
    }
    return;
  }
  if (request.text) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64')); }
    catch { throw new ProjectGitCliError('BINARY_FILE', 'Historical file is not valid UTF-8; use --output.', 2); }
    process.stdout.write(text);
    return;
  }
  if (request.json) {
    printResult(file, true);
    return;
  }
  throw new ProjectGitCliError('OUTPUT_REQUIRED', 'Historical files require --json, --text, or --output.', 2);
}

function writeProjectGitFailure(failure: ProjectGitCliError, json: boolean): void {
  const secrets = [process.env.OD_TOOL_TOKEN ?? ''];
  const error = {
    code: failure.code,
    message: safeMessage(failure.message, secrets),
    ...(failure.details === undefined
      ? {}
      : { details: redactJsonValue(failure.details, secrets) }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
    ...(failure.requestId === undefined
      ? {}
      : { requestId: redactText(failure.requestId, secrets) }),
    ...(failure.taskId === undefined
      ? {}
      : { taskId: redactText(failure.taskId, secrets) }),
  };
  if (json) {
    process.stderr.write(`${JSON.stringify({ error })}\n`);
    return;
  }
  const lines = [`${error.code}: ${error.message}`];
  if (error.details !== undefined) lines.push(`Details: ${JSON.stringify(error.details)}`);
  if (error.retryable !== undefined) lines.push(`Retryable: ${error.retryable}`);
  if (error.requestId !== undefined) lines.push(`Request ID: ${error.requestId}`);
  if (error.taskId !== undefined) lines.push(`Task ID: ${error.taskId}`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

export async function runProjectGit(args: string[]): Promise<void> {
  try {
    if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
      process.stdout.write(`Usage:
  od git status --project <id> [--json]
  od git check --project <id> [--prompt-file <path|->] [--json]
  od git enable --project <id> [--preview <id>] [--prompt-file <path|->] [--json]
  od git bind-preview --project <id> --url <url> --branch <branch> [--prompt-file <path|->] [--json]
  od git bind --project <id> --preview <id> [--prompt-file <path|->] [--json]
  od git unbind --project <id> [--prompt-file <path|->] [--json]
  od git pause|resume|sync --project <id> [--prompt-file <path|->] [--json]
  od git open --url <url> --branch <branch> [--prompt-file <path|->] [--json]
  od git log --project <id> [--cursor <cursor>] [--path <path>] [--json]
  od git show --project <id> --commit <oid> [--path <path> | --conversations] [--json]
              [--text | --output <path> [--overwrite]]
  od git restore-preview --project <id> --commit <oid> [--prompt-file <path|->] [--json]
  od git restore --project <id> --preview <id> [--prompt-file <path|->] [--json]
  od git conflicts --project <id> [--json]
  od git resolve --project <id> --operation <id> --prompt-file <path|-> [--json]
  od git operation <id> [--json]
  od git retry --operation <id> [--prompt-file <path|->] [--json]

Mutations use an Idempotency-Key and the project revision captured before the
request. Preview confirmations retain the preview's frozen revision instead of
refreshing stale input. JSON output contains no progress text; polling progress
is written to stderr.

Open imports the repository and enables automatic synchronization after the
operation succeeds. Open Design uses the installed system Git; missing Git or
identity does not block project editing. Repository credentials remain with the daemon
and system credential helpers and are never written into the project.
Open Design does not install Git, dependencies, LFS, or submodules automatically.

Common options:
  --daemon-url <url>          Open Design daemon HTTP base.
  --idempotency-key <key>     Reuse one mutation request safely.
  --prompt-file <path|->      Merge a JSON object from a file or stdin.
  --json                      Emit machine-readable JSON only.
`);
      if (args.length === 0) process.exitCode = 2;
      return;
    }
    const request = parseProjectGitCommand(args);
    const base = (await resolveDaemonUrl(
      request.daemonUrl ? { flagUrl: request.daemonUrl } : {},
    )).replace(/\/$/u, '');
    if (request.method === 'GET') {
      await printReadResult(request, await requestJson(base, request));
      return;
    }
    const mutationRequest = {
      ...request,
      idempotencyKey: request.idempotencyKey ?? randomUUID(),
    };
    const body = await prepareMutationBody(args[0]!, base, mutationRequest);
    if (args[0] === 'check') {
      printResult(await requestJson(base, mutationRequest, body, 200), request.json);
      return;
    }
    const accepted = await requestJson(base, mutationRequest, body, 202);
    if (!isRecord(accepted) || typeof accepted.operationId !== 'string' || !accepted.operationId) {
      throw new ProjectGitCliError('INVALID_RESPONSE', 'The daemon did not return an operation id.', 1);
    }
    printResult(await pollOperation(base, accepted.operationId, mutationRequest), request.json);
  } catch (error) {
    const failure = error instanceof ProjectGitCliError
      ? error
      : new ProjectGitCliError('BAD_REQUEST', safeMessage(error instanceof Error ? error.message : error, [process.env.OD_TOOL_TOKEN ?? '']), 2);
    writeProjectGitFailure(failure, args.includes('--json'));
    process.exitCode = failure.exitCode;
  }
}
