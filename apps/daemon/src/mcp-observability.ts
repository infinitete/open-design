import { createHash } from 'node:crypto';

export const OPEN_DESIGN_PLUGIN_ID = 'open-design';

// Plugin contract vocabularies (formerly @open-design/contracts/analytics
// types). The unions mirror the external plugin protocol wire contract and
// gate validation below.
export type AnalyticsDistributionMechanism =
  | 'git_marketplace'
  | 'local_repo'
  | 'manual'
  | 'unknown';
export type AnalyticsPublisherClass =
  | 'open_design_first_party'
  | 'third_party'
  | 'unknown';
export type AnalyticsHostProduct =
  | 'codex_desktop'
  | 'codex_cli'
  | 'codex_unknown'
  | 'claude_code'
  | 'unknown';

import type { ExternalPluginContext, PluginWorkflowProvenance } from '@open-design/contracts';
export type { ExternalPluginContext } from '@open-design/contracts';

export function validatePluginWorkflowProvenance(value: unknown, requestId?: unknown): PluginWorkflowProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw pluginContractError('pluginWorkflowProvenance must be an object');
  }
  const input = value as Record<string, unknown>;
  const keys = new Set(['pluginWorkflowId', 'externalPluginContext', 'logicalRequestDigest', 'logicalRequestDigestVersion']);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    throw pluginContractError('unsupported pluginWorkflowProvenance field');
  }
  if (input.logicalRequestDigestVersion !== 1 || typeof input.logicalRequestDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.logicalRequestDigest)) {
    throw pluginContractError('invalid logical request digest');
  }
  if (requestId !== undefined && logicalPluginRequestDigest(validatePluginRequestId(requestId)).digest !== input.logicalRequestDigest) {
    throw pluginContractError('logical request digest does not match requestId');
  }
  return {
    pluginWorkflowId: validatePluginWorkflowId(input.pluginWorkflowId),
    externalPluginContext: validateExternalPluginContext(input.externalPluginContext),
    logicalRequestDigest: input.logicalRequestDigest,
    logicalRequestDigestVersion: 1,
  };
}

/** Read-only migration of old local state; never accepts analytics hints on new requests. */
export function decodeDurablePluginWorkflowProvenance(state: Record<string, unknown>): PluginWorkflowProvenance | null {
  try {
    if (state.pluginWorkflowProvenance != null) return validatePluginWorkflowProvenance(state.pluginWorkflowProvenance);
    const legacy = state.externalPluginAnalytics as Record<string, unknown> | undefined;
    if (!legacy || legacy.entrySurface !== 'external_mcp') return null;
    return validatePluginWorkflowProvenance({
      pluginWorkflowId: legacy.pluginWorkflowId,
      logicalRequestDigest: legacy.logicalRequestDigest,
      logicalRequestDigestVersion: legacy.logicalRequestDigestVersion,
      externalPluginContext: {
        id: legacy.externalPluginId, version: legacy.externalPluginVersion,
        distributionMechanism: legacy.distributionMechanism, publisherClass: legacy.publisherClass,
      },
    });
  } catch { return null; }
}

const ALLOWED_CONTEXT_KEYS = new Set([
  'id',
  'version',
  'distributionMechanism',
  'publisherClass',
]);
const ALLOWED_DISTRIBUTION = new Set<AnalyticsDistributionMechanism>([
  'git_marketplace',
  'local_repo',
  'manual',
  'unknown',
]);
const ALLOWED_PUBLISHER = new Set<AnalyticsPublisherClass>([
  'open_design_first_party',
  'third_party',
  'unknown',
]);
const ALLOWED_HOST_PRODUCT = new Set<AnalyticsHostProduct>([
  'codex_desktop',
  'codex_cli',
  'codex_unknown',
  'claude_code',
  'unknown',
]);
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/u;
const WORKFLOW_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/iu;

export function pluginContractError(message: string): Error {
  const error = new Error(`PLUGIN_CONTRACT_REJECTED: ${message}`);
  Object.assign(error, { code: 'PLUGIN_CONTRACT_REJECTED' });
  return error;
}

export function validateExternalPluginContext(
  value: unknown,
): ExternalPluginContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw pluginContractError('externalPluginContext must be an object');
  }
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => !ALLOWED_CONTEXT_KEYS.has(key));
  if (extra.length > 0) {
    throw pluginContractError(`unsupported externalPluginContext field: ${extra[0]}`);
  }
  if (input.id !== OPEN_DESIGN_PLUGIN_ID) {
    throw pluginContractError(
      `id must be ${OPEN_DESIGN_PLUGIN_ID}`,
    );
  }
  if (
    typeof input.version !== 'string'
    || !VERSION_PATTERN.test(input.version)
    || input.version.length > 64
  ) {
    throw pluginContractError('version must be a bounded semver string');
  }
  if (
    typeof input.distributionMechanism !== 'string'
    || !ALLOWED_DISTRIBUTION.has(
      input.distributionMechanism as AnalyticsDistributionMechanism,
    )
  ) {
    throw pluginContractError('distributionMechanism is invalid');
  }
  if (
    typeof input.publisherClass !== 'string'
    || !ALLOWED_PUBLISHER.has(input.publisherClass as AnalyticsPublisherClass)
  ) {
    throw pluginContractError('publisherClass is invalid');
  }
  return {
    id: OPEN_DESIGN_PLUGIN_ID,
    version: input.version,
    distributionMechanism:
      input.distributionMechanism as AnalyticsDistributionMechanism,
    publisherClass: input.publisherClass as AnalyticsPublisherClass,
  };
}

function validateCanonicalPluginCorrelationId(
  value: unknown,
  fieldName: 'pluginWorkflowId' | 'requestId',
): string {
  if (
    typeof value !== 'string'
    || value.length > 64
    || !WORKFLOW_ID_PATTERN.test(value)
  ) {
    throw pluginContractError(
      `${fieldName} must be a canonical UUID or ULID`,
    );
  }
  return value;
}

export function validatePluginWorkflowId(value: unknown): string {
  return validateCanonicalPluginCorrelationId(value, 'pluginWorkflowId');
}

export function validatePluginRequestId(value: unknown): string {
  return validateCanonicalPluginCorrelationId(value, 'requestId');
}

export function mapMcpHostProduct(
  clientInfo: { name?: unknown; version?: unknown } | null | undefined,
): AnalyticsHostProduct {
  const name =
    typeof clientInfo?.name === 'string'
      ? clientInfo.name.trim().toLowerCase()
      : '';
  if (name.includes('claude')) return 'claude_code';
  if (name.includes('codex')) return 'codex_unknown';
  return 'unknown';
}

export function logicalPluginRequestDigest(requestId: string): {
  version: 1;
  digest: string;
} {
  return {
    version: 1,
    digest: createHash('sha256')
      .update(`od-plugin-logical-request:v1:${requestId}`)
      .digest('hex'),
  };
}
