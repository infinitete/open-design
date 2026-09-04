import type { AgentNetworkPrefs } from '@open-design/contracts';

import { InvalidAppConfigValueError } from './app-config-errors.js';

const MAX_ENTRIES = 128;
const MAX_ID_LENGTH = 128;
const MAX_PROXY_URL_LENGTH = 2_048;
const MAX_NO_PROXY_LENGTH = 4_096;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1_024;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type StoredAgentNetworkPolicy =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      password?: string;
    };

export type StoredAgentNetworkPrefs = Record<string, StoredAgentNetworkPolicy>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(key: string, message: string): never {
  throw new InvalidAppConfigValueError(key, message);
}

function isValidAgentId(agentId: string): boolean {
  return agentId.length <= MAX_ID_LENGTH && AGENT_ID.test(agentId) && !RESERVED_KEYS.has(agentId);
}

function validateString(value: unknown, key: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(key, `${key} must be a string`);
  if (value.length > maxLength) invalid(key, `${key} exceeds its maximum length`);
  if (CONTROL_CHARACTERS.test(value)) invalid(key, `${key} must not contain control characters`);
  return value;
}

function validateProxyUrl(value: unknown, key: string): string {
  const proxyUrl = validateString(value, key, MAX_PROXY_URL_LENGTH);
  if (proxyUrl === undefined || proxyUrl.length === 0) invalid(key, `${key} is required`);
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    invalid(key, `${key} must be an absolute proxy URL`);
  }
  if (
    !PROXY_PROTOCOLS.has(url.protocol)
    || url.hostname === ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    invalid(key, `${key} must be a supported host-only proxy URL without credentials`);
  }
  return proxyUrl;
}

function parsePolicy(
  raw: unknown,
  key: string,
  options: { allowClearPassword: boolean; allowUseStoredPassword: boolean; strict: boolean },
): StoredAgentNetworkPolicy | undefined {
  if (!isRecord(raw)) {
    if (options.strict) invalid(key, `${key} must be an object`);
    return undefined;
  }
  if (raw.mode === 'direct') {
    if (
      options.strict
      && (raw.password !== undefined || raw.clearPassword !== undefined || raw.useStoredPassword !== undefined)
    ) {
      invalid(key, `${key} cannot include password actions in direct mode`);
    }
    return { mode: 'direct' };
  }
  if (raw.mode !== 'custom') {
    if (options.strict) invalid(`${key}.mode`, `${key}.mode must be direct or custom`);
    return undefined;
  }

  try {
    const proxyUrl = validateProxyUrl(raw.proxyUrl, `${key}.proxyUrl`);
    const noProxy = validateString(raw.noProxy, `${key}.noProxy`, MAX_NO_PROXY_LENGTH);
    const username = validateString(raw.username, `${key}.username`, MAX_USERNAME_LENGTH);
    const password = validateString(raw.password, `${key}.password`, MAX_PASSWORD_LENGTH);
    if (password !== undefined && (username === undefined || username.length === 0)) {
      invalid(`${key}.password`, `${key}.password requires a username`);
    }
    if (raw.clearPassword !== undefined && (!options.allowClearPassword || raw.clearPassword !== true)) {
      invalid(`${key}.clearPassword`, `${key}.clearPassword must be true`);
    }
    if (raw.useStoredPassword !== undefined && (!options.allowUseStoredPassword || raw.useStoredPassword !== true)) {
      invalid(`${key}.useStoredPassword`, `${key}.useStoredPassword must be true`);
    }
    if (raw.password !== undefined && raw.clearPassword === true) {
      invalid(key, `${key} cannot include password and clearPassword together`);
    }
    if (raw.useStoredPassword === true && (raw.password !== undefined || raw.clearPassword === true)) {
      invalid(key, `${key} cannot combine useStoredPassword with a password action`);
    }
    return {
      mode: 'custom',
      proxyUrl,
      ...(noProxy === undefined ? {} : { noProxy }),
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
    };
  } catch (error) {
    if (options.strict) throw error;
    return undefined;
  }
}

function parsePrefs(raw: unknown, strict: boolean): StoredAgentNetworkPrefs | undefined {
  if (!isRecord(raw)) {
    if (strict) invalid('agentNetwork', 'agentNetwork must be an object');
    return undefined;
  }
  const entries = Object.keys(raw);
  if (strict && entries.length > MAX_ENTRIES) {
    invalid('agentNetwork', `agentNetwork must contain at most ${MAX_ENTRIES} entries`);
  }
  const prefs: StoredAgentNetworkPrefs = Object.create(null);
  for (const agentId of entries.slice(0, MAX_ENTRIES)) {
    const key = `agentNetwork.${agentId}`;
    if (!isValidAgentId(agentId)) {
      if (strict) invalid(key, `${key} is not a valid CLI ID`);
      continue;
    }
    const policy = parsePolicy(raw[agentId], key, {
      allowClearPassword: strict,
      allowUseStoredPassword: false,
      strict,
    });
    if (policy) prefs[agentId] = policy;
  }
  return prefs;
}

export function parseStoredAgentNetworkPrefs(raw: unknown): StoredAgentNetworkPrefs | undefined {
  return parsePrefs(raw, false);
}

export function mergeAgentNetworkUpdate(
  raw: unknown,
  existing: StoredAgentNetworkPrefs | undefined,
): StoredAgentNetworkPrefs | undefined {
  const next = parsePrefs(raw, true);
  if (!next) return next;
  const source = raw as Record<string, unknown>;
  for (const agentId of Object.keys(next)) {
    const policy = next[agentId];
    const update = source[agentId] as Record<string, unknown>;
    const saved = existing?.[agentId];
    if (
      policy?.mode === 'custom'
      && update.password === undefined
      && update.clearPassword === undefined
      && saved?.mode === 'custom'
      && saved.password !== undefined
    ) {
      next[agentId] = { ...policy, password: saved.password };
    }
  }
  return next;
}

export function agentNetworkPolicyForAgent(
  prefs: StoredAgentNetworkPrefs | undefined,
  agentId: string,
): StoredAgentNetworkPolicy | undefined {
  return prefs?.[agentId];
}

export function toPublicAgentNetworkPrefs(
  prefs: StoredAgentNetworkPrefs | undefined,
): AgentNetworkPrefs | undefined {
  if (prefs === undefined) return undefined;
  const publicPrefs: AgentNetworkPrefs = {};
  for (const agentId of Object.keys(prefs)) {
    const policy = prefs[agentId];
    if (!policy) continue;
    publicPrefs[agentId] = policy.mode === 'direct'
      ? { mode: 'direct' }
      : {
          mode: 'custom',
          proxyUrl: policy.proxyUrl,
          ...(policy.noProxy === undefined ? {} : { noProxy: policy.noProxy }),
          ...(policy.username === undefined ? {} : { username: policy.username }),
          passwordConfigured: policy.password !== undefined,
        };
  }
  return publicPrefs;
}

export function resolveAgentNetworkTestPolicy(
  raw: unknown,
  saved: StoredAgentNetworkPolicy | undefined,
): StoredAgentNetworkPolicy | undefined {
  if (!isRecord(raw)) invalid('agentNetwork', 'agentNetwork must be an object');
  if (raw.mode === 'inherit') {
    if (
      raw.proxyUrl !== undefined
      || raw.noProxy !== undefined
      || raw.username !== undefined
      || raw.password !== undefined
      || raw.clearPassword !== undefined
      || raw.useStoredPassword !== undefined
    ) {
      invalid('agentNetwork', 'agentNetwork inherit mode cannot include custom proxy fields');
    }
    return undefined;
  }
  const policy = parsePolicy(raw, 'agentNetwork', {
    allowClearPassword: true,
    allowUseStoredPassword: true,
    strict: true,
  });
  if (
    raw.useStoredPassword === true
    && saved?.mode === 'custom'
    && saved.password !== undefined
    && policy?.mode === 'custom'
  ) {
    return { ...policy, password: saved.password };
  }
  if (raw.useStoredPassword === true) {
    invalid('agentNetwork.useStoredPassword', 'agentNetwork.useStoredPassword requires a saved custom password');
  }
  return policy;
}
