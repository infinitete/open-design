import { expect, it, vi } from 'vitest';
import {
  assertProjectRevision,
  createProjectGitMutationAdapter,
  createUnavailableProjectGitCoordination,
  expectedProjectRevisionFromTransport,
} from '../../../src/services/project-git/mutation-adapter.js';
import { createProjectGate } from '../../../src/services/project-git/gate.js';

it('allows ordinary edits in one epoch but rejects old or missing epochs after restore', () => {
  expect(() => assertProjectRevision(true, 7, 7)).not.toThrow();
  expect(() => assertProjectRevision(true, 8, 7)).toThrow();
  expect(() => assertProjectRevision(true, 8, undefined)).toThrow();
  expect(() => assertProjectRevision(false, 0, undefined)).not.toThrow();
});

it('checks the epoch under the gate and marks every started content mutation dirty', async () => {
  const gate = createProjectGate();
  const binding = {
    projectRevision: 7,
    contentRevision: 2,
    generation: 3,
    localHead: null,
    observedRemoteHead: null,
  };
  const notifications: string[] = [];
  const adapter = createProjectGitMutationAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => binding,
      bumpContent: (_projectId, basis) => {
        expect(basis).toEqual({
          bindingGeneration: 3,
          projectRevision: 7,
          contentRevision: binding.contentRevision,
          localHead: null,
          remoteHead: null,
        });
        binding.contentRevision += 1;
        return binding.contentRevision;
      },
    },
    gateFor: () => gate,
    notify: projectId => notifications.push(projectId),
  });

  await expect(adapter.withProjectMutation(
    { projectId: 'project', expectedProjectRevision: 7, source: 'test' },
    async () => 'saved',
  )).resolves.toBe('saved');
  await expect(adapter.withProjectMutation(
    { projectId: 'project', expectedProjectRevision: 7, source: 'test' },
    async () => { throw new Error('partial write'); },
  )).rejects.toThrow('partial write');

  expect(binding.contentRevision).toBe(4);
  expect(notifications).toEqual(['project', 'project']);
});

it('holds current-state reads behind the stable project gate', async () => {
  const gate = createProjectGate();
  const adapter = createProjectGitMutationAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => null, bumpContent: () => 0 },
    gateFor: () => gate,
    notify: () => {},
  });
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const exclusive = gate.exclusive(() => blocked);
  const read = adapter.withProjectRead('project', async () => 'visible');
  await new Promise<void>(resolve => setImmediate(resolve));
  let settled = false;
  void read.finally(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  finish();
  await expect(read).resolves.toBe('visible');
  await exclusive;
});

it('normalizes body and header epochs and rejects malformed or mismatched transports', () => {
  expect(expectedProjectRevisionFromTransport({ body: 7 })).toBe(7);
  expect(expectedProjectRevisionFromTransport({ header: '7' })).toBe(7);
  expect(expectedProjectRevisionFromTransport({ body: '7', header: '7' })).toBe(7);
  expect(expectedProjectRevisionFromTransport({})).toBeUndefined();
  for (const input of [
    { body: 7, header: '8' },
    { body: -1 },
    { body: 1.5 },
    { header: 'revision-7' },
    { header: ['7', '8'] },
  ]) {
    expect(() => expectedProjectRevisionFromTransport(input)).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
    );
  }
});

it('keeps unmanaged behavior but fails closed before managed effects until service composition', async () => {
  const managed = createUnavailableProjectGitCoordination({
    getBinding: () => ({ projectRevision: 7 }),
  });
  const effect = vi.fn(async () => 'written');
  await expect(managed.withProjectMutation(
    { projectId: 'managed', expectedProjectRevision: 7, source: 'route' },
    effect,
  )).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
    status: 409,
    message: 'Project versioning is unavailable until recovery completes.',
  });
  await expect(managed.withProjectRead('managed', effect)).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  await expect(managed.runtime.admit('managed', 7)).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  });
  expect(effect).not.toHaveBeenCalled();

  const unmanaged = createUnavailableProjectGitCoordination({ getBinding: () => null });
  await expect(unmanaged.withProjectMutation(
    { projectId: 'plain', source: 'route' },
    effect,
  )).resolves.toBe('written');
  await expect(unmanaged.withProjectRead('plain', effect)).resolves.toBe('written');
  const admission = await unmanaged.runtime.admit('plain', undefined);
  expect(admission.projectRevision).toBe(0);
  expect(() => admission.release()).not.toThrow();
});

it('runs startup repair recheck under the gate and does not dirty a no-op', async () => {
  const gate = createProjectGate();
  const binding = {
    projectRevision: 7, contentRevision: 2, generation: 3,
    localHead: null, observedRemoteHead: null,
  };
  const bumpContent = vi.fn(() => { binding.contentRevision += 1; return binding.contentRevision; });
  const notify = vi.fn();
  const adapter = createProjectGitMutationAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => binding, bumpContent },
    gateFor: () => gate,
    notify,
  });
  const work = vi.fn(async () => 'repaired');

  await expect(adapter.startup.repairIfNeeded({
    projectId: 'project', bindingGeneration: 3, projectRevision: 7, source: 'legacy-brand-transcript',
    recheck: vi.fn(async () => false), work,
  })).resolves.toEqual({ mutated: false });
  expect(work).not.toHaveBeenCalled();
  expect(bumpContent).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();

  await expect(adapter.startup.repairIfNeeded({
    projectId: 'project', bindingGeneration: 3, projectRevision: 7, source: 'legacy-brand-transcript',
    recheck: vi.fn(async () => true), work,
  })).resolves.toEqual({ mutated: true, value: 'repaired' });
  expect(bumpContent).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith('project');
});

it('rejects stale startup repair before recheck and conservatively dirties work failure', async () => {
  const gate = createProjectGate();
  const binding = {
    projectRevision: 8, contentRevision: 0, generation: 1,
    localHead: null, observedRemoteHead: null,
  };
  const bumpContent = vi.fn(() => { binding.contentRevision += 1; return binding.contentRevision; });
  const notify = vi.fn();
  const adapter = createProjectGitMutationAdapter({
    recoveryReady: Promise.resolve(), store: { getBinding: () => binding, bumpContent },
    gateFor: () => gate, notify,
  });
  const recheck = vi.fn(async () => true);
  await expect(adapter.startup.repairIfNeeded({
    projectId: 'project', bindingGeneration: 1, projectRevision: 7, source: 'legacy-brand-transcript',
    recheck, work: vi.fn(),
  })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(recheck).not.toHaveBeenCalled();
  expect(bumpContent).not.toHaveBeenCalled();

  await expect(adapter.startup.repairIfNeeded({
    projectId: 'project', bindingGeneration: 1, projectRevision: 8, source: 'legacy-brand-transcript',
    recheck, work: async () => { throw new Error('repair failed'); },
  })).rejects.toThrow('repair failed');
  expect(binding.contentRevision).toBe(1);
  expect(notify).toHaveBeenCalledWith('project');
  expect(gate.activeRuns()).toBe(0);
});
