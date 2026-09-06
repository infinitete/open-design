import { describe, expect, expectTypeOf, it } from 'vitest';
import { API_ERROR_CODES } from '../src/errors.js';
import type { ChatRunCreateRequest } from '../src/api/chat.js';
import type { UpdateConversationRequest, UpdateProjectRequest } from '../src/api/projects.js';
import {
  parseProjectGitAction,
  parseProjectGitEnableRequest,
  ProjectGitBindRequestSchema,
  ProjectGitAcceptedSchema,
  ProjectGitApiErrorResponseSchema,
  ProjectGitApiErrorSchema,
  ProjectGitPreviewSchema,
  ProjectGitStateSchema,
  ProjectGitOperationSchema,
  ProjectGitHistoryPageSchema,
  ProjectGitFileResponseSchema,
  ProjectGitConflictsResponseSchema,
  ProjectGitOperationResultSchema,
  type ProjectGitAction,
  type ProjectMutationRevision,
} from '../src/api/project-git.js';
import {
  parsePortableManifest,
  parsePortableSnapshot,
} from '../src/api/project-git-portable.js';

const digest = 'a'.repeat(64);

describe('project Git browser response schemas', () => {
  const basis = {
    projectRevision: 2,
    contentRevision: 5,
    localHead: 'a'.repeat(40),
    remoteHead: null,
    bindingGeneration: 1,
  };
  const state = {
    enabled: true,
    phase: 'pending_push',
    localHead: 'a'.repeat(40),
    observedRemoteHead: null,
    confirmedRemoteHead: null,
    projectRevision: 2,
    contentRevision: 5,
    bindingGeneration: 1,
    dirty: false,
    pendingPush: true,
    autoSync: true,
    operationId: null,
    error: null,
    binding: { remoteConfigured: false, remoteLabel: null, branch: null },
    dependencies: [],
  } as const;

  it('accepts the legal pending-push state and rejects impossible or extra fields', () => {
    expect(ProjectGitStateSchema.parse(state)).toEqual(state);
    expect(ProjectGitStateSchema.safeParse({ ...state, localHead: null }).success).toBe(false);
    expect(ProjectGitStateSchema.safeParse({ ...state, secret: 'nope' }).success).toBe(false);
  });

  it('validates operation, history, file, and conflict responses at the browser boundary', () => {
    const operation = {
      id: 'operation-1',
      kind: 'sync',
      status: 'waiting',
      phase: 'auth_required',
      projectId: 'project-1',
      basis,
      result: null,
      error: { code: 'GIT_AUTH_REQUIRED', message: 'Sign in', retryable: true },
    } as const;
    expect(ProjectGitOperationSchema.parse(operation)).toEqual(operation);
    expect(ProjectGitHistoryPageSchema.parse({ commits: [], nextCursor: null })).toEqual({ commits: [], nextCursor: null });
    expect(ProjectGitFileResponseSchema.parse({ encoding: 'base64', content: 'SGk=', mediaType: 'text/plain' }))
      .toEqual({ encoding: 'base64', content: 'SGk=', mediaType: 'text/plain' });
    expect(ProjectGitConflictsResponseSchema.parse({ conflicts: [] })).toEqual({ conflicts: [] });
    expect(ProjectGitOperationSchema.safeParse({ ...operation, status: 'done' }).success).toBe(false);
  });

  it('declares the daemon-supported optional history path', () => {
    const request = { cursor: 'next', path: 'src/index.ts' } satisfies import('../src/api/project-git.js').ProjectGitHistoryRequest;
    expect(request).toEqual({ cursor: 'next', path: 'src/index.ts' });
  });

  it('strictly validates accepted mutations and shared API error envelopes', () => {
    expect(ProjectGitAcceptedSchema.parse({ operationId: 'operation-1' }))
      .toEqual({ operationId: 'operation-1' });
    expect(ProjectGitAcceptedSchema.safeParse({ operationId: '' }).success).toBe(false);
    expect(ProjectGitAcceptedSchema.safeParse({ operationId: 'operation-1', extra: true }).success).toBe(false);
    const apiError = { code: 'PROJECT_STATE_CHANGED', message: 'History changed', retryable: false } as const;
    expect(ProjectGitApiErrorSchema.parse(apiError)).toEqual(apiError);
    expect(ProjectGitApiErrorResponseSchema.parse({ error: apiError })).toEqual({ error: apiError });
    expect(ProjectGitApiErrorSchema.safeParse({ ...apiError, code: 'UNKNOWN_CODE' }).success).toBe(false);
    expect(ProjectGitApiErrorSchema.safeParse({ ...apiError, extra: true }).success).toBe(false);
    expect(ProjectGitApiErrorResponseSchema.safeParse({ error: apiError, extra: true }).success).toBe(false);
  });
});

it('validates existing-copy operation results without exposing clone identity', () => {
  expect(ProjectGitOperationResultSchema.parse({ projectId: 'new', existingProjectIds: ['first', 'second'] }))
    .toEqual({ projectId: 'new', existingProjectIds: ['first', 'second'] });
  expect(ProjectGitOperationResultSchema.safeParse({ projectId: 'new', existingProjectIds: ['first', 'first'] }).success).toBe(false);
  expect(ProjectGitOperationResultSchema.safeParse({ projectId: 'new', existingProjectIds: ['new'] }).success).toBe(false);
  expect(ProjectGitOperationResultSchema.safeParse({ projectId: 'new', cloneId: 'private' }).success).toBe(false);
});

describe('binding confirmation', () => {
  it('carries explicit ordinary and portable path decisions through request and action parsing', () => {
    const confirmation = { paths: [
      { path: 'index.html', selectedSide: 'local' },
      { path: '.open-design/project.json', selectedSide: 'remote' },
      { path: 'old.html', selectedSide: 'delete' },
    ] };
    expect(ProjectGitBindRequestSchema.parse({ previewId: 'preview', confirmation, expectedProjectRevision: 3 }))
      .toEqual({ previewId: 'preview', confirmation, expectedProjectRevision: 3 });
    expect(parseProjectGitAction({ kind: 'bind', previewId: 'preview', confirmation }))
      .toEqual({ kind: 'bind', previewId: 'preview', confirmation });
    expect(ProjectGitBindRequestSchema.parse({ previewId: 'preview', confirmation: { metadataSource: 'local' } }))
      .toEqual({ previewId: 'preview', confirmation: { metadataSource: 'local' } });
    expect(() => ProjectGitBindRequestSchema.parse({ previewId: 'preview', confirmation: { paths: [confirmation.paths[0], confirmation.paths[0]] } })).toThrow();
    expect(() => ProjectGitBindRequestSchema.parse({ previewId: 'preview', confirmation: { paths: [{ path: 'index.html', selectedSide: 'base' }] } })).toThrow();
  });

  it('preserves preview provenance without changing the frozen full basis', () => {
    const preview = { id: 'preview', kind: 'bind', basis: { projectRevision: 3, contentRevision: 8,
      localHead: 'a'.repeat(40), remoteHead: 'b'.repeat(40), bindingGeneration: 2 }, targetOid: 'b'.repeat(40), expiresAt: 1000,
      changes: { addedPaths: [], modifiedPaths: ['index.html'], deletedPaths: [], settingsChanged: 0, conversationsChanged: 0,
        ignoredPaths: [], privatePaths: [], missingPaths: [], historyMode: 'complete', collisions: [] }, dependencies: [],
      binding: { classification: 'independent_history', metadataSources: [], requiredPaths: ['index.html', '.open-design/project.json'] } };
    expect(ProjectGitPreviewSchema.parse(preview)).toEqual(preview);
    expect(() => ProjectGitPreviewSchema.parse({ ...preview, binding: { ...preview.binding, metadataSources: ['base'] } })).toThrow();
  });
});

function validSnapshot() {
  return {
    manifest: {
      schemaVersion: 1,
      repositoryProjectId: 'repo-one',
      resources: [{
        digest,
        locations: [{ path: `.open-design/resources/${digest}/attachment.png`, purpose: 'attachment', sourceLabel: 'uploaded image' }],
        references: ['repo-one', 'message-one'],
      }],
    },
    project: {
      schemaVersion: 1,
      name: 'Portable project',
      createdAt: 1_725_000_000_000,
      kind: 'prototype',
      entryFile: 'index.html',
      customInstructions: 'Keep the existing visual language.',
      pendingPrompt: 'Continue when the user asks.',
      preferences: {
        intent: 'marketing',
        platform: 'responsive',
        speakerNotes: true,
        examplePromptBrief: { audience: 'designers' },
      },
      contentRefs: [digest],
      linkedFolderRequirements: [{ label: 'Brand assets', purpose: 'reference' }],
    },
    conversations: [{
      schemaVersion: 1,
      id: 'conversation-one',
      title: 'First conversation',
      mode: 'design',
      createdAt: 1_725_000_000_001,
    }],
    messages: [{
      schemaVersion: 1,
      id: 'message-one',
      conversationId: 'conversation-one',
      role: 'user',
      content: 'Use the attached reference.',
      createdAt: 1_725_000_000_002,
      predecessorId: null,
      turnId: 'turn-one',
      terminal: 'historical',
      resourceRefs: [digest],
      displayEvents: [{ kind: 'status', text: 'Saved' }],
      context: { agentId: 'codex', model: 'gpt-5' },
    }],
  } as const;
}

describe('portable manifest', () => {
  it('preserves every location and role for identical bytes while rejecting alias collisions', () => {
    const locations = [
      { path: `.open-design/resources/${digest}/content`, purpose: 'attachment', sourceLabel: 'upload' },
      { path: '.open-design/legacy-file-history/one/v1.html', purpose: 'legacy-history' },
      { path: '.open-design/legacy-file-history/two/v1.html', purpose: 'legacy-history' },
      { path: `.open-design/resources/${digest}/content`, purpose: 'skill', sourceLabel: 'skill' },
      { path: `.open-design/resources/${digest}/content`, purpose: 'plugin', sourceLabel: 'plugin' },
    ];
    const resource = { digest, locations, references: ['repo-one', 'message-one'] };
    const value = validSnapshot();
    const candidate = { ...value, manifest: { ...value.manifest, resources: [resource] } };
    expect(parsePortableSnapshot(candidate)).toEqual(candidate);
    expect(() => parsePortableSnapshot({ ...candidate, manifest: { ...candidate.manifest,
      resources: [{ ...resource, locations: [...locations, locations[0]] }] } })).toThrow();
    expect(() => parsePortableSnapshot({ ...candidate, manifest: { ...candidate.manifest,
      resources: [resource, { digest: 'b'.repeat(64), references: [], locations: [locations[1]] }] } })).toThrow();
  });
  it('accepts v1 and rejects newer schema without rewriting it', () => {
    const value = { schemaVersion: 1, repositoryProjectId: 'repo-one', resources: [] };
    expect(parsePortableManifest(value)).toEqual(value);
    expect(() => parsePortableManifest({ ...value, schemaVersion: 2 })).toThrow();
    expect(() => parsePortableManifest({
      ...value,
      resources: [{
        digest: 'a'.repeat(64),
        locations: [{ path: '../outside', purpose: 'attachment' }],
        references: ['m1'],
      }],
    })).toThrow();
  });
});

describe('portable project snapshot', () => {
  it('preserves JSON own preference keys as data without changing prototypes', () => {
    const value = validSnapshot();
    const preferences = JSON.parse('{"designSystemReview":{"__proto__":{"decision":"looks-good","updatedAt":"one"},"constructor":{"decision":"needs-work","updatedAt":"two"}},"examplePromptBrief":{"__proto__":"prototype label","constructor":"constructor label"}}');
    const result = parsePortableSnapshot({ ...value, project: { ...value.project, preferences } });
    expect(result.project.preferences).toEqual(preferences);
    for (const record of [result.project.preferences.designSystemReview!, result.project.preferences.examplePromptBrief!]) {
      expect(Object.keys(record).sort()).toEqual(['__proto__', 'constructor']);
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('strictly validates values under special preference keys and rejects non-JSON records', () => {
    const value = validSnapshot();
    for (const preferences of [JSON.parse('{"designSystemReview":{"__proto__":{"decision":"looks-good","updatedAt":"now","task":"execute"}}}'),
      JSON.parse('{"examplePromptBrief":{"__proto__":{"unexpected":true}}}'),
      { examplePromptBrief: Object.create({ inherited: 'not own' }) }, { designSystemReview: [] }]) {
      expect(() => parsePortableSnapshot({ ...value, project: { ...value.project, preferences } })).toThrow();
    }
  });

  it('preserves display feedback while rejecting telemetry authority and invalid timestamps', () => {
    const value = validSnapshot();
    const feedback = { rating: 'negative', reasonCodes: ['weak_visual', 'other'], customReason: 'Contrast',
      createdAt: 1, reasonsSubmittedAt: 2, updatedAt: 3 };
    const candidate = { ...value, messages: [{ ...value.messages[0], context: { feedback } }] };
    expect(parsePortableSnapshot(candidate)).toEqual(candidate);
    for (const bad of [{ ...feedback, runId: 'native' }, { ...feedback, telemetryConsent: true },
      { ...feedback, reasonCodes: ['unknown'] }, { ...feedback, updatedAt: Infinity }, { ...feedback, createdAt: NaN }]) {
      expect(() => parsePortableSnapshot({ ...candidate, messages: [{ ...candidate.messages[0], context: { feedback: bad } }] })).toThrow();
    }
  });
  it('preserves inert structured comments and scenario resources with reciprocal digest edges', () => {
    const value = validSnapshot();
    const comment = { order: 0, label: 'Heading', comment: 'Larger', currentText: 'Hello',
      filePath: 'index.html', elementId: 'heading', selector: '#heading', htmlHint: '<h1>Hello</h1>',
      pagePosition: { x: 1, y: 2, width: 3, height: 4 }, style: { fontSize: '16px' },
      selectionKind: 'pod', memberCount: 1, slideIndex: 0,
      podMembers: [{ elementId: 'child', selector: 'span', label: 'Child', text: 'Hello',
        position: { x: 1, y: 2, width: 3, height: 4 }, style: { color: 'red' } }],
      screenshotResourceRef: digest, imageAttachments: [{ resourceRef: digest, name: 'capture.png' }],
      markKind: 'click', intent: 'resize', commentContext: 'context', source: 'saved-comment' };
    const candidate = { ...value, manifest: { ...value.manifest,
      resources: [{ ...value.manifest.resources[0], locations: [{ ...value.manifest.resources[0].locations[0], purpose: 'scenario' }] }] },
      messages: [{ ...value.messages[0], context: { commentAttachments: [comment] } }] };
    expect(parsePortableSnapshot(candidate)).toEqual(candidate);
    for (const bad of [{ ...comment, id: 'local-authority' }, { ...comment, filePath: '/private/index.html' },
      { ...comment, style: { fontSize: '16px', onClick: 'execute' } },
      { ...comment, screenshotResourceRef: 'b'.repeat(64) }]) {
      expect(() => parsePortableSnapshot({ ...candidate,
        messages: [{ ...candidate.messages[0], context: { commentAttachments: [bad] } }] })).toThrow();
    }
    expect(() => parsePortableSnapshot({ ...candidate,
      messages: [{ ...candidate.messages[0], resourceRefs: [] }] })).toThrow();
  });

  it('roundtrips a valid v1 snapshot', () => {
    const value = validSnapshot();
    expect(parsePortableSnapshot(value)).toEqual(value);
  });

  it('rejects local authority fields from project preferences and message context', () => {
    const withBaseDir = validSnapshot();
    expect(() => parsePortableSnapshot({
      ...withBaseDir,
      project: {
        ...withBaseDir.project,
        preferences: { ...withBaseDir.project.preferences, baseDir: '/tmp/private' },
      },
    })).toThrow();

    const withNativeSession = validSnapshot();
    expect(() => parsePortableSnapshot({
      ...withNativeSession,
      messages: [{
        ...withNativeSession.messages[0],
        context: { ...withNativeSession.messages[0].context, nativeSessionId: 'secret' },
      }],
    })).toThrow();
  });

  it('preserves safe content labels and attachment descriptors without execution authority', () => {
    const value = validSnapshot();
    const withDisplayContext = {
      ...value,
      messages: [{
        ...value.messages[0],
        context: {
          ...value.messages[0].context,
          runStatus: 'succeeded',
          contentItems: [{
            kind: 'skill',
            label: 'Frontend design',
            resourceRef: digest,
          }],
          attachments: [{
            resourceRef: digest,
            name: 'attachment.png',
            kind: 'image',
            size: 128,
            order: 0,
          }],
        },
      }],
    } as const;
    expect(parsePortableSnapshot(withDisplayContext)).toEqual(withDisplayContext);

    expect(() => parsePortableSnapshot({
      ...withDisplayContext,
      messages: [{
        ...withDisplayContext.messages[0],
        resourceRefs: [],
      }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...value,
      messages: [{
        ...value.messages[0],
        displayEvents: [{ kind: 'tool_summary', label: 'Shell', status: 'succeeded', input: 'rm -rf' }],
      }],
    })).toThrow();
  });

  it('rejects resource paths outside their digest directory and invalid references', () => {
    const wrongResourcePath = validSnapshot();
    expect(() => parsePortableSnapshot({
      ...wrongResourcePath,
      manifest: {
        ...wrongResourcePath.manifest,
        resources: [{
          ...wrongResourcePath.manifest.resources[0],
          locations: [{ ...wrongResourcePath.manifest.resources[0].locations[0], path: `.open-design/resources/${'b'.repeat(64)}/attachment.png` }],
        }],
      },
    })).toThrow();

    const missingResource = validSnapshot();
    expect(() => parsePortableSnapshot({
      ...missingResource,
      project: { ...missingResource.project, contentRefs: ['b'.repeat(64)] },
    })).toThrow();

    const missingRecord = validSnapshot();
    expect(() => parsePortableSnapshot({
      ...missingRecord,
      manifest: {
        ...missingRecord.manifest,
        resources: [{
          ...missingRecord.manifest.resources[0],
          references: ['missing-message'],
        }],
      },
    })).toThrow();
  });

  it('requires the manifest resource index to match actual project and message references', () => {
    const base = validSnapshot();

    expect(() => parsePortableSnapshot({
      ...base,
      messages: [{ ...base.messages[0], resourceRefs: [] }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        resources: [{ ...base.manifest.resources[0], references: ['repo-one'] }],
      },
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        resources: [{ ...base.manifest.resources[0], references: ['message-one'] }],
      },
    })).toThrow();
  });

  it('requires globally unique portable record identities across record kinds', () => {
    const base = validSnapshot();

    expect(() => parsePortableSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        repositoryProjectId: 'message-one',
        resources: [{ ...base.manifest.resources[0], references: ['message-one'] }],
      },
      messages: [{ ...base.messages[0], resourceRefs: [] }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        repositoryProjectId: 'conversation-one',
        resources: [{
          ...base.manifest.resources[0],
          references: ['conversation-one', 'message-one'],
        }],
      },
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      manifest: {
        ...base.manifest,
        resources: [{
          ...base.manifest.resources[0],
          references: ['repo-one', 'conversation-one'],
        }],
      },
      messages: [{ ...base.messages[0], id: 'conversation-one' }],
    })).toThrow();
  });

  it('rejects duplicate and invalid message graph identities', () => {
    const base = validSnapshot();
    const secondMessage = {
      ...base.messages[0],
      id: 'message-two',
      role: 'assistant' as const,
      predecessorId: 'message-one',
      resourceRefs: [] as string[],
    };

    expect(() => parsePortableSnapshot({
      ...base,
      conversations: [...base.conversations, { ...base.conversations[0] }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      messages: [...base.messages, { ...base.messages[0] }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      messages: [{ ...base.messages[0], predecessorId: 'missing-message' }],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      conversations: [
        ...base.conversations,
        { ...base.conversations[0], id: 'conversation-two' },
      ],
      messages: [
        base.messages[0],
        { ...secondMessage, conversationId: 'conversation-two' },
      ],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      messages: [
        { ...base.messages[0], predecessorId: 'message-two' },
        secondMessage,
      ],
    })).toThrow();
  });

  it('requires one predecessor-defined sequence per non-empty conversation', () => {
    const base = validSnapshot();
    const secondMessage = {
      ...base.messages[0],
      id: 'message-two',
      role: 'assistant' as const,
      predecessorId: null,
      resourceRefs: [] as string[],
    };

    expect(() => parsePortableSnapshot({
      ...base,
      messages: [...base.messages, secondMessage],
    })).toThrow();
    expect(() => parsePortableSnapshot({
      ...base,
      messages: [
        base.messages[0],
        { ...secondMessage, predecessorId: 'message-one' },
        { ...secondMessage, id: 'message-three', predecessorId: 'message-one' },
      ],
    })).toThrow();
  });
});

describe('project git API contracts', () => {
  it('accepts every action payload and rejects route-owned context fields', () => {
    const actions: ProjectGitAction[] = [
      { kind: 'enable_preview' },
      { kind: 'enable', previewId: 'preview-enable' },
      { kind: 'binding_preview', url: 'https://example.com/repo.git', branch: 'main' },
      { kind: 'bind', previewId: 'preview-bind' },
      { kind: 'unbind' },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'sync' },
      { kind: 'open', url: 'https://example.com/repo.git', branch: 'main' },
      { kind: 'restore_preview', oid: 'sha256-not-assumed' },
      { kind: 'restore', previewId: 'preview-restore' },
      {
        kind: 'resolve',
        operationId: 'operation-one',
        basis: {
          projectRevision: 3,
          contentRevision: 8,
          localHead: 'a'.repeat(40),
          remoteHead: 'b'.repeat(40),
          bindingGeneration: 2,
        },
        resolutions: [
          { conflictId: 'conflict-one', kind: 'select', selectedSide: 'local' },
          { conflictId: 'conflict-two', kind: 'edit', value: null },
          { conflictId: 'conflict-three', kind: 'delete' },
          { conflictId: 'conflict-four', kind: 'order', orderedTurnIds: ['turn-one', 'turn-two'] },
        ],
      },
      { kind: 'retry', operationId: 'operation-one' },
    ];

    expect(actions.map((action) => parseProjectGitAction(action))).toEqual(actions);
    expect(() => parseProjectGitAction({ kind: 'sync', actorId: 'attacker' })).toThrow();
    expect(() => parseProjectGitAction({ kind: 'bind', url: 'wrong-field' })).toThrow();
  });

  it('keeps preview and confirmed enable requests distinct and strict', () => {
    expect(parseProjectGitEnableRequest({ mode: 'preview', expectedProjectRevision: 4 })).toEqual({
      mode: 'preview',
      expectedProjectRevision: 4,
    });
    expect(parseProjectGitEnableRequest({
      mode: 'confirm',
      previewId: 'preview-enable',
      expectedProjectRevision: 4,
    })).toEqual({
      mode: 'confirm',
      previewId: 'preview-enable',
      expectedProjectRevision: 4,
    });
    expect(() => parseProjectGitEnableRequest({ mode: 'preview', previewId: 'not-allowed' })).toThrow();
    expect(() => parseProjectGitEnableRequest({ mode: 'confirm' })).toThrow();
  });

  it('exposes all project git error codes', () => {
    expect(API_ERROR_CODES).toEqual(expect.arrayContaining([
      'GIT_UNAVAILABLE',
      'GIT_IDENTITY_REQUIRED',
      'GIT_AUTH_REQUIRED',
      'GIT_PERMISSION_DENIED',
      'GIT_CONFLICT',
      'EXTERNAL_GIT_BUSY',
      'PROJECT_BUSY',
      'PROJECT_STATE_CHANGED',
      'PREVIEW_STALE',
      'PORTABLE_FORMAT_UNSUPPORTED',
      'PORTABLE_RESOURCE_MISSING',
      'RECOVERY_REQUIRED',
    ]));
  });

  it('adds the compatibility revision to existing project mutation and task DTOs', () => {
    expectTypeOf<UpdateProjectRequest['expectedProjectRevision']>()
      .toEqualTypeOf<ProjectMutationRevision['expectedProjectRevision']>();
    expectTypeOf<UpdateConversationRequest['expectedProjectRevision']>()
      .toEqualTypeOf<ProjectMutationRevision['expectedProjectRevision']>();
    expectTypeOf<ChatRunCreateRequest['expectedProjectRevision']>()
      .toEqualTypeOf<ProjectMutationRevision['expectedProjectRevision']>();
  });
});
