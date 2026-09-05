import { describe, expect, expectTypeOf, it } from 'vitest';
import { API_ERROR_CODES } from '../src/errors.js';
import type { ChatRunCreateRequest } from '../src/api/chat.js';
import type { UpdateConversationRequest, UpdateProjectRequest } from '../src/api/projects.js';
import {
  parseProjectGitAction,
  parseProjectGitEnableRequest,
  type ProjectGitAction,
  type ProjectMutationRevision,
} from '../src/api/project-git.js';
import {
  parsePortableManifest,
  parsePortableSnapshot,
} from '../src/api/project-git-portable.js';

const digest = 'a'.repeat(64);

function validSnapshot() {
  return {
    manifest: {
      schemaVersion: 1,
      repositoryProjectId: 'repo-one',
      resources: [{
        digest,
        path: `.open-design/resources/${digest}/attachment.png`,
        purpose: 'attachment',
        references: ['message-one'],
        sourceLabel: 'uploaded image',
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
  it('accepts v1 and rejects newer schema without rewriting it', () => {
    const value = { schemaVersion: 1, repositoryProjectId: 'repo-one', resources: [] };
    expect(parsePortableManifest(value)).toEqual(value);
    expect(() => parsePortableManifest({ ...value, schemaVersion: 2 })).toThrow();
    expect(() => parsePortableManifest({
      ...value,
      resources: [{
        digest: 'a'.repeat(64),
        path: '../outside',
        purpose: 'attachment',
        references: ['m1'],
      }],
    })).toThrow();
  });
});

describe('portable project snapshot', () => {
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
          path: `.open-design/resources/${'b'.repeat(64)}/attachment.png`,
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
