import { z } from 'zod';
import type {
  AudioKind,
  DesignSystemReviewDecision,
  MediaAspect,
  ProjectKind,
  ProjectMetadata,
  ProjectPlatform,
} from './projects.js';
import type { ChatRunStatus, ChatSessionMode, ResultDeliveryState } from './chat.js';

const relativePath = z.string().min(1).refine((value) =>
  !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && !/^[a-z]:/i.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);

const portableResourceLocationSchema = z.object({
  path: relativePath,
  purpose: z.enum([
    'attachment',
    'artifact',
    'design-system',
    'skill',
    'plugin',
    'scenario',
    'legacy-history',
  ]),
  sourceLabel: z.string().optional(),
}).strict();
const portableResourceSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  locations: z.array(portableResourceLocationSchema).nonempty(),
  references: z.array(z.string().min(1)),
}).strict().superRefine((resource, context) => {
  const tuples = new Set<string>();
  for (const [index, location] of resource.locations.entries()) {
    const expectedPrefix = location.purpose === 'legacy-history'
      ? '.open-design/legacy-file-history/' : `.open-design/resources/${resource.digest}/`;
    if (!location.path.startsWith(expectedPrefix) || location.path.length === expectedPrefix.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['locations', index, 'path'],
        message: `resource path must be inside ${expectedPrefix}` });
    }
    const tuple = JSON.stringify([location.path, location.purpose, location.sourceLabel ?? null]);
    if (tuples.has(tuple)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['locations', index], message: 'resource location tuple must be unique' });
    tuples.add(tuple);
  }
});

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryProjectId: z.string().min(1),
  resources: z.array(portableResourceSchema),
}).strict();

export type PortableResource = z.infer<typeof portableResourceSchema>;
export type PortableResourceLocation = z.infer<typeof portableResourceLocationSchema>;
export type PortableResourcePurpose = PortableResourceLocation['purpose'];
export type PortableManifest = z.infer<typeof manifestSchema>;

const projectKindSchema = z.enum([
  'prototype',
  'deck',
  'template',
  'other',
  'brand',
  'image',
  'video',
  'audio',
] satisfies [ProjectKind, ...ProjectKind[]]);

const mediaAspectSchema = z.enum([
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
] satisfies [MediaAspect, ...MediaAspect[]]);

const projectPlatformSchema = z.enum([
  'auto',
  'responsive',
  'web-desktop',
  'mobile-ios',
  'mobile-android',
  'tablet',
  'desktop-app',
] satisfies [ProjectPlatform, ...ProjectPlatform[]]);

const promptTemplateSourceSchema = z.object({
  repo: z.string(),
  license: z.string(),
  author: z.string().optional(),
  url: z.string().optional(),
}).strict();

const promptTemplateSchema = z.object({
  id: z.string(),
  surface: z.enum(['image', 'video']),
  title: z.string(),
  prompt: z.string(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  model: z.string().optional(),
  aspect: mediaAspectSchema.optional(),
  source: promptTemplateSourceSchema.optional(),
}).strict();

const portableDesignSystemReviewSchema = z.object({
  decision: z.enum([
    'looks-good',
    'needs-work',
  ] satisfies [DesignSystemReviewDecision, ...DesignSystemReviewDecision[]]),
  updatedAt: z.string(),
  feedback: z.string().optional(),
  files: z.array(relativePath).optional(),
}).strict();

const preferenceKeys = [
  'intent', 'fidelity', 'speakerNotes', 'slideCount', 'animations', 'includeLandingPage',
  'includeOsWidgets', 'templateId', 'templateLabel', 'platform', 'platformTargets',
  'imageModel', 'imageAspect', 'imageStyle', 'videoModel', 'videoLength', 'videoAspect',
  'audioKind', 'audioModel', 'audioDuration', 'voice', 'skipDiscoveryBrief',
  'examplePrompt', 'examplePromptTitle', 'examplePromptBrief',
] as const satisfies readonly (keyof ProjectMetadata)[];

export const PORTABLE_PROJECT_PREFERENCE_KEYS = [
  ...preferenceKeys,
  'promptTemplate',
  'designSystemReview',
  'agentId',
  'model',
] as const;

const portableProjectPreferencesSchema = z.object({
  intent: z.enum([
    'live-artifact',
    'web-clone',
    'document',
    'webgl-experience',
    'worker-visualizer',
    'marketing',
    'hyperframes',
  ]).optional(),
  fidelity: z.enum(['wireframe', 'high-fidelity']).optional(),
  speakerNotes: z.boolean().optional(),
  slideCount: z.string().optional(),
  animations: z.boolean().optional(),
  includeLandingPage: z.boolean().optional(),
  includeOsWidgets: z.boolean().optional(),
  templateId: z.string().optional(),
  templateLabel: z.string().optional(),
  platform: projectPlatformSchema.optional(),
  platformTargets: z.array(projectPlatformSchema).optional(),
  imageModel: z.string().optional(),
  imageAspect: mediaAspectSchema.optional(),
  imageStyle: z.string().optional(),
  videoModel: z.string().optional(),
  videoLength: z.number().optional(),
  videoAspect: mediaAspectSchema.optional(),
  audioKind: z.enum([
    'music',
    'speech',
    'sfx',
  ] satisfies [AudioKind, ...AudioKind[]]).optional(),
  audioModel: z.string().optional(),
  audioDuration: z.number().optional(),
  voice: z.string().optional(),
  skipDiscoveryBrief: z.boolean().optional(),
  examplePrompt: z.boolean().optional(),
  examplePromptTitle: z.string().optional(),
  examplePromptBrief: z.record(z.string()).optional(),
  promptTemplate: promptTemplateSchema.optional(),
  designSystemReview: z.record(portableDesignSystemReviewSchema).optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
}).strict();

const portableExecutionPreferencesSchema = z.object({
  agentId: z.string().optional(),
  model: z.string().optional(),
}).strict();

const chatSessionModeSchema = z.enum([
  'design',
  'chat',
  'plan',
] satisfies [ChatSessionMode, ...ChatSessionMode[]]);

const portableRunStatusSchema = z.enum([
  'succeeded',
  'failed',
  'canceled',
] satisfies [ChatRunStatus, ...ChatRunStatus[]]);

const resultDeliveryStateSchema = z.enum([
  'delivered',
  'no_result',
  'delivery_failed',
] satisfies [ResultDeliveryState, ...ResultDeliveryState[]]);

const portableProjectSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  kind: projectKindSchema,
  entryFile: relativePath.optional(),
  customInstructions: z.string().optional(),
  pendingPrompt: z.string().optional(),
  preferences: portableProjectPreferencesSchema,
  contentRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  linkedFolderRequirements: z.array(z.object({
    label: z.string().min(1),
    purpose: z.string().min(1),
  }).strict()),
}).strict();

const portableConversationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string(),
  mode: chatSessionModeSchema,
  createdAt: z.number().finite(),
  preferences: portableExecutionPreferencesSchema.optional(),
}).strict();

const portableCommentPositionSchema = z.object({
  x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite(),
}).strict();
const portableCommentStyleSchema = z.object({
  color: z.string().optional(), backgroundColor: z.string().optional(), fontSize: z.string().optional(),
  fontWeight: z.string().optional(), lineHeight: z.string().optional(), textAlign: z.string().optional(),
  fontFamily: z.string().optional(), paddingTop: z.string().optional(), paddingRight: z.string().optional(),
  paddingBottom: z.string().optional(), paddingLeft: z.string().optional(), borderRadius: z.string().optional(),
}).strict();
/** Historical selection geometry/text only; never apply to a live document or resume a task. */
const portableCommentAttachmentSchema = z.object({
  order: z.number().int().nonnegative(), label: z.string(), comment: z.string(), currentText: z.string(),
  filePath: relativePath.optional(), elementId: z.string().optional(), selector: z.string().optional(),
  htmlHint: z.string().optional(), pagePosition: portableCommentPositionSchema.optional(),
  style: portableCommentStyleSchema.optional(), selectionKind: z.enum(['element', 'pod', 'visual']).optional(),
  memberCount: z.number().int().nonnegative().optional(), slideIndex: z.number().int().nonnegative().optional(),
  podMembers: z.array(z.object({
    elementId: z.string(), selector: z.string(), label: z.string(), text: z.string(),
    position: portableCommentPositionSchema, htmlHint: z.string().optional(), style: portableCommentStyleSchema.optional(),
  }).strict()).optional(),
  screenshotResourceRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  imageAttachments: z.array(z.object({ resourceRef: z.string().regex(/^[a-f0-9]{64}$/), name: z.string() }).strict()).optional(),
  markKind: z.enum(['click', 'stroke', 'click+stroke']).optional(), intent: z.string().optional(),
  commentContext: z.enum(['context', 'query']).optional(), source: z.enum(['saved-comment', 'board-batch']).optional(),
  unavailable: z.boolean().optional(),
}).strict();

const portableMessageContextSchema = z.object({
  feedback: z.object({
    rating: z.enum(['positive', 'negative']), createdAt: z.number().finite(),
    reasonCodes: z.array(z.enum(['matched_request', 'strong_visual', 'useful_structure', 'easy_to_continue',
      'followed_design_system', 'missed_request', 'weak_visual', 'incomplete_output', 'hard_to_use',
      'missed_design_system', 'other'])).optional(),
    customReason: z.string().optional(), reasonsSubmittedAt: z.number().finite().optional(),
    updatedAt: z.number().finite().optional(),
  }).strict().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  model: z.string().optional(),
  sessionMode: chatSessionModeSchema.optional(),
  runStatus: portableRunStatusSchema.optional(),
  resultDeliveryState: resultDeliveryStateSchema.optional(),
  contentItems: z.array(z.object({
    kind: z.enum(['skill', 'design-system', 'plugin', 'scenario', 'workspace']),
    label: z.string(),
    resourceRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    unavailable: z.boolean().optional(),
  }).strict()).optional(),
  attachments: z.array(z.object({
    resourceRef: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string(),
    kind: z.enum(['image', 'file']),
    size: z.number().nonnegative().optional(),
    order: z.number().int().nonnegative().optional(),
  }).strict()).optional(),
  commentAttachments: z.array(portableCommentAttachmentSchema).optional(),
}).strict();

const portableDisplayEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({ kind: z.literal('thinking'), text: z.string(), unavailable: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('conversation_title'), title: z.string() }).strict(),
  z.object({
    kind: z.literal('status'),
    text: z.string(),
    status: z.enum(['succeeded', 'failed', 'canceled', 'historical']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('tool_summary'),
    label: z.string(),
    status: z.enum(['succeeded', 'failed', 'canceled', 'historical']),
    unavailable: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('result'),
    text: z.string().optional(),
    resourceRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
    unavailable: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal('history-form'),
    title: z.string(),
    summary: z.string().optional(),
    status: z.enum(['succeeded', 'failed', 'canceled', 'historical']),
  }).strict(),
]);

const portableMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number().finite(),
  predecessorId: z.string().min(1).nullable(),
  turnId: z.string().min(1),
  terminal: z.enum(['succeeded', 'failed', 'cancelled', 'historical']),
  resourceRefs: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  displayEvents: z.array(portableDisplayEventSchema),
  context: portableMessageContextSchema,
}).strict();

const portableSnapshotSchema = z.object({
  manifest: manifestSchema,
  project: portableProjectSchema,
  conversations: z.array(portableConversationSchema),
  messages: z.array(portableMessageSchema),
}).strict().superRefine((snapshot, context) => {
  const resourceDigests = new Set<string>();
  const resourcePaths = new Map<string, string>();
  const actualReferencesByDigest = new Map<string, Set<string>>();
  const recordKindsById = new Map<string, 'project' | 'conversation' | 'message'>([
    [snapshot.manifest.repositoryProjectId, 'project'],
  ]);
  const registerRecordIdentity = (
    id: string,
    kind: 'conversation' | 'message',
    path: Array<string | number>,
  ) => {
    const existingKind = recordKindsById.get(id);
    if (existingKind && existingKind !== kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `portable record id is already used by a ${existingKind}`,
      });
      return;
    }
    recordKindsById.set(id, kind);
  };
  for (const [index, resource] of snapshot.manifest.resources.entries()) {
    if (resourceDigests.has(resource.digest)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manifest', 'resources', index, 'digest'],
        message: 'resource digest must be unique',
      });
    }
    for (const [locationIndex, location] of resource.locations.entries()) {
      const existing = resourcePaths.get(location.path);
      if (existing !== undefined && existing !== resource.digest) context.addIssue({
        code: z.ZodIssueCode.custom, path: ['manifest', 'resources', index, 'locations', locationIndex, 'path'],
        message: 'resource path cannot be claimed by different digests',
      });
      resourcePaths.set(location.path, resource.digest);
    }
    resourceDigests.add(resource.digest);
    actualReferencesByDigest.set(resource.digest, new Set());
  }

  const conversationIds = new Set<string>();
  for (const [index, conversation] of snapshot.conversations.entries()) {
    registerRecordIdentity(conversation.id, 'conversation', ['conversations', index, 'id']);
    if (conversationIds.has(conversation.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conversations', index, 'id'],
        message: 'conversation id must be unique',
      });
    }
    conversationIds.add(conversation.id);
  }

  const messagesById = new Map<string, (typeof snapshot.messages)[number]>();
  for (const [index, message] of snapshot.messages.entries()) {
    registerRecordIdentity(message.id, 'message', ['messages', index, 'id']);
    if (messagesById.has(message.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'id'],
        message: 'message id must be unique',
      });
    } else {
      messagesById.set(message.id, message);
    }
    if (!conversationIds.has(message.conversationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'conversationId'],
        message: 'message conversation must exist in the snapshot',
      });
    }
    for (const [refIndex, digestRef] of message.resourceRefs.entries()) {
      if (!resourceDigests.has(digestRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'resourceRefs', refIndex],
          message: 'message resource reference must exist in the manifest',
        });
      } else {
        actualReferencesByDigest.get(digestRef)?.add(message.id);
      }
    }
    const contextRefs = [
      ...(message.context.contentItems ?? []).flatMap((item) => item.resourceRef ? [item.resourceRef] : []),
      ...(message.context.attachments ?? []).map((attachment) => attachment.resourceRef),
      ...(message.context.commentAttachments ?? []).flatMap((comment) => [
        ...(comment.screenshotResourceRef ? [comment.screenshotResourceRef] : []),
        ...(comment.imageAttachments ?? []).map((attachment) => attachment.resourceRef),
      ]),
    ];
    for (const contextRef of contextRefs) {
      if (!resourceDigests.has(contextRef) || !message.resourceRefs.includes(contextRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'context'],
          message: 'message context resource must exist in the manifest and message resourceRefs',
        });
      } else {
        actualReferencesByDigest.get(contextRef)?.add(message.id);
      }
    }
    for (const event of message.displayEvents) {
      if (event.kind !== 'result') continue;
      for (const eventRef of event.resourceRefs ?? []) {
        if (!resourceDigests.has(eventRef) || !message.resourceRefs.includes(eventRef)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['messages', index, 'displayEvents'],
            message: 'display event resource must exist in the manifest and message resourceRefs',
          });
        } else {
          actualReferencesByDigest.get(eventRef)?.add(message.id);
        }
      }
    }
  }

  for (const [index, digestRef] of snapshot.project.contentRefs.entries()) {
    if (!resourceDigests.has(digestRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project', 'contentRefs', index],
        message: 'project content reference must exist in the manifest',
      });
    } else {
      actualReferencesByDigest.get(digestRef)?.add(snapshot.manifest.repositoryProjectId);
    }
  }

  const recordIds = new Set([
    snapshot.manifest.repositoryProjectId,
    ...conversationIds,
    ...messagesById.keys(),
  ]);
  for (const [resourceIndex, resource] of snapshot.manifest.resources.entries()) {
    const declaredReferences = new Set<string>();
    const actualReferences = actualReferencesByDigest.get(resource.digest) ?? new Set<string>();
    for (const [referenceIndex, reference] of resource.references.entries()) {
      if (declaredReferences.has(reference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'resources', resourceIndex, 'references', referenceIndex],
          message: 'resource reference must be unique',
        });
      }
      declaredReferences.add(reference);
      if (!recordIds.has(reference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'resources', resourceIndex, 'references', referenceIndex],
          message: 'resource reference must identify a snapshot record',
        });
      }
      if (!actualReferences.has(reference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'resources', resourceIndex, 'references', referenceIndex],
          message: 'resource reference must match an actual snapshot content reference',
        });
      }
    }
    for (const actualReference of actualReferences) {
      if (!declaredReferences.has(actualReference)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['manifest', 'resources', resourceIndex, 'references'],
          message: `resource index is missing record reference ${actualReference}`,
        });
      }
    }
  }

  const messageCountsByConversation = new Map<string, number>();
  const rootCountsByConversation = new Map<string, number>();
  const successorCountsByMessage = new Map<string, number>();
  for (const [index, message] of snapshot.messages.entries()) {
    messageCountsByConversation.set(
      message.conversationId,
      (messageCountsByConversation.get(message.conversationId) ?? 0) + 1,
    );
    if (message.predecessorId === null) {
      rootCountsByConversation.set(
        message.conversationId,
        (rootCountsByConversation.get(message.conversationId) ?? 0) + 1,
      );
      continue;
    }
    const successorCount = (successorCountsByMessage.get(message.predecessorId) ?? 0) + 1;
    successorCountsByMessage.set(message.predecessorId, successorCount);
    if (successorCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'predecessorId'],
        message: 'each message may have at most one successor',
      });
    }
    const predecessor = messagesById.get(message.predecessorId);
    if (!predecessor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'predecessorId'],
        message: 'message predecessor must exist in the snapshot',
      });
      continue;
    }
    if (predecessor.conversationId !== message.conversationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['messages', index, 'predecessorId'],
        message: 'message predecessor must belong to the same conversation',
      });
    }

    const visited = new Set<string>([message.id]);
    let cursor: (typeof snapshot.messages)[number] | undefined = predecessor;
    while (cursor) {
      if (visited.has(cursor.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'predecessorId'],
          message: 'message predecessor graph must not contain a cycle',
        });
        break;
      }
      visited.add(cursor.id);
      cursor = cursor.predecessorId === null
        ? undefined
        : messagesById.get(cursor.predecessorId);
    }
  }

  for (const [index, conversation] of snapshot.conversations.entries()) {
    const messageCount = messageCountsByConversation.get(conversation.id) ?? 0;
    if (messageCount > 0 && rootCountsByConversation.get(conversation.id) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conversations', index, 'id'],
        message: 'each non-empty conversation must have exactly one root message',
      });
    }
  }
});

export type PortableProjectPreferences = z.infer<typeof portableProjectPreferencesSchema>;
export type PortableExecutionPreferences = z.infer<typeof portableExecutionPreferencesSchema>;
export type PortableProject = z.infer<typeof portableProjectSchema>;
export type PortableConversation = z.infer<typeof portableConversationSchema>;
export type PortableMessageContext = z.infer<typeof portableMessageContextSchema>;
export type PortableCommentAttachment = z.infer<typeof portableCommentAttachmentSchema>;
export type PortableDisplayEvent = z.infer<typeof portableDisplayEventSchema>;
export type PortableMessage = z.infer<typeof portableMessageSchema>;
export type PortableSnapshot = z.infer<typeof portableSnapshotSchema>;

export function parsePortableManifest(input: unknown): PortableManifest {
  return manifestSchema.parse(input);
}

export function parsePortableProject(input: unknown): PortableProject {
  return portableProjectSchema.parse(input);
}

export function parsePortableConversation(input: unknown): PortableConversation {
  return portableConversationSchema.parse(input);
}

export function parsePortableMessage(input: unknown): PortableMessage {
  return portableMessageSchema.parse(input);
}

export function parsePortableSnapshot(input: unknown): PortableSnapshot {
  return portableSnapshotSchema.parse(input);
}
