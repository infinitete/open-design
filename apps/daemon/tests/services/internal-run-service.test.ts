import { describe, expect, it, vi } from 'vitest';
import {
  createInternalRunCreationService,
  type InternalPhysicalRun,
  type InternalRunCreateInput,
  type InternalRunRegistry,
} from '../../src/services/internal-run-service.js';

interface TestRun extends InternalPhysicalRun {
  assistantMessageId: string | null;
  manualResumeAttemptCount?: number;
  pendingManualResumeAttemptCount?: number;
  projectGitBindingGeneration?: number;
}

function createHarness(initial: {
  creation?: 'created' | 'reused' | 'conflict';
  claimOk?: boolean;
  claimThrows?: boolean;
  restartOk?: boolean;
  installThrows?: boolean;
  startThrows?: boolean;
  reserveRestartOk?: boolean;
} = {}) {
  const run: TestRun = {
    id: 'run-1',
    status: initial.creation === 'reused' ? 'failed' : 'queued',
    assistantMessageId: 'assistant-1',
  };
  const drop = vi.fn();
  const releaseProjectRun = vi.fn();
  let started: Promise<unknown> | null = null;
  const start = vi.fn((startedRun: TestRun, starter: () => Promise<unknown>) => {
    if (initial.startThrows) throw new Error('start failed');
    started = starter();
    return startedRun;
  });
  const persistState = vi.fn();
  const reserveRestartAttempt = vi.fn((reservedRun: TestRun, executionAttempt: number) => {
    if (initial.reserveRestartOk === false) return false;
    reservedRun.pendingManualResumeAttemptCount = executionAttempt;
    persistState(reservedRun);
    return true;
  });
  const clearRestartAttempt = vi.fn((reservedRun: TestRun, executionAttempt: number) => {
    if (reservedRun.pendingManualResumeAttemptCount !== executionAttempt) return;
    delete reservedRun.pendingManualResumeAttemptCount;
    persistState(reservedRun);
  });
  const registry: InternalRunRegistry<InternalRunCreateInput, TestRun> & {
    reserveRestartAttempt(run: TestRun, executionAttempt: number): boolean;
    clearRestartAttempt(run: TestRun, executionAttempt: number): void;
  } = {
    createOrReuse: vi.fn((meta) => {
      run.projectId = meta.projectId ?? null;
      run.expectedProjectRevision = meta.expectedProjectRevision;
      return ({
      kind: initial.creation ?? 'created',
      run,
    } as
      | { kind: 'created'; run: TestRun }
      | { kind: 'reused'; run: TestRun }
      | { kind: 'conflict'; run: TestRun });
    }),
    prepareRestart: vi.fn(() => {
      if (initial.restartOk === false) return null;
      run.status = 'queued';
      run.manualResumeAttemptCount = run.pendingManualResumeAttemptCount
        ?? (run.manualResumeAttemptCount ?? 0) + 1;
      delete run.pendingManualResumeAttemptCount;
      return run;
    }),
    reserveRestartAttempt,
    clearRestartAttempt,
    get: vi.fn(() => null),
    drop,
    fail: vi.fn((failedRun, _errorCode, _errorMessage) => {
      failedRun.status = 'failed';
      releaseProjectRun(failedRun.id);
    }),
    persistState,
    start,
    isTerminal: vi.fn((status) => ['succeeded', 'failed', 'canceled'].includes(status)),
  };
  const claimAssistantMessage = vi.fn((
    _claimedRun: TestRun,
    options?: { beforeClaimCommit?: () => void },
  ) => {
    if (initial.claimThrows) throw new Error('claim failed');
    if (initial.claimOk === false) {
      return { ok: false as const, reason: 'active' as const };
    }
    options?.beforeClaimCommit?.();
    return { ok: true as const };
  });
  const install = vi.fn(() => {
    if (initial.installThrows) throw new Error('install failed');
  });
  const preRunHandle = {
    projectId: 'project-1',
    projectRevision: 7,
    bindingGeneration: 3,
    release: vi.fn(),
  };
  const beginProjectRunAdmission = vi.fn(async () => preRunHandle);
  const attachProjectRun = vi.fn(() => ({ bindingGeneration: 3, projectRevision: 7 }));
  const detachProjectRun = vi.fn();
  const coordinateProjectMutation = vi.fn(async (
    _admission: unknown,
    _source: string,
    work: () => Promise<unknown>,
  ) => work());
  const service = createInternalRunCreationService({
    runs: registry,
    claimAssistantMessage,
    analyticsLifecycle: { install },
    releaseProjectRun,
    beginProjectRunAdmission,
    attachProjectRun,
    detachProjectRun,
    coordinateProjectMutation: coordinateProjectMutation as any,
  });
  return {
    attachProjectRun,
    beginProjectRunAdmission,
    claimAssistantMessage,
    clearRestartAttempt,
    drop,
    detachProjectRun,
    install,
    persistState,
    coordinateProjectMutation,
    preRunHandle,
    releaseProjectRun,
    registry,
    reserveRestartAttempt,
    run,
    service,
    start,
    started: () => started,
  };
}

describe('internal run creation service', () => {
  it('creates, claims, and starts a prepared physical run with the same resolved input', async () => {
    const harness = createHarness();
    const meta: InternalRunCreateInput = {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'codex',
      currentPrompt: 'Build the page',
      appliedPluginSnapshotId: 'snapshot-1',
      sessionMode: 'design',
      analyticsHints: { sourceRunId: 'run-0' },
    };
    const prepared = await harness.service.prepare({ meta });

    expect(prepared).toEqual({
      kind: 'ready',
      run: harness.run,
      creationKind: 'created',
      resumed: false,
    });
    expect(harness.registry.createOrReuse).toHaveBeenCalledWith(meta);
    expect(harness.claimAssistantMessage).toHaveBeenCalledOnce();

    const starter = vi.fn(async () => undefined);
    if (prepared.kind !== 'ready') throw new Error('expected ready run');
    harness.service.start(
      prepared.run,
      { body: { ...meta }, requestAnalyticsContext: null },
      starter,
    );
    expect(harness.start).toHaveBeenCalledOnce();
    expect(starter).toHaveBeenCalledWith(harness.run);
  });

  // Every physical Run is started here, so this is the one place that can
  // guarantee analytics without each caller remembering to ask for it. Four
  // daemon-internal callers used to start Runs another way and reported
  // nothing at all (OPEND-2365).
  it('arms the analytics lifecycle for the run before it starts', async () => {
    const harness = createHarness();
    const starter = vi.fn(async () => undefined);
    const facts = {
      body: { projectId: 'project-1' },
      requestAnalyticsContext: {
        deviceId: 'device-1',
        sessionId: 'session-1',
        clientType: 'web' as const,
        locale: 'en',
        requestId: null,
      },
      creationKind: 'created' as const,
      resumed: false,
    };

    const prepared = await harness.service.prepare({ meta: {} });
    if (prepared.kind !== 'ready') throw new Error('expected ready run');
    harness.service.start(prepared.run, facts, starter);

    expect(harness.install).toHaveBeenCalledWith({ ...facts, run: harness.run });
    expect(harness.install.mock.invocationCallOrder[0]!)
      .toBeLessThan(harness.start.mock.invocationCallOrder[0]!);
  });

  it('starts the run even when no caller identity is available', async () => {
    // A scheduled Automation has nobody to attribute the Run to. It still goes
    // through the one start path so the Run is never silently uninstrumented
    // for a reason other than "there was no identity".
    const harness = createHarness();
    const starter = vi.fn(async () => undefined);

    const prepared = await harness.service.prepare({ meta: {} });
    if (prepared.kind !== 'ready') throw new Error('expected ready run');
    harness.service.start(prepared.run, { body: {}, requestAnalyticsContext: null }, starter);

    expect(harness.install).toHaveBeenCalledOnce();
    expect(harness.start).toHaveBeenCalledOnce();
  });

  it('admits and persists the captured project epoch before claim or portable seeds', async () => {
    const harness = createHarness();
    let releaseAdmission!: () => void;
    harness.beginProjectRunAdmission.mockImplementation(() => new Promise(resolve => {
      releaseAdmission = () => resolve(harness.preRunHandle);
    }));
    const beforeClaimCommit = vi.fn();
    const preparing = harness.service.prepare({
      meta: {
      projectId: 'project-1',
      expectedProjectRevision: 7,
      },
      beforeClaimCommit,
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.beginProjectRunAdmission).toHaveBeenCalledWith('project-1', 7);
    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
    expect(beforeClaimCommit).not.toHaveBeenCalled();

    releaseAdmission();
    const prepared = await preparing;
    expect(prepared.kind).toBe('ready');
    expect(harness.run.projectGitBindingGeneration).toBe(3);
    expect(harness.run.expectedProjectRevision).toBe(7);
    expect(harness.registry.persistState).toHaveBeenCalledWith(harness.run);
    expect(beforeClaimCommit).toHaveBeenCalledWith(harness.run);
    expect(harness.persistState.mock.invocationCallOrder[0]!)
      .toBeLessThan(harness.claimAssistantMessage.mock.invocationCallOrder[0]!);
  });

  it('drops a new run with zero claim or seed effects when managed admission rejects', async () => {
    const harness = createHarness();
    const beforeClaimCommit = vi.fn();
    harness.beginProjectRunAdmission.mockRejectedValue(new Error('stale project revision'));

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 6 },
      beforeClaimCommit,
    })).rejects.toThrow('stale project revision');
    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
    expect(beforeClaimCommit).not.toHaveBeenCalled();
    expect(harness.registry.persistState).not.toHaveBeenCalled();
    expect(harness.drop).toHaveBeenCalledWith(harness.run);
    expect(harness.releaseProjectRun).not.toHaveBeenCalled();
  });

  it('drops an optimistic run and releases admission when the assistant ownership claim is rejected', async () => {
    const harness = createHarness({ claimOk: false });
    const beforeClaimCommit = vi.fn();

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1' },
      beforeClaimCommit,
    })).resolves.toEqual({
      kind: 'assistant_claim_conflict',
      run: harness.run,
      reason: 'active',
    });
    expect(beforeClaimCommit).not.toHaveBeenCalled();
    expect(harness.drop).toHaveBeenCalledWith(harness.run);
    expect(harness.releaseProjectRun).toHaveBeenCalledWith('run-1');
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('runs message seeding inside a successful ownership claim', async () => {
    const harness = createHarness();
    const beforeClaimCommit = vi.fn();

    expect((await harness.service.prepare({ meta: {}, beforeClaimCommit })).kind).toBe('ready');
    expect(beforeClaimCommit).toHaveBeenCalledOnce();
    expect(beforeClaimCommit).toHaveBeenCalledWith(harness.run);
  });

  it('drops an optimistic run and releases admission when the claim transaction throws', async () => {
    const harness = createHarness({ claimThrows: true });

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1' },
    })).rejects.toThrow('claim failed');
    expect(harness.drop).toHaveBeenCalledWith(harness.run);
    expect(harness.releaseProjectRun).toHaveBeenCalledWith('run-1');
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('returns an existing idempotent run without admission, claim, or effects', async () => {
    const harness = createHarness({ creation: 'reused' });

    expect(await harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 9 },
    })).toEqual({
      kind: 'reused',
      run: harness.run,
    });
    expect(harness.beginProjectRunAdmission).not.toHaveBeenCalled();
    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('admits a resume with the request epoch before it reclaims and rearms the run', async () => {
    const harness = createHarness({ creation: 'reused' });
    harness.run.expectedProjectRevision = 2;
    harness.run.manualResumeAttemptCount = 2;

    expect(await harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 8 },
      resume: { requested: true, canResume: () => true },
    })).toEqual({
      kind: 'ready',
      run: harness.run,
      creationKind: 'reused',
      resumed: true,
    });
    expect(harness.beginProjectRunAdmission).toHaveBeenCalledWith('project-1', 8);
    expect(harness.reserveRestartAttempt).toHaveBeenCalledWith(harness.run, 3);
    expect(harness.reserveRestartAttempt.mock.invocationCallOrder[0]!)
      .toBeLessThan(harness.claimAssistantMessage.mock.invocationCallOrder[0]!);
    expect(harness.attachProjectRun).toHaveBeenCalledWith(
      'run-1',
      'project-1',
      harness.preRunHandle,
      3,
    );
    expect(harness.claimAssistantMessage).toHaveBeenCalledWith(
      harness.run,
      expect.objectContaining({ status: 'queued' }),
    );
    expect(harness.registry.prepareRestart).toHaveBeenCalledWith(harness.run);
    expect(harness.run.manualResumeAttemptCount).toBe(3);
    expect(harness.run.pendingManualResumeAttemptCount).toBeUndefined();
  });

  it('clears a durable resume-attempt reservation when the assistant claim conflicts', async () => {
    const harness = createHarness({ creation: 'reused', claimOk: false });
    harness.run.manualResumeAttemptCount = 0;

    expect(await harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 7 },
      resume: { requested: true, canResume: () => true },
    })).toMatchObject({ kind: 'assistant_claim_conflict' });

    expect(harness.reserveRestartAttempt).toHaveBeenCalledWith(harness.run, 1);
    expect(harness.clearRestartAttempt).toHaveBeenCalledWith(harness.run, 1);
    expect(harness.run.pendingManualResumeAttemptCount).toBeUndefined();
    expect(harness.registry.prepareRestart).not.toHaveBeenCalled();
  });

  it('does not claim or admit a resume when its attempt reservation cannot be persisted', async () => {
    const harness = createHarness({ creation: 'reused', reserveRestartOk: false });

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 7 },
      resume: { requested: true, canResume: () => true },
    })).rejects.toThrow('Failed to persist the resumed run execution attempt.');

    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
    expect(harness.beginProjectRunAdmission).not.toHaveBeenCalled();
    expect(harness.attachProjectRun).not.toHaveBeenCalled();
    expect(harness.run.pendingManualResumeAttemptCount).toBeUndefined();
  });

  it('clears a durable resume-attempt reservation when the claim transaction throws', async () => {
    const harness = createHarness({ creation: 'reused', claimThrows: true });

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 7 },
      resume: { requested: true, canResume: () => true },
    })).rejects.toThrow('claim failed');

    expect(harness.clearRestartAttempt).toHaveBeenCalledWith(harness.run, 1);
    expect(harness.run.pendingManualResumeAttemptCount).toBeUndefined();
    expect(harness.releaseProjectRun).toHaveBeenCalledWith('run-1');
  });

  it('preserves a reused terminal run when resume eligibility fails before admission', async () => {
    const harness = createHarness({ creation: 'reused' });

    expect(await harness.service.prepare({
      meta: {},
      resume: { requested: true, canResume: () => false },
    })).toEqual({ kind: 'resume_not_allowed', run: harness.run });
    expect(harness.drop).not.toHaveBeenCalled();
    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
  });

  it('releases an admitted resume when restart preparation fails', async () => {
    const harness = createHarness({ creation: 'reused', restartOk: false });

    expect(await harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 4 },
      resume: { requested: true, canResume: () => true },
    })).toEqual({ kind: 'resume_not_allowed', run: harness.run });
    expect(harness.releaseProjectRun).toHaveBeenCalledOnce();
    expect(harness.releaseProjectRun).toHaveBeenCalledWith('run-1');
    expect(harness.drop).not.toHaveBeenCalled();
    expect(harness.run.pendingManualResumeAttemptCount).toBe(1);
  });

  it('discards an admitted ready run through the service and releases exactly once', async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepare({ meta: { projectId: 'project-1' } });
    if (prepared.kind !== 'ready') throw new Error('expected ready run');

    harness.service.discard(prepared.run);
    harness.service.discard(prepared.run);

    expect(harness.releaseProjectRun).toHaveBeenCalledOnce();
    expect(harness.releaseProjectRun).toHaveBeenCalledWith('run-1');
    expect(harness.drop).toHaveBeenCalledOnce();
    expect(harness.drop).toHaveBeenCalledWith(harness.run);
  });

  it('does not let start bypass preparation', () => {
    const harness = createHarness();
    const starter = vi.fn(async () => undefined);

    expect(() => harness.service.start(
      { ...harness.run, projectId: 'project-1' },
      { body: {}, requestAnalyticsContext: null },
      starter,
    )).toThrow('must be prepared');
    expect(harness.install).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
  });

  it('reuses one branded pre-run admission for snapshot mutation and physical-run attach', async () => {
    const harness = createHarness();
    const effect = vi.fn(async () => 'snapshot-ready');
    const service = harness.service as typeof harness.service & {
      preAdmitProjectRun(projectId: string, expected?: number): Promise<unknown>;
      withProjectMutation<T>(admission: unknown, source: string, work: () => Promise<T>): Promise<T>;
    };

    const admission = await service.preAdmitProjectRun('project-1', 7);
    await expect(service.withProjectMutation(
      admission,
      'run.snapshot-resolution',
      effect,
    )).resolves.toBe('snapshot-ready');
    const prepared = await service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 7 },
      projectAdmission: admission,
    } as never);

    expect(prepared.kind).toBe('ready');
    expect(harness.beginProjectRunAdmission).toHaveBeenCalledOnce();
    expect(harness.attachProjectRun).toHaveBeenCalledWith(
      'run-1',
      'project-1',
      harness.preRunHandle,
      0,
    );
    expect(harness.coordinateProjectMutation).toHaveBeenCalledWith(
      harness.preRunHandle,
      'run.snapshot-resolution',
      effect,
    );
    expect(harness.beginProjectRunAdmission.mock.invocationCallOrder[0]!)
      .toBeLessThan(harness.coordinateProjectMutation.mock.invocationCallOrder[0]!);
    expect(harness.coordinateProjectMutation.mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(harness.registry.createOrReuse).mock.invocationCallOrder[0]!);
  });

  it('rejects a stale pre-run epoch before snapshot mutation or private run allocation', async () => {
    const harness = createHarness();
    harness.beginProjectRunAdmission.mockRejectedValue(new Error('stale project revision'));

    await expect(harness.service.preAdmitProjectRun('project-1', 6))
      .rejects.toThrow('stale project revision');
    expect(harness.coordinateProjectMutation).not.toHaveBeenCalled();
    expect(harness.registry.createOrReuse).not.toHaveBeenCalled();
    expect(harness.claimAssistantMessage).not.toHaveBeenCalled();
  });

  it('detaches a supplied admission after claim failure so the request scope can release it', async () => {
    const harness = createHarness({ claimThrows: true });
    const admission = await harness.service.preAdmitProjectRun('project-1', 7);

    await expect(harness.service.prepare({
      meta: { projectId: 'project-1', expectedProjectRevision: 7 },
      projectAdmission: admission,
    })).rejects.toThrow('claim failed');
    expect(harness.detachProjectRun).toHaveBeenCalledWith(
      'run-1',
      harness.preRunHandle,
    );
    expect(harness.releaseProjectRun).not.toHaveBeenCalled();

    harness.service.releaseProjectRunAdmission(admission);
    harness.service.releaseProjectRunAdmission(admission);
    expect(harness.preRunHandle.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['analytics install', { installThrows: true }, 'install failed'],
    ['registry start', { startThrows: true }, 'start failed'],
  ] as const)('fails a prepared run and releases its admission when %s throws synchronously', async (
    _label,
    setup,
    message,
  ) => {
    const harness = createHarness(setup);
    const prepared = await harness.service.prepare({ meta: { projectId: 'project-1' } });
    if (prepared.kind !== 'ready') throw new Error('expected ready run');

    expect(() => harness.service.start(
      prepared.run,
      { body: {}, requestAnalyticsContext: null },
      async () => undefined,
    )).toThrow(message);
    expect(harness.releaseProjectRun).toHaveBeenCalledOnce();
    expect(harness.registry.fail).toHaveBeenCalledWith(
      harness.run,
      'RUN_START_FAILED',
      message,
    );
    expect(harness.drop).not.toHaveBeenCalled();
  });
});
