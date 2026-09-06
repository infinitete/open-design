import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseProjectGitCommand,
  readProjectGitPromptFile,
  runProjectGit,
} from '../src/cli/project-git.js';

let tempRoot = '';
let server: http.Server | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  if (server) server.close();
  server = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function runCli(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.NODE_OPTIONS;
  return new Promise(resolve => {
    const child = execFile(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const failed = error as { code?: number | null } | null;
      resolve({ stdout, stderr, code: failed?.code ?? 0 });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function startStub(
  responder: (request: CapturedRequest, response: http.ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const captured = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      requests.push(captured);
      response.setHeader('content-type', 'application/json');
      responder(captured, response);
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server has no address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function operation(
  id: string,
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' = 'succeeded',
) {
  return {
    id,
    kind: 'restore',
    status,
    phase: status === 'succeeded' ? 'synced' : status === 'failed' ? 'failed' : 'syncing',
    projectId: 'p 1',
    basis: {
      projectRevision: 7,
      contentRevision: 3,
      localHead: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      bindingGeneration: 2,
    },
    result: status === 'succeeded' ? { head: 'c'.repeat(40) } : null,
    error: status === 'failed'
      ? { code: 'GIT_CONFLICT', message: 'merge failed', retryable: false }
      : null,
  };
}

const projectState = {
  enabled: true,
  phase: 'synced',
  localHead: 'a'.repeat(40),
  observedRemoteHead: 'b'.repeat(40),
  confirmedRemoteHead: 'b'.repeat(40),
  projectRevision: 7,
  contentRevision: 3,
  bindingGeneration: 2,
  dirty: false,
  pendingPush: false,
  autoSync: true,
  operationId: null,
  error: null,
  binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
  dependencies: [],
};

const projectCommit = {
  oid: 'abc',
  parents: [],
  author: { name: 'Open Design', email: null },
  authoredAt: 1,
  message: 'commit',
  source: 'open-design',
  snapshotKind: 'complete',
  changedPaths: { added: [], modified: [], deleted: [] },
};

describe('od git parser', () => {
  it('maps every project Git read and mutation to the reviewed HTTP route', () => {
    const cases = [
      [['status', '--project', 'p 1', '--json'], 'GET', '/api/projects/p%201/git', undefined],
      [['enable', '--project', 'p 1', '--json'], 'POST', '/api/projects/p%201/git/enable', { mode: 'preview' }],
      [['enable', '--project', 'p 1', '--preview', 'enable-1', '--json'], 'POST', '/api/projects/p%201/git/enable', { mode: 'confirm', previewId: 'enable-1' }],
      [['bind-preview', '--project', 'p 1', '--url', 'ssh://git/repo', '--branch', 'main', '--json'], 'POST', '/api/projects/p%201/git/binding-preview', { url: 'ssh://git/repo', branch: 'main' }],
      [['bind', '--project', 'p 1', '--preview', 'bind-1', '--json'], 'POST', '/api/projects/p%201/git/bind', { previewId: 'bind-1' }],
      [['unbind', '--project', 'p 1', '--json'], 'POST', '/api/projects/p%201/git/unbind', {}],
      [['pause', '--project', 'p 1', '--json'], 'PATCH', '/api/projects/p%201/git', { action: 'pause' }],
      [['resume', '--project', 'p 1', '--json'], 'PATCH', '/api/projects/p%201/git', { action: 'resume' }],
      [['sync', '--project', 'p 1', '--json'], 'POST', '/api/projects/p%201/git/sync', {}],
      [['open', '--url', 'ssh://git/repo', '--branch', 'main', '--json'], 'POST', '/api/import/git', { url: 'ssh://git/repo', branch: 'main' }],
      [['log', '--project', 'p 1', '--cursor', 'next cursor', '--path', 'src/a b.ts', '--json'], 'GET', '/api/projects/p%201/git/history?cursor=next%20cursor&path=src%2Fa%20b.ts', undefined],
      [['show', '--project', 'p 1', '--commit', 'abc123', '--json'], 'GET', '/api/projects/p%201/git/commits/abc123', undefined],
      [['show', '--project', 'p 1', '--commit', 'abc123', '--path', 'src/a b.ts', '--json'], 'GET', '/api/projects/p%201/git/commits/abc123/files/src/a%20b.ts', undefined],
      [['show', '--project', 'p 1', '--commit', 'abc123', '--conversations', '--json'], 'GET', '/api/projects/p%201/git/commits/abc123/conversations', undefined],
      [['restore-preview', '--project', 'p 1', '--commit', 'abc123', '--json'], 'POST', '/api/projects/p%201/git/restore-preview', { oid: 'abc123' }],
      [['restore', '--project', 'p 1', '--preview', 'restore-1', '--json'], 'POST', '/api/projects/p%201/git/restore', { previewId: 'restore-1' }],
      [['conflicts', '--project', 'p 1', '--json'], 'GET', '/api/projects/p%201/git/conflicts', undefined],
      [['resolve', '--project', 'p 1', '--operation', 'conflict-1', '--prompt-file', 'resolution.json', '--json'], 'POST', '/api/projects/p%201/git/conflicts/resolve', { operationId: 'conflict-1' }],
      [['operation', 'operation 1', '--json'], 'GET', '/api/project-git-operations/operation%201', undefined],
      [['retry', '--operation', 'operation 1', '--json'], 'POST', '/api/project-git-operations/operation%201/retry', { operationId: 'operation 1' }],
    ] as const;

    for (const [args, method, path, body] of cases) {
      expect(parseProjectGitCommand([...args])).toMatchObject({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        json: true,
      });
    }
  });

  it('maps a restore confirmation to the same HTTP contract', () => {
    expect(parseProjectGitCommand(['restore', '--project', 'p 1', '--preview', 'v1', '--json']))
      .toMatchObject({
        method: 'POST',
        path: '/api/projects/p%201/git/restore',
        body: { previewId: 'v1' },
        json: true,
      });
  });

  it('keeps parsing free of file IO and records explicit historical-file output policy', () => {
    expect(parseProjectGitCommand([
      'show', '--project', 'p', '--commit', 'abc', '--path', 'assets/logo.bin',
      '--output', 'copy.bin', '--overwrite', '--json',
    ])).toMatchObject({
      outputPath: 'copy.bin',
      overwrite: true,
      json: true,
    });

    expect(parseProjectGitCommand([
      'bind', '--project', 'p', '--preview', 'preview-1', '--prompt-file', 'decisions.json',
    ])).toMatchObject({ promptFile: 'decisions.json' });
  });

  it('rejects ambiguous or incomplete command shapes before any IO', () => {
    expect(() => parseProjectGitCommand(['show', '--project', 'p', '--commit', 'abc', '--path', 'a', '--conversations']))
      .toThrow(/cannot be combined/i);
    expect(() => parseProjectGitCommand(['bind', '--project', 'p']))
      .toThrow(/--preview/i);
    expect(() => parseProjectGitCommand(['restore', '--project', 'p']))
      .toThrow(/--preview/i);
    expect(() => parseProjectGitCommand(['resolve', '--project', 'p', '--operation', 'op']))
      .toThrow(/--prompt-file/i);
    expect(() => parseProjectGitCommand(['sync', '--project', 'p', '--unknown']))
      .toThrow(/unknown flag/i);
    expect(() => parseProjectGitCommand(['show', '--project', 'p', '--commit', 'abc', '--output', 'copy.bin']))
      .toThrow(/--path/i);
    expect(() => parseProjectGitCommand(['show', '--project', 'p', '--commit', 'abc', '--path', 'a', '--overwrite']))
      .toThrow(/--output/i);
    expect(() => parseProjectGitCommand(['show', '--project', 'p', '--commit', 'abc', '--path', 'a', '--text', '--json']))
      .toThrow(/cannot be combined/i);
    expect(() => parseProjectGitCommand(['status', '--project', 'p', '--prompt-file', 'body.json']))
      .toThrow(/mutation/i);
    expect(() => parseProjectGitCommand(['retry', 'operation-1']))
      .toThrow(/unexpected positional/i);
  });

  it('rejects unsafe historical paths before URL construction', () => {
    for (const path of [
      'a//b', '.', '..', 'a/./b', 'a/../b', 'a\\b', `a${String.fromCharCode(1)}b`,
      '/etc/passwd', '//server/share/file', '\\\\server\\share\\file',
      'C:\\Windows\\system.ini', 'C:/Windows/system.ini',
    ]) {
      expect(() => parseProjectGitCommand([
        'show', '--project', 'p', '--commit', 'abc', '--path', path, '--json',
      ]), path).toThrow(/path/i);
    }
  });

  it('rejects every known flag that is inapplicable to the selected command', () => {
    const cases = [
      ['restore', '--project', 'p', '--preview', 'v', '--commit', 'different-target'],
      ['status', '--project', 'p', '--url', 'ssh://git/repo'],
      ['status', '--project', 'p', '--conversations'],
      ['sync', '--project', 'p', '--url', 'ssh://git/repo'],
      ['sync', '--project', 'p', '--text'],
      ['log', '--project', 'p', '--preview', 'v'],
    ];
    for (const args of cases) {
      expect(() => parseProjectGitCommand(args), args.join(' ')).toThrow(/not valid|not allowed/i);
    }
  });

  it('rejects explicitly empty string flags, including optional flags', () => {
    const cases = [
      ['log', '--project', 'p', '--cursor', ''],
      ['show', '--project', 'p', '--commit', 'abc', '--path='],
      ['enable', '--project', 'p', '--preview', ''],
      ['sync', '--project', 'p', '--idempotency-key='],
      ['status', '--project', 'p', '--daemon-url', ''],
    ];
    for (const args of cases) {
      expect(() => parseProjectGitCommand(args), args.join(' ')).toThrow(/empty|requires a value/i);
    }
  });

  it('reads a UTF-8 prompt file whose path contains spaces', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-git-cli-'));
    const promptPath = join(tempRoot, 'binding decisions.json');
    writeFileSync(promptPath, '{"confirmation":{"metadataSource":"local"}}\n', 'utf8');

    await expect(readProjectGitPromptFile(promptPath)).resolves.toBe(
      '{"confirmation":{"metadataSource":"local"}}\n',
    );
  });
});

describe('od git process boundary', () => {
  it('documents the complete command surface and daemon-owned Git credentials', async () => {
    const rootHelp = await runCli(['--help']);
    const result = await runCli(['git', '--help']);

    expect(rootHelp.code).toBe(0);
    expect(rootHelp.stdout).toMatch(/od git\b/);
    expect(result.code).toBe(0);
    for (const command of [
      'status', 'enable', 'bind-preview', 'bind', 'unbind', 'pause', 'resume', 'sync',
      'open', 'log', 'show', 'restore-preview', 'restore', 'conflicts', 'resolve',
      'operation', 'retry',
    ]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toMatch(/system Git/i);
    expect(result.stdout).toMatch(/credentials.*daemon/i);
    expect(result.stdout).toMatch(/open.*automatic synchronization/is);
    expect(result.stdout).toContain('--prompt-file <path|->');
    expect(result.stdout).toContain('--json');
  });

  it('uses the frozen preview basis, sends the real mutation contract, and polls the accepted operation', async () => {
    let restorePolls = 0;
    const stub = await startStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/project-git-operations/preview-1') {
        response.statusCode = 200;
        response.end(JSON.stringify(operation('preview-1')));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/projects/p%201/git/restore') {
        response.statusCode = 202;
        response.end(JSON.stringify({ operationId: 'restore-op' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/project-git-operations/restore-op') {
        response.statusCode = 200;
        response.end(JSON.stringify(operation(
          'restore-op',
          restorePolls++ === 0 ? 'running' : 'succeeded',
        )));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });

    const result = await runCli([
      'git', 'restore', '--project', 'p 1', '--preview', 'preview-1', '--json',
      '--idempotency-key', 'stable-restore-key', '--daemon-url', stub.baseUrl,
    ], { env: { OD_TOOL_TOKEN: 'private-token' } });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'restore-op', status: 'succeeded' });
    expect(result.stderr).toMatch(/restore-op.*running/i);
    expect(result.stderr).not.toContain('private-token');
    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/project-git-operations/preview-1'],
      ['POST', '/api/projects/p%201/git/restore'],
      ['GET', '/api/project-git-operations/restore-op'],
      ['GET', '/api/project-git-operations/restore-op'],
    ]);
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer private-token');
    expect(stub.requests[1]!.headers['idempotency-key']).toBe('stable-restore-key');
    expect(stub.requests[1]!.headers['x-od-project-revision']).toBe('7');
    expect(JSON.parse(stub.requests[1]!.body)).toEqual({
      previewId: 'preview-1',
      expectedProjectRevision: 7,
    });
  });

  it('executes every reviewed route through the real CLI entrypoint', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-git-cli-matrix-'));
    const bindPrompt = join(tempRoot, 'bind decisions.json');
    const resolvePrompt = join(tempRoot, 'resolve long text.json');
    const emptyPrompt = join(tempRoot, 'empty request.json');
    writeFileSync(bindPrompt, JSON.stringify({ confirmation: { metadataSource: 'local' } }), 'utf8');
    writeFileSync(resolvePrompt, JSON.stringify({
      basis: operation('basis').basis,
      resolutions: [{ conflictId: 'conflict-1', kind: 'edit', value: 'x'.repeat(16_384) }],
    }), 'utf8');
    writeFileSync(emptyPrompt, '{}', 'utf8');
    let accepted = 0;
    const stub = await startStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/projects/p%201/git') {
        response.statusCode = 200;
        response.end(JSON.stringify(projectState));
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/project-git-operations/')) {
        const id = decodeURIComponent(request.url.split('/').at(-1) ?? 'operation');
        response.statusCode = 200;
        response.end(JSON.stringify(operation(id)));
        return;
      }
      if (request.method === 'GET' && request.url?.includes('/history')) {
        response.statusCode = 200;
        response.end(JSON.stringify({ commits: [], nextCursor: null }));
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/files/src/a%20b.txt')) {
        response.statusCode = 200;
        response.end(JSON.stringify({ encoding: 'base64', content: Buffer.from('hello').toString('base64'), mediaType: 'text/plain' }));
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/conversations')) {
        response.statusCode = 200;
        response.end('null');
        return;
      }
      if (request.method === 'GET' && request.url?.endsWith('/conflicts')) {
        response.statusCode = 200;
        response.end(JSON.stringify({ conflicts: [] }));
        return;
      }
      if (request.method === 'GET' && request.url?.includes('/commits/')) {
        response.statusCode = 200;
        response.end(JSON.stringify(projectCommit));
        return;
      }
      if (request.method === 'POST' || request.method === 'PATCH') {
        accepted += 1;
        response.statusCode = 202;
        response.end(JSON.stringify({ operationId: `accepted-${accepted}` }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });

    const commands = [
      ['status', '--project', 'p 1'],
      ['enable', '--project', 'p 1'],
      ['enable', '--project', 'p 1', '--preview', 'enable-preview'],
      ['bind-preview', '--project', 'p 1', '--url', 'ssh://git/repo', '--branch', 'main'],
      ['bind', '--project', 'p 1', '--preview', 'bind-preview', '--prompt-file', bindPrompt],
      ['unbind', '--project', 'p 1'],
      ['pause', '--project', 'p 1'],
      ['resume', '--project', 'p 1'],
      ['sync', '--project', 'p 1', '--prompt-file', emptyPrompt],
      ['open', '--url', 'ssh://git/repo', '--branch', 'main'],
      ['log', '--project', 'p 1', '--cursor', 'next cursor', '--path', 'src/a b.txt'],
      ['show', '--project', 'p 1', '--commit', 'abc'],
      ['show', '--project', 'p 1', '--commit', 'abc', '--path', 'src/a b.txt'],
      ['show', '--project', 'p 1', '--commit', 'abc', '--conversations'],
      ['restore-preview', '--project', 'p 1', '--commit', 'abc'],
      ['restore', '--project', 'p 1', '--preview', 'restore-preview'],
      ['conflicts', '--project', 'p 1'],
      ['resolve', '--project', 'p 1', '--operation', 'conflict-operation', '--prompt-file', resolvePrompt],
      ['operation', 'inspect-operation'],
      ['retry', '--operation', 'retry-operation'],
    ];

    for (const command of commands) {
      const result = await runCli(['git', ...command, '--json', '--daemon-url', stub.baseUrl]);
      expect(result.code, `${command.join(' ')}\n${result.stderr}`).toBe(0);
      expect(() => JSON.parse(result.stdout), command.join(' ')).not.toThrow();
    }

    const mutations = stub.requests.filter(request => request.method === 'POST' || request.method === 'PATCH');
    expect(mutations.map(request => [request.method, request.url, JSON.parse(request.body)])).toEqual([
      ['POST', '/api/projects/p%201/git/enable', { mode: 'preview', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/enable', { mode: 'confirm', previewId: 'enable-preview', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/binding-preview', { url: 'ssh://git/repo', branch: 'main', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/bind', { previewId: 'bind-preview', confirmation: { metadataSource: 'local' }, expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/unbind', { expectedProjectRevision: 7 }],
      ['PATCH', '/api/projects/p%201/git', { action: 'pause', expectedProjectRevision: 7 }],
      ['PATCH', '/api/projects/p%201/git', { action: 'resume', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/sync', { expectedProjectRevision: 7 }],
      ['POST', '/api/import/git', { url: 'ssh://git/repo', branch: 'main' }],
      ['POST', '/api/projects/p%201/git/restore-preview', { oid: 'abc', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/restore', { previewId: 'restore-preview', expectedProjectRevision: 7 }],
      ['POST', '/api/projects/p%201/git/conflicts/resolve', {
        operationId: 'conflict-operation',
        basis: operation('basis').basis,
        resolutions: [{ conflictId: 'conflict-1', kind: 'edit', value: 'x'.repeat(16_384) }],
        expectedProjectRevision: 7,
      }],
      ['POST', '/api/project-git-operations/retry-operation/retry', {
        operationId: 'retry-operation', expectedProjectRevision: 7,
      }],
    ]);
    for (const mutation of mutations) {
      expect(mutation.headers['idempotency-key']).toMatch(/\S+/);
    }
  }, 45_000);

  it('reads resolution JSON from stdin and rejects invalid or duplicate JSON fields locally', async () => {
    const stub = await startStub((request, response) => {
      if (request.method === 'GET' && request.url === '/api/project-git-operations/preview-1') {
        response.statusCode = 200;
        response.end(JSON.stringify(operation('preview-1')));
        return;
      }
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { code: 'SHOULD_NOT_REACH', message: 'should not reach' } }));
    });
    const basis = operation('basis').basis;
    const valid = await runCli([
      'git', 'resolve', '--project', 'p', '--operation', 'operation-1', '--prompt-file', '-', '--json',
      '--daemon-url', stub.baseUrl,
    ], { input: JSON.stringify({ basis, resolutions: [] }) });
    expect(valid.code).not.toBe(2);
    expect(stub.requests).toHaveLength(1);

    stub.requests.length = 0;
    const invalid = await runCli([
      'git', 'resolve', '--project', 'p', '--operation', 'operation-1', '--prompt-file', '-', '--json',
      '--daemon-url', stub.baseUrl,
    ], { input: '{not json' });
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(stub.requests).toHaveLength(0);

    tempRoot = mkdtempSync(join(tmpdir(), 'od-git-cli-duplicate-'));
    const duplicatePath = join(tempRoot, 'duplicate.json');
    writeFileSync(duplicatePath, JSON.stringify({ previewId: 'different' }), 'utf8');
    const duplicate = await runCli([
      'git', 'bind', '--project', 'p', '--preview', 'preview-1', '--prompt-file', duplicatePath,
      '--daemon-url', stub.baseUrl,
    ]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toMatch(/duplicate|conflict/i);
    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/project-git-operations/preview-1'],
    ]);
  });

  it('rejects traversal and absolute path forms locally before any daemon request', async () => {
    const stub = await startStub((_request, response) => {
      response.statusCode = 200;
      response.end(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('should not be fetched').toString('base64'),
        mediaType: 'text/plain',
      }));
    });

    for (const path of [
      '../../../../../../health', '/api/health', '//server/share/file',
      '\\\\server\\share\\file', 'C:\\Windows\\system.ini', 'C:/Windows/system.ini',
    ]) {
      const result = await runCli([
        'git', 'show', '--project', 'p', '--commit', 'abc',
        '--path', path, '--json', '--daemon-url', stub.baseUrl,
      ]);
      expect(result.code, path).toBe(2);
      expect(result.stderr, path).toMatch(/path/i);
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('looks up every operation state exactly once and prints the complete DTO', async () => {
    const counts = new Map<string, number>();
    const requested = new Map<string, ReturnType<typeof operation>>();
    for (const status of ['queued', 'running', 'waiting', 'succeeded', 'failed'] as const) {
      requested.set(`op-${status}`, operation(`op-${status}`, status));
    }
    const stub = await startStub((request, response) => {
      const id = decodeURIComponent(request.url.split('/').at(-1) ?? '');
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      response.statusCode = 200;
      response.end(JSON.stringify(count === 1 ? requested.get(id) : operation(id)));
    });

    for (const [id, expectedOperation] of requested) {
      const result = await runCli([
        'git', 'operation', id, '--json', '--daemon-url', stub.baseUrl,
      ]);
      expect(result.code, `${id}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expectedOperation);
      expect(counts.get(id)).toBe(1);
    }
  });

  it('renders the complete explicit operation DTO in human mode for every state', async () => {
    const requested = new Map<string, unknown>();
    for (const status of ['queued', 'running', 'waiting', 'succeeded', 'failed'] as const) {
      const value = operation(`human-${status}`, status);
      requested.set(`human-${status}`, status === 'failed'
        ? {
            ...value,
            error: {
              ...value.error!,
              details: { conflictId: 'conflict-1', nextStep: 'resolve' },
            },
          }
        : value);
    }
    const counts = new Map<string, number>();
    const stub = await startStub((request, response) => {
      const id = decodeURIComponent(request.url.split('/').at(-1) ?? '');
      counts.set(id, (counts.get(id) ?? 0) + 1);
      response.statusCode = 200;
      response.end(JSON.stringify(requested.get(id)));
    });

    for (const [id, expectedOperation] of requested) {
      const result = await runCli([
        'git', 'operation', id, '--daemon-url', stub.baseUrl,
      ]);
      expect(result.code, `${id}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout), id).toEqual(expectedOperation);
      expect(counts.get(id)).toBe(1);
    }
  });

  it('rejects operation DTOs whose identity does not match the requested operation', async () => {
    const stub = await startStub((request, response) => {
      response.statusCode = 200;
      if (request.url === '/api/projects/p/git') {
        response.end(JSON.stringify(projectState));
        return;
      }
      if (request.method === 'POST') {
        response.statusCode = 202;
        response.end(JSON.stringify({ operationId: 'accepted-id' }));
        return;
      }
      response.end(JSON.stringify(operation('different-id')));
    });

    for (const command of [
      ['operation', 'lookup-id'],
      ['restore', '--project', 'p', '--preview', 'preview-id'],
      ['retry', '--operation', 'retry-id'],
      ['sync', '--project', 'p'],
    ]) {
      const result = await runCli(['git', ...command, '--json', '--daemon-url', stub.baseUrl]);
      expect(result.code, command.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/INVALID_RESPONSE/);
    }
    expect(stub.requests.filter(request => request.method === 'POST').map(request => request.url))
      .toEqual(['/api/projects/p/git/sync']);
  });

  it('retains the operation id and latest status when mutation polling times out', async () => {
    vi.useFakeTimers();
    const operationId = 'timeout-op?access_token=timeout-secret';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' && url.endsWith('/api/projects/p/git')) {
        return new Response(JSON.stringify(projectState), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'POST' && url.endsWith('/api/projects/p/git/sync')) {
        return new Response(JSON.stringify({ operationId }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(operation(operationId, 'running')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });

    const pending = runProjectGit([
      'sync', '--project', 'p', '--json', '--daemon-url', 'http://127.0.0.1:7456',
    ]);
    await vi.runAllTimersAsync();
    await pending;

    expect(process.exitCode).toBe(2);
    expect(stdout).toEqual([]);
    const failure = JSON.parse(stderr.at(-1) ?? '{}') as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    expect(failure.error).toMatchObject({
      code: 'OPERATION_PENDING',
      details: { operationId: 'timeout-op?access_token=[redacted]', latestStatus: 'running' },
    });
    expect(failure.error?.message).toMatch(/timeout-op.*running/i);
    expect(stderr.join('')).not.toContain('timeout-secret');
    expect(stderr.join('')).toContain('timeout-op?access_token=[redacted]');
  });

  it('keeps HTTP failures non-zero and redacts tokens and credential-bearing URLs from stderr', async () => {
    let status = 401;
    const stub = await startStub((_request, response) => {
      response.statusCode = status;
      response.end(JSON.stringify({
        error: {
          code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'PROJECT_STATE_CHANGED',
          message: 'credential https://user:secret@example.test/repo token private-token',
        },
      }));
    });
    for (const nextStatus of [401, 403, 409]) {
      status = nextStatus;
      const result = await runCli([
        'git', 'status', '--project', 'p', '--json', '--daemon-url', stub.baseUrl,
      ], { env: { OD_TOOL_TOKEN: 'private-token' } });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('private-token');
      expect(result.stderr).not.toContain('user:secret');
    }
  });

  it('preserves actionable error fields while redacting every credential form at stderr', async () => {
    const message = [
      'https://user:pass@example.test/repo?access_token=query-secret',
      'Authorization: Basic YmFkOmNyZWRlbnRpYWw=',
      'credential=assigned-secret',
      'Bearer bearer-secret',
      'tool-private-token',
    ].join(' ');
    const stub = await startStub((_request, response) => {
      response.statusCode = 409;
      response.end(JSON.stringify({
        error: {
          code: 'PROJECT_STATE_CHANGED',
          message,
          details: {
            operationId: 'op-1',
            requestId: 'detail-request-1',
            taskId: 'detail-task-1',
            status: 'running',
            nextStep: 'retry with password=detail-secret',
            nested: {
              password: 'plain-password-value',
              PASSWD: 'plain-passwd-value',
              accessToken: 'plain-access-token-value',
              'api-key': 'plain-api-key-value',
              secret: { deeply: 'plain-secret-object' },
              credential: ['plain-credential-array'],
              authorization: 'plain-authorization-value',
            },
            'tool-private-token': 'credential key',
          },
          retryable: true,
          requestId: 'request-1',
          taskId: 'task-1',
        },
      }));
    });

    const jsonResult = await runCli([
      'git', 'status', '--project', 'p', '--json', '--daemon-url', stub.baseUrl,
    ], { env: { OD_TOOL_TOKEN: 'tool-private-token' } });
    expect(jsonResult.code).toBe(1);
    const jsonFailure = JSON.parse(jsonResult.stderr) as { error: Record<string, unknown> };
    expect(jsonFailure.error).toMatchObject({
      code: 'PROJECT_STATE_CHANGED',
      details: {
        operationId: 'op-1',
        requestId: 'detail-request-1',
        taskId: 'detail-task-1',
        status: 'running',
        nested: {
          password: '[redacted]',
          PASSWD: '[redacted]',
          accessToken: '[redacted]',
          'api-key': '[redacted]',
          secret: '[redacted]',
          credential: '[redacted]',
          authorization: '[redacted]',
        },
      },
      retryable: true,
      requestId: 'request-1',
      taskId: 'task-1',
    });
    for (const secret of [
      'user:pass', 'query-secret', 'YmFkOmNyZWRlbnRpYWw=', 'assigned-secret',
      'bearer-secret', 'detail-secret', 'tool-private-token',
      'plain-password-value', 'plain-passwd-value', 'plain-access-token-value',
      'plain-api-key-value', 'plain-secret-object', 'plain-credential-array',
      'plain-authorization-value',
    ]) {
      expect(jsonResult.stderr).not.toContain(secret);
    }

    const humanResult = await runCli([
      'git', 'status', '--project', 'p', '--daemon-url', stub.baseUrl,
    ], { env: { OD_TOOL_TOKEN: 'tool-private-token' } });
    expect(humanResult.code).toBe(1);
    expect(humanResult.stderr).toMatch(/PROJECT_STATE_CHANGED/);
    expect(humanResult.stderr).toMatch(/retryable/i);
    expect(humanResult.stderr).toContain('request-1');
    expect(humanResult.stderr).toContain('task-1');
    expect(humanResult.stderr).toContain('op-1');
    expect(humanResult.stderr).toContain('detail-request-1');
    expect(humanResult.stderr).toContain('detail-task-1');
    expect(() => JSON.parse(humanResult.stderr)).toThrow();
    expect(humanResult.stderr).not.toMatch(
      /query-secret|assigned-secret|bearer-secret|detail-secret|tool-private-token|plain-[a-z-]+-value|plain-secret-object|plain-credential-array/u,
    );
  });

  it('rejects malformed operation, status, and history success DTOs immediately', async () => {
    let operationRequests = 0;
    const stub = await startStub((request, response) => {
      response.statusCode = 200;
      if (request.url === '/api/projects/p/git') {
        response.end(JSON.stringify({ projectRevision: 7 }));
        return;
      }
      if (request.url === '/api/projects/p/git/history') {
        response.end(JSON.stringify({ commits: 'not-an-array', nextCursor: null }));
        return;
      }
      operationRequests += 1;
      response.end(JSON.stringify(operationRequests === 1
        ? { ...operation('bad-op'), status: 'mystery' }
        : operation('bad-op')));
    });

    for (const command of [
      ['status', '--project', 'p'],
      ['log', '--project', 'p'],
      ['operation', 'bad-op'],
    ]) {
      const result = await runCli(['git', ...command, '--json', '--daemon-url', stub.baseUrl]);
      expect(result.code, command.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/INVALID_RESPONSE/);
    }
    expect(operationRequests).toBe(1);
  });

  it('rejects a mutation response that is not the reviewed 202 acceptance contract', async () => {
    const stub = await startStub((request, response) => {
      if (request.method === 'GET') {
        response.statusCode = 200;
        response.end(JSON.stringify(projectState));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ operationId: 'not-accepted' }));
    });

    const result = await runCli([
      'git', 'sync', '--project', 'p', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/projects/p/git'],
      ['POST', '/api/projects/p/git/sync'],
    ]);
  });

  it('never prints historical binary bytes and requires explicit overwrite', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-git-cli-output-'));
    const outputPath = join(tempRoot, 'copy.bin');
    const bytes = Buffer.from([0, 1, 2, 255]);
    const stub = await startStub((_request, response) => {
      response.statusCode = 200;
      response.end(JSON.stringify({ encoding: 'base64', content: bytes.toString('base64'), mediaType: 'application/octet-stream' }));
    });

    const json = await runCli([
      'git', 'show', '--project', 'p', '--commit', 'abc', '--path', 'asset.bin', '--json',
      '--daemon-url', stub.baseUrl,
    ]);
    expect(JSON.parse(json.stdout)).toEqual({
      encoding: 'base64', content: bytes.toString('base64'), mediaType: 'application/octet-stream',
    });
    expect(json.stdout).not.toContain(bytes.toString('binary'));

    writeFileSync(outputPath, 'keep', 'utf8');
    const refused = await runCli([
      'git', 'show', '--project', 'p', '--commit', 'abc', '--path', 'asset.bin', '--output', outputPath,
      '--daemon-url', stub.baseUrl,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/exists|overwrite/i);

    const overwritten = await runCli([
      'git', 'show', '--project', 'p', '--commit', 'abc', '--path', 'asset.bin', '--output', outputPath, '--overwrite', '--json',
      '--daemon-url', stub.baseUrl,
    ]);
    expect(overwritten.code).toBe(0);
    expect(JSON.parse(overwritten.stdout)).toMatchObject({ outputPath, bytes: 4 });
    expect(Buffer.from(await import('node:fs/promises').then(fs => fs.readFile(outputPath)))).toEqual(bytes);
  });

  it('rejects malformed base64 before mutating an output file', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'od-git-cli-invalid-base64-'));
    const outputPath = join(tempRoot, 'copy.bin');
    writeFileSync(outputPath, 'keep', 'utf8');
    const stub = await startStub((_request, response) => {
      response.statusCode = 200;
      response.end(JSON.stringify({
        encoding: 'base64', content: '%%%not-base64%%%', mediaType: 'application/octet-stream',
      }));
    });

    const result = await runCli([
      'git', 'show', '--project', 'p', '--commit', 'abc', '--path', 'asset.bin',
      '--output', outputPath, '--overwrite', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/INVALID_RESPONSE|base64/i);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep');
  });
});
