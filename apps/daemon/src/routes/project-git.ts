import type Database from 'better-sqlite3';
import type { Express, Request, RequestHandler, Response } from 'express';
import {
  ProjectGitBindingPreviewRequestSchema,
  ProjectGitBindRequestSchema,
  ProjectGitEnableRequestSchema,
  ProjectGitOpenRequestSchema,
  ProjectGitResolveRequestSchema,
  ProjectGitRestorePreviewRequestSchema,
  ProjectGitRestoreRequestSchema,
  ProjectGitRetryRequestSchema,
  ProjectGitSyncRequestSchema,
  ProjectGitUnbindRequestSchema,
  ProjectGitUpdateRequestSchema,
  type ProjectGitAction,
  type ProjectGitBindingPreviewRequest,
  type ProjectGitBindRequest,
  type ProjectGitEnableRequest,
  type ProjectGitOpenRequest,
  type ProjectGitRequestContext,
  type ProjectGitResolveRequest,
  type ProjectGitRestorePreviewRequest,
  type ProjectGitRestoreRequest,
  type ProjectGitRetryRequest,
  type ProjectGitSyncRequest,
  type ProjectGitUnbindRequest,
  type ProjectGitUpdateRequest,
} from '@open-design/contracts';
import { getProject } from '../db.js';
import type { HttpDeps } from '../server-context.js';
import type { ProjectGitStore } from '../storage/project-git.js';
import { GitDomainError } from '../services/project-git/errors.js';
import { expectedProjectRevisionFromTransport } from '../services/project-git/mutation-adapter.js';
import type { ProjectGitService } from '../services/project-git/service.js';

type AuthorizeProjectRequest = (
  req: Request,
  res: Response,
  projectId: string,
  options: { mode: 'read' | 'write'; capability?: 'writeFiles' },
) => boolean | Promise<boolean>;

export interface RegisterProjectGitRoutesDeps {
  db: Database.Database;
  projectGit: ProjectGitService;
  projectGitStore: ProjectGitStore;
  resolveProjectGitActor(req: Request): string;
  authorizeProjectRequest: AuthorizeProjectRequest;
  http: Pick<HttpDeps, 'sendApiError' | 'requireLocalDaemonRequest'>;
}

function idempotencyKey(req: Request): string {
  const value = req.get('idempotency-key')?.trim();
  if (!value || value.length > 256 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new GitDomainError('BAD_REQUEST', 400, 'A valid Idempotency-Key header is required.');
  }
  return value;
}

interface Schema<T> { parse(input: unknown): T }

function parse<T>(schema: Schema<T>, req: Request): T {
  return schema.parse(req.body ?? {});
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join('/') : value ?? '';
}

function routeError(ctx: RegisterProjectGitRoutesDeps, res: Response, error: unknown): Response {
  if (res.headersSent) return res;
  if (error instanceof GitDomainError) {
    return ctx.http.sendApiError(res, error.status, error.code, error.message, error.details ? { details: error.details } : {});
  }
  if (error instanceof Error && error.name === 'ZodError') {
    const issues = (error as Error & { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues ?? [];
    return ctx.http.sendApiError(res, 400, 'BAD_REQUEST', 'Invalid project Git request.', {
      details: { issues: issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }
  return ctx.http.sendApiError(res, 500, 'INTERNAL_ERROR', 'Project versioning request failed.');
}

function expectedRevision(req: Request, body: { expectedProjectRevision?: number }): number | undefined {
  return expectedProjectRevisionFromTransport({
    body: body.expectedProjectRevision,
    header: req.get('x-od-project-revision'),
  });
}

export function registerProjectGitRoutes(app: Express, ctx: RegisterProjectGitRoutesDeps): void {
  const project = async (req: Request, res: Response, mode: 'read' | 'write'): Promise<string | null> => {
    const projectId = param(req.params.id);
    if (!projectId) {
      ctx.http.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    if (!await ctx.authorizeProjectRequest(req, res, projectId, mode === 'write' ? { mode, capability: 'writeFiles' } : { mode })) return null;
    if (!getProject(ctx.db, projectId)) {
      ctx.http.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    return projectId;
  };
  const context = (req: Request, projectId: string | null, body: { expectedProjectRevision?: number }): ProjectGitRequestContext => ({
    actorId: ctx.resolveProjectGitActor(req),
    projectId,
    idempotencyKey: idempotencyKey(req),
    ...(() => {
      const revision = expectedRevision(req, body);
      return revision === undefined ? {} : { expectedProjectRevision: revision };
    })(),
  });
  const read = (work: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const result = await work(req, res);
      if (!res.headersSent) res.status(200).json(result);
    }
    catch (error) { routeError(ctx, res, error); }
  };
  const mutate = <T extends { expectedProjectRevision?: number }>(
    schema: Schema<unknown>,
    action: (body: T) => ProjectGitAction,
  ) => async (req: Request, res: Response) => {
    try {
      const projectId = await project(req, res, 'write');
      if (!projectId) return;
      const body = parse(schema, req) as T;
      res.status(202).json(await ctx.projectGit.execute(action(body), context(req, projectId, body)));
    } catch (error) { routeError(ctx, res, error); }
  };

  app.use('/api/projects/:id/git', ctx.http.requireLocalDaemonRequest as RequestHandler);
  app.use('/api/project-git-operations/:id', ctx.http.requireLocalDaemonRequest as RequestHandler);

  app.get('/api/projects/:id/git', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    return ctx.projectGit.getState(projectId);
  }));
  app.post('/api/projects/:id/git/enable', mutate<ProjectGitEnableRequest>(ProjectGitEnableRequestSchema, body => body.mode === 'preview'
    ? { kind: 'enable_preview' } : { kind: 'enable', previewId: body.previewId }));
  app.post('/api/projects/:id/git/binding-preview', mutate<ProjectGitBindingPreviewRequest>(ProjectGitBindingPreviewRequestSchema,
    body => ({ kind: 'binding_preview', url: body.url, branch: body.branch })));
  app.post('/api/projects/:id/git/bind', mutate<ProjectGitBindRequest>(ProjectGitBindRequestSchema,
    body => ({ kind: 'bind', previewId: body.previewId, ...(body.confirmation ? { confirmation: body.confirmation } : {}) })));
  app.post('/api/projects/:id/git/unbind', mutate<ProjectGitUnbindRequest>(ProjectGitUnbindRequestSchema, () => ({ kind: 'unbind' })));
  app.patch('/api/projects/:id/git', mutate<ProjectGitUpdateRequest>(ProjectGitUpdateRequestSchema,
    body => ({ kind: body.action })));
  app.post('/api/projects/:id/git/sync', mutate<ProjectGitSyncRequest>(ProjectGitSyncRequestSchema, () => ({ kind: 'sync' })));

  app.post('/api/import/git', ctx.http.requireLocalDaemonRequest as RequestHandler, async (req, res) => {
    try {
      const body = parse(ProjectGitOpenRequestSchema, req) as ProjectGitOpenRequest;
      res.status(202).json(await ctx.projectGit.execute(
        { kind: 'open', url: body.url, branch: body.branch },
        context(req, null, {}),
      ));
    } catch (error) { routeError(ctx, res, error); }
  });

  app.get('/api/projects/:id/git/history', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    if (Array.isArray(req.query.cursor) || Array.isArray(req.query.path)
      || req.query.cursor && typeof req.query.cursor !== 'string'
      || req.query.path && typeof req.query.path !== 'string') {
      throw new GitDomainError('BAD_REQUEST', 400, 'History query parameters must be singular strings.');
    }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const path = typeof req.query.path === 'string' ? req.query.path : undefined;
    return ctx.projectGit.history(projectId, cursor, path);
  }));
  app.get('/api/projects/:id/git/commits/:oid', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    return ctx.projectGit.commit(projectId, param(req.params.oid));
  }));
  app.get('/api/projects/:id/git/commits/:oid/files/*path', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    const raw = req.params.path;
    const path = Array.isArray(raw) ? raw.join('/') : raw;
    if (!path) throw new GitDomainError('BAD_REQUEST', 400, 'A historical file path is required.');
    return ctx.projectGit.file(projectId, param(req.params.oid), path);
  }));
  app.get('/api/projects/:id/git/commits/:oid/conversations', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    return ctx.projectGit.conversations(projectId, param(req.params.oid));
  }));
  app.post('/api/projects/:id/git/restore-preview', mutate<ProjectGitRestorePreviewRequest>(ProjectGitRestorePreviewRequestSchema,
    body => ({ kind: 'restore_preview', oid: body.oid })));
  app.post('/api/projects/:id/git/restore', mutate<ProjectGitRestoreRequest>(ProjectGitRestoreRequestSchema,
    body => ({ kind: 'restore', previewId: body.previewId })));
  app.get('/api/projects/:id/git/conflicts', read(async (req, res) => {
    const projectId = await project(req, res, 'read');
    if (!projectId) return undefined;
    return { conflicts: await ctx.projectGit.conflicts(projectId) };
  }));
  app.post('/api/projects/:id/git/conflicts/resolve', mutate<ProjectGitResolveRequest>(ProjectGitResolveRequestSchema,
    body => ({ kind: 'resolve', operationId: body.operationId, resolutions: body.resolutions, basis: body.basis })));

  const authorizeOperation = async (req: Request, res: Response, write: boolean) => {
    const journal = ctx.projectGitStore.getJournal(param(req.params.id));
    if (!journal || journal.kind === 'checkpoint'
      || journal.projectId === null && journal.actorId !== ctx.resolveProjectGitActor(req)) {
      ctx.http.sendApiError(res, 404, 'NOT_FOUND', 'Project Git operation not found.');
      return null;
    }
    if (journal.projectId) {
      const visibleProject = getProject(ctx.db, journal.projectId);
      // Initial imports reserve an ID before publication. Keep their creator's
      // read access after rollback too, using the durable creation provenance.
      const payload = journal.payload;
      if (!visibleProject && !write && journal.kind === 'open' && journal.scope === 'import'
        && journal.actorId === ctx.resolveProjectGitActor(req)
        && payload && typeof payload === 'object' && !Array.isArray(payload)
        && payload.reservedProjectId === journal.projectId) return journal;
      if (!await ctx.authorizeProjectRequest(req, res, journal.projectId,
        write ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
      if (!getProject(ctx.db, journal.projectId)) {
        ctx.http.sendApiError(res, 404, 'NOT_FOUND', 'Project Git operation not found.');
        return null;
      }
    }
    return journal;
  };
  app.get('/api/project-git-operations/:id', read(async (req, res) => {
    const journal = await authorizeOperation(req, res, false);
    if (!journal) return undefined;
    return ctx.projectGit.getOperation(journal.id);
  }));
  app.post('/api/project-git-operations/:id/retry', async (req, res) => {
    try {
      const journal = await authorizeOperation(req, res, true);
      if (!journal) return;
      const supplied = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as { operationId?: unknown }).operationId : undefined;
      if (supplied !== undefined && supplied !== journal.id) throw new GitDomainError('BAD_REQUEST', 400, 'Operation ID mismatch.');
      const body = ProjectGitRetryRequestSchema.parse({ ...(req.body ?? {}), operationId: journal.id }) as ProjectGitRetryRequest;
      if (body.operationId !== journal.id) throw new GitDomainError('BAD_REQUEST', 400, 'Operation ID mismatch.');
      res.status(202).json(await ctx.projectGit.execute(
        { kind: 'retry', operationId: journal.id },
        context(req, journal.projectId, body),
      ));
    } catch (error) { routeError(ctx, res, error); }
  });
}
