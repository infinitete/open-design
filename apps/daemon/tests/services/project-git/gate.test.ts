import { afterEach, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectGate, getProjectGate, getUnmanagedProjectGate, initializeProjectRepository, type MutationPermit } from '../../../src/services/project-git/gate.js';
import { acquireRepositoryLease, getRepositoryOwnerDomain } from '../../../src/services/project-git/repository-lease.js';
import { createGitFixture } from '../../helpers/project-git.js';

const fixtures: Awaited<ReturnType<typeof createGitFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.close())); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('promotes the same unmanaged gate after draining admitted work and owns the real lease during registration', async () => {
  const f = await createGitFixture(); fixtures.push(f); const root = join(f.root, 'unmanaged'); await mkdir(root);
  const identity = { root, instanceId: 'promotion', ownerDomain: await getRepositoryOwnerDomain() ?? 'unknown', dataRootId: f.root };
  const gate = await getUnmanagedProjectGate(identity);
  expect(await getUnmanagedProjectGate(identity)).toBe(gate);
  const end = deferred<void>(); const active = gate.mutate(() => end.promise); await tick();
  let promoted = false;
  const promotion = initializeProjectRepository({ ...identity, initialBranch: 'main', objectFormat: 'sha1' }, async () => {
    promoted = true;
    await expect(acquireRepositoryLease({ ...identity, dataRootId: 'another-data-root' })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
    throw new Error('registration fixture failed');
  });
  const failure = expect(promotion).rejects.toThrow('registration fixture failed');
  await tick(); expect(promoted).toBe(false); end.resolve(); await active; await failure;
  expect(await getProjectGate(identity)).toBe(gate);
  expect(await gate.mutate(async () => 'managed')).toBe('managed');
});

it('rejects repository appearance on every unmanaged admission even while an earlier run owns its local lease', async () => {
  const f = await createGitFixture(); fixtures.push(f); const root = join(f.root, 'unmanaged'); await mkdir(root);
  const identity = { root, instanceId: 'promotion', ownerDomain: await getRepositoryOwnerDomain() ?? 'unknown', dataRootId: f.root };
  const gate = await getUnmanagedProjectGate(identity); const run = await gate.beginRun();
  await f.git(root, 'init', '--initial-branch=main');
  await expect(gate.mutate(async () => 'unsafe', run.permit)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  run();
  await expect(getProjectGate(identity)).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  await expect(getUnmanagedProjectGate({ ...identity, root: f.a })).rejects.toBeDefined();
});

it('quarantines ordinary admission after failure until the owning recovery converges', async () => {
  const gate = createProjectGate();
  const barrier = gate.holdRecovery('operation');
  await expect(barrier.exclusive(async () => { throw new Error('partial files'); })).rejects.toThrow('partial files');
  for (const action of [gate.mutate, gate.exclusive]) await expect(action(async () => 'unsafe')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(gate.beginRun()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  let read = false;
  await expect(gate.read(async () => { read = true; }, 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await expect(createProjectGate().read(async () => 'other project')).resolves.toBe('other project');
  await expect(barrier.exclusive(async () => 'repaired')).resolves.toBe('repaired');
  barrier.release(); barrier.release();
  await gate.read(async () => {}); expect(read).toBe(false);
  await expect(barrier.exclusive(async () => 'stale')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});

it('drains active work and blocks already queued ordinary writes before recovery admission', async () => {
  let leases = 0;
  const gate = createProjectGate({ acquireLease: async () => { leases++; return { release: async () => {} }; } });
  const end = deferred<void>();
  const active = gate.mutate(() => end.promise);
  await tick();
  const queued = gate.exclusive(async () => 'unsafe').catch(error => error.code);
  const write = gate.mutate(async () => 'unsafe').catch(error => error.code);
  const barrier = gate.holdRecovery('operation');
  expect(await queued).toBe('RECOVERY_REQUIRED'); expect(await write).toBe('RECOVERY_REQUIRED');
  let entered = false;
  const recovery = barrier.exclusive(async () => { entered = true; });
  await tick(); expect(entered).toBe(false);
  end.resolve(); await Promise.all([active, recovery]); expect(leases).toBe(2);
  barrier.release();
});

it('requires every recovery owner to release and rejects duplicate operation handles', async () => {
  const gate = createProjectGate();
  const one = gate.holdRecovery('one'); const two = gate.holdRecovery('two');
  expect(Object.isFrozen(one)).toBe(true);
  expect(() => gate.holdRecovery('one')).toThrow();
  one.release();
  await expect(gate.read(async () => 'unsafe', 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await two.exclusive(async () => {}); two.release();
  await expect(gate.read(async () => 'safe')).resolves.toBe('safe');
});

it('lets an already admitted run drain owned terminal writes before recovery', async () => {
  const gate = createProjectGate(); const run = await gate.beginRun();
  const barrier = gate.holdRecovery('recovery'); const seen: string[] = [];
  const recovery = barrier.exclusive(async () => { seen.push('recovery'); });
  await gate.mutate(async () => { seen.push('terminal persistence'); }, run.permit);
  expect(seen).toEqual(['terminal persistence']); run(); await recovery;
  await expect(gate.mutate(async () => {}, run.permit)).rejects.toBeDefined();
  expect(seen).toEqual(['terminal persistence', 'recovery']); barrier.release();
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('does not expose current files before database materialization completes', async () => {
  const gate = createProjectGate();
  const entered = deferred<void>();
  const finish = deferred<void>();
  const seen: string[] = [];
  const writer = gate.exclusive(async () => {
    seen.push('files'); entered.resolve(); await finish.promise; seen.push('db');
  });
  await entered.promise;
  const reader = gate.read(async () => { seen.push('read'); });
  await tick(); expect(seen).toEqual(['files']);
  finish.resolve(); await Promise.all([writer, reader]);
  expect(seen).toEqual(['files', 'db', 'read']);
});

it('queues exclusive fairly behind existing reads mutations and runs', async () => {
  const gate = createProjectGate();
  const finish = deferred<void>();
  const release = await gate.beginRun();
  const read = gate.read(() => finish.promise);
  const mutation = gate.mutate(() => finish.promise);
  const seen: string[] = [];
  const exclusive = gate.exclusive(async () => { seen.push('exclusive'); });
  const laterWrite = gate.mutate(async () => { seen.push('write'); });
  const laterRun = gate.beginRun().then(done => { seen.push('run'); done(); });
  const laterRead = gate.read(async () => { seen.push('read'); });
  release(); release();
  await tick(); expect(seen).toEqual([]);
  finish.resolve(); await Promise.all([read, mutation, exclusive, laterWrite, laterRun, laterRead]);
  expect(seen[0]).toBe('exclusive'); expect(gate.activeRuns()).toBe(0);
});

it('admits owned run writes after exclusive queues and drains them after run release', async () => {
  const gate = createProjectGate();
  const run = await gate.beginRun();
  const finish = deferred<void>();
  const seen: string[] = [];
  const exclusive = gate.exclusive(async () => { seen.push('exclusive'); });
  const unrelated = gate.mutate(async () => { seen.push('unrelated'); });
  const owned = gate.mutate(async () => { seen.push('owned'); await finish.promise; seen.push('saved'); }, run.permit);
  await tick(); expect(seen).toEqual(['owned']);
  run(); run();
  await expect(gate.mutate(async () => {}, run.permit)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await tick(); expect(seen).toEqual(['owned']);
  finish.resolve(); await Promise.all([owned, exclusive, unrelated]);
  expect(seen).toEqual(['owned', 'saved', 'exclusive', 'unrelated']);
});

it('allows a mutation-owned continuation without admitting unrelated or foreign permits', async () => {
  const gate = createProjectGate();
  const entered = deferred<MutationPermit>();
  const finish = deferred<void>();
  const mutation = gate.mutate(async permit => { entered.resolve(permit); await finish.promise; });
  const permit = await entered.promise;
  const exclusive = gate.exclusive(async () => {});
  await expect(gate.mutate(async () => 'saved', permit)).resolves.toBe('saved');
  const other = createProjectGate();
  await expect(other.mutate(async () => {}, permit)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await expect(gate.mutate(async () => {}, {} as MutationPermit)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  finish.resolve(); await Promise.all([mutation, exclusive]);
  await expect(gate.mutate(async () => {}, permit)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
});

it('times out queued current-state reads without executing them later', async () => {
  const gate = createProjectGate();
  const finish = deferred<void>();
  const writer = gate.exclusive(() => finish.promise);
  let executed = false;
  await expect(gate.read(async () => { executed = true; }, 10)).rejects.toMatchObject({ code: 'PROJECT_BUSY', status: 409 });
  finish.resolve(); await writer;
  await gate.exclusive(async () => {}); expect(executed).toBe(false);
});

it('releases admission and lease on failures including cancellation', async () => {
  let held = 0;
  const gate = createProjectGate({ acquireLease: async () => {
    held++; return { release: async () => { held--; } };
  } });
  for (const action of [gate.mutate, gate.exclusive, gate.read]) {
    await expect(action(async () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
    expect(held).toBe(0);
  }
  await expect(gate.exclusive(async () => 'ok')).resolves.toBe('ok');
});

it('shares one acquisition for overlapping runs and mutations and releases once on drain', async () => {
  let acquisitions = 0; let releases = 0;
  const gate = createProjectGate({ acquireLease: async () => {
    acquisitions++; return { release: async () => { releases++; } };
  } });
  const [one, two] = await Promise.all([gate.beginRun(), gate.beginRun()]);
  await gate.mutate(async () => {});
  expect(acquisitions).toBe(1); expect(releases).toBe(0);
  one(); one(); expect(gate.activeRuns()).toBe(1);
  two(); await gate.exclusive(async () => {});
  expect(acquisitions).toBe(2); expect(releases).toBe(2);
});

it('recovers its queue from shared acquisition failure', async () => {
  let fail = true;
  const gate = createProjectGate({ acquireLease: async () => {
    if (fail) throw new Error('acquire failed');
    return { release: async () => {} };
  } });
  const results = await Promise.allSettled([gate.beginRun(), gate.mutate(async () => {})]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(gate.activeRuns()).toBe(0);
  fail = false; await expect(gate.exclusive(async () => 'ok')).resolves.toBe('ok');
});

it('fails queued work safely after a release failure without hanging', async () => {
  const gate = createProjectGate({ acquireLease: async () => ({ release: async () => { throw new Error('release failed'); } }) });
  const run = await gate.beginRun();
  const next = gate.exclusive(async () => 'must not execute');
  run();
  await expect(next).rejects.toThrow('release failed');
  expect(gate.activeRuns()).toBe(0);
  await expect(gate.mutate(async () => {})).rejects.toThrow('release failed');
});

it('canonicalizes registry aliases, separates worktree gates and rejects owner identity collisions', async () => {
  const f = await createGitFixture(); fixtures.push(f);
  await f.git(f.a, 'commit', '--allow-empty', '-m', 'first');
  const linked = join(f.root, 'linked'); const alias = join(f.root, 'alias');
  await f.git(f.a, 'worktree', 'add', '-b', 'linked', linked);
  await symlink(f.a, alias, 'dir');
  const input = { root: f.a, instanceId: 'daemon', dataRootId: 'data', ownerDomain: (await getRepositoryOwnerDomain()) ?? 'unknown' };
  const first = await getProjectGate(input);
  expect(await getProjectGate({ ...input, root: alias })).toBe(first);
  const second = await getProjectGate({ ...input, root: linked }); expect(second).not.toBe(first);
  const [one, two] = await Promise.all([first.beginRun(), second.beginRun()]);
  await expect(getProjectGate({ ...input, instanceId: 'other' })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  await expect(getProjectGate({ ...input, root: linked, dataRootId: 'other' })).rejects.toMatchObject({ code: 'EXTERNAL_GIT_BUSY' });
  one(); two(); await Promise.all([first.exclusive(async () => {}), second.read(async () => {})]);
});

it('retains the registered ownership configuration when a caller later mutates its input', async () => {
  const f = await createGitFixture(); fixtures.push(f);
  const input = { root: f.a, instanceId: 'daemon', dataRootId: 'original-data', ownerDomain: 'unknown' };
  const gate = await getProjectGate(input);
  input.dataRootId = 'other-data';
  const run = await gate.beginRun();
  try {
    const owner = JSON.parse(await f.git(f.a, 'cat-file', 'blob', 'refs/open-design/locks/repository')) as { dataRootId: string };
    expect(owner.dataRootId).toBe('original-data');
  } finally { run(); await gate.exclusive(async () => {}); }
});
