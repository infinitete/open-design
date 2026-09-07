import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ProjectGitAccepted, ProjectGitOperation, ProjectGitState } from '@open-design/contracts';
import { e2eWorkspaceRoot } from './tools-dev/runtime.ts';
import { T } from './timeouts.ts';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function createProjectGitE2eFixture(root: string) {
  const fixtureRoot = join(root, `git-${randomUUID()}`);
  const sshBinDir = join(fixtureRoot, 'bin');
  const bare = join(fixtureRoot, 'remote.git');
  const cloneA = join(fixtureRoot, 'clone-a');
  const cloneB = join(fixtureRoot, 'clone-b');
  const xdg = join(fixtureRoot, 'xdg');
  const repoId = randomUUID();
  const registry = join(fixtureRoot, 'repos.json');
  const realGit = (await execute('which', ['git'])).stdout.trim();
  await mkdir(sshBinDir, { recursive: true });
  await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(join(xdg, 'git', 'config'), '[user]\n name = Project Git E2E\n email = project-git@example.invalid\n');
  await writeFile(registry, JSON.stringify({ repos: { [repoId]: bare }, realGit, identity: join(xdg, 'git', 'config') }));
  await writeFile(join(sshBinDir, 'ssh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./project-git-ssh.ts', import.meta.url)))} "$@"\n`);
  await chmod(join(sshBinDir, 'ssh'), 0o755);
  await writeFile(join(sshBinDir, 'git'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./project-git-ssh.ts', import.meta.url)))} --git-launcher "$@"\n`);
  await chmod(join(sshBinDir, 'git'), 0o755);
  const env = { XDG_CONFIG_HOME: xdg, PATH: `${sshBinDir}${delimiter}${process.env.PATH ?? ''}`, OD_PROJECT_GIT_FIXTURE_REGISTRY: registry };
  const git = async (cwd: string, ...args: string[]) => (await execute(realGit, ['-C', cwd, ...args], {
    env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: join(xdg, 'git', 'config'), GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    timeout: T.long,
  })).stdout.trim();
  await git(fixtureRoot, 'init', '--bare', '--initial-branch=main', bare);
  await git(fixtureRoot, 'clone', bare, cloneA);
  await git(fixtureRoot, 'clone', bare, cloneB);
  const authServer = async () => {
    const ca = join(fixtureRoot, 'https-cert.pem'); const key = join(fixtureRoot, 'https-key.pem');
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { timeout: T.long });
    await chmod(key, 0o600);
    const requests: string[] = [];
    const server = createServer({ key: await readFile(key), cert: await readFile(ca) }, (request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(401, { 'www-authenticate': 'Basic realm="Project Git fixture"' }); response.end('Authentication required');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTPS fixture has no address');
    const url = `https://127.0.0.1:${address.port}/repo`;
    await writeFile(registry, JSON.stringify({ repos: { [repoId]: bare }, realGit, identity: join(xdg, 'git', 'config'), https: { url, ca } }));
    return { url, ca, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  };
  return { bare, cloneA, cloneB, realGit, sshBinDir, remoteUrl: `ssh://git@project-git.invalid/${repoId}`, env, git, authServer,
    // The suite owns scratch retention and cleanup, including failed fixtures.
    close: async () => {},
  };
}

export async function requestJson<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(path, baseUrl), { ...init, signal: init.signal ?? AbortSignal.timeout(T.long),
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...init.headers } });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) as T }; }
  catch { throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status}: ${text.slice(0, 300)}`); }
}

export async function waitOperation(baseUrl: string, id: string): Promise<ProjectGitOperation> {
  const deadline = Date.now() + T.xlong;
  let latest: ProjectGitOperation | undefined;
  while (Date.now() < deadline) {
    const result = await requestJson<ProjectGitOperation>(baseUrl, `/api/project-git-operations/${id}`);
    if (result.status !== 200) throw new Error(`operation ${id}: ${JSON.stringify(result)}`);
    latest = result.body;
    if (['succeeded', 'failed', 'waiting'].includes(latest.status)) return latest;
    await new Promise(resolve => setTimeout(resolve, T.short / 10));
  }
  throw new Error(`operation ${id} never settled: ${JSON.stringify(latest)}`);
}

export async function runOd(baseUrl: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execute(process.execPath, [join(e2eWorkspaceRoot(), 'apps/daemon/dist/cli.js'), ...args, '--daemon-url', baseUrl], { timeout: T.xlong });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof result.code === 'number' ? result.code : 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(error) };
  }
}

export async function state(baseUrl: string, projectId: string): Promise<ProjectGitState> {
  const result = await requestJson<ProjectGitState>(baseUrl, `/api/projects/${projectId}/git`);
  if (result.status !== 200) throw new Error(`Git state: ${JSON.stringify(result)}`);
  return result.body;
}

export async function mutate<T>(baseUrl: string, projectId: string, path: string, body: object, method = 'POST'): Promise<T> {
  const current = await state(baseUrl, projectId);
  const result = await requestJson<T>(baseUrl, path, { method, body: JSON.stringify({ ...body, expectedProjectRevision: current.projectRevision }) });
  if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
  return result.body;
}

export async function gitOperation(baseUrl: string, projectId: string, suffix: string, body: object = {}, method = 'POST') {
  const accepted = await mutate<ProjectGitAccepted>(baseUrl, projectId, `/api/projects/${projectId}/git${suffix}`, body, method);
  const operation = await waitOperation(baseUrl, accepted.operationId);
  if (operation.status !== 'succeeded') throw new Error(`${suffix}: ${JSON.stringify(operation)}`);
  return operation;
}

export async function seedGitHistory(baseUrl: string): Promise<{ projectId: string; conversationId: string; targetOid: string; projectRevision: number; targetContent: string }> {
  const projectId = randomUUID();
  const created = await requestJson(baseUrl, '/api/projects', { method: 'POST', body: JSON.stringify({ id: projectId, name: 'Git acceptance' }) });
  if (created.status !== 200) throw new Error(`create: ${JSON.stringify(created)}`);
  const initial = await state(baseUrl, projectId);
  if (!initial.enabled) throw new Error(`fixture identity/initialization unavailable: ${JSON.stringify(initial)}`);
  const conversation = await mutate<{ conversation: { id: string } }>(baseUrl, projectId, `/api/projects/${projectId}/conversations`, { title: 'Versioned conversation' });
  const conversationId = conversation.conversation.id;
  const targetContent = '<!doctype html><html><head><title>Version one</title></head><body><h1>version-one</h1></body></html>';
  await mutate(baseUrl, projectId, `/api/projects/${projectId}/files`, { name: 'index.html', content: targetContent });
  await mutate(baseUrl, projectId, `/api/projects/${projectId}/conversations/${conversationId}/messages/${randomUUID()}`, { role: 'user', content: 'version-one message', createdAt: 1 }, 'PUT');
  await gitOperation(baseUrl, projectId, '/sync');
  const targetOid = (await state(baseUrl, projectId)).localHead!;
  await mutate(baseUrl, projectId, `/api/projects/${projectId}/files`, { name: 'index.html', content: targetContent.replaceAll('one', 'two') });
  await mutate(baseUrl, projectId, `/api/projects/${projectId}/conversations/${conversationId}/messages/${randomUUID()}`, { role: 'user', content: 'version-two message', createdAt: 2 }, 'PUT');
  await gitOperation(baseUrl, projectId, '/sync');
  return { projectId, conversationId, targetOid, projectRevision: (await state(baseUrl, projectId)).projectRevision, targetContent };
}
