import type { Request, Response } from 'express';
import type { ProjectGitCoordination } from '../services/project-git/mutation-adapter.js';
import { expectedProjectRevisionFromTransport } from '../services/project-git/mutation-adapter.js';
import { GitDomainError } from '../services/project-git/errors.js';
import type { ProjectRunMutationContext } from '../services/project-git/runtime-adapter.js';

type SendApiError = (
  res: Response,
  status: number,
  code: string,
  message: string,
) => unknown;

interface AuthorizedProjectOperation<T> {
  req: Request;
  res: Response;
  projectId: string;
  coordination: ProjectGitCoordination;
  sendApiError: SendApiError;
  authorize(): Promise<boolean>;
  work(): Promise<T>;
}

export type AuditedProjectOperation =
  | 'current-content-read'
  | 'portable-content-mutation'
  | 'event-stream'
  | 'preview-scope'
  | 'tab-state'
  | 'file-version-bookkeeping';

export function projectOperationCoordination(
  operation: AuditedProjectOperation,
): 'read' | 'mutation' | 'none' {
  if (operation === 'current-content-read') return 'read';
  if (operation === 'portable-content-mutation') return 'mutation';
  return 'none';
}

function responseCompletion(res: Response): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res.off('finish', done);
      res.off('close', done);
      resolve();
    };
    res.once('finish', done);
    res.once('close', done);
  });
}

export async function coordinateAuthorizedProjectRead<T>(
  input: AuthorizedProjectOperation<T> & { retainUntilResponse?: boolean },
): Promise<T | undefined> {
  if (!await input.authorize()) return undefined;
  try {
    return await input.coordination.withProjectRead(input.projectId, async () => {
      const completion = input.retainUntilResponse ? responseCompletion(input.res) : null;
      const result = await input.work();
      if (completion) await completion;
      return result;
    });
  } catch (error) {
    if (error instanceof GitDomainError && !input.res.headersSent) {
      input.sendApiError(input.res, error.status, error.code, error.message);
      return undefined;
    }
    throw error;
  }
}

export async function coordinateAuthorizedProjectMutation<T>(
  input: AuthorizedProjectOperation<T> & {
    source: string;
    trustedMutationContext?: ProjectRunMutationContext | null;
  },
): Promise<T | unknown | undefined> {
  if (!await input.authorize()) return undefined;
  try {
    return await input.coordination.withProjectMutation(
      projectMutationScope(input),
      input.work,
    );
  } catch (error) {
    if (error instanceof GitDomainError && !input.res.headersSent) {
      return input.sendApiError(input.res, error.status, error.code, error.message);
    }
    throw error;
  }
}

function projectMutationScope(input: {
  req: Request;
  projectId: string;
  source: string;
  trustedMutationContext?: ProjectRunMutationContext | null;
}) {
  const requiresTrustedMutationContext = Object.prototype.hasOwnProperty.call(
    input,
    'trustedMutationContext',
  );
  const transportedProjectRevision = expectedProjectRevisionFromTransport({
    body: input.req.body?.expectedProjectRevision,
    header: input.req.get('X-OD-Project-Revision'),
  });
  if (
    requiresTrustedMutationContext
    && input.trustedMutationContext
    && transportedProjectRevision !== undefined
    && transportedProjectRevision !== input.trustedMutationContext.expectedProjectRevision
  ) {
    throw new GitDomainError('BAD_REQUEST', 400, 'Invalid project revision.');
  }
  const expectedProjectRevision = requiresTrustedMutationContext
    ? input.trustedMutationContext?.expectedProjectRevision
    : transportedProjectRevision;
  return {
    projectId: input.projectId,
    ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }),
    source: input.source,
    ...(input.trustedMutationContext
      ? { permit: input.trustedMutationContext.permit }
      : {}),
  };
}

export async function coordinateAuthorizedProjectMutationStart<T>(
  input: Omit<AuthorizedProjectOperation<never>, 'work'> & {
    source: string;
    trustedMutationContext?: ProjectRunMutationContext | null;
    start(): Promise<{ accepted: T; settled: Promise<unknown> }>;
    onSettledError(error: unknown): void;
  },
): Promise<T | undefined> {
  if (!await input.authorize()) return undefined;
  try {
    let resolveAccepted!: (value: T) => void;
    let rejectAccepted!: (error: unknown) => void;
    let started = false;
    const accepted = new Promise<T>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const settled = input.coordination.withProjectMutation(
      projectMutationScope(input),
      async () => {
        const mutation = await input.start();
        started = true;
        resolveAccepted(mutation.accepted);
        await mutation.settled;
      },
    );
    void settled.catch(error => {
      rejectAccepted(error);
      if (started) {
        try { input.onSettledError(error); } catch { /* The 202 response already settled. */ }
      }
    });
    return await accepted;
  } catch (error) {
    if (error instanceof GitDomainError && !input.res.headersSent) {
      input.sendApiError(input.res, error.status, error.code, error.message);
      return undefined;
    }
    throw error;
  }
}

export async function coordinateAuthorizedProjectReadStart<T>(
  input: Omit<AuthorizedProjectOperation<never>, 'work'> & {
    start(): Promise<{ accepted: T; settled: Promise<unknown> }>;
    onSettledError(error: unknown): void;
  },
): Promise<T | undefined> {
  if (!await input.authorize()) return undefined;
  try {
    let resolveAccepted!: (value: T) => void;
    let rejectAccepted!: (error: unknown) => void;
    let started = false;
    const accepted = new Promise<T>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const settled = input.coordination.withProjectRead(input.projectId, async () => {
      const read = await input.start();
      started = true;
      resolveAccepted(read.accepted);
      await read.settled;
    });
    void settled.catch(error => {
      rejectAccepted(error);
      if (started) {
        try { input.onSettledError(error); } catch { /* The 202 response already settled. */ }
      }
    });
    return await accepted;
  } catch (error) {
    if (error instanceof GitDomainError && !input.res.headersSent) {
      input.sendApiError(input.res, error.status, error.code, error.message);
      return undefined;
    }
    throw error;
  }
}
