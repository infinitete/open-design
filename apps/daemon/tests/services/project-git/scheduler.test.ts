import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateProjectGit } from '../../../src/storage/project-git-migrations.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { createProjectGitScheduler } from '../../../src/services/project-git/scheduler.js';

afterEach(() => { vi.useRealTimers(); });

it('rechecks after asynchronous dirty observation and stops scheduling once clean', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  const observations: number[] = [];
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5,
    detect: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      observations.push(Date.now());
      return observations.length === 1 ? 5_000 : undefined;
    }, sync: async () => {} });
  try {
    scheduler.start(); scheduler.notify('project');
    await vi.advanceTimersByTimeAsync(5_100);
    expect(observations).toEqual([100]);
    await vi.advanceTimersByTimeAsync(100);
    expect(observations).toEqual([100, 5_200]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observations).toEqual([100, 5_200]);
  } finally { await scheduler.stop(); db.close(); }
});

function boundStore() {
  const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'repository', canonicalRoot: '/fixture/project', commonDir: '/fixture/project/.git',
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  return { db, store };
}

it('drains the admitted network operation and rejects new requests while local detection continues', async () => {
  vi.useFakeTimers(); const { db, store } = boundStore();
  let release!: () => void; const issued = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = []; let probes = 0;
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5,
    detect: async () => { probes++; }, sync: async () => { events.push('issued'); await issued; events.push('settled'); } });
  try {
    scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    scheduler.requestSync('project', true);
    const hold = scheduler.withNetworkPaused('project', async () => {
      events.push('transition'); expect(scheduler.requestSync('project', true)).toBe(false);
      store.saveBinding({ ...store.getBinding('project')!, remoteUrl: null });
      return 'complete';
    });
    expect(scheduler.requestSync('project', true)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['issued']); expect(probes).toBe(1);
    expect(store.getBinding('project')!.generation).toBe(1);
    release(); expect(await hold).toBe('complete'); await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['issued', 'settled', 'transition']);
    expect(store.getBinding('project')).toMatchObject({ generation: 2, remoteUrl: null });
  } finally { release(); await scheduler.stop(); db.close(); }
});

it('cancels network work not yet issued and serializes overlapping holds even when one rejects', async () => {
  const { db, store } = boundStore(); const events: string[] = [];
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5,
    detect: async () => {}, sync: async () => { events.push('network'); } });
  try {
    scheduler.start();
    const first = scheduler.withNetworkPaused('project', async () => { events.push('first'); await waiting; throw new Error('fixture failure'); });
    const failure = expect(first).rejects.toThrow('fixture failure');
    const second = scheduler.withNetworkPaused('project', async () => { events.push('second'); });
    await Promise.resolve(); await Promise.resolve();
    expect(events).not.toContain('network');
    release(); await failure; await second;
    expect(events).toEqual(['first', 'second']);
    expect(scheduler.requestSync('project', true)).toBe(true);
    await scheduler.stop(); expect(events).toEqual(['first', 'second', 'network']);
  } finally { release(); await scheduler.stop(); db.close(); }
});

it('rejects nested network holds without deadlock and releases admission after rejection', async () => {
  const { db, store } = boundStore();
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => {}, sync: async () => {} });
  try {
    await expect(scheduler.withNetworkPaused('project', async () => {
      await scheduler.withNetworkPaused('project', async () => {});
    })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    expect(await scheduler.withNetworkPaused('project', async () => 'released')).toBe('released');
  } finally { await scheduler.stop(); db.close(); }
});

it('closes transition admission synchronously during shutdown and waits for the admitted hold', async () => {
  const { db, store } = boundStore(); const events: string[] = [];
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => {}, sync: async () => {} });
  const admitted = scheduler.withNetworkPaused('project', async () => { await waiting; events.push('admitted'); });
  const stopping = scheduler.stop().then(() => { events.push('stopped'); });
  try {
    await expect(scheduler.withNetworkPaused('other', async () => { events.push('late'); })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    expect(events).toEqual([]); release(); await admitted; await stopping;
    expect(events).toEqual(['admitted', 'stopped']);
    db.close(); scheduler.start();
    await expect(scheduler.withNetworkPaused('project', async () => {})).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    expect(scheduler.requestSync('project', true)).toBe(false);
  } finally { release(); await stopping; if (db.open) db.close(); }
});

it('detects managed projects without page subscriptions, deduplicates start, and stops cleanly', async () => {
  vi.useFakeTimers();
  const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'repository', canonicalRoot: '/fixture/project', commonDir: '/fixture/project/.git',
    branch: 'main', remoteUrl: null, generation: 0, autoSync: false, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  let detections = 0; let networks = 0;
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5,
    detect: async () => { detections++; }, sync: async () => { networks++; } });
  try {
    scheduler.start(); scheduler.start(); await vi.advanceTimersByTimeAsync(0);
    expect(detections).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); expect(detections).toBe(1); expect(networks).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000); expect(detections).toBe(2); expect(networks).toBe(0);
    await vi.advanceTimersByTimeAsync(55_000); expect(detections).toBe(3); expect(networks).toBe(0);
    await scheduler.stop(); const stopped = detections;
    await vi.advanceTimersByTimeAsync(120000); expect(detections).toBe(stopped);
  } finally { await scheduler.stop(); db.close(); }
});

it('coalesces a watcher burst into one prompt probe and one five-second quiet probe', async () => {
  vi.useFakeTimers(); const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  let probes = 0;
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => { probes++; }, sync: async () => {} });
  try {
    scheduler.start(); scheduler.notify('project'); scheduler.notify('project'); await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999); expect(probes).toBe(1);
    scheduler.notify('project');
    await vi.advanceTimersByTimeAsync(4_999); expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(1); expect(probes).toBe(2);
  } finally { await scheduler.stop(); db.close(); }
});

it('deduplicates in-flight network requests and keeps a paused oneShot from enabling autoSync', async () => {
  vi.useFakeTimers(); const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'repository', canonicalRoot: '/fixture/project', commonDir: '/fixture/project/.git',
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: false, localHead: null, observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  let release!: () => void; const flight = new Promise<void>(resolve => { release = resolve; }); const calls: boolean[] = [];
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => {},
    sync: async (_id, oneShot) => { calls.push(oneShot); await flight; } });
  try {
    scheduler.start(); scheduler.requestSync('project', false); await vi.advanceTimersByTimeAsync(0); expect(calls).toEqual([]);
    scheduler.requestSync('project', true); scheduler.requestSync('project', true); await vi.advanceTimersByTimeAsync(0);
    release(); await vi.advanceTimersByTimeAsync(0); expect(calls).toEqual([true]);
    expect(store.getBinding('project')!.autoSync).toBe(false);
  } finally { release(); await scheduler.stop(); db.close(); }
});

it('honors durable retry deadlines between jittered sixty-second remote checks', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  const binding = store.saveBinding({ projectId: 'project', cloneId: 'clone', repositoryProjectId: 'repository', canonicalRoot: '/fixture/project', commonDir: '/fixture/project/.git',
    branch: 'main', remoteUrl: 'ssh://git@example.invalid/repo', generation: 0, autoSync: true, localHead: 'a'.repeat(40), observedRemoteHead: null, confirmedRemoteHead: null,
    projectRevision: 0, contentRevision: 0, exportedContentRevision: 0, materializedHead: null, dirty: false });
  store.queuePush('project', binding.generation, binding.localHead!); const calls: number[] = [];
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => {}, sync: async () => {
    calls.push(Date.now());
    if (calls.length === 1) store.deferPush('project', binding.generation, binding.localHead!, 5000);
    else store.ackPush('project', binding.generation, binding.localHead!);
  } });
  try {
    scheduler.start(); await vi.advanceTimersByTimeAsync(4999); expect(calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toEqual([0, 5000]);
    await vi.advanceTimersByTimeAsync(59999); expect(calls).toEqual([0, 5000]);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toEqual([0, 5000, 65000]);
  } finally { await scheduler.stop(); db.close(); }
});
