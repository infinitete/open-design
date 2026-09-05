import { z } from 'zod';
import type { JsonValue } from '../common.js';
import type { ApiError } from '../errors.js';
import type { PortableSnapshot } from './project-git-portable.js';

export interface ProjectMutationRevision {
  expectedProjectRevision?: number;
}

export interface ProjectGitBasis {
  projectRevision: number;
  contentRevision: number;
  localHead: string | null;
  remoteHead: string | null;
  bindingGeneration: number;
}

export type ProjectGitPhase =
  | 'enable_pending'
  | 'waiting_idle'
  | 'dirty'
  | 'checkpointing'
  | 'local_saved'
  | 'pending_push'
  | 'syncing'
  | 'synced'
  | 'paused'
  | 'conflict'
  | 'auth_required'
  | 'external_git_busy'
  | 'recovering'
  | 'failed';

export type ProjectGitDependencyKind =
  | 'git'
  | 'identity'
  | 'agent'
  | 'model'
  | 'plugin'
  | 'linked_folder'
  | 'lfs'
  | 'submodule'
  | 'resource';

export interface ProjectGitNextStep {
  action:
    | 'install_git'
    | 'configure_identity'
    | 'authenticate'
    | 'install_dependency'
    | 'locate_folder'
    | 'resolve_conflict'
    | 'retry';
  label: string;
}

export interface ProjectGitDependency {
  kind: ProjectGitDependencyKind;
  label: string;
  requiredForContent: boolean;
  nextStep: ProjectGitNextStep | null;
}

export interface ProjectGitCollision {
  id: string;
  kind: 'repository' | 'project' | 'path';
  label: string;
  path?: string;
}

export interface ProjectGitChangeSummary {
  addedPaths: string[];
  modifiedPaths: string[];
  deletedPaths: string[];
  settingsChanged: number;
  conversationsChanged: number;
  ignoredPaths: string[];
  privatePaths: string[];
  missingPaths: string[];
  historyMode: 'complete' | 'files_only';
  collisions: ProjectGitCollision[];
}

export interface ProjectGitPreview {
  id: string;
  kind: 'enable' | 'bind' | 'restore' | 'resolve';
  basis: ProjectGitBasis;
  targetOid: string | null;
  expiresAt: number;
  changes: ProjectGitChangeSummary;
  dependencies: ProjectGitDependency[];
  binding?: ProjectGitBindingPreview;
}

export interface ProjectGitBindingPreview {
  classification: 'empty' | 'shared_history' | 'independent_history' | 'different_project';
  /** Available portable heads when a genuine metadata namespace is absent. */
  metadataSources: ('local' | 'remote')[];
  /** Exact full path union requiring a decision, including reserved portable members. */
  requiredPaths: string[];
}

export interface ProjectGitBindConfirmation {
  metadataSource?: 'local' | 'remote';
  paths?: { path: string; selectedSide: 'local' | 'remote' | 'delete' }[];
}

export interface ProjectGitFileResponse {
  encoding: 'base64';
  content: string;
  mediaType: string;
}

export type ProjectGitConflictContent =
  | { kind: 'missing' }
  | { kind: 'text'; content: string }
  | { kind: 'json'; value: JsonValue }
  | { kind: 'resource'; resourceRef: string }
  | { kind: 'file'; file: ProjectGitFileResponse };

type ProjectGitConflictLocation =
  | { path: string; recordId?: never }
  | { path?: never; recordId: string };

export type ProjectGitConflict = {
  id: string;
  kind: 'file' | 'field' | 'message' | 'conversation_order' | 'resource';
  base: ProjectGitConflictContent;
  local: ProjectGitConflictContent;
  remote: ProjectGitConflictContent;
} & ProjectGitConflictLocation;

export type ProjectGitResolution =
  | { conflictId: string; kind: 'select'; selectedSide: 'base' | 'local' | 'remote' }
  | { conflictId: string; kind: 'edit'; value: JsonValue }
  | { conflictId: string; kind: 'edit'; resourceRef: string }
  | { conflictId: string; kind: 'edit'; file: ProjectGitFileResponse }
  | { conflictId: string; kind: 'delete' }
  | { conflictId: string; kind: 'order'; orderedTurnIds: string[] };

export type ProjectGitAction =
  | { kind: 'enable_preview' }
  | { kind: 'enable'; previewId: string }
  | { kind: 'binding_preview'; url: string; branch: string }
  | { kind: 'bind'; previewId: string; confirmation?: ProjectGitBindConfirmation }
  | { kind: 'unbind' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'sync' }
  | { kind: 'open'; url: string; branch: string }
  | { kind: 'restore_preview'; oid: string }
  | { kind: 'restore'; previewId: string }
  | { kind: 'resolve'; operationId: string; resolutions: ProjectGitResolution[] }
  | { kind: 'retry'; operationId: string };

export interface ProjectGitRequestContext extends ProjectMutationRevision {
  actorId: string;
  projectId: string | null;
  idempotencyKey: string;
}

export interface ProjectGitBinding {
  remoteConfigured: boolean;
  remoteLabel: string | null;
  branch: string | null;
}

export interface ProjectGitState {
  enabled: boolean;
  phase: ProjectGitPhase;
  localHead: string | null;
  observedRemoteHead: string | null;
  confirmedRemoteHead: string | null;
  projectRevision: number;
  contentRevision: number;
  bindingGeneration: number;
  dirty: boolean;
  pendingPush: boolean;
  autoSync: boolean;
  operationId: string | null;
  error: ApiError | null;
  binding: ProjectGitBinding;
  dependencies: ProjectGitDependency[];
}

export type ProjectGitOperationStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed';

export interface ProjectGitOperationResult {
  projectId?: string;
  existingProjectIds?: string[];
  preview?: ProjectGitPreview;
  head?: string;
  dependencies?: ProjectGitDependency[];
}

export interface ProjectGitOperation {
  id: string;
  kind: ProjectGitAction['kind'];
  status: ProjectGitOperationStatus;
  phase: ProjectGitPhase;
  projectId: string | null;
  basis: ProjectGitBasis;
  result: ProjectGitOperationResult | null;
  error: ApiError | null;
}

export interface ProjectGitCommitAuthor {
  name: string;
  email: string | null;
}

export interface ProjectGitCommit {
  oid: string;
  parents: string[];
  author: ProjectGitCommitAuthor;
  authoredAt: number;
  message: string;
  source: 'open-design' | 'external';
  snapshotKind: 'complete' | 'files_only';
  changedPaths: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
}

export interface ProjectGitHistoryPage {
  commits: ProjectGitCommit[];
  nextCursor: string | null;
}

export interface ProjectGitAccepted {
  operationId: string;
}

export type ProjectGitEvent =
  | { type: 'project-git-state'; projectId: string; state: ProjectGitState }
  | { type: 'project-git-operation'; projectId: string; operation: ProjectGitOperation };

export type ProjectGitStatusRequest = Record<string, never>;
export type ProjectGitStatusResponse = ProjectGitState;

export type ProjectGitEnableRequest = ProjectMutationRevision & (
  | { mode: 'preview' }
  | { mode: 'confirm'; previewId: string }
);
export type ProjectGitEnableResponse = ProjectGitAccepted;

export interface ProjectGitBindingPreviewRequest extends ProjectMutationRevision {
  url: string;
  branch: string;
}
export type ProjectGitBindingPreviewResponse = ProjectGitAccepted;

export interface ProjectGitBindRequest extends ProjectMutationRevision {
  previewId: string;
  confirmation?: ProjectGitBindConfirmation;
}
export type ProjectGitBindResponse = ProjectGitAccepted;

export interface ProjectGitUnbindRequest extends ProjectMutationRevision {}
export type ProjectGitUnbindResponse = ProjectGitAccepted;

export type ProjectGitUpdateRequest = ProjectMutationRevision & (
  | { action: 'pause' }
  | { action: 'resume' }
);
export type ProjectGitUpdateResponse = ProjectGitAccepted;

export interface ProjectGitSyncRequest extends ProjectMutationRevision {}
export type ProjectGitSyncResponse = ProjectGitAccepted;

export interface ProjectGitOpenRequest {
  url: string;
  branch: string;
}
export type ProjectGitOpenResponse = ProjectGitAccepted;

export interface ProjectGitHistoryRequest {
  cursor?: string;
}
export type ProjectGitHistoryResponse = ProjectGitHistoryPage;

export interface ProjectGitCommitRequest {
  oid: string;
}
export type ProjectGitCommitResponse = ProjectGitCommit;

export interface ProjectGitFileRequest {
  oid: string;
  path: string;
}

export interface ProjectGitConversationsRequest {
  oid: string;
}
export type ProjectGitConversationsResponse = PortableSnapshot;

export interface ProjectGitRestorePreviewRequest extends ProjectMutationRevision {
  oid: string;
}
export type ProjectGitRestorePreviewResponse = ProjectGitAccepted;

export interface ProjectGitRestoreRequest extends ProjectMutationRevision {
  previewId: string;
}
export type ProjectGitRestoreResponse = ProjectGitAccepted;

export type ProjectGitConflictsRequest = Record<string, never>;
export interface ProjectGitConflictsResponse {
  conflicts: ProjectGitConflict[];
}

export interface ProjectGitResolveRequest extends ProjectMutationRevision {
  operationId: string;
  resolutions: ProjectGitResolution[];
}
export type ProjectGitResolveResponse = ProjectGitAccepted;

export interface ProjectGitOperationRequest {
  operationId: string;
}
export type ProjectGitOperationResponse = ProjectGitOperation;

export interface ProjectGitRetryRequest extends ProjectMutationRevision {
  operationId: string;
}
export type ProjectGitRetryResponse = ProjectGitAccepted;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const projectGitFileResponseSchema = z.object({
  encoding: z.literal('base64'),
  content: z.string(),
  mediaType: z.string(),
}).strict();

export const ProjectGitResolutionSchema = z.union([
  z.object({
    conflictId: z.string().min(1),
    kind: z.literal('select'),
    selectedSide: z.enum(['base', 'local', 'remote']),
  }).strict(),
  z.object({
    conflictId: z.string().min(1),
    kind: z.literal('edit'),
    value: jsonValueSchema,
  }).strict(),
  z.object({
    conflictId: z.string().min(1),
    kind: z.literal('edit'),
    resourceRef: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  z.object({
    conflictId: z.string().min(1),
    kind: z.literal('edit'),
    file: projectGitFileResponseSchema,
  }).strict(),
  z.object({ conflictId: z.string().min(1), kind: z.literal('delete') }).strict(),
  z.object({
    conflictId: z.string().min(1),
    kind: z.literal('order'),
    orderedTurnIds: z.array(z.string().min(1)),
  }).strict(),
]);

const projectMutationRevisionSchema = {
  expectedProjectRevision: z.number().int().nonnegative().optional(),
};

export const ProjectGitBindConfirmationSchema = z.object({
  metadataSource: z.enum(['local', 'remote']).optional(),
  paths: z.array(z.object({ path: z.string().min(1), selectedSide: z.enum(['local', 'remote', 'delete']) }).strict())
    .refine(paths => new Set(paths.map(item => item.path)).size === paths.length, 'Duplicate path decisions').optional(),
}).strict();

export const ProjectGitBindRequestSchema = z.object({
  previewId: z.string().min(1), confirmation: ProjectGitBindConfirmationSchema.optional(), ...projectMutationRevisionSchema,
}).strict();

export const ProjectGitDependencySchema = z.object({
  kind: z.enum(['git', 'identity', 'agent', 'model', 'plugin', 'linked_folder', 'lfs', 'submodule', 'resource']),
  label: z.string(), requiredForContent: z.boolean(),
  nextStep: z.object({ action: z.enum(['install_git', 'configure_identity', 'authenticate', 'install_dependency', 'locate_folder', 'resolve_conflict', 'retry']),
    label: z.string() }).strict().nullable(),
}).strict();

export const ProjectGitBindingPreviewSchema = z.object({
  classification: z.enum(['empty', 'shared_history', 'independent_history', 'different_project']),
  metadataSources: z.array(z.enum(['local', 'remote'])), requiredPaths: z.array(z.string().min(1)),
}).strict();

export const ProjectGitPreviewSchema = z.object({
  id: z.string().min(1), kind: z.enum(['enable', 'bind', 'restore', 'resolve']),
  basis: z.object({ projectRevision: z.number().int().nonnegative(), contentRevision: z.number().int().nonnegative(),
    localHead: z.string().nullable(), remoteHead: z.string().nullable(), bindingGeneration: z.number().int().nonnegative() }).strict(),
  targetOid: z.string().nullable(), expiresAt: z.number().finite(),
  changes: z.object({ addedPaths: z.array(z.string()), modifiedPaths: z.array(z.string()), deletedPaths: z.array(z.string()),
    settingsChanged: z.number().int().nonnegative(), conversationsChanged: z.number().int().nonnegative(),
    ignoredPaths: z.array(z.string()), privatePaths: z.array(z.string()), missingPaths: z.array(z.string()),
    historyMode: z.enum(['complete', 'files_only']), collisions: z.array(z.object({ id: z.string(), kind: z.enum(['repository', 'project', 'path']),
      label: z.string(), path: z.string().optional() }).strict()) }).strict(),
  dependencies: z.array(ProjectGitDependencySchema), binding: ProjectGitBindingPreviewSchema.optional(),
}).strict();

export const ProjectGitOperationResultSchema = z.object({
  projectId: z.string().min(1).optional(), existingProjectIds: z.array(z.string().min(1)).optional(),
  preview: ProjectGitPreviewSchema.optional(), head: z.string().min(1).optional(),
  dependencies: z.array(ProjectGitDependencySchema).optional(),
}).strict().refine(value => value.existingProjectIds === undefined || (new Set(value.existingProjectIds).size === value.existingProjectIds.length
  && !value.existingProjectIds.includes(value.projectId ?? '')), 'Existing copies must be distinct from the opened project.');

export const ProjectGitEnableRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preview'), ...projectMutationRevisionSchema }).strict(),
  z.object({
    mode: z.literal('confirm'),
    previewId: z.string().min(1),
    ...projectMutationRevisionSchema,
  }).strict(),
]);

export const ProjectGitActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enable_preview') }).strict(),
  z.object({ kind: z.literal('enable'), previewId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('binding_preview'),
    url: z.string().min(1),
    branch: z.string().min(1),
  }).strict(),
  z.object({ kind: z.literal('bind'), previewId: z.string().min(1), confirmation: ProjectGitBindConfirmationSchema.optional() }).strict(),
  z.object({ kind: z.literal('unbind') }).strict(),
  z.object({ kind: z.literal('pause') }).strict(),
  z.object({ kind: z.literal('resume') }).strict(),
  z.object({ kind: z.literal('sync') }).strict(),
  z.object({
    kind: z.literal('open'),
    url: z.string().min(1),
    branch: z.string().min(1),
  }).strict(),
  z.object({ kind: z.literal('restore_preview'), oid: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('restore'), previewId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('resolve'),
    operationId: z.string().min(1),
    resolutions: z.array(ProjectGitResolutionSchema),
  }).strict(),
  z.object({ kind: z.literal('retry'), operationId: z.string().min(1) }).strict(),
]);

export function parseProjectGitAction(input: unknown): ProjectGitAction {
  return ProjectGitActionSchema.parse(input) as ProjectGitAction;
}

export function parseProjectGitEnableRequest(input: unknown): ProjectGitEnableRequest {
  return ProjectGitEnableRequestSchema.parse(input) as ProjectGitEnableRequest;
}
