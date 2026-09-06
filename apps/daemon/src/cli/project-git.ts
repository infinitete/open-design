import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  ProjectGitBindingPreviewRequestSchema,
  ProjectGitBindRequestSchema,
  ProjectGitEnableRequestSchema,
  ProjectGitOpenRequestSchema,
  ProjectGitResolveRequestSchema,
  ProjectGitRestoreRequestSchema,
  ProjectGitRestorePreviewRequestSchema,
  ProjectGitRetryRequestSchema,
  ProjectGitSyncRequestSchema,
  ProjectGitUnbindRequestSchema,
  ProjectGitUpdateRequestSchema,
  type JsonValue,
  type ProjectGitOperation,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';

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
    if (equals < 0) index += 1;
    flags[name] = value;
  }
  return { command, positionals, flags };
}

function required(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function encodedProjectPath(projectId: string, suffix = ''): string {
  return `/api/projects/${encodeURIComponent(projectId)}/git${suffix}`;
}

function encodedFilePath(path: string): string {
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
      if (typeof parsed.flags.path === 'string') query.push(`path=${encodeURIComponent(parsed.flags.path)}`);
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
  ) {
    super(message);
  }
}

function safeMessage(value: unknown, secrets: string[]): string {
  let message = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'Project Git request failed.';
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]');
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
    throw new ProjectGitCliError(code, safeMessage(message, [token ?? '']), 1);
  }
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new ProjectGitCliError(
      'INVALID_RESPONSE',
      `The daemon returned HTTP ${response.status}; expected ${expectedStatus}.`,
      1,
    );
  }
  return payload;
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

function operationRevision(payload: unknown): number {
  const basis = payload && typeof payload === 'object' && 'basis' in payload
    ? (payload as { basis?: unknown }).basis
    : null;
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
  } else if (command !== 'open' && command !== 'resolve') {
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operation = await requestJson(base, operationRequest) as ProjectGitOperation;
    if (operation.status === 'succeeded' || operation.status === 'waiting') return operation;
    if (operation.status === 'failed') {
      throw new ProjectGitCliError(
        operation.error?.code ?? 'OPERATION_FAILED',
        safeMessage(operation.error?.message, [process.env.OD_TOOL_TOKEN ?? '']),
        1,
      );
    }
    if (attempt === 0) process.stderr.write(`Project Git operation ${operationId} is ${operation.status}.\n`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new ProjectGitCliError('OPERATION_PENDING', 'Project Git operation is still running.', 2);
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
    || typeof (payload as { mediaType?: unknown }).mediaType !== 'string') {
    throw new ProjectGitCliError('INVALID_RESPONSE', 'The daemon returned an invalid historical file.', 1);
  }
  return payload as { encoding: 'base64'; content: string; mediaType: string };
}

async function printReadResult(request: ProjectGitCliRequest, payload: unknown): Promise<void> {
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

export async function runProjectGit(args: string[]): Promise<void> {
  try {
    if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
      process.stdout.write(`Usage:
  od git status --project <id> [--json]
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
      if (args[0] === 'operation') {
        const operationId = decodeURIComponent(request.path.split('/').at(-1) ?? '');
        printResult(await pollOperation(base, operationId, request), request.json);
        return;
      }
      await printReadResult(request, await requestJson(base, request));
      return;
    }
    const mutationRequest = {
      ...request,
      idempotencyKey: request.idempotencyKey ?? randomUUID(),
    };
    const body = await prepareMutationBody(args[0]!, base, mutationRequest);
    const accepted = await requestJson(base, mutationRequest, body, 202) as { operationId?: unknown };
    if (typeof accepted.operationId !== 'string' || !accepted.operationId) {
      throw new ProjectGitCliError('INVALID_RESPONSE', 'The daemon did not return an operation id.', 1);
    }
    printResult(await pollOperation(base, accepted.operationId, mutationRequest), request.json);
  } catch (error) {
    const failure = error instanceof ProjectGitCliError
      ? error
      : new ProjectGitCliError('BAD_REQUEST', safeMessage(error instanceof Error ? error.message : error, [process.env.OD_TOOL_TOKEN ?? '']), 2);
    process.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`);
    process.exitCode = failure.exitCode;
  }
}
