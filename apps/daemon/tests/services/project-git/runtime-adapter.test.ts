import { expect, it, vi } from 'vitest';
import { createProjectGate } from '../../../src/services/project-git/gate.js';
import { createProjectGitMutationAdapter } from '../../../src/services/project-git/mutation-adapter.js';
import {
  createProjectGitRuntimeAdapter,
  type ProjectRunPermit,
} from '../../../src/services/project-git/runtime-adapter.js';

it('holds overlapping run permits until each run settles and bumps from the latest content revision', async () => {
  const gate = createProjectGate();
  const binding = { projectRevision: 7, contentRevision: 0, generation: 2 };
  const permits = new Map<string, ProjectRunPermit>();
  const receipts = new Set<string>();
  const notifications: string[] = [];
  const adapter = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => binding,
      recordRunTerminal: input => {
        if (receipts.has(input.runId)) return false;
        receipts.add(input.runId);
        binding.contentRevision += 1;
        return true;
      },
    },
    gateFor: () => gate,
    notify: projectId => notifications.push(projectId),
    permits,
  });

  const one = await adapter.admit('project', 7);
  const two = await adapter.admit('project', 7);
  expect(gate.activeRuns()).toBe(2);
  adapter.attach('run-one', 'project', one);
  adapter.attach('run-two', 'project', two);
  adapter.onTerminal('run-one', 'project', 'succeeded');
  adapter.onTerminal('run-one', 'project', 'succeeded');
  adapter.onTerminal('run-two', 'project', 'failed');
  adapter.onSettled('run-one');
  expect(gate.activeRuns()).toBe(1);
  adapter.onSettled('run-two');
  expect(gate.activeRuns()).toBe(0);
  expect(binding.contentRevision).toBe(2);
  expect(notifications).toEqual(['project', 'project']);
});

it('isolates local dirty-state failures from model terminal convergence', async () => {
  const gate = createProjectGate();
  const permits = new Map<string, ProjectRunPermit>();
  const adapter = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => ({ projectRevision: 0, contentRevision: 0, generation: 1 }),
      recordRunTerminal: () => { throw new Error('sqlite unavailable'); },
    },
    gateFor: () => gate,
    notify: () => {},
    permits,
  });
  const admission = await adapter.admit('project', 0);
  adapter.attach('run', 'project', admission);

  expect(() => adapter.onTerminal('run', 'project', 'failed')).not.toThrow();
  adapter.onSettled('run');
  expect(gate.activeRuns()).toBe(0);
});

it('rejects stale and missing managed run epochs only after admission', async () => {
  const gate = createProjectGate();
  const adapter = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => ({ projectRevision: 8, contentRevision: 0, generation: 1 }),
      recordRunTerminal: () => true,
    },
    gateFor: () => gate,
    notify: () => {},
    permits: new Map(),
  });
  await expect(adapter.admit('project', 7)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  await expect(adapter.admit('project', undefined)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(gate.activeRuns()).toBe(0);
});

it('does not let checkpoint notification failures replace terminal state convergence', async () => {
  const gate = createProjectGate();
  const binding = { projectRevision: 0, contentRevision: 0, generation: 1 };
  const permits = new Map<string, ProjectRunPermit>();
  const adapter = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => binding,
      recordRunTerminal: () => { binding.contentRevision += 1; return true; },
    },
    gateFor: () => gate,
    notify: () => { throw new Error('scheduler unavailable'); },
    permits,
  });
  const admission = await adapter.admit('project', 0);
  adapter.attach('run', 'project', admission);
  expect(() => adapter.onTerminal('run', 'project', 'canceled')).not.toThrow();
  adapter.onSettled('run');
  expect(binding.contentRevision).toBe(1);
  expect(gate.activeRuns()).toBe(0);
});

it('reconciles a durable terminal through the same receipt and notifies only on first insert', () => {
  const binding = { projectRevision: 4, contentRevision: 8, generation: 3 };
  const receipts = new Set<string>();
  const notifications: string[] = [];
  const adapter = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => binding,
      recordRunTerminal: input => {
        const key = JSON.stringify(input);
        if (receipts.has(key)) return false;
        receipts.add(key);
        return true;
      },
    },
    gateFor: () => { throw new Error('startup reconciliation must not acquire a live gate'); },
    notify: projectId => notifications.push(projectId),
    permits: new Map(),
  });

  adapter.reconcileTerminal('orphan', 'project', 3, 4, 'failed');
  adapter.reconcileTerminal('orphan', 'project', 3, 4, 'failed');

  expect(receipts.size).toBe(1);
  expect(notifications).toEqual(['project']);
});

it('retains the branded run permit for same-project nested mutations', async () => {
  const gate = createProjectGate();
  const binding = {
    projectRevision: 4,
    contentRevision: 0,
    generation: 2,
    localHead: null,
    observedRemoteHead: null,
  };
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => binding, recordRunTerminal: () => false },
    gateFor: () => gate,
    notify: () => {},
    permits: new Map(),
  });
  const mutation = createProjectGitMutationAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => binding,
      bumpContent: () => { binding.contentRevision += 1; return binding as any; },
    },
    gateFor: () => gate,
    notify: () => {},
  });

  const admission = await runtime.admit('project', 4);
  expect(admission.permit).toBeDefined();
  expect(admission.bindingGeneration).toBe(2);
  if (!admission.permit) throw new Error('expected mutation permit');
  await expect(mutation.withProjectMutation({
    projectId: 'project',
    expectedProjectRevision: 4,
    source: 'nested-design-system-sync',
    permit: admission.permit,
  }, async () => 'done')).resolves.toBe('done');
  admission.release();
  expect(gate.activeRuns()).toBe(0);
});

it('admits a non-run mutation session without bumping and blocks exclusive work until release', async () => {
  const gate = createProjectGate();
  const binding = {
    projectRevision: 4,
    contentRevision: 2,
    generation: 3,
    localHead: null,
    observedRemoteHead: null,
  };
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => binding, recordRunTerminal: vi.fn() },
    gateFor: () => gate,
    notify: vi.fn(),
    permits: new Map(),
  });
  const session = await runtime.admitSession('project', 4);
  expect(session).toMatchObject({ projectId: 'project', expectedProjectRevision: 4 });
  expect(session.permit).toBeDefined();
  expect(binding.contentRevision).toBe(2);
  expect(gate.activeRuns()).toBe(1);

  let exclusiveEntered = false;
  const exclusive = gate.exclusive(async () => { exclusiveEntered = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(exclusiveEntered).toBe(false);
  session.release();
  session.release();
  await exclusive;
  expect(exclusiveEntered).toBe(true);
  expect(gate.activeRuns()).toBe(0);
});

it('rejects missing and stale managed non-run session epochs before effects', async () => {
  const gate = createProjectGate();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => ({ projectRevision: 8, contentRevision: 0, generation: 1 }),
      recordRunTerminal: vi.fn(),
    },
    gateFor: () => gate,
    notify: vi.fn(),
    permits: new Map(),
  });
  await expect(runtime.admitSession('project')).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  await expect(runtime.admitSession('project', 7)).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED' });
  expect(gate.activeRuns()).toBe(0);
});

it('attaches a pre-run admission to its exact physical run only once', async () => {
  const gate = createProjectGate();
  const permits = new Map<string, ProjectRunPermit>();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => ({ projectRevision: 5, contentRevision: 0, generation: 7 }),
      recordRunTerminal: () => false,
    },
    gateFor: () => gate,
    notify: () => {},
    permits,
  });
  const admission = await runtime.admit('project', 5);

  expect(() => runtime.attach('run-3', 'other-project', admission)).toThrow('project mismatch');
  expect(runtime.attach('run-1', 'project', admission)).toEqual({
    bindingGeneration: 7,
    projectRevision: 5,
  });
  expect(() => runtime.attach('run-2', 'project', admission)).toThrow('already attached');
  expect(permits.get('run-1')).toMatchObject({
    projectId: 'project',
    bindingGeneration: 7,
    projectRevision: 5,
  });
  expect(runtime.mutationContext('run-1', 'project')).toEqual({
    expectedProjectRevision: 5,
    permit: admission.permit,
  });
  expect(runtime.mutationContext('run-1', 'other-project')).toBeNull();
  expect(runtime.mutationContext('other-run', 'project')).toBeNull();

  runtime.onSettled('run-1');
  expect(runtime.mutationContext('run-1', 'project')).toBeNull();
  expect(gate.activeRuns()).toBe(0);
});

it('detaches a failed pre-claim run without releasing the scoped admission', async () => {
  const gate = createProjectGate();
  const permits = new Map<string, ProjectRunPermit>();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: {
      getBinding: () => ({ projectRevision: 5, contentRevision: 0, generation: 7 }),
      recordRunTerminal: () => false,
    },
    gateFor: () => gate,
    notify: () => {},
    permits,
  });
  const admission = await runtime.admit('project', 5);
  runtime.attach('failed-run', 'project', admission);

  runtime.detach('failed-run', admission);
  expect(permits.has('failed-run')).toBe(false);
  expect(gate.activeRuns()).toBe(1);
  expect(runtime.attach('retry-run', 'project', admission)).toEqual({
    bindingGeneration: 7,
    projectRevision: 5,
  });

  runtime.onSettled('retry-run');
  expect(gate.activeRuns()).toBe(0);
});

it('repairs a recovered terminal under its exact durable epoch and records one receipt', async () => {
  const gate = createProjectGate();
  const binding = { projectRevision: 5, contentRevision: 2, generation: 7 };
  const order: string[] = [];
  const receipts = new Set<string>();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve().then(() => { order.push('recovery'); }),
    store: {
      getBinding: () => binding,
      recordRunTerminal: input => {
        order.push('receipt');
        if (receipts.has(input.runId)) return false;
        receipts.add(input.runId);
        binding.contentRevision += 1;
        return true;
      },
    },
    gateFor: () => gate,
    notify: () => { order.push('notify'); },
    permits: new Map(),
  });

  await runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 7, projectRevision: 5,
    terminals: [{ runId: 'recovered', terminal: 'failed' }],
  }, async () => { order.push('repair'); });
  await runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 7, projectRevision: 5,
    terminals: [{ runId: 'recovered', terminal: 'failed' }],
  }, async () => { order.push('repair:replay'); });

  expect(order).toEqual(['recovery', 'repair', 'receipt', 'notify', 'repair:replay', 'receipt']);
  expect(binding.contentRevision).toBe(3);
  expect(gate.activeRuns()).toBe(0);
});

it('rejects stale recovery epochs before work and releases the real gate once', async () => {
  const gate = createProjectGate();
  const repair = vi.fn();
  const recordRunTerminal = vi.fn();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => ({ projectRevision: 6, contentRevision: 0, generation: 8 }), recordRunTerminal },
    gateFor: () => gate,
    notify: vi.fn(),
    permits: new Map(),
  });

  await expect(runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 7, projectRevision: 5,
    terminals: [{ runId: 'stale', terminal: 'failed' }],
  }, repair)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(repair).not.toHaveBeenCalled();
  expect(recordRunTerminal).not.toHaveBeenCalled();
  expect(gate.activeRuns()).toBe(0);
});

it('withholds terminal receipt and bump when recovered local repair fails', async () => {
  const gate = createProjectGate();
  const recordRunTerminal = vi.fn();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => ({ projectRevision: 0, contentRevision: 0, generation: 0 }), recordRunTerminal },
    gateFor: () => gate,
    notify: vi.fn(),
    permits: new Map(),
  });
  await expect(runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 0, projectRevision: 0,
    terminals: [{ runId: 'failed-repair', terminal: 'failed' }],
  }, async () => { throw new Error('local repair failed'); })).rejects.toThrow('local repair failed');
  expect(recordRunTerminal).not.toHaveBeenCalled();
  expect(gate.activeRuns()).toBe(0);
});

it('accepts only an explicit zero epoch for unmanaged recovered terminals', async () => {
  const gate = createProjectGate();
  const repair = vi.fn(async () => undefined);
  const recordRunTerminal = vi.fn();
  const runtime = createProjectGitRuntimeAdapter({
    recoveryReady: Promise.resolve(),
    store: { getBinding: () => null, recordRunTerminal },
    gateFor: () => gate,
    notify: vi.fn(),
    permits: new Map(),
  });
  await runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 0, projectRevision: 0,
    terminals: [{ runId: 'unmanaged', terminal: 'failed' }],
  }, repair);
  expect(repair).toHaveBeenCalledOnce();
  expect(recordRunTerminal).not.toHaveBeenCalled();
  await expect(runtime.reconcileTerminalsWithLocalRepair({
    projectId: 'project', bindingGeneration: 1, projectRevision: 0,
    terminals: [{ runId: 'bad-unmanaged', terminal: 'failed' }],
  }, repair)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
