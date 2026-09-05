import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireRepositoryLease, getRepositoryOwnerDomain } from '../../../src/services/project-git/repository-lease.js';
import { runGit } from '../../../src/services/project-git/git-process.js';
import { createGitFixture } from '../../helpers/project-git.js';

const fixtures: Awaited<ReturnType<typeof createGitFixture>>[] = [];
const workers: ChildProcess[] = [];
const ref = 'refs/open-design/locks/repository';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map(async worker => {
    if (worker.exitCode === null && worker.signalCode === null) { const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited; }
  }));
  await Promise.all(fixtures.splice(0).map(f => f.close()));
});
async function fixture() {
  const f = await createGitFixture(); fixtures.push(f);
  await writeFile(join(f.a, 'file'), 'initial'); await f.git(f.a, 'add', 'file'); await f.git(f.a, 'commit', '-m', 'initial');
  return f;
}
async function input(root: string) {
  return { root, instanceId: 'test-daemon', ownerDomain: (await getRepositoryOwnerDomain()) ?? 'unknown', dataRootId: 'fixture-data' };
}
async function worker() {
  const child = fork(fileURLToPath(new URL('../../helpers/project-git-lease-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  workers.push(child); await once(child, 'message'); return child;
}
async function command(child: ChildProcess, action: string, root: string, dataRootId?: string) {
  const reply = once(child, 'message'); child.send({ action, root, dataRootId });
  return (await reply)[0] as { status: string; code?: string };
}
async function replaceOwner(f: Awaited<ReturnType<typeof fixture>>, owner: unknown) {
  const oid = (await runGit({ cwd: f.a, args: ['hash-object', '-w', '--stdin'], stdin: Buffer.from(JSON.stringify(owner)) })).stdout.toString().trim();
  await f.git(f.a, 'update-ref', '--no-deref', ref, oid); return oid;
}

it('admits exactly one independent worker and leaves HEAD/index unchanged for the loser', async () => {
  const f = await fixture(); const head = await f.git(f.a, 'rev-parse', 'HEAD'); const index = await readFile(join(f.a, '.git/index'));
  const [one, two] = await Promise.all([worker(), worker()]);
  const results = await Promise.all([command(one, 'acquire', f.a), command(two, 'acquire', f.a)]);
  expect(results.map(r => r.status).sort()).toEqual(['acquired', 'error']);
  expect(results.find(r => r.status === 'error')?.code).toBe('EXTERNAL_GIT_BUSY');
  expect(await f.git(f.a, 'rev-parse', 'HEAD')).toBe(head); expect(await readFile(join(f.a, '.git/index'))).toEqual(index);
  await command(results[0]!.status === 'acquired' ? one : two, 'release', f.a);
  const lease = await acquireRepositoryLease(await input(f.a)); await lease.release();
});

it.skipIf(process.platform !== 'linux')('never expires a paused live holder and recovers only after proven same-domain death', async () => {
  const f = await fixture(); const holder = await worker(); expect((await command(holder, 'acquire', f.a)).status).toBe('acquired');
  holder.kill('SIGSTOP');
  vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000);
  await expect(acquireRepositoryLease(await input(f.a))).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
  const lease = await acquireRepositoryLease(await input(f.a)); await lease.release();
});

it('blocks dead holders from another data root before any takeover', async () => {
  const f = await fixture(); const holder = await worker(); await command(holder, 'acquire', f.a, 'other-data');
  const oid = await f.git(f.a, 'rev-parse', ref);
  const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
  await expect(acquireRepositoryLease(await input(f.a))).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  expect(await f.git(f.a, 'rev-parse', ref)).toBe(oid);
});

it('coordinates linked worktrees through the common directory', async () => {
  const f = await fixture(); const linked = join(f.root, 'linked'); await f.git(f.a, 'worktree', 'add', '-b', 'linked', linked);
  const lease = await acquireRepositoryLease(await input(f.a));
  const contender = await worker(); expect(await command(contender, 'acquire', linked)).toMatchObject({ status: 'error', code: 'EXTERNAL_GIT_BUSY' });
  await lease.release(); expect(await command(contender, 'acquire', linked)).toMatchObject({ status: 'acquired' });
  await command(contender, 'release', linked);
});

it('conditionally releases its own value once and cannot delete a successor value', async () => {
  const f = await fixture(); const lease = await acquireRepositoryLease(await input(f.a));
  const successor = await replaceOwner(f, { ...(await input(f.a)), token: 'successor-token', pid: process.pid });
  await Promise.all([lease.release(), lease.release()]);
  expect(await f.git(f.a, 'rev-parse', ref)).toBe(successor);
});

it('snapshots ownership before asynchronous repository discovery', async () => {
  const f = await fixture(); const request = await input(f.a);
  const pending = acquireRepositoryLease(request); request.dataRootId = 'changed-data';
  const lease = await pending;
  try {
    const owner = JSON.parse(await f.git(f.a, 'cat-file', 'blob', ref)) as { dataRootId: string };
    expect(owner.dataRootId).toBe('fixture-data');
  } finally { await lease.release(); }
});

it.each(['foreign-domain', 'unknown-domain', 'reused-live-pid', 'eperm', 'malformed'] as const)('refuses unsafe stale takeover: %s', async scenario => {
  const f = await fixture(); const own = await input(f.a);
  const owner = { ...own, pid: process.pid, token: '00000000-0000-4000-8000-000000000001' };
  if (scenario === 'foreign-domain') owner.ownerDomain = 'other-host/user/namespace';
  if (scenario === 'unknown-domain') { owner.ownerDomain = 'unknown'; own.ownerDomain = 'unknown'; }
  const oid = await replaceOwner(f, scenario === 'malformed' ? { pid: -1 } : owner);
  if (scenario === 'eperm') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  await expect(acquireRepositoryLease(own)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  expect(await f.git(f.a, 'rev-parse', ref)).toBe(oid);
});
