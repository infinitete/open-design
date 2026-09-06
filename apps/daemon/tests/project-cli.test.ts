import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

let stub: StubServer | null = null;
let tempRoot = '';

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

async function startProjectStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw,
      };
      requests.push(captured);

      res.setHeader('content-type', 'application/json');
      if (captured.method === 'POST' && captured.url === '/api/projects/source-project/design-system-copy') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          project: { id: 'design-copy-1', name: 'Design Copy' },
          designSystemId: 'user:design-copy-1',
          conversationId: 'conversation-design-copy',
        }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/source-project/duplicate') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          project: { id: 'duplicate-1', name: 'Duplicate Copy' },
          conversationId: 'conversation-duplicate',
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          project: { id: 'project-1', name: 'Project One', workspaceId: 'ws-1' },
          resolvedDir: '/tmp/projects/project-1',
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1/git') {
        res.statusCode = 200;
        res.end(JSON.stringify({ projectRevision: 11 }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-2/git') {
        res.statusCode = 200;
        res.end(JSON.stringify({ projectRevision: 22 }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1/files') {
        res.statusCode = 200;
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/project-1/files') {
        res.statusCode = 200;
        res.end(JSON.stringify({ file: { name: 'asset.bin' } }));
        return;
      }
      if (captured.method === 'DELETE' && captured.url === '/api/projects/project-1/files/old.txt') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/project-1/files/index.html/versions') {
        res.statusCode = 201;
        res.end(JSON.stringify({ version: { id: 'version-new', version: 2 } }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/project-1/files/index.html/versions/version-1/restore') {
        res.statusCode = 200;
        res.end(JSON.stringify({ version: { id: 'version-restored', version: 3 } }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/project-1/conversations') {
        res.statusCode = 201;
        res.end(JSON.stringify({ conversation: { id: 'conversation-new', sessionMode: 'design' } }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/runs') {
        res.statusCode = 202;
        res.end(JSON.stringify({ runId: 'run-new' }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/runs/resume-run') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          id: 'resume-run', resumable: true, projectId: 'project-1',
          conversationId: 'conversation-1', agentId: 'codex',
        }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/project-1/scenario/restore-automatic') {
        res.statusCode = 200;
        res.end(JSON.stringify({ changed: true, scenarioBinding: { pluginId: 'plugin', snapshotId: 'snapshot' } }));
        return;
      }
      if (captured.method === 'DELETE' && captured.url === '/api/projects/project-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (
        captured.method === 'DELETE'
        && captured.url === '/api/projects/project-1/files/nested%2Findex.html/publish-public'
      ) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          slug: 'legacy-public-slug',
          fileName: 'nested/index.html',
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspaces/ws-1/projects?view=team') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          projects: [
            { id: 'project-1', name: 'Project One', visibility: 'team', resourceState: 'active' },
          ],
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspaces/ws-1/projects') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          projects: [
            { id: 'project-1', name: 'Project One', skillId: null },
          ],
        }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/workspace/invite') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          results: [{ email: 'teammate@example.com', ok: true, inviteId: 'invite-1' }],
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspace/projects/team') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          projects: [{ projectId: 'team-project-1', displayName: 'Team Project' }],
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspace/members') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          members: [{ memberId: 'member-1', displayName: 'Member One', role: 'admin' }],
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspace/skills/team') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ids: ['team-skill'], resources: [{ id: 'team-skill' }] }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/workspaces/ws-1/projects/batch-delete') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, deletedProjectIds: ['project-1', 'project-2'] }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/workspaces/ws-stale/projects/batch-delete') {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: { code: 'PROJECT_STATE_CHANGED', message: 'project changed' } }));
        return;
      }
      if (captured.method === 'POST' && captured.url?.startsWith('/api/brands/brand-1/')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ id: 'brand-1', status: 'ready', brand: { name: 'Brand One' } }));
        return;
      }
      // Workspace directory used by `od project list` to auto-resolve the
      // signed-in workspace when no explicit --workspace/--workspace-member
      // is supplied (#6679). Mirrors the personal workspace shape returned
      // by the real daemon GET /api/workspace/directory.
      if (captured.method === 'GET' && captured.url === '/api/workspace/directory') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          items: [
            {
              workspaceId: 'ws-personal',
              workspaceName: 'Personal',
              workspaceType: 'personal',
              workspaceMemberId: 'mem-personal',
              role: 'owner',
              memberStatus: 'active',
              lifecycleState: 'active',
            },
          ],
          activeWorkspaceId: null,
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/workspaces/ws-personal/projects') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          projects: [
            { id: 'bound-project-1', name: 'Bound Project One', skillId: 'skill-1' },
            { id: 'bound-project-2', name: 'Bound Project Two', skillId: 'skill-2' },
          ],
        }));
        return;
      }
      // An unbound project catalog (no signed-in workspace / non-vela).
      if (captured.method === 'GET' && captured.url === '/api/projects') {
        res.statusCode = 200;
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'unexpected-request', message: captured.url } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.OD_PROJECT_REVISION;
  Object.assign(env, envOverrides);
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
    if (input !== undefined) child.stdin?.end(input);
  });
}

describe('od project CLI', () => {
  it('creates a design-system project with prompt-file content and JSON output', async () => {
    stub = await startProjectStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-project-cli-'));
    const promptPath = join(tempRoot, 'prompt.md');
    writeFileSync(promptPath, 'Use this workspace as the brand source.\n', 'utf8');

    const result = await runCli([
      'project',
      'create-design-system',
      'source-project',
      '--name',
      'Design Copy',
      '--prompt-file',
      promptPath,
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      project: { id: 'design-copy-1', name: 'Design Copy' },
      designSystemId: 'user:design-copy-1',
      conversationId: 'conversation-design-copy',
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/source-project/design-system-copy',
    });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      name: 'Design Copy',
      pendingPrompt: 'Use this workspace as the brand source.\n',
    });
  });

  it('duplicates a project and prints the human-readable result', async () => {
    stub = await startProjectStubServer();

    const result = await runCli([
      'project',
      'duplicate',
      'source-project',
      '--name',
      'Duplicate Copy',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      '[project] duplicated source-project as duplicate-1 (conversation conversation-duplicate)\n',
    );
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/source-project/duplicate',
    });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ name: 'Duplicate Copy' });
  });

  it('captures one project epoch before files, project, conversation, chat, and run mutations', async () => {
    stub = await startProjectStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-project-epoch-cli-'));
    const uploadPath = join(tempRoot, 'asset.bin');
    writeFileSync(uploadPath, Buffer.from([0, 1, 2, 3]));

    const commands = [
      ['files', 'upload', 'project-1', uploadPath, '--as', 'asset.bin'],
      ['project', 'delete', 'project-1'],
      ['conversation', 'new', 'project-1', '--title', 'Conversation'],
      ['chat', 'new', '--project', 'project-1', '--title', 'Chat'],
      ['run', 'start', '--project', 'project-1', '--message', 'Create it'],
    ];
    for (const command of commands) {
      const result = await runCli([...command, '--json', '--daemon-url', stub.baseUrl]);
      expect(result.code, `${command.join(' ')}\n${result.stderr}`).toBe(0);
    }
    const write = await runCli([
      'files', 'write', 'project-1', 'notes.txt', '--json', '--daemon-url', stub.baseUrl,
    ], {}, 'frozen stdin payload');
    expect(write.code, write.stderr).toBe(0);

    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/files'],
      ['GET', '/api/projects/project-1/git'],
      ['DELETE', '/api/projects/project-1'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/conversations'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/conversations'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/runs'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/files'],
    ]);
    const mutations = stub.requests.filter(request => request.method !== 'GET');
    expect(mutations).toHaveLength(6);
    for (const mutation of mutations) {
      expect(mutation.headers['x-od-project-revision']).toBe('11');
    }
    expect(JSON.parse(mutations.at(-1)!.body)).toMatchObject({
      name: 'notes.txt', content: 'frozen stdin payload', encoding: 'utf8',
    });
  }, 30_000);

  it('does not refresh and replay an old CLI payload after PROJECT_STATE_CHANGED', async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/projects/project-1/git') {
        res.statusCode = 200;
        res.end(JSON.stringify({ projectRevision: 11 }));
        return;
      }
      res.statusCode = 409;
      res.end(JSON.stringify({ error: { code: 'PROJECT_STATE_CHANGED', message: 'project changed' } }));
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub server has no address');
    stub = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests: [],
      close: () => new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())),
    };

    const result = await runCli([
      'conversation', 'new', 'project-1', '--title', 'Old payload', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).not.toBe(0);
    expect(requests).toBe(2);
    expect(result.stderr).toContain('PROJECT_STATE_CHANGED');
  });

  it('carries the captured epoch through every remaining content-write and run-start branch', async () => {
    stub = await startProjectStubServer();
    const commands = [
      ['files', 'delete', 'project-1', 'old.txt'],
      ['files', 'version-create', 'project-1', 'index.html', '--prompt', 'checkpoint'],
      ['files', 'version-restore', 'project-1', 'index.html', 'version-1', '--prompt', 'restore'],
      ['project', 'restore-automatic-scenario', 'project-1'],
      ['run', 'continue', 'resume-run', '--message', 'continue'],
      ['run', 'redesign', '--project', 'project-1', '--conversation', 'conversation-1', '--message', 'redesign'],
    ];
    for (const command of commands) {
      const result = await runCli([...command, '--json', '--daemon-url', stub.baseUrl]);
      expect(result.code, `${command.join(' ')}\n${result.stderr}`).toBe(0);
    }

    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/projects/project-1/git'],
      ['DELETE', '/api/projects/project-1/files/old.txt'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/files/index.html/versions'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/projects/project-1/files/index.html/versions/version-1/restore'],
      ['GET', '/api/projects/project-1/git'],
      ['GET', '/api/projects/project-1'],
      ['POST', '/api/projects/project-1/scenario/restore-automatic'],
      ['GET', '/api/runs/resume-run'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/runs'],
      ['GET', '/api/projects/project-1/git'],
      ['POST', '/api/runs'],
    ]);
    for (const mutation of stub.requests.filter(request => request.method === 'POST' || request.method === 'DELETE')) {
      expect(mutation.headers['x-od-project-revision']).toBe('11');
    }
  }, 30_000);

  it('propagates one frozen brand epoch from a flag or run environment and rejects disagreement', async () => {
    stub = await startProjectStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-brand-epoch-cli-'));
    const htmlPath = join(tempRoot, 'rendered page.html');
    writeFileSync(htmlPath, '<main>Brand</main>', 'utf8');

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [
      { args: ['brand', 'continue', 'brand-1'], env: { OD_PROJECT_REVISION: '31' } },
      { args: ['brand', 'preview', 'brand-1', '--expected-project-revision', '31'] },
      {
        args: ['brand', 'finalize', 'brand-1', '--expected-project-revision', '31'],
        env: { OD_PROJECT_REVISION: '31' },
      },
      {
        args: [
          'brand', 'extract-from-html', 'brand-1', '--html-file', htmlPath,
          '--expected-project-revision', '31',
        ],
      },
    ];
    for (const command of commands) {
      const result = await runCli([
        ...command.args, '--json', '--daemon-url', stub.baseUrl,
      ], command.env);
      expect(result.code, `${command.args.join(' ')}\n${result.stderr}`).toBe(0);
    }

    const brandRequests = stub.requests.filter(request => request.url.startsWith('/api/brands/'));
    expect(brandRequests).toHaveLength(4);
    for (const request of brandRequests) {
      expect(request.headers['x-od-project-revision']).toBe('31');
    }

    const beforeMismatch = stub.requests.length;
    const mismatch = await runCli([
      'brand', 'preview', 'brand-1', '--expected-project-revision', '32',
      '--json', '--daemon-url', stub.baseUrl,
    ], { OD_PROJECT_REVISION: '31' });
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toMatch(/revision.*agree|mismatch/i);
    expect(stub.requests).toHaveLength(beforeMismatch);

    for (const invalid of ['', '-1', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const result = await runCli([
        'brand', 'continue', 'brand-1', '--expected-project-revision', invalid,
        '--json', '--daemon-url', stub.baseUrl,
      ]);
      expect(result.code).toBe(2);
      expect(stub.requests).toHaveLength(beforeMismatch);
    }
  }, 30_000);

  it('documents the brand epoch handoff for independent and run-scoped callers', async () => {
    const help = await runCli(['brand', '--help']);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--expected-project-revision');
    expect(help.stdout).toContain('OD_PROJECT_REVISION');
    expect(help.stdout).toMatch(/git status/i);
  });

  it('captures a deduplicated revision map before workspace batch delete and never refreshes on 409', async () => {
    stub = await startProjectStubServer();
    const args = [
      'workspace', 'projects', 'batch-delete', '--workspace', 'ws-1', '--member', 'member-1',
      '--project', 'project-1', '--project', 'project-2', '--project', 'project-1',
      '--json', '--daemon-url', stub.baseUrl,
    ];
    const result = await runCli(args);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/projects/project-1/git'],
      ['GET', '/api/projects/project-2/git'],
      ['POST', '/api/workspaces/ws-1/projects/batch-delete'],
    ]);
    expect(JSON.parse(stub.requests[2]!.body)).toEqual({
      projectIds: ['project-1', 'project-2'],
      expectedProjectRevisions: { 'project-1': 11, 'project-2': 22 },
    });
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBe('ws-1');
      expect(request.headers['x-od-workspace-member-id']).toBe('member-1');
    }

    stub.requests.length = 0;
    const stale = await runCli([
      ...args.map(value => value === 'ws-1' ? 'ws-stale' : value),
    ]);
    expect(stale.code).not.toBe(0);
    expect(stub.requests.map(request => [request.method, request.url])).toEqual([
      ['GET', '/api/projects/project-1/git'],
      ['GET', '/api/projects/project-2/git'],
      ['POST', '/api/workspaces/ws-stale/projects/batch-delete'],
    ]);
  }, 30_000);
});
