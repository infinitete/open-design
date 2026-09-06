import { describe, expect, it, vi } from 'vitest';

import {
  coordinateProjectBatchDelete,
  parseBatchDeleteExpectedProjectRevisions,
  projectBatchDeleteErrorResponse,
} from '../../src/routes/project/index.js';
import { GitDomainError } from '../../src/services/project-git/errors.js';

describe('workspace batch-delete project Git coordination', () => {
  it('admits every final-reference project in stable order before cancel, bump, or deletion', async () => {
    const order: string[] = [];
    const permits = new Map<string, object>();
    const coordination = {
      runtime: {
        admitSession: vi.fn(async (projectId: string, expected: number | undefined) => {
          order.push(`admit:${projectId}:${expected ?? 'missing'}`);
          const permit = Object.freeze({ projectId });
          permits.set(projectId, permit);
          return {
            projectId,
            expectedProjectRevision: expected ?? 0,
            permit,
            release: () => order.push(`release:${projectId}`),
          };
        }),
      },
      withProjectMutation: vi.fn(async (input: any, work: () => Promise<unknown>) => {
        expect(input.permit).toBe(permits.get(input.projectId));
        order.push(`bump:${input.projectId}`);
        return work();
      }),
    };

    await coordinateProjectBatchDelete({
      finalProjectIds: ['project-b', 'project-a'],
      expectedProjectRevisions: new Map([['project-a', 3], ['project-b', 4]]),
      coordination: coordination as never,
      cancelProjectRuns: async projectId => { order.push(`cancel:${projectId}`); },
      deleteProjects: async () => { order.push('delete'); return 'done'; },
    });

    expect(order).toEqual([
      'admit:project-a:3',
      'admit:project-b:4',
      'cancel:project-a',
      'cancel:project-b',
      'bump:project-a',
      'bump:project-b',
      'delete',
      'release:project-b',
      'release:project-a',
    ]);
  });

  it('releases prior admissions and performs zero effects when any epoch is stale', async () => {
    const order: string[] = [];
    const cancelProjectRuns = vi.fn();
    const deleteProjects = vi.fn();
    const withProjectMutation = vi.fn();
    const coordination = {
      runtime: {
        admitSession: vi.fn(async (projectId: string) => {
          order.push(`admit:${projectId}`);
          if (projectId === 'project-b') {
            throw new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.');
          }
          return {
            projectId,
            expectedProjectRevision: 1,
            permit: Object.freeze({ projectId }),
            release: () => order.push(`release:${projectId}`),
          };
        }),
      },
      withProjectMutation,
    };

    await expect(coordinateProjectBatchDelete({
      finalProjectIds: ['project-b', 'project-a'],
      expectedProjectRevisions: new Map(),
      coordination: coordination as never,
      cancelProjectRuns,
      deleteProjects,
    })).rejects.toMatchObject({ code: 'PROJECT_STATE_CHANGED', status: 409 });

    expect(order).toEqual(['admit:project-a', 'admit:project-b', 'release:project-a']);
    expect(cancelProjectRuns).not.toHaveBeenCalled();
    expect(withProjectMutation).not.toHaveBeenCalled();
    expect(deleteProjects).not.toHaveBeenCalled();
  });

  it('releases every admission in reverse order when staged deletion fails', async () => {
    const order: string[] = [];
    const coordination = {
      runtime: {
        admitSession: vi.fn(async (projectId: string) => ({
          projectId,
          expectedProjectRevision: 0,
          permit: Object.freeze({ projectId }),
          release: () => order.push(`release:${projectId}`),
        })),
      },
      withProjectMutation: vi.fn(async (_input: unknown, work: () => Promise<unknown>) => work()),
    };

    await expect(coordinateProjectBatchDelete({
      finalProjectIds: ['project-a', 'project-b'],
      expectedProjectRevisions: new Map(),
      coordination: coordination as never,
      cancelProjectRuns: async () => undefined,
      deleteProjects: async () => { throw new Error('staging failed'); },
    })).rejects.toThrow('staging failed');

    expect(order).toEqual(['release:project-b', 'release:project-a']);
  });

  it('normalizes an exact map and only accepts a header for one final-reference project', () => {
    expect(parseBatchDeleteExpectedProjectRevisions({
      selectedProjectIds: ['project-a', 'project-b'],
      finalProjectIds: ['project-a'],
      body: { 'project-a': 3, 'project-b': 4 },
      header: '3',
    })).toEqual(new Map([['project-a', 3]]));

    expect(() => parseBatchDeleteExpectedProjectRevisions({
      selectedProjectIds: ['project-a'],
      finalProjectIds: ['project-a'],
      body: { foreign: 3 },
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
    expect(() => parseBatchDeleteExpectedProjectRevisions({
      selectedProjectIds: ['project-a'],
      finalProjectIds: ['project-a'],
      body: { 'project-a': -1 },
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
    expect(() => parseBatchDeleteExpectedProjectRevisions({
      selectedProjectIds: ['project-a', 'project-b'],
      finalProjectIds: ['project-a', 'project-b'],
      header: '3',
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
    expect(() => parseBatchDeleteExpectedProjectRevisions({
      selectedProjectIds: ['project-a'],
      finalProjectIds: ['project-a'],
      body: { 'project-a': 3 },
      header: '4',
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }));
  });

  it('preserves the standard Git domain status and nested API envelope at the route boundary', () => {
    const failure = projectBatchDeleteErrorResponse(
      new GitDomainError('PROJECT_STATE_CHANGED', 409, 'Reload the project before editing.'),
    );
    expect(failure).toEqual({
      status: 409,
      code: 'PROJECT_STATE_CHANGED',
      message: 'Reload the project before editing.',
    });
    expect({ error: { code: failure.code, message: failure.message } }).toEqual({
      error: {
        code: 'PROJECT_STATE_CHANGED',
        message: 'Reload the project before editing.',
      },
    });
    expect(projectBatchDeleteErrorResponse(new Error('staging failed'))).toEqual({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Error: staging failed',
    });
  });
});
