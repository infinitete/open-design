import { describe, expect, it, vi } from 'vitest';
import {
  captureProjectMutation,
  createProjectGitStateStore,
  createProjectRevisionTracker,
  isProjectMutationReady,
  registerProjectMutationStore,
  unregisterProjectMutationStore,
} from '../../src/state/project-git';
import type { ProjectGitState } from '@open-design/contracts';

function state(projectRevision: number, contentRevision = 0): ProjectGitState {
  return {
    enabled: true,
    phase: 'synced',
    localHead: 'a'.repeat(40),
    observedRemoteHead: 'a'.repeat(40),
    confirmedRemoteHead: 'a'.repeat(40),
    projectRevision,
    contentRevision,
    bindingGeneration: 1,
    dirty: false,
    pendingPush: false,
    autoSync: true,
    operationId: null,
    error: null,
    binding: { remoteConfigured: true, remoteLabel: 'origin', branch: 'main' },
    dependencies: [],
  };
}

describe('project revision tracker', () => {
  it('keeps a queued save bound to the epoch in which its content was edited', () => {
    const tracker = createProjectRevisionTracker(4);
    const queuedSave = { content: 'old draft', ...tracker.capture() };
    expect(tracker.accept(5)).toBe(true);
    expect(queuedSave.expectedProjectRevision).toBe(4);
    expect(tracker.isCurrent(queuedSave.expectedProjectRevision)).toBe(false);
    expect(tracker.capture()).toEqual({ expectedProjectRevision: 5 });
  });

  it('does not advance for the same or an older revision', () => {
    const tracker = createProjectRevisionTracker(5);
    expect(tracker.accept(5)).toBe(false);
    expect(tracker.accept(4)).toBe(false);
    expect(tracker.current()).toBe(5);
  });
});

describe('project Git state store', () => {
  it('captures mutation authority only from a loaded ready store', () => {
    const loadingStore = createProjectGitStateStore();
    const errorStore = createProjectGitStateStore();
    const errorRead = errorStore.beginRead();
    errorStore.failRead(errorRead, new Error('read failed'));
    const lockedStore = createProjectGitStateStore(state(1));
    lockedStore.accept(state(2), 'event');
    const readyStore = createProjectGitStateStore(state(3));
    const registrations = [
      ['loading-project', loadingStore],
      ['error-project', errorStore],
      ['locked-project', lockedStore],
      ['ready-project', readyStore],
    ] as const;
    for (const [projectId, store] of registrations) registerProjectMutationStore(projectId, store);
    try {
      expect(captureProjectMutation('missing-project')).toBeUndefined();
      expect(captureProjectMutation('loading-project')).toBeUndefined();
      expect(captureProjectMutation('error-project')).toBeUndefined();
      expect(captureProjectMutation('locked-project')).toBeUndefined();
      expect(captureProjectMutation('ready-project')).toMatchObject({
        expectedProjectRevision: 3,
        generation: 0,
      });
    } finally {
      for (const [projectId, store] of registrations) {
        unregisterProjectMutationStore(projectId, store);
        store.dispose();
      }
    }
  });

  it('treats a loaded unmanaged project as mutation-ready without a revision header', () => {
    const unmanaged = { ...state(0), enabled: false };
    const store = createProjectGitStateStore(unmanaged);
    registerProjectMutationStore('unmanaged-project', store);
    try {
      expect(isProjectMutationReady('unmanaged-project')).toBe(true);
      expect(store.capture().expectedProjectRevision).toBeUndefined();
    } finally {
      unregisterProjectMutationStore('unmanaged-project', store);
      store.dispose();
    }
  });

  it('aborts the old browser epoch and locks writes only for a greater project revision', () => {
    const onAdvance = vi.fn();
    const store = createProjectGitStateStore(state(4), { onRevisionAdvance: onAdvance });
    const old = store.capture();
    expect(store.accept(state(4, 1), 'event')).toBe('updated');
    expect(old.signal.aborted).toBe(false);
    expect(store.snapshot().writeLocked).toBe(false);

    expect(store.accept(state(5), 'event')).toBe('advanced');
    expect(old.signal.aborted).toBe(true);
    expect(store.snapshot().writeLocked).toBe(true);
    expect(onAdvance).toHaveBeenCalledOnce();
    expect(store.isCurrent(old)).toBe(false);
  });

  it('generation-fences a GET that started before a newer event', () => {
    const store = createProjectGitStateStore(state(4));
    const read = store.beginRead();
    expect(store.accept(state(5), 'event')).toBe('advanced');
    expect(store.acceptRead(read, state(4, 99))).toBe('stale');
    expect(store.snapshot().state?.projectRevision).toBe(5);
  });

  it('does not let an older same-epoch content snapshot overwrite newer state', () => {
    const store = createProjectGitStateStore(state(4, 3));

    expect(store.accept(state(4, 2), 'event')).toBe('stale');
    expect(store.snapshot().state?.contentRevision).toBe(3);
  });

  it('ignores a late GET failure after an event supplied newer state', () => {
    const store = createProjectGitStateStore(state(4));
    const read = store.beginRead();
    store.accept(state(5), 'event');
    expect(store.failRead(read, new Error('late network failure'))).toBe(false);
    expect(store.snapshot().error).toBeNull();
    expect(store.snapshot().state?.projectRevision).toBe(5);
  });

  it('unlocks only after the current reconciliation barrier succeeds', () => {
    const store = createProjectGitStateStore(state(1));
    store.accept(state(2), 'event');
    const staleBarrier = store.reconciliationToken();
    store.accept(state(3), 'event');
    expect(store.completeReconciliation(staleBarrier)).toBe(false);
    expect(store.snapshot().writeLocked).toBe(true);
    expect(store.completeReconciliation(store.reconciliationToken())).toBe(true);
    expect(store.snapshot().writeLocked).toBe(false);
  });

  it('disposes the current epoch signal and rejects later currentness checks', () => {
    const store = createProjectGitStateStore(state(3));
    const captured = store.capture();

    store.dispose();

    expect(captured.signal.aborted).toBe(true);
    expect(store.isCurrent(captured)).toBe(false);
    expect(store.capture().signal.aborted).toBe(true);
  });
});
