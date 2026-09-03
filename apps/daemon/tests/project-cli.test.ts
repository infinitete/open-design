import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
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
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1/files') {
        res.statusCode = 200;
        res.end(JSON.stringify({ files: [] }));
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

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
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
});
