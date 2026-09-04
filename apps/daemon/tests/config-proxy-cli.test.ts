import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder(fn: (request: CapturedRequest) => { status: number; body: unknown }): void;
  close(): Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder: (request: CapturedRequest) => { status: number; body: unknown } = (_request) => ({
    status: 200,
    body: { config: { agentNetwork: {} } },
  });
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const captured = {
        method: request.method ?? '',
        url: request.url ?? '',
        body,
      };
      requests.push(captured);
      const result = responder(captured);
      response.statusCode = result.status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder(fn) { responder = fn; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function runCli(
  args: string[],
  options: { stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = execFile(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args],
      { cwd: DAEMON_ROOT, env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error ? (error as { code?: number | null }).code ?? 1 : 0,
        });
      },
    );
    if (options.stdin !== undefined) child.stdin?.write(options.stdin);
    child.stdin?.end();
  });
}

describe('od config proxy CLI', () => {
  let stub: StubServer;
  let tempDir: string;

  beforeAll(async () => {
    stub = await startStubServer();
    tempDir = await mkdtemp(join(tmpdir(), 'od-config-proxy-'));
  });

  afterAll(async () => {
    await stub.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.setResponder((request) => request.method === 'GET'
      ? {
          status: 200,
          body: {
            config: {
              agentNetwork: {
                claude: { mode: 'direct' },
                codex: {
                  mode: 'custom',
                  proxyUrl: 'http://old.test:8080',
                  username: 'alice',
                  passwordConfigured: true,
                },
              },
            },
          },
        }
      : request.url === '/api/test/connection'
        ? { status: 200, body: { ok: true, kind: 'success', latencyMs: 12, agentName: 'Codex' } }
        : {
            status: 200,
            body: {
              config: {
                agentNetwork: Object.fromEntries(Object.entries(
                  (JSON.parse(request.body) as { agentNetwork: Record<string, Record<string, unknown>> })
                    .agentNetwork,
                ).map(([agentId, policy]) => [agentId, policy.mode === 'custom'
                  ? {
                      ...policy,
                      passwordConfigured: typeof policy.password === 'string'
                        || agentId === 'codex',
                      password: undefined,
                    }
                  : policy])),
              },
            },
          });
  });

  it('gets one public policy and reports inherit for an absent entry', async () => {
    const custom = await runCli([
      'config', 'proxy', 'get', 'codex', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(custom.code).toBe(0);
    expect(JSON.parse(custom.stdout)).toEqual({
      mode: 'custom',
      proxyUrl: 'http://old.test:8080',
      username: 'alice',
      passwordConfigured: true,
    });

    const inherited = await runCli([
      'config', 'proxy', 'get', 'gemini', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(inherited.code).toBe(0);
    expect(JSON.parse(inherited.stdout)).toEqual({ mode: 'inherit' });
  });

  it('prints only public policy fields if a daemon response contains a credential', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        config: {
          agentNetwork: {
            codex: {
              mode: 'custom',
              proxyUrl: 'http://proxy.test:8080',
              username: 'alice',
              password: 'daemon-response-secret',
              passwordConfigured: true,
            },
          },
        },
      },
    }));
    const result = await runCli([
      'config', 'proxy', 'get', 'codex', '--json', '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('daemon-response-secret');
    expect(JSON.parse(result.stdout)).toEqual({
      mode: 'custom',
      proxyUrl: 'http://proxy.test:8080',
      username: 'alice',
      passwordConfigured: true,
    });
  });

  it('removes URL credentials from proxy get JSON and human output', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        config: {
          agentNetwork: {
            codex: {
              mode: 'custom',
              proxyUrl: 'http://alice:malicious-url-secret@proxy.test:8080/private?token=secret',
              username: 'alice',
              passwordConfigured: true,
            },
          },
        },
      },
    }));

    const jsonResult = await runCli([
      'config', 'proxy', 'get', 'codex', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(jsonResult.code).toBe(0);
    expect(`${jsonResult.stdout}${jsonResult.stderr}`).not.toContain('malicious-url-secret');
    expect(JSON.parse(jsonResult.stdout).proxyUrl).toBe('http://proxy.test:8080');

    const humanResult = await runCli([
      'config', 'proxy', 'get', 'codex', '--daemon-url', stub.baseUrl,
    ]);
    expect(humanResult.code).toBe(0);
    expect(`${humanResult.stdout}${humanResult.stderr}`).not.toContain('malicious-url-secret');
    expect(humanResult.stdout).toContain('custom http://proxy.test:8080');
  });

  it('sets an authenticated custom policy without printing the password', async () => {
    const passwordFile = join(tempDir, 'proxy-password.txt');
    await writeFile(passwordFile, 'proxy-password-value\n');
    const result = await runCli([
      'config', 'proxy', 'set', 'codex',
      '--mode', 'custom',
      '--url', 'http://proxy.test:8080',
      '--username', 'alice',
      '--password-file', passwordFile,
      '--json',
      '--daemon-url', stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('proxy-password-value');
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/app-config',
      'PUT /api/app-config',
    ]);
    expect(JSON.parse(stub.requests.at(-1)!.body)).toEqual({
      agentNetwork: {
        claude: { mode: 'direct' },
        codex: {
          mode: 'custom',
          proxyUrl: 'http://proxy.test:8080',
          username: 'alice',
          password: 'proxy-password-value',
        },
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      mode: 'custom',
      proxyUrl: 'http://proxy.test:8080',
      username: 'alice',
      passwordConfigured: true,
    });
  });

  it('removes URL credentials from post-set JSON and human output', async () => {
    stub.setResponder((request) => request.method === 'GET'
      ? {
          status: 200,
          body: { config: { agentNetwork: {} } },
        }
      : {
          status: 200,
          body: {
            config: {
              agentNetwork: {
                codex: {
                  mode: 'custom',
                  proxyUrl: 'socks5://alice:malicious-set-url-secret@proxy.test:1080/private',
                  passwordConfigured: true,
                },
              },
            },
          },
        });

    const setArgs = [
      'config', 'proxy', 'set', 'codex',
      '--mode', 'custom', '--url', 'socks5://proxy.test:1080',
      '--daemon-url', stub.baseUrl,
    ];
    const jsonResult = await runCli([...setArgs, '--json']);
    expect(jsonResult.code).toBe(0);
    expect(`${jsonResult.stdout}${jsonResult.stderr}`).not.toContain('malicious-set-url-secret');
    expect(JSON.parse(jsonResult.stdout).proxyUrl).toBe('socks5://proxy.test:1080');

    const humanResult = await runCli(setArgs);
    expect(humanResult.code).toBe(0);
    expect(`${humanResult.stdout}${humanResult.stderr}`).not.toContain('malicious-set-url-secret');
    expect(humanResult.stdout).toContain('custom socks5://proxy.test:1080');
  });

  it('reads a password from stdin once and preserves the saved public fields', async () => {
    const result = await runCli([
      'config', 'proxy', 'set', 'codex',
      '--mode', 'custom', '--password-file', '-',
      '--json', '--daemon-url', stub.baseUrl,
    ], { stdin: 'stdin-secret\r\n' });

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('stdin-secret');
    const update = JSON.parse(stub.requests.at(-1)!.body);
    expect(update.agentNetwork.codex).toEqual({
      mode: 'custom',
      proxyUrl: 'http://old.test:8080',
      username: 'alice',
      password: 'stdin-secret',
    });
  });

  it.each([
    ['unset', ['unset', 'codex']],
    ['inherit', ['set', 'codex', '--mode', 'inherit']],
  ])('%s removes the selected entry while preserving the rest of the map', async (_name, command) => {
    const result = await runCli([
      'config', 'proxy', ...command, '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(stub.requests.at(-1)!.body)).toEqual({
      agentNetwork: { claude: { mode: 'direct' } },
    });
    expect(JSON.parse(result.stdout)).toEqual({ mode: 'inherit' });
  });

  it('tests the saved daemon policy without fetching or persisting config', async () => {
    const result = await runCli([
      'config', 'proxy', 'test', 'codex', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, kind: 'success' });
    expect(stub.requests).toEqual([{
      method: 'POST',
      url: '/api/test/connection',
      body: JSON.stringify({ mode: 'agent', agentId: 'codex' }),
    }]);
  });

  it('allowlists proxy test JSON and human output from a malicious success response', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        ok: true,
        kind: 'success',
        latencyMs: 12,
        agentName: 'Codex',
        password: 'malicious-success-secret',
        detail: 'credential=malicious-success-secret',
        diagnostics: {
          phase: 'connection_smoke_test',
          stdoutTail: 'malicious-success-secret',
        },
      },
    }));

    const jsonResult = await runCli([
      'config', 'proxy', 'test', 'codex', '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(jsonResult.code).toBe(0);
    expect(`${jsonResult.stdout}${jsonResult.stderr}`).not.toContain('malicious-success-secret');
    expect(JSON.parse(jsonResult.stdout)).toEqual({
      ok: true,
      kind: 'success',
      latencyMs: 12,
      agentName: 'Codex',
    });

    const humanResult = await runCli([
      'config', 'proxy', 'test', 'codex', '--daemon-url', stub.baseUrl,
    ]);
    expect(humanResult.code).toBe(0);
    expect(`${humanResult.stdout}${humanResult.stderr}`).not.toContain('malicious-success-secret');
    expect(humanResult.stdout).toContain('[config] proxy test codex: ok (success)');
  });

  it('maps structured HTTP error codes while replacing daemon-provided messages', async () => {
    stub.setResponder(() => ({
      status: 400,
      body: { error: { code: 'missing-input', message: 'agent policy rejected' } },
    }));
    const result = await runCli([
      'config', 'proxy', 'get', 'codex', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(67);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: 'missing-input',
        message: 'Proxy configuration request failed (HTTP 400)',
      },
    });
  });

  it('preserves structured HTTP exit mapping without exposing malicious proxy error fields', async () => {
    stub.setResponder(() => ({
      status: 400,
      body: {
        error: {
          code: 'missing-input',
          message: 'cannot use http://alice:malicious-error-secret@proxy.test:8080',
          data: {
            password: 'malicious-error-secret',
            proxyUrl: 'http://alice:malicious-error-secret@proxy.test:8080',
          },
        },
      },
    }));

    const result = await runCli([
      'config', 'proxy', 'test', 'codex', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(67);
    expect(`${result.stdout}${result.stderr}`).not.toContain('malicious-error-secret');
    expect(result.stderr).not.toContain('alice:');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'missing-input',
        message: 'Proxy configuration request failed (HTTP 400)',
        data: {},
      },
    });
  });

  it('replaces an unknown credential-bearing daemon error code', async () => {
    stub.setResponder(() => ({
      status: 400,
      body: {
        error: {
          code: 'malicious-code-secret',
          message: 'otherwise safe',
        },
      },
    }));

    const result = await runCli([
      'config', 'proxy', 'test', 'codex', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('malicious-code-secret');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'proxy-request-failed',
        message: 'Proxy configuration request failed (HTTP 400)',
        data: {},
      },
    });
  });

  it.each([
    ['missing CLI ID', ['get']],
    ['unknown flag', ['get', 'codex', '--bogus']],
    ['raw password flag', ['set', 'codex', '--mode', 'custom', '--password', 'secret']],
    ['missing custom URL', ['set', 'new-cli', '--mode', 'custom']],
    ['conflicting password actions', [
      'set', 'codex', '--mode', 'custom', '--password-file', '-', '--clear-password',
    ]],
  ])('exits 2 without HTTP or secret output for %s', async (_name, command) => {
    const result = await runCli([
      'config', 'proxy', ...command, '--daemon-url', stub.baseUrl,
    ], { stdin: 'usage-secret\n' });
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain('usage-secret');
    if (_name === 'missing custom URL') {
      expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'GET /api/app-config',
      ]);
    } else {
      expect(stub.requests).toHaveLength(0);
    }
  });

  it('documents the proxy command group in config help', async () => {
    const result = await runCli(['config', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('od config proxy get <cli-id>');
    expect(result.stdout).toContain('--password-file <path|->');
    expect(result.stdout).not.toContain('--password <');
  });
});
