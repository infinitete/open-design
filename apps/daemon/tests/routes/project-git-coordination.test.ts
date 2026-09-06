import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  coordinateAuthorizedProjectMutation,
  coordinateAuthorizedProjectMutationStart,
  coordinateAuthorizedProjectRead,
  coordinateAuthorizedProjectReadStart,
  projectOperationCoordination,
} from '../../src/routes/project-git-coordination.js';
import { createProjectGitMutationAdapter } from '../../src/services/project-git/mutation-adapter.js';
import { GitDomainError } from '../../src/services/project-git/errors.js';
import { createProjectGate } from '../../src/services/project-git/gate.js';

function response() {
  const emitter = new EventEmitter() as EventEmitter & {
    headersSent: boolean;
    writableEnded: boolean;
    destroyed: boolean;
    status(code: number): unknown;
    json(body: unknown): unknown;
  };
  emitter.headersSent = false;
  emitter.writableEnded = false;
  emitter.destroyed = false;
  emitter.status = vi.fn(() => emitter);
  emitter.json = vi.fn(() => emitter);
  return emitter;
}

function coordination() {
  return {
    recoveryReady: Promise.resolve(),
    startup: {} as never,
    withProjectMutation: vi.fn(async (_input, work) => work()),
    withProjectRead: vi.fn(async (_projectId, work) => work()),
    runtime: {} as never,
  };
}

describe('post-authorization project Git coordination', () => {
  it('preserves an unauthorized response without looking up managed binding state', async () => {
    const coordinator = coordination();
    const res = response();
    const authorize = vi.fn(async () => {
      res.status(403);
      res.json({ error: 'forbidden' });
      return false;
    });
    await coordinateAuthorizedProjectMutation({
      req: { body: {}, get: vi.fn() } as never,
      res: res as never,
      projectId: 'managed',
      source: 'test',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize,
      work: vi.fn(async () => undefined),
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(coordinator.withProjectMutation).not.toHaveBeenCalled();
    expect(coordinator.withProjectRead).not.toHaveBeenCalled();
  });

  it('returns an accepted mutation handshake while retaining the permit until background settlement', async () => {
    const coordinator = coordination();
    const order: string[] = [];
    let settle!: () => void;
    const background = new Promise<void>(resolve => { settle = resolve; });
    coordinator.withProjectMutation.mockImplementation(async (_scope, work) => {
      order.push('acquire');
      try {
        return await work();
      } finally {
        order.push('release');
      }
    });

    await expect(coordinateAuthorizedProjectMutationStart({
      req: { body: { expectedProjectRevision: 7 }, get: vi.fn() } as never,
      res: response() as never,
      projectId: 'project',
      source: 'media.generate',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      start: vi.fn(async () => {
        order.push('start');
        return { accepted: { taskId: 'task' }, settled: background };
      }),
      onSettledError: vi.fn(),
    })).resolves.toEqual({ taskId: 'task' });
    expect(order).toEqual(['acquire', 'start']);

    settle();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual(['acquire', 'start', 'release']);
  });

  it('returns an accepted read handshake while retaining the permit until background settlement', async () => {
    const coordinator = coordination();
    const order: string[] = [];
    let settle!: () => void;
    const background = new Promise<void>(resolve => { settle = resolve; });
    coordinator.withProjectRead.mockImplementation(async (_projectId, work) => {
      order.push('acquire');
      try {
        return await work();
      } finally {
        order.push('release');
      }
    });

    await expect(coordinateAuthorizedProjectReadStart({
      req: {} as never,
      res: response() as never,
      projectId: 'project',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      start: vi.fn(async () => {
        order.push('start');
        return { accepted: { taskId: 'task' }, settled: background };
      }),
      onSettledError: vi.fn(),
    })).resolves.toEqual({ taskId: 'task' });
    expect(order).toEqual(['acquire', 'start']);

    settle();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual(['acquire', 'start', 'release']);
  });

  it('does not start a background read when managed admission rejects', async () => {
    const coordinator = coordination();
    coordinator.withProjectRead.mockRejectedValue(
      new GitDomainError('RECOVERY_REQUIRED', 409, 'Project versioning is unavailable until recovery completes.'),
    );
    const start = vi.fn();
    const res = response();
    const sendApiError = vi.fn();

    await expect(coordinateAuthorizedProjectReadStart({
      req: {} as never,
      res: res as never,
      projectId: 'project',
      coordination: coordinator,
      sendApiError,
      authorize: vi.fn(async () => true),
      start,
      onSettledError: vi.fn(),
    })).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(sendApiError).toHaveBeenCalledWith(
      res,
      409,
      'RECOVERY_REQUIRED',
      'Project versioning is unavailable until recovery completes.',
    );
  });

  it('does not start a background mutation when managed admission rejects', async () => {
    const coordinator = coordination();
    coordinator.withProjectMutation.mockRejectedValue(
      new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.'),
    );
    const start = vi.fn();
    const res = response();
    const sendApiError = vi.fn();

    await expect(coordinateAuthorizedProjectMutationStart({
      req: { body: {}, get: vi.fn() } as never,
      res: res as never,
      projectId: 'project',
      source: 'media.generate',
      coordination: coordinator,
      sendApiError,
      authorize: vi.fn(async () => true),
      start,
      onSettledError: vi.fn(),
    })).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(sendApiError).toHaveBeenCalledWith(
      res,
      409,
      'PROJECT_STATE_CHANGED',
      'Reload the project before editing.',
    );
  });

  it('releases a background mutation and isolates its post-acceptance failure', async () => {
    const coordinator = coordination();
    const order: string[] = [];
    coordinator.withProjectMutation.mockImplementation(async (_scope, work) => {
      order.push('acquire');
      try {
        return await work();
      } finally {
        order.push('release');
      }
    });
    let rejectBackground!: (error: unknown) => void;
    const background = new Promise<void>((_resolve, reject) => { rejectBackground = reject; });
    const onSettledError = vi.fn();

    await expect(coordinateAuthorizedProjectMutationStart({
      req: { body: {}, get: vi.fn() } as never,
      res: response() as never,
      projectId: 'project',
      source: 'media.generate',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      start: async () => ({ accepted: 'task', settled: background }),
      onSettledError,
    })).resolves.toBe('task');

    const error = new Error('provider settlement failed');
    rejectBackground(error);
    for (let attempt = 0; attempt < 20 && !order.includes('release'); attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(order).toEqual(['acquire', 'release']);
    expect(onSettledError).toHaveBeenCalledWith(error);
  });

  it('isolates a settled-error callback failure after the accepted response', async () => {
    const coordinator = coordination();
    let rejectBackground!: (error: unknown) => void;
    const background = new Promise<void>((_resolve, reject) => { rejectBackground = reject; });

    await expect(coordinateAuthorizedProjectReadStart({
      req: {} as never,
      res: response() as never,
      projectId: 'project',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      start: async () => ({ accepted: 'task', settled: background }),
      onSettledError: () => { throw new Error('logger unavailable'); },
    })).resolves.toBe('task');

    rejectBackground(new Error('background failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('keeps tab, preview, event, and version bookkeeping outside portable dirty tracking', () => {
    expect(projectOperationCoordination('tab-state')).toBe('none');
    expect(projectOperationCoordination('preview-scope')).toBe('none');
    expect(projectOperationCoordination('event-stream')).toBe('none');
    expect(projectOperationCoordination('file-version-bookkeeping')).toBe('none');
    expect(projectOperationCoordination('portable-content-mutation')).toBe('mutation');
  });

  it('normalizes body and header after authorization and before mutation effects', async () => {
    const coordinator = coordination();
    const work = vi.fn(async () => 'saved');
    await expect(coordinateAuthorizedProjectMutation({
      req: { body: { expectedProjectRevision: '7' }, get: () => '7' } as never,
      res: response() as never,
      projectId: 'project',
      source: 'files.write',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      work,
    })).resolves.toBe('saved');
    expect(coordinator.withProjectMutation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project', expectedProjectRevision: 7 }),
      work,
    );
  });

  it('uses a verified run mutation context without reacquiring and rejects a mismatched transport epoch', async () => {
    const coordinator = coordination();
    const permit = Object.freeze({ run: 'permit' });
    const work = vi.fn(async () => 'saved');
    const trustedMutationContext = {
      expectedProjectRevision: 7,
      permit: permit as never,
    };
    await expect(coordinateAuthorizedProjectMutation({
      req: { body: {}, get: vi.fn() } as never,
      res: response() as never,
      projectId: 'project',
      source: 'tool.write',
      coordination: coordinator,
      sendApiError: vi.fn(),
      authorize: vi.fn(async () => true),
      trustedMutationContext,
      work,
    })).resolves.toBe('saved');
    expect(coordinator.withProjectMutation).toHaveBeenCalledWith(
      {
        projectId: 'project',
        expectedProjectRevision: 7,
        source: 'tool.write',
        permit,
      },
      work,
    );

    coordinator.withProjectMutation.mockClear();
    const res = response();
    const sendApiError = vi.fn();
    await coordinateAuthorizedProjectMutation({
      req: { body: { expectedProjectRevision: 8 }, get: vi.fn() } as never,
      res: res as never,
      projectId: 'project',
      source: 'tool.write',
      coordination: coordinator,
      sendApiError,
      authorize: vi.fn(async () => true),
      trustedMutationContext,
      work,
    });
    expect(coordinator.withProjectMutation).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
    expect(sendApiError).toHaveBeenCalledWith(
      res,
      400,
      'BAD_REQUEST',
      'Invalid project revision.',
    );
  });

  it('rejects an explicitly missing trusted run context even when transport supplies the current managed revision', async () => {
    const bumpContent = vi.fn(() => 1);
    const adapter = createProjectGitMutationAdapter({
      recoveryReady: Promise.resolve(),
      store: {
        getBinding: () => ({
          projectRevision: 7,
          contentRevision: 0,
          generation: 1,
          localHead: null,
          observedRemoteHead: null,
        }),
        bumpContent,
      },
      gateFor: () => createProjectGate(),
      notify: vi.fn(),
    });
    const coordinationWithRealAdapter = {
      ...coordination(),
      ...adapter,
    };
    const res = response();
    const sendApiError = vi.fn();
    const work = vi.fn(async () => 'wrote');

    await expect(coordinateAuthorizedProjectMutation({
      req: { body: { expectedProjectRevision: 7 }, get: vi.fn() } as never,
      res: res as never,
      projectId: 'project',
      source: 'tool.write',
      coordination: coordinationWithRealAdapter,
      sendApiError,
      authorize: vi.fn(async () => true),
      trustedMutationContext: null,
      work,
    })).resolves.toBeUndefined();

    expect(sendApiError).toHaveBeenCalledWith(
      res,
      409,
      'PROJECT_STATE_CHANGED',
      'Reload the project before editing.',
    );
    expect(bumpContent).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('maps a managed domain rejection without letting an outer route rewrite its response', async () => {
    const coordinator = coordination();
    coordinator.withProjectMutation.mockRejectedValue(
      new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.'),
    );
    const res = response();
    const sendApiError = vi.fn();

    await expect(coordinateAuthorizedProjectMutation({
      req: { body: {}, get: vi.fn() } as never,
      res: res as never,
      projectId: 'project',
      source: 'project.update',
      coordination: coordinator,
      sendApiError,
      authorize: vi.fn(async () => true),
      work: vi.fn(async () => undefined),
    })).resolves.toBeUndefined();
    expect(sendApiError).toHaveBeenCalledWith(
      res,
      409,
      'PROJECT_STATE_CHANGED',
      'Reload the project before editing.',
    );
  });

  for (const completionEvent of ['finish', 'close'] as const) {
    it(`retains a streaming read permit through response ${completionEvent}`, async () => {
      const coordinator = coordination();
      const res = response();
      const order: string[] = [];
      coordinator.withProjectRead.mockImplementation(async (_projectId, work) => {
        order.push('acquire');
        const value = await work();
        order.push('release');
        return value;
      });
      const pending = coordinateAuthorizedProjectRead({
        req: {} as never,
        res: res as never,
        projectId: 'project',
        coordination: coordinator,
        sendApiError: vi.fn(),
        authorize: vi.fn(async () => true),
        retainUntilResponse: true,
        work: vi.fn(async () => { order.push('stream'); }),
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(order).toEqual(['acquire', 'stream']);
      res.emit(completionEvent);
      await pending;
      expect(order).toEqual(['acquire', 'stream', 'release']);
    });
  }
});
