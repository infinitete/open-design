import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateProjectGit } from '../../../src/storage/project-git-migrations.js';
import { createProjectGitStore } from '../../../src/storage/project-git.js';
import { createProjectGitScheduler } from '../../../src/services/project-git/scheduler.js';

afterEach(() => { vi.useRealTimers(); });

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
    await vi.advanceTimersByTimeAsync(1000); expect(detections).toBe(2); expect(networks).toBe(0);
    await scheduler.stop(); const stopped = detections;
    await vi.advanceTimersByTimeAsync(120000); expect(detections).toBe(stopped);
  } finally { await scheduler.stop(); db.close(); }
});

it('probes notifications promptly so the detector alone owns the five-second quiet period', async () => {
  vi.useFakeTimers(); const db = new Database(':memory:'); migrateProjectGit(db); const store = createProjectGitStore(db);
  let probes = 0;
  const scheduler = createProjectGitScheduler({ store, now: Date.now, random: () => 0.5, detect: async () => { probes++; }, sync: async () => {} });
  try {
    scheduler.start(); scheduler.notify('project'); scheduler.notify('project'); await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
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
