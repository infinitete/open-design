import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatRunService } from '../src/runtimes/runs.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { artifactOriginForRun } from '../src/run-html-version-snapshots.js';
import { validatePluginWorkflowProvenance, decodeDurablePluginWorkflowProvenance } from '../src/mcp-observability.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalMcpBriefStore,
  handleMcpToolCall,
  issuePluginWorkflowId,
  logicalPluginRequestDigest,
  mapMcpHostProduct,
  McpObservabilitySession,
  mcpDeliveryFacts,
  mcpFailureFacts,
  validateExternalPluginContext,
  validateMcpToolArgs,
} from '../src/mcp.js';

describe('local MCP plugin observability contract', () => {
  const originalFetch = globalThis.fetch;
  const pluginContext = {
    id: 'open-design',
    version: '0.5.0',
    distributionMechanism: 'git_marketplace',
    publisherClass: 'open_design_first_party',
  } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('accepts the bounded OpenDesign context and rejects extra or secret fields', () => {
    expect(validateExternalPluginContext(pluginContext)).toEqual(pluginContext);

    expect(() => validateExternalPluginContext({
      ...pluginContext,
      id: 'open-design-cloud',
    })).toThrow(/PLUGIN_CONTRACT_REJECTED/u);

    expect(() =>
      validateExternalPluginContext({
        ...pluginContext,
        apiKey: 'must-never-cross-mcp',
      }),
    ).toThrow(/PLUGIN_CONTRACT_REJECTED/u);

    expect(() =>
      validateExternalPluginContext({
        ...pluginContext,
        telemetrySchemaVersion: 2,
      }),
    ).toThrow(/PLUGIN_CONTRACT_REJECTED/u);
  });

  it('validates product provenance and only decodes bounded legacy durable metadata', () => {
    const requestId = '018f6f2e-1111-7111-8111-111111111111';
    const provenance = {
      pluginWorkflowId: '018f6f2e-2222-7222-8222-222222222222',
      externalPluginContext: pluginContext,
      logicalRequestDigest: logicalPluginRequestDigest(requestId).digest,
      logicalRequestDigestVersion: 1,
    };
    expect(validatePluginWorkflowProvenance(provenance, requestId)).toEqual(provenance);
    expect(() => validatePluginWorkflowProvenance({ ...provenance, apiKey: 'secret' })).toThrow(/PLUGIN_CONTRACT_REJECTED/);
    expect(() => validatePluginWorkflowProvenance({ ...provenance, logicalRequestDigest: 'a'.repeat(64) }, requestId)).toThrow(/does not match/);
    expect(() => validatePluginWorkflowProvenance({ ...provenance, pluginWorkflowId: 'bad' })).toThrow(/canonical/);
    const legacy = {
      entrySurface: 'external_mcp', externalPluginId: pluginContext.id,
      externalPluginVersion: pluginContext.version,
      distributionMechanism: pluginContext.distributionMechanism, publisherClass: pluginContext.publisherClass,
      pluginWorkflowId: provenance.pluginWorkflowId, logicalRequestDigest: provenance.logicalRequestDigest,
      logicalRequestDigestVersion: 1, hostProduct: 'codex_unknown', briefState: 'confirmed',
    };
    expect(decodeDurablePluginWorkflowProvenance({ externalPluginAnalytics: legacy })).toEqual(provenance);
    expect(decodeDurablePluginWorkflowProvenance({ analyticsHints: legacy })).toBeNull();
    expect(decodeDurablePluginWorkflowProvenance({ externalPluginAnalytics: { ...legacy, logicalRequestDigest: 'invalid' } })).toBeNull();
  });

  it('issues plugin workflow ids server-side and rejects caller-created ids', () => {
    expect(issuePluginWorkflowId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(() =>
      issuePluginWorkflowId(
        '018f6f2e-4444-7444-8444-444444444444',
      ),
    ).toThrow(/must be omitted/u);
  });

  it('executes the published tool schema as a runtime boundary for plugin calls', () => {
    expect(() => validateMcpToolArgs('collect_brief', {
      artifactType: 'website',
      externalPluginContext: pluginContext,
    })).not.toThrow();

    expect(() => validateMcpToolArgs('start_run', {
      project: 'Demo',
      prompt: 'Create a launch page',
      requestId: '018f6f2e-5555-7555-8555-555555555555',
      pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
    })).not.toThrow();

    expect(() => validateMcpToolArgs('start_run', {
      project: 'Demo',
      prompt: 'Create a launch page',
      requestId: '018f6f2e-5555-7555-8555-555555555555',
      pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      apiKey: 'must-never-cross-mcp',
    })).toThrow(/PLUGIN_CONTRACT_REJECTED/u);
  });

  it('keeps Codex host variants bounded until a real host smoke proves a stable split', () => {
    expect(mapMcpHostProduct({ name: 'codex', version: '1.2.3' })).toBe(
      'codex_unknown',
    );
    expect(
      mapMcpHostProduct({ name: 'Codex Desktop', version: '1.2.3' }),
    ).toBe('codex_unknown');
    expect(mapMcpHostProduct({ name: 'claude-code', version: '1.2.3' })).toBe(
      'claude_code',
    );
    expect(mapMcpHostProduct({ name: 'mystery-host', version: '1.2.3' })).toBe(
      'unknown',
    );
  });

  it('derives a versioned lower-case SHA-256 logical request digest', () => {
    const requestId = '018f6f2e-1111-7111-8111-111111111111';
    const expected = createHash('sha256')
      .update(`od-plugin-logical-request:v1:${requestId}`)
      .digest('hex');

    expect(logicalPluginRequestDigest(requestId)).toEqual({
      version: 1,
      digest: expected,
    });
  });

  it('binds plugin workflow context to a brief draft and inherits it on confirmation', () => {
    const store = createLocalMcpBriefStore();
    const collected = store.collect({
      artifactType: 'website',
      skip: true,
      pluginWorkflowId: '018f6f2e-2222-7222-8222-222222222222',
      externalPluginContext: pluginContext,
    });

    const confirmed = store.confirm({
      briefDraftId: collected.briefDraftId,
      nonce: collected.nonce,
      answers: {},
    });

    expect(confirmed).toMatchObject({
      pluginWorkflowId: '018f6f2e-2222-7222-8222-222222222222',
      externalPluginContext: pluginContext,
    });
    expect(
      store.briefStateForWorkflow(
        '018f6f2e-2222-7222-8222-222222222222',
      ),
    ).toBe('skipped');
  });

  it('records a confirmed brief state without retaining answers in analytics', () => {
    const store = createLocalMcpBriefStore();
    const collected = store.collect({
      artifactType: 'website',
      pluginWorkflowId: '018f6f2e-6666-7666-8666-666666666666',
      externalPluginContext: pluginContext,
    });
    const answers = Object.fromEntries(
      collected.questionForm.questions.map((question) => [
        question.id,
        [question.defaultValue],
      ]),
    );

    store.confirm({
      briefDraftId: collected.briefDraftId,
      nonce: collected.nonce,
      answers,
    });

    expect(
      store.briefStateForWorkflow(
        '018f6f2e-6666-7666-8666-666666666666',
      ),
    ).toBe('confirmed');
  });

  it('does not leak plugin attribution into the next ordinary brief', () => {
    const store = createLocalMcpBriefStore();
    store.collect({
      artifactType: 'website',
      skip: true,
      pluginWorkflowId: '018f6f2e-3333-7333-8333-333333333333',
      externalPluginContext: pluginContext,
    });

    const ordinary = store.collect({
      artifactType: 'website',
      skip: true,
    });

    expect(ordinary).not.toHaveProperty('pluginWorkflowId');
    expect(ordinary).not.toHaveProperty('externalPluginContext');
  });

  it('keeps ordinary MCP tools un-attributed while correlating the accepted run object', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/analytics/mcp/context')) {
        return new Response(JSON.stringify({
          enabled: false,
          deviceId: null,
          locale: 'en',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const session = await McpObservabilitySession.create(
      'http://127.0.0.1:17456',
      { name: 'codex', version: '1.0.0' },
    );
    const store = createLocalMcpBriefStore();
    const collectArgs = {
      artifactType: 'website',
      skip: true,
      externalPluginContext: pluginContext,
    };
    const attribution = await session.resolveAttribution(
      'collect_brief',
      collectArgs,
      store,
    );
    expect(attribution).not.toBeNull();
    expect(
      await session.resolveAttribution('list_projects', {}, store),
    ).toBeNull();

    session.rememberRun('run-1', 'project-1', attribution!);
    await expect(
      session.resolveAttribution('get_run', { runId: 'run-1' }, store),
    ).resolves.toEqual(attribution);
    await expect(
      session.resolveAttribution('get_project', { project: 'project-1' }, store),
    ).resolves.toBeNull();
  });

  it('keeps MCP transport failures and delivery completeness as separate facts', () => {
    expect(mcpFailureFacts('start_run', {
      isError: true,
      content: [{ type: 'text', text: 'cannot reach the OpenDesign daemon' }],
    })).toEqual({
      error_code: 'DAEMON_UNREACHABLE',
      failure_stage: 'run_accept',
      failure_source: 'open_design_daemon',
      failure_category: 'availability',
      retryable: true,
      user_action: 'start_open_design',
    });

    expect(mcpDeliveryFacts('get_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      status: 'running',
    }, 2)).toEqual({
      poll_state: 'non_terminal',
    });

    expect(mcpDeliveryFacts('get_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      status: 'succeeded',
      deliverableValid: true,
      deliverableValidation: 'valid',
      deliverableEntryFile: 'index.html',
      previewUrl: 'http://127.0.0.1:17456/artifacts/index.html',
      entryFile: 'index.html',
    }, 3)).toEqual({
      poll_state: 'terminal',
      delivery_kind: 'preview_studio_reference',
      delivery_result: 'complete',
      deliverable_validation: 'valid',
      poll_attempt_count: 3,
    });

    expect(mcpDeliveryFacts('get_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      status: 'succeeded',
      artifactCount: 1,
      deliverableValid: true,
      deliverableValidation: 'valid',
      deliverableEntryFile: 'report.pdf',
      studioUrl:
        'http://127.0.0.1:3000/projects/project-1/conversations/conv-1',
    }, 4)).toEqual({
      poll_state: 'terminal',
      delivery_kind: 'preview_studio_reference',
      delivery_result: 'complete',
      deliverable_validation: 'valid',
      poll_attempt_count: 4,
    });

    expect(mcpDeliveryFacts('get_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      status: 'succeeded',
      artifactCount: 1,
      deliverableValid: false,
      deliverableValidation: 'entry_missing',
      studioUrl:
        'http://127.0.0.1:3000/projects/project-1/conversations/conv-1',
    }, 5)).toMatchObject({
      poll_state: 'terminal',
      delivery_result: 'failed',
      deliverable_validation: 'invalid',
      error_code: 'DELIVERABLE_MISSING',
    });

    expect(mcpDeliveryFacts('get_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      status: 'succeeded',
      artifactCount: 0,
      studioUrl:
        'http://127.0.0.1:3000/projects/project-1/conversations/conv-1',
    }, 6)).toMatchObject({
      poll_state: 'terminal',
      delivery_result: 'failed',
      deliverable_validation: 'invalid',
      error_code: 'DELIVERABLE_MISSING',
    });

    expect(mcpDeliveryFacts('start_run', {
      content: [{ type: 'text', text: '{}' }],
    }, {
      runId: 'run-1',
      analyticsAttributionMismatch: true,
    })).toEqual({
      correlation_status: 'run_mismatch',
      error_code: 'PLUGIN_ATTRIBUTION_MISMATCH',
    });
  });

  it('requires a stable plugin request id and forwards bounded attribution to the run', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/projects')) {
        return new Response(
          JSON.stringify({ projects: [{ id: 'project-1', name: 'Demo' }] }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/mcp/install-info')) {
        return new Response(JSON.stringify({ webBaseUrl: null }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ runId: 'run-plugin', conversationId: 'conv-1' }),
        { status: 202 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const missingRequest = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'start_run',
      {
        project: 'Demo',
        prompt: 'Create a launch page',
        pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      },
      {
        pluginAttribution: {
          pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
          context: pluginContext,
        },
      },
    );
    expect(missingRequest).toMatchObject({ isError: true });
    expect(missingRequest.content[0]?.text).toContain(
      'PLUGIN_CONTRACT_REJECTED',
    );
    expect(missingRequest.content[0]?.text).toContain(
      'requestId is required for attributed start_run calls',
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).endsWith('/api/runs'),
      ),
    ).toBe(false);

    const invalidRequest = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'start_run',
      {
        project: 'Demo',
        prompt: 'Create a launch page',
        requestId: 'od-mscwn4y2-tlnx02dig7',
        pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      },
      {
        pluginAttribution: {
          pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
          context: pluginContext,
        },
      },
    );
    expect(invalidRequest).toMatchObject({ isError: true });
    expect(invalidRequest.content[0]?.text).toContain(
      'requestId must be a canonical UUID or ULID',
    );
    expect(invalidRequest.content[0]?.text).not.toContain(
      'pluginWorkflowId must be a canonical UUID or ULID',
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).endsWith('/api/runs'),
      ),
    ).toBe(false);

    const requestId = '018f6f2e-5555-7555-8555-555555555555';
    const result = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'start_run',
      {
        project: 'Demo',
        prompt: 'Create a launch page',
        requestId,
        pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      },
      {
        pluginAttribution: {
          pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
          context: pluginContext,
        },
        briefState: 'confirmed',
      },
    );

    expect(result).not.toHaveProperty('isError');
    const runCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/runs')
        && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((runCall?.[1] as RequestInit)?.body));
    expect(body.analyticsHints).toBeUndefined();
    expect(body.pluginWorkflowProvenance).toEqual({
      pluginWorkflowId: '018f6f2e-4444-7444-8444-444444444444',
      externalPluginContext: pluginContext,
      logicalRequestDigest: logicalPluginRequestDigest(requestId).digest,
      logicalRequestDigestVersion: 1,
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-provenance-'));
    try {
      const makeRuns = () => createChatRunService({
        createSseResponse: vi.fn(), createSseErrorPayload: vi.fn(),
        runsLogDir: root as unknown as null,
      });
      const originalRuns = makeRuns();
      const created = originalRuns.create(body);
      originalRuns.finish(created, 'succeeded');
      const persisted = JSON.parse(fs.readFileSync(path.join(root, created.id, 'state.json'), 'utf8'));
      expect(persisted.pluginWorkflowProvenance).toEqual(body.pluginWorkflowProvenance);
      expect(persisted).not.toHaveProperty('externalPluginAnalytics');
      expect(persisted).not.toHaveProperty('analyticsHints');
      // A fresh daemon service must index the persisted binding, not session memory.
      const runs = makeRuns();
      const handlers = new Map<string, Function>();
      registerRunRoutes({
        get: (route: string, handler: Function) => handlers.set(route, handler),
        post: vi.fn(),
      } as never, {
        design: { runs }, http: { sendApiError: (res: { status: Function }, status: number) => res.status(status) },
        paths: { RUNTIME_DATA_DIR: root }, agents: {}, chat: {}, plugins: {}, messages: {},
      } as never);
      let binding: unknown;
      const lookup = handlers.get('/api/runs/by-plugin-workflow/:workflowId')!;
      lookup({ params: { workflowId: body.pluginWorkflowProvenance.pluginWorkflowId } }, {
        json: (value: unknown) => { binding = value; },
        status: (status: number) => { throw new Error(`workflow lookup returned ${status}`); },
      });
      expect(binding).toMatchObject({ runId: created.id, projectId: 'project-1', ...body.pluginWorkflowProvenance });
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify(binding)));
      const freshSession = await McpObservabilitySession.create('http://127.0.0.1:17456', { name: 'codex' });
      await expect(freshSession.resolveAttribution('get_run', {
        pluginWorkflowId: body.pluginWorkflowProvenance.pluginWorkflowId,
      }, createLocalMcpBriefStore())).resolves.toEqual({
        pluginWorkflowId: body.pluginWorkflowProvenance.pluginWorkflowId, context: pluginContext,
      });
      const restored = runs.findByPluginWorkflowId(body.pluginWorkflowProvenance.pluginWorkflowId);
      expect(runs.createOrReuse(body)).toMatchObject({ kind: 'reused', run: { id: created.id } });
      const conflictingRequestId = '018f6f2e-7777-7777-8777-777777777777';
      const conflicting = { ...body, clientRequestId: conflictingRequestId,
        pluginWorkflowProvenance: { ...body.pluginWorkflowProvenance,
          logicalRequestDigest: logicalPluginRequestDigest(conflictingRequestId).digest },
      };
      expect(() => runs.createOrReuse(conflicting)).toThrow(/already bound/);
      expect(() => runs.create(conflicting)).toThrow(/already bound/);
      expect(runs.findByPluginWorkflowId(body.pluginWorkflowProvenance.pluginWorkflowId).id).toBe(created.id);
      expect(fs.readdirSync(root)).toEqual([created.id]);
      const expectedOrigin = {
        entrySurface: 'external_mcp', externalPluginId: 'open-design',
        pluginWorkflowId: body.pluginWorkflowProvenance.pluginWorkflowId, runId: created.id,
      };
      expect(artifactOriginForRun({ runId: restored.id, pluginWorkflowProvenance: restored.pluginWorkflowProvenance })).toEqual(expectedOrigin);
      // Older installations retain the former durable shape; decoding must also rebuild the index.
      delete persisted.pluginWorkflowProvenance;
      persisted.externalPluginAnalytics = {
        entrySurface: 'external_mcp', externalPluginId: pluginContext.id,
        externalPluginVersion: pluginContext.version,
        distributionMechanism: pluginContext.distributionMechanism,
        publisherClass: pluginContext.publisherClass,
        pluginWorkflowId: body.pluginWorkflowProvenance.pluginWorkflowId,
        logicalRequestDigest: body.pluginWorkflowProvenance.logicalRequestDigest,
        logicalRequestDigestVersion: 1,
      };
      fs.writeFileSync(path.join(root, created.id, 'state.json'), JSON.stringify(persisted));
      const legacyRun = makeRuns().findByPluginWorkflowId(body.pluginWorkflowProvenance.pluginWorkflowId);
      expect(legacyRun.pluginWorkflowProvenance).toEqual(body.pluginWorkflowProvenance);
      expect(legacyRun).not.toHaveProperty('externalPluginAnalytics');
      expect(artifactOriginForRun({ runId: legacyRun.id, pluginWorkflowProvenance: legacyRun.pluginWorkflowProvenance })).toEqual(expectedOrigin);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
