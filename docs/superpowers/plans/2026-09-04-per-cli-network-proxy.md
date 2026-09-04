# Per-CLI Network Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently persisted Follow system, Direct, and authenticated Custom network proxy policies for every local CLI in Models & Providers and `od config proxy`.

**Architecture:** Store a semantic `agentNetwork` map in daemon app-config, expose only a password-redacted public view, and translate the selected CLI's stored policy into standard proxy environment variables at the existing `spawnEnvForAgent` choke point. Keep proxy editing in an explicit-save Settings sub-flow, pass draft policy only to the existing connection-test endpoint, and leave daemon-owned/BYOK traffic untouched.

**Tech Stack:** TypeScript, React 18, Next.js 16, Express 5, Node.js 24 child processes, Vitest, Playwright, pnpm 10.33.2.

**Spec:** `docs/superpowers/specs/2026-09-04-per-cli-network-proxy-design.md`

## Global Constraints

- Read the root `AGENTS.md` plus `apps/AGENTS.md`, `apps/daemon/AGENTS.md`, `packages/AGENTS.md`, and `e2e/AGENTS.md` before editing their layers.
- Do not use or update Graphify for this work.
- This is a non-trivial feature. Do not start Task 1 until a concrete repository issue exists, as required by root `AGENTS.md`; use that exact issue number in the eventual PR.
- Node remains `~24`; pnpm remains `10.33.2`; all new project-owned source, tests, and scripts are TypeScript.
- `packages/contracts` stays pure TypeScript with no Node, browser, Express, SQLite, daemon, or sidecar imports.
- All persisted daemon data continues to derive from the resolved `RUNTIME_DATA_DIR`; do not add another data root or port-derived path.
- `agentCliEnv` keeps its current responsibility for CLI homes, binary paths, provider base URLs, and CLI API credentials. Do not add proxy environment keys to its per-agent allowlist.
- The policy applies only to local CLI detection, model discovery, connection tests, and future CLI runs. It must not affect BYOK, media, updates, plugins, connectors, downloads, or the daemon process environment.
- Supported custom schemes are exactly `http:`, `https:`, and `socks5:`. HTTP(S) sets both `HTTP_PROXY` and `HTTPS_PROXY`; SOCKS5 sets `ALL_PROXY`.
- Limits are exact: 128 entries; CLI ID `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; proxy URL 2,048 characters; bypass list 4,096; username 256; password 1,024.
- Public config, `od` output, logs, analytics, diagnostics, and browser `localStorage` never contain a proxy password. Only the daemon's owner-protected app-config file may persist it.
- Network Proxy uses an explicit Save proxy settings action. General Settings autosave must not persist proxy drafts or half-entered credentials.
- Use fake runtime executables and existing replay fixtures. Do not call a real model provider or spend provider budget.
- Do not edit generated `dist/` output.

---

### Task 1: Add the app-config contract, secret-preserving persistence, and public redaction

**Files:**

- Modify: `packages/contracts/src/api/app-config.ts`
- Modify: `packages/contracts/src/api/connectionTest.ts`
- Create: `apps/daemon/src/storage/app-config-errors.ts`
- Create: `apps/daemon/src/storage/agent-network-config.ts`
- Modify: `apps/daemon/src/app-config.ts`
- Modify: `apps/daemon/src/routes/media.ts`
- Modify: `apps/daemon/tests/app-config.test.ts`
- Modify: `apps/daemon/tests/server-startup-smoke.test.ts`

**Interfaces:**

- Consumes: existing `AppConfigPrefs`, `UpdateAppConfigRequest`, `InvalidAppConfigValueError`, `readAppConfig`, and `writeAppConfig`.
- Produces: `AgentNetworkPolicyView`, `AgentNetworkPolicyUpdate`, `AgentNetworkPrefs`, `AgentNetworkUpdatePrefs`, `AgentNetworkTestPolicy`, `StoredAgentNetworkPolicy`, `StoredAgentNetworkPrefs`, `parseStoredAgentNetworkPrefs`, `mergeAgentNetworkUpdate`, `agentNetworkPolicyForAgent`, `toPublicAgentNetworkPrefs`, and `toPublicAppConfigPrefs`.

- [ ] **Step 1: Write failing app-config persistence and redaction tests**

Add focused cases to `apps/daemon/tests/app-config.test.ts` that cover valid direct/custom entries, private/custom profile IDs, all exact limits, URL validation, password preservation/replacement/clear, full-map clear, public redaction, prototype keys, and file permissions. Use literal inert credentials rather than token-shaped strings.

```ts
it('persists a custom agent network policy while redacting its password publicly', async () => {
  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        noProxy: '.corp.test',
        username: 'alice',
        password: 'proxy-password-value',
      },
      'corp-profile': { mode: 'direct' },
    },
  });

  const stored = await readAppConfig(dataDir);
  expect(stored.agentNetwork?.codex).toMatchObject({
    mode: 'custom',
    password: 'proxy-password-value',
  });
  expect(toPublicAppConfigPrefs(stored).agentNetwork).toEqual({
    codex: {
      mode: 'custom',
      proxyUrl: 'http://proxy.corp.test:8080',
      noProxy: '.corp.test',
      username: 'alice',
      passwordConfigured: true,
    },
    'corp-profile': { mode: 'direct' },
  });
});

it('preserves, replaces, and explicitly clears a stored proxy password', async () => {
  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        username: 'alice',
        password: 'first-password',
      },
    },
  });

  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        username: 'alice',
      },
    },
  });
  expect((await readAppConfig(dataDir)).agentNetwork?.codex).toMatchObject({
    password: 'first-password',
  });

  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        username: 'alice',
        password: 'second-password',
      },
    },
  });
  expect((await readAppConfig(dataDir)).agentNetwork?.codex).toMatchObject({
    password: 'second-password',
  });

  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        username: 'alice',
        clearPassword: true,
      },
    },
  });
  expect((await readAppConfig(dataDir)).agentNetwork?.codex).not.toHaveProperty('password');
});

it.runIf(process.platform !== 'win32')('writes app-config owner-only', async () => {
  await writeAppConfig(dataDir, { agentNetwork: { codex: { mode: 'direct' } } });
  const mode = (await stat(path.join(dataDir, 'app-config.json'))).mode & 0o777;
  expect(mode).toBe(0o600);
});
```

Add table tests expecting `InvalidAppConfigValueError` with `code === 'INVALID_APP_CONFIG_VALUE'` and a `key` beginning with `agentNetwork` for `ftp:`, URL userinfo, a path/query/fragment, control characters, password-without-username, over-limit strings, the 129th entry, and malformed IDs.

- [ ] **Step 2: Run the persistence tests to verify RED**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/app-config.test.ts
```

Expected: FAIL because `agentNetwork`, `toPublicAppConfigPrefs`, and the storage module do not exist and the current app-config file is not explicitly written with mode `0600`.

- [ ] **Step 3: Add distinct public, update, and connection-test contract types**

Add these exported shapes to `packages/contracts/src/api/app-config.ts`, extend `AppConfigPrefs`, and replace the simple `Partial<AppConfigPrefs>` alias with an override for the write shape.

```ts
export type AgentNetworkPolicyView =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      passwordConfigured: boolean;
    };

export type AgentNetworkPolicyUpdate =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      password?: string;
      clearPassword?: true;
    };

export type AgentNetworkPrefs = Record<string, AgentNetworkPolicyView>;
export type AgentNetworkUpdatePrefs = Record<string, AgentNetworkPolicyUpdate>;

export type AgentNetworkTestPolicy =
  | { mode: 'inherit' }
  | { mode: 'direct' }
  | ({
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      password?: string;
      clearPassword?: true;
      useStoredPassword?: true;
    });

export interface AppConfigPrefs {
  agentNetwork?: AgentNetworkPrefs;
}

export type UpdateAppConfigRequest =
  & Omit<Partial<AppConfigPrefs>, 'agentNetwork'>
  & { agentNetwork?: AgentNetworkUpdatePrefs };
```

Extend `AgentTestRequest` in `packages/contracts/src/api/connectionTest.ts` with `agentNetwork?: AgentNetworkTestPolicy`.

- [ ] **Step 4: Implement bounded persisted-policy parsing and secret merges**

Create `apps/daemon/src/storage/agent-network-config.ts`. Keep public DTO imports type-only. Export the stored shapes and five helpers with these exact signatures:

```ts
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

export function parseStoredAgentNetworkPrefs(
  raw: unknown,
): StoredAgentNetworkPrefs | undefined;

export function mergeAgentNetworkUpdate(
  raw: unknown,
  existing: StoredAgentNetworkPrefs | undefined,
): StoredAgentNetworkPrefs | undefined;

export function agentNetworkPolicyForAgent(
  prefs: StoredAgentNetworkPrefs | undefined,
  agentId: string,
): StoredAgentNetworkPolicy | undefined;

export function toPublicAgentNetworkPrefs(
  prefs: StoredAgentNetworkPrefs | undefined,
): AgentNetworkPrefs | undefined;

export function resolveAgentNetworkTestPolicy(
  raw: unknown,
  saved: StoredAgentNetworkPolicy | undefined,
): StoredAgentNetworkPolicy | undefined;
```

Use `new URL(proxyUrl)` and require `url.protocol` in the exact allowlist,
`url.hostname !== ''`, `url.pathname === '/'`, empty search/hash, and empty
username/password. Reject control characters with `/[\u0000-\u001F\u007F]/u`.
Treat an explicit empty object as clearing the map. Preserve an existing
password only for the same retained custom entry when the update omits both
`password` and `clearPassword`; reject `password` plus `clearPassword` and
`useStoredPassword` plus either password action.

Move `InvalidAppConfigValueError` into
`apps/daemon/src/storage/app-config-errors.ts` and re-export it from
`app-config.ts`. Both app-config control validation and agent-network strict
write validation import the shared error class, avoiding an
`app-config.ts` <-> `agent-network-config.ts` cycle. The lenient
`parseStoredAgentNetworkPrefs` drops malformed disk entries instead of making
daemon startup fail; `mergeAgentNetworkUpdate` is the strict explicit-write
path and throws the shared error.

- [ ] **Step 5: Integrate internal storage, public API views, and owner-only writes**

In `apps/daemon/src/app-config.ts`, add `agentNetwork` to the internal
`AppConfigPrefs` and `ALLOWED_KEYS`. In `filterAllowedKeys`, parse disk values
with `parseStoredAgentNetworkPrefs`. In `doWrite`, handle an explicitly supplied
`agentNetwork` before the ordinary preference loop by calling
`mergeAgentNetworkUpdate(partial.agentNetwork, existing.agentNetwork)`, then
skip that key in the ordinary `applyConfigValue` loop. Export:

```ts
export function toPublicAppConfigPrefs(prefs: AppConfigPrefs): PublicAppConfigPrefs {
  const { agentNetwork: stored, ...rest } = prefs;
  const agentNetwork = toPublicAgentNetworkPrefs(stored);
  return {
    ...rest,
    ...(agentNetwork ? { agentNetwork } : {}),
  };
}
```

Import that return type as
`AppConfigPrefs as PublicAppConfigPrefs` from `@open-design/contracts`; do not
expose the daemon's stored `AppConfigPrefs` type through the route.

Write the atomic temporary file with `{ encoding: 'utf8', mode: 0o600 }` and,
on POSIX, `chmod(file, 0o600)` after the rename. In
`apps/daemon/src/routes/media.ts`, return `toPublicAppConfigPrefs(config)` from
both app-config GET and successful PUT while continuing to pass the internal
stored config to `orbitService.configure` and `onAppConfigWritten`.

- [ ] **Step 6: Add an HTTP regression proving GET/PUT never return the password**

Extend the existing real-daemon app-config smoke in
`apps/daemon/tests/server-startup-smoke.test.ts`:

```ts
const put = await fetch(`${started.url}/api/app-config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.corp.test:8080',
        username: 'alice',
        password: 'http-secret-value',
      },
    },
  }),
});
expect(put.status).toBe(200);
expect(await put.text()).not.toContain('http-secret-value');

const get = await fetch(`${started.url}/api/app-config`);
const text = await get.text();
expect(text).not.toContain('http-secret-value');
expect(JSON.parse(text).config.agentNetwork.codex.passwordConfigured).toBe(true);
```

- [ ] **Step 7: Run Task 1 tests and typechecks**

Run:

```bash
pnpm --filter @open-design/contracts typecheck
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/app-config.test.ts tests/server-startup-smoke.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: all selected tests and both typechecks PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts/src/api/app-config.ts packages/contracts/src/api/connectionTest.ts apps/daemon/src/storage/app-config-errors.ts apps/daemon/src/storage/agent-network-config.ts apps/daemon/src/app-config.ts apps/daemon/src/routes/media.ts apps/daemon/tests/app-config.test.ts apps/daemon/tests/server-startup-smoke.test.ts
git commit -m "feat(config): persist per-cli network policies"
```

---

### Task 2: Build proxy-env primitives, the runtime resolver, and credential redaction

**Files:**

- Modify: `packages/platform/src/proxy-env.ts`
- Modify: `packages/platform/src/index.ts`
- Modify: `packages/platform/tests/index.test.ts`
- Modify: `packages/diagnostics/src/redaction.ts`
- Modify: `packages/diagnostics/tests/redaction.test.ts`
- Create: `apps/daemon/src/runtimes/network-policy.ts`
- Modify: `apps/daemon/src/runtimes/env.ts`
- Modify: `apps/daemon/src/redact.ts`
- Modify: `apps/daemon/src/connectionTest.ts`
- Create: `apps/daemon/tests/runtimes/network-policy.test.ts`
- Modify: `apps/daemon/tests/runtimes/env-and-detection.test.ts`
- Modify: `apps/daemon/tests/redact.test.ts`
- Modify: `apps/daemon/tests/connection-test.test.ts`
- Modify: `apps/daemon/tests/diagnostics-export.test.ts`

**Interfaces:**

- Consumes: `StoredAgentNetworkPolicy` from Task 1 and existing
  `mergeProxyAwareEnv` / `resolveSystemProxyEnv`.
- Produces: `PROXY_ENV_KEYS`, `withoutProxyEnv`,
  `mergeNoProxyWithLoopbackDefaults`, `applyAgentNetworkPolicy`, and the new
  `networkPolicy` member of `SpawnEnvOptions`, with authenticated proxy URL
  redaction in every existing diagnostic scrubber before runtime wiring lands.

- [ ] **Step 1: Write failing platform and runtime policy tests**

Add platform tests for case-insensitive stripping without input mutation and
loopback/wildcard bypass normalization. Add the runtime matrix in the new
daemon test file:

```ts
it.each([
  ['http://proxy.test:8080', 'HTTP_PROXY', 'http://proxy.test:8080'],
  ['https://proxy.test:8443', 'HTTPS_PROXY', 'https://proxy.test:8443'],
  ['socks5://proxy.test:1080', 'ALL_PROXY', 'socks5://proxy.test:1080'],
] as const)('maps custom proxy %s to %s', (proxyUrl, key, value) => {
  const env = applyAgentNetworkPolicy(
    {
      HTTP_PROXY: 'http://inherited.test:80',
      HTTPS_PROXY: 'http://inherited.test:443',
      NO_PROXY: '.old.test',
      KEEP_ME: 'yes',
    },
    { mode: 'custom', proxyUrl, noProxy: '.corp.test' },
    'linux',
  );
  expect(env[key]).toBe(value);
  expect(env.NO_PROXY).toBe('.corp.test,localhost,127.0.0.1,[::1]');
  expect(env.NODE_USE_ENV_PROXY).toBe('1');
  expect(env.KEEP_ME).toBe('yes');
});

it('makes direct mode remove every proxy spelling', () => {
  const env = applyAgentNetworkPolicy(
    {
      http_proxy: 'http://lower.test:80',
      HTTPS_PROXY: 'http://upper.test:443',
      all_proxy: 'socks5://old.test:1080',
      No_Proxy: '.old.test',
      NODE_USE_ENV_PROXY: '1',
      KEEP_ME: 'yes',
    },
    { mode: 'direct' },
    'linux',
  );
  const proxyKeys = new Set<string>(PROXY_ENV_KEYS);
  expect(Object.keys(env).filter((key) => proxyKeys.has(key.toUpperCase()))).toEqual([]);
  expect(env.KEEP_ME).toBe('yes');
});

it('encodes proxy credentials only in the returned child environment', () => {
  const policy = {
    mode: 'custom' as const,
    proxyUrl: 'http://proxy.test:8080',
    username: 'a user',
    password: 'p@ss:/word',
  };
  const env = applyAgentNetworkPolicy({}, policy, 'linux');
  expect(env.HTTP_PROXY).toBe('http://a%20user:p%40ss%3A%2Fword@proxy.test:8080/');
  expect(policy.proxyUrl).toBe('http://proxy.test:8080');
});
```

Add URL-userinfo RED cases to `apps/daemon/tests/redact.test.ts`,
`packages/diagnostics/tests/redaction.test.ts`, and the connection-test helper:

```ts
it.each([
  'http://alice:proxy-pass@proxy.test:8080',
  'https://alice:p%40ss@proxy.test:8443',
  'socks5://alice:proxy-pass@proxy.test:1080',
])('redacts proxy URL credentials from %s', (url) => {
  const output = redactSecrets(`spawn failed with ${url}/connect`);
  expect(output).not.toContain('alice');
  expect(output).not.toMatch(/proxy-pass|p%40ss/u);
  expect(output).toContain('proxy.test');
});
```

Use `redactText` instead of `redactSecrets` in the diagnostics package case.

- [ ] **Step 2: Run the new tests to verify RED**

Run:

```bash
pnpm --filter @open-design/platform test -- tests/index.test.ts
pnpm --filter @open-design/diagnostics test -- tests/redaction.test.ts
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/network-policy.test.ts tests/runtimes/env-and-detection.test.ts tests/redact.test.ts tests/connection-test.test.ts
```

Expected: FAIL because the generic helpers, resolver, spawn option, and URL-userinfo redaction do not exist.

- [ ] **Step 3: Add generic immutable proxy helpers to `packages/platform`**

Export exactly these helpers from `proxy-env.ts` and the package barrel:

```ts
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
] as const;

export function withoutProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxyKeys = new Set<string>(PROXY_ENV_KEYS);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !proxyKeys.has(key.toUpperCase())),
  );
}

export function mergeNoProxyWithLoopbackDefaults(noProxy: string | undefined): string {
  if (noProxy?.split(/[\s,]+/u).some((token) => token.trim() === '*')) return '*';
  const values = [
    ...(noProxy ? noProxy.split(/[\s,]+/u) : []),
    'localhost',
    '127.0.0.1',
    '[::1]',
  ].map((token) => token.trim() === '::1' ? '[::1]' : token.trim()).filter(Boolean);
  return [...new Set(values)].join(',');
}
```

Update `apps/daemon/src/connectionTest.ts` to import the shared bypass helper
and delete its private duplicate. Re-export the imported helper from that
module for the current `server.ts` consumer so Task 2 stays independently
type-correct; Task 3 may switch that consumer to the platform import directly.
Existing dispatcher tests must remain green.

- [ ] **Step 4: Implement the daemon-owned semantic resolver**

Create `apps/daemon/src/runtimes/network-policy.ts`:

```ts
import {
  mergeNoProxyWithLoopbackDefaults,
  mergeProxyAwareEnv,
  withoutProxyEnv,
} from '@open-design/platform';
import type { StoredAgentNetworkPolicy } from '../storage/agent-network-config.js';

export function applyAgentNetworkPolicy(
  env: NodeJS.ProcessEnv,
  policy: StoredAgentNetworkPolicy | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!policy) return { ...env };
  const direct = withoutProxyEnv(env);
  if (policy.mode === 'direct') return direct;

  const url = new URL(policy.proxyUrl);
  if (policy.username) url.username = policy.username;
  if (policy.password) url.password = policy.password;
  const authenticatedProxy = policy.username || policy.password
    ? url.toString()
    : policy.proxyUrl;
  const proxyEnv: NodeJS.ProcessEnv = {
    NO_PROXY: mergeNoProxyWithLoopbackDefaults(policy.noProxy),
    NODE_USE_ENV_PROXY: '1',
  };
  if (url.protocol === 'socks5:') {
    proxyEnv.ALL_PROXY = authenticatedProxy;
  } else {
    proxyEnv.HTTP_PROXY = authenticatedProxy;
    proxyEnv.HTTPS_PROXY = authenticatedProxy;
  }
  return mergeProxyAwareEnv(platform, direct, proxyEnv);
}
```

- [ ] **Step 5: Apply the policy last in `spawnEnvForAgent`**

Extend the private options type without changing existing positional parameters:

```ts
type SpawnEnvOptions = {
  resolvedBin?: string | null;
  networkPolicy?: StoredAgentNetworkPolicy;
};
```

Pass `options.networkPolicy` into `finalizeRuntimeEnv` for every agent branch,
then apply it after sandbox and Windows cache shaping and before the existing
scheme sanitizer:

```ts
function finalizeRuntimeEnv(
  env: NodeJS.ProcessEnv,
  sandboxRuntime: SandboxRuntimeConfig | null,
  networkPolicy?: StoredAgentNetworkPolicy,
): NodeJS.ProcessEnv {
  const sandboxed = reapplySandboxRuntimeEnv(env, sandboxRuntime);
  applyWindowsUserCacheEnv(sandboxed);
  const networked = applyAgentNetworkPolicy(sandboxed, networkPolicy);
  sanitizeProxyEnv(networked);
  return networked;
}
```

- [ ] **Step 6: Harden proxy credential redaction before wiring policies into launches**

Before running the whole Task 2 gate, add one conservative URL-userinfo
replacement to the daemon telemetry redactor, the connection-test helper, and
the diagnostics redactor:

```ts
const URL_USERINFO_RE = /\b((?:https?|socks5):\/\/)[^/@\s]+@/giu;
```

Run this replacement before email/IP patterns. The daemon telemetry marker is
`$1[REDACTED:proxy_credentials]@`; connection-test and diagnostics use
`$1[REDACTED]@`. The destination host remains visible while username and
password are removed. Keep the connection-test helper's existing
`exactSecrets` pass as defense in depth.

- [ ] **Step 7: Run Task 2 tests and typechecks**

Run:

```bash
pnpm --filter @open-design/platform test -- tests/index.test.ts
pnpm --filter @open-design/platform typecheck
pnpm --filter @open-design/diagnostics test -- tests/redaction.test.ts
pnpm --filter @open-design/diagnostics typecheck
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/network-policy.test.ts tests/runtimes/env-and-detection.test.ts tests/proxy-dispatcher-options.test.ts tests/redact.test.ts tests/connection-test.test.ts tests/diagnostics-export.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: all selected tests and typechecks PASS; existing system-proxy behavior remains green.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/platform/src/proxy-env.ts packages/platform/src/index.ts packages/platform/tests/index.test.ts packages/diagnostics/src/redaction.ts packages/diagnostics/tests/redaction.test.ts apps/daemon/src/runtimes/network-policy.ts apps/daemon/src/runtimes/env.ts apps/daemon/src/redact.ts apps/daemon/src/connectionTest.ts apps/daemon/tests/runtimes/network-policy.test.ts apps/daemon/tests/runtimes/env-and-detection.test.ts apps/daemon/tests/redact.test.ts apps/daemon/tests/connection-test.test.ts apps/daemon/tests/diagnostics-export.test.ts
git commit -m "feat(runtime): resolve per-cli proxy environments"
```

---

### Task 3: Thread network policy through detection, model discovery, tests, and runs

**Files:**

- Modify: `apps/daemon/src/runtimes/detection.ts`
- Modify: `apps/daemon/src/routes/static-resource.ts`
- Modify: `apps/daemon/src/routes/chat.ts`
- Modify: `apps/daemon/src/routes/runs.ts`
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/connectionTest.ts`
- Modify: `apps/daemon/src/memory-llm.ts`
- Modify: `apps/daemon/tests/runtimes/env-and-detection.test.ts`
- Modify: `apps/daemon/tests/connection-test.test.ts`
- Modify: `apps/daemon/tests/server-startup-smoke.test.ts`
- Modify: `apps/daemon/tests/runtimes/registry-and-args.test.ts`

**Interfaces:**

- Consumes: Task 1 stored/test policy helpers and Task 2's
  `SpawnEnvOptions.networkPolicy`.
- Produces: `detectAgents(configuredEnvByAgent, agentNetworkByAgent)`,
  `detectAgentsStream(configuredEnvByAgent, agentNetworkByAgent)`, and a
  connection-test route that resolves saved/draft policy before spawn.

- [ ] **Step 1: Add RED detection, test, custom-profile, and real-run witnesses**

Extend existing fake-CLI fixtures so the child succeeds only when the expected
proxy variables are present. Keep assertions sanitized so credentials are not
printed on failure.

```ts
test('detectAgents applies the selected agent network policy to version and model probes', async () => {
  const agents = await detectAgents(
    { codex: { CODEX_BIN: fakeCodex } },
    {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.test:8080',
        noProxy: '.corp.test',
      },
    },
  );
  expect(agents.find((agent) => agent.id === 'codex')?.available).toBe(true);
});

it('tests an unsaved direct draft instead of the saved custom policy', async () => {
  await writeAppConfig(dataDir, {
    agentNetwork: {
      codex: { mode: 'custom', proxyUrl: 'http://saved.test:8080' },
    },
  });
  const response = await postConnectionTest({
    mode: 'agent',
    agentId: 'codex',
    agentNetwork: { mode: 'direct' },
  });
  expect(response.ok).toBe(true);
});
```

Add one local-profile case in `registry-and-args.test.ts` using the existing
profile fixture and a non-built-in ID, and one run case in
`server-startup-smoke.test.ts` whose fake CLI writes a success frame only when
its expected custom proxy is present.

- [ ] **Step 2: Run the integration witnesses to verify RED**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/env-and-detection.test.ts tests/runtimes/registry-and-args.test.ts tests/connection-test.test.ts tests/server-startup-smoke.test.ts
```

Expected: FAIL because detection, connection testing, custom profiles, and real runs do not receive `agentNetwork`.

- [ ] **Step 3: Extend detection without changing the existing first argument**

Use a second map so current `agentCliEnv` callers remain source-compatible:

```ts
export async function detectAgents(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  agentNetworkByAgent: StoredAgentNetworkPrefs = {},
) {
  const results = await Promise.all(
    AGENT_DEFS.map((def) => detectAgent(
      def,
      configuredEnvForAgent(configuredEnvByAgent, def.id),
      agentNetworkPolicyForAgent(agentNetworkByAgent, def.id),
    )),
  );
  for (const agent of results) rememberDetectedLiveModels(agent);
  return results;
}
```

Make the same additive change to `detectAgentsStream`, `detectAgent`, `probe`,
and `runtimeVersionProbeContext`. Every `spawnEnvForAgent` inside detection
passes `{ resolvedBin, networkPolicy }`; model listing then automatically uses
the same probe environment.

- [ ] **Step 4: Pass saved policy to every daemon detection call**

Update `/api/agents` batch and SSE paths in `routes/static-resource.ts`, daemon
startup warming, transcript/Orbit/routine fallbacks in `server.ts`, and both
fallback paths in `routes/runs.ts` to use the same pair:

```ts
const config = await readAppConfig(RUNTIME_DATA_DIR);
const agents = await detectAgents(
  config.agentCliEnv ?? {},
  config.agentNetwork ?? {},
);
```

Update `RegisterRunRoutesDeps.agents.detectAgents` to accept both arguments.
Do not send public agent-network config from the browser to `/api/agents`;
rescans read the saved daemon config so an unsaved Settings draft remains
non-persistent.

- [ ] **Step 5: Resolve connection-test drafts against saved credentials**

In `routes/chat.ts`, validate `body.agentNetwork` with
`resolveAgentNetworkTestPolicy`. An absent draft uses the saved policy. An
explicit `{ mode: 'inherit' }` overrides a saved direct/custom policy for that
test. `useStoredPassword: true` is accepted only for the same selected CLI and
only when a stored custom password exists.

```ts
const savedPolicy = agentNetworkPolicyForAgent(appConfig.agentNetwork, body.agentId);
const networkPolicy = Object.hasOwn(body, 'agentNetwork')
  ? resolveAgentNetworkTestPolicy(body.agentNetwork, savedPolicy)
  : savedPolicy;

const result = await testAgentConnection({
  agentId: body.agentId,
  model: safeModel,
  reasoning: safeReasoning,
  serviceTier: safeServiceTier,
  agentCliEnv: body.agentCliEnv && typeof body.agentCliEnv === 'object'
    ? body.agentCliEnv
    : undefined,
  networkPolicy,
  signal: controller.signal,
});
```

Use an internal `ResolvedAgentConnectionInput` type so stored passwords never
enter `packages/contracts`. Pass `networkPolicy` to the primary test and Codex
fallback attempt. Catch `InvalidAppConfigValueError` around draft resolution
and return the same HTTP 400 `INVALID_APP_CONFIG_VALUE` envelope used by the
app-config route; do not turn malformed draft policy into a 500.

- [ ] **Step 6: Apply saved policy to new run processes**

When `startChatRun` reads app-config, resolve both the CLI env and network policy:

```ts
const configuredAgentEnv = agentCliEnvForAgent(appConfig.agentCliEnv, def.id);
const configuredNetworkPolicy = agentNetworkPolicyForAgent(appConfig.agentNetwork, def.id);
```

Pass `networkPolicy: configuredNetworkPolicy` to the final
`spawnEnvForAgent` that produces `agentSpawnEnv` and to any same-operation
Codex/model preflight spawn. Because retry and resume paths re-enter
`startChatRun`, they resolve the current policy at their own operation start.
Pass the policy in `memory-llm.ts` when it intentionally spawns the selected
CLI for memory work. Leave these non-network child/environment-inspection
sites unchanged and add a short comment at each: `agent-companion-setup.ts`
(installer owned by daemon), `diagnostics-export.ts` (path discovery only),
and `services/run-analytics-lifecycle.ts` (Codex home derivation only).

- [ ] **Step 7: Re-run the focused integration suite**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/env-and-detection.test.ts tests/runtimes/registry-and-args.test.ts tests/connection-test.test.ts tests/server-startup-smoke.test.ts
pnpm --filter @open-design/daemon typecheck
```

Expected: all selected tests and daemon typecheck PASS.

- [ ] **Step 8: Audit the spawn/detection call graph before commit**

Run:

```bash
rg -n "spawnEnvForAgent\(|detectAgents\(|detectAgentsStream\(" apps/daemon/src
```

Expected: every network-capable detection/test/run call either passes the
selected policy or is one of the three explicitly documented non-network
inspection/setup sites from Step 6.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/daemon/src/runtimes/detection.ts apps/daemon/src/routes/static-resource.ts apps/daemon/src/routes/chat.ts apps/daemon/src/routes/runs.ts apps/daemon/src/server.ts apps/daemon/src/connectionTest.ts apps/daemon/src/memory-llm.ts apps/daemon/tests/runtimes/env-and-detection.test.ts apps/daemon/tests/connection-test.test.ts apps/daemon/tests/server-startup-smoke.test.ts apps/daemon/tests/runtimes/registry-and-args.test.ts
git commit -m "feat(daemon): apply cli proxy policy to launches"
```

---

### Task 4: Add the web persistence boundary for explicit proxy saves

**Files:**

- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/state/config.ts`
- Create: `apps/web/src/providers/agent-network.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/tests/state/config.test.ts`
- Create: `apps/web/tests/providers/agent-network.test.ts`

**Interfaces:**

- Consumes: Task 1 public/update contract types and `/api/app-config`.
- Produces: `saveAgentNetworkPrefs`, `onPersistAgentNetwork`, and reconciled
  public `AppConfig.agentNetwork` state. General `syncConfigToDaemon` remains
  unable to write this field.

- [ ] **Step 1: Write RED state and provider tests**

Add state tests proving daemon public config hydrates `agentNetwork`, the
browser serializer can store only the public view, and generic autosave does
not send `agentNetwork`. Add a provider test that captures the exact PUT and
response:

```ts
it('writes only agentNetwork and returns the daemon public view', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    config: {
      agentNetwork: {
        codex: {
          mode: 'custom',
          proxyUrl: 'http://proxy.test:8080',
          username: 'alice',
          passwordConfigured: true,
        },
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  const result = await saveAgentNetworkPrefs({
    codex: {
      mode: 'custom',
      proxyUrl: 'http://proxy.test:8080',
      username: 'alice',
      password: 'write-only-password',
    },
  });

  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
    agentNetwork: {
      codex: {
        mode: 'custom',
        proxyUrl: 'http://proxy.test:8080',
        username: 'alice',
        password: 'write-only-password',
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain('write-only-password');
});
```

- [ ] **Step 2: Run the web tests to verify RED**

Run:

```bash
pnpm --filter @open-design/web test -- tests/state/config.test.ts tests/providers/agent-network.test.ts
```

Expected: FAIL because the web types and dedicated provider do not exist.

- [ ] **Step 3: Add public web types and daemon hydration**

Import or alias the contract types in `apps/web/src/types.ts`:

```ts
export type AgentNetworkConfig = AgentNetworkPrefs;

export interface AppConfig {
  agentNetwork?: AgentNetworkConfig;
}
```

Initialize `agentNetwork: {}` in the default config and merge
`daemonConfig.agentNetwork ?? {}` in `mergeDaemonConfig`. Do not add
`agentNetwork` to the object built by `syncConfigToDaemon`; that omission is
the explicit-save boundary. `saveConfig` can persist the public view because
it contains no password, but add a defensive recursive removal of any
accidental `password` property before serializing.

- [ ] **Step 4: Implement the focused HTTP provider**

Create `apps/web/src/providers/agent-network.ts`:

```ts
export async function saveAgentNetworkPrefs(
  agentNetwork: AgentNetworkUpdatePrefs,
): Promise<AgentNetworkPrefs> {
  const response = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentNetwork }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { message?: string } | string;
    } | null;
    const message = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message;
    throw new Error(message || `Proxy settings save failed (${response.status})`);
  }
  const payload = await response.json() as AppConfigResponse;
  return payload.config.agentNetwork ?? {};
}
```

- [ ] **Step 5: Add an App-owned non-optimistic persistence callback**

Add `handlePersistAgentNetwork` beside the explicit Composio handler. It
calls `saveAgentNetworkPrefs`, then merges only the accepted public map into
`latestPersistedConfigRef`, `configRef`, localStorage, and React state.

```ts
const handlePersistAgentNetwork = useCallback(async (
  agentNetwork: AgentNetworkUpdatePrefs,
): Promise<AgentNetworkPrefs> => {
  const accepted = await saveAgentNetworkPrefs(agentNetwork);
  const next = { ...latestPersistedConfigRef.current, agentNetwork: accepted };
  latestPersistedConfigRef.current = next;
  saveConfig(next);
  setConfig(next);
  return accepted;
}, []);
```

Pass it to `SettingsDialog` as `onPersistAgentNetwork`. Do not update app state
before the daemon response succeeds.

- [ ] **Step 6: Run Task 4 tests and web typecheck**

Run:

```bash
pnpm --filter @open-design/web test -- tests/state/config.test.ts tests/providers/agent-network.test.ts
pnpm --filter @open-design/web typecheck
```

Expected: all selected tests and web typecheck PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/web/src/types.ts apps/web/src/state/config.ts apps/web/src/providers/agent-network.ts apps/web/src/App.tsx apps/web/tests/state/config.test.ts apps/web/tests/providers/agent-network.test.ts
git commit -m "feat(web): add explicit cli proxy persistence"
```

---

### Task 5: Build the Models & Providers proxy editor and draft test flow

**Files:**

- Create: `apps/web/src/components/AgentNetworkProxySection.tsx`
- Create: `apps/web/tests/components/AgentNetworkProxySection.test.tsx`
- Modify: `apps/web/src/components/SettingsDialog.tsx`
- Modify: `apps/web/src/styles/workspace/artifacts.css`
- Modify: `apps/web/src/i18n/types.ts`
- Modify: `apps/web/src/i18n/locales/en.ts`
- Modify: `apps/web/src/i18n/locales/zh-CN.ts`
- Modify: `apps/web/src/i18n/locales/zh-TW.ts`
- Modify: `apps/web/src/i18n/locales/ar.ts`
- Modify: `apps/web/src/i18n/locales/de.ts`
- Modify: `apps/web/src/i18n/locales/es-ES.ts`
- Modify: `apps/web/src/i18n/locales/fa.ts`
- Modify: `apps/web/src/i18n/locales/fr.ts`
- Modify: `apps/web/src/i18n/locales/hu.ts`
- Modify: `apps/web/src/i18n/locales/id.ts`
- Modify: `apps/web/src/i18n/locales/it.ts`
- Modify: `apps/web/src/i18n/locales/ja.ts`
- Modify: `apps/web/src/i18n/locales/ko.ts`
- Modify: `apps/web/src/i18n/locales/pl.ts`
- Modify: `apps/web/src/i18n/locales/pt-BR.ts`
- Modify: `apps/web/src/i18n/locales/ru.ts`
- Modify: `apps/web/src/i18n/locales/th.ts`
- Modify: `apps/web/src/i18n/locales/tr.ts`
- Modify: `apps/web/src/i18n/locales/uk.ts`

**Interfaces:**

- Consumes: Task 4 `onPersistAgentNetwork`, existing `testAgent`, selected CLI
  model/reasoning/service-tier, and `agentCliEnv`.
- Produces: `AgentNetworkProxySection`, `AgentNetworkDraft`,
  `draftFromPolicy`, `updateMapFromDraft`, and `testPolicyFromDraft`.

- [ ] **Step 1: Write RED component tests for independent drafts and explicit save**

Use Testing Library with two selected agent IDs. Prove editing does not invoke
save, draft survives a CLI switch while mounted, Test receives the draft,
Save sends the complete map, a rejected save keeps the draft/error, and a
successful response replaces the baseline.

```tsx
it('keeps drafts per CLI and persists only on explicit save', async () => {
  const onSave = vi.fn().mockResolvedValue({
    codex: { mode: 'custom', proxyUrl: 'http://codex.proxy:8080', passwordConfigured: true },
  });
  const onDraftChange = vi.fn();
  const { rerender } = render(
    <AgentNetworkProxySection
      agentId="codex"
      savedPrefs={{}}
      onSave={onSave}
      onDraftChange={onDraftChange}
    />,
  );
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await userEvent.type(screen.getByLabelText('Proxy URL'), 'http://codex.proxy:8080');
  await userEvent.type(screen.getByLabelText('Password'), 'proxy-password');
  expect(onSave).not.toHaveBeenCalled();

  rerender(
    <AgentNetworkProxySection
      agentId="claude"
      savedPrefs={{}}
      onSave={onSave}
      onDraftChange={onDraftChange}
    />,
  );
  rerender(
    <AgentNetworkProxySection
      agentId="codex"
      savedPrefs={{}}
      onSave={onSave}
      onDraftChange={onDraftChange}
    />,
  );
  expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://codex.proxy:8080');
  await userEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }));
  expect(onSave).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the component test to verify RED**

Run:

```bash
pnpm --filter @open-design/web test -- tests/components/AgentNetworkProxySection.test.tsx
```

Expected: FAIL because the component and draft helpers do not exist.

- [ ] **Step 3: Implement the draft model and explicit-save component**

Create the component with this public contract:

```ts
export interface AgentNetworkDraft {
  mode: 'inherit' | 'direct' | 'custom';
  proxyUrl: string;
  noProxy: string;
  username: string;
  password: string;
  passwordAction: 'keep' | 'replace' | 'clear';
}

export interface AgentNetworkProxySectionProps {
  agentId: string;
  savedPrefs: AgentNetworkPrefs;
  onDraftChange: (agentId: string, policy: AgentNetworkTestPolicy) => void;
  onSave: (next: AgentNetworkUpdatePrefs) => Promise<AgentNetworkPrefs>;
}
```

The component maintains `Record<string, AgentNetworkDraft>` so changing
`agentId` does not destroy another CLI's draft. Render a fieldset/radio group
for Follow system, Direct, and Custom. Custom mode renders URL, bypass,
username, password, saved-password state, Clear password, and Save proxy
settings. Disable Save while invalid or saving; render the daemon error in an
`aria-live="polite"` status. Use the existing `Button` primitive and design
tokens, not literal colors.

Map a draft into the full update map by cloning `savedPrefs`, deleting the
agent key for inherit, writing `{ mode: 'direct' }` for direct, and writing the
custom fields plus either `password` or `clearPassword`. `testPolicyFromDraft`
returns explicit inherit/direct; custom keep uses `useStoredPassword: true`
only when the saved view has `passwordConfigured`.

- [ ] **Step 4: Wire the component into Settings without entering autosave**

Add `onPersistAgentNetwork` to `SettingsDialog.Props`. Render the new section
for every selected available local CLI before the existing Advanced CLI env
disclosure. Keep the provider Base URL/path fields unchanged except for copy
that no longer calls them network proxies.

Maintain the latest test draft in a ref and a revision counter:

```ts
const agentNetworkTestDraftRef = useRef<Record<string, AgentNetworkTestPolicy>>({});
const [agentNetworkDraftRevision, setAgentNetworkDraftRevision] = useState(0);

const handleAgentNetworkDraftChange = useCallback((
  agentId: string,
  policy: AgentNetworkTestPolicy,
) => {
  agentNetworkTestDraftRef.current[agentId] = policy;
  setAgentNetworkDraftRevision((revision) => revision + 1);
}, []);
```

Include the revision in the effect that invalidates stale connection-test
results. Add `agentNetwork` to `testAgent` only from the selected CLI's current
draft; never put the draft into `cfg`, `autosaveLatestRef`, or `onPersist`.
After explicit save succeeds, update `cfg.agentNetwork` from the accepted
public map while setting `suppressNextAutosaveRef.current = true` and aligning
`autosaveLastSavedRef.current.agentNetwork` so the normal autosave indicator
does not claim ownership of the proxy save.

- [ ] **Step 5: Add accessible token-based styling and all locale keys**

Add keys for title, scope hint, three modes, URL, bypass, username, password,
configured badge, clear, save, saving, saved, validation errors, and save
failure to `Dict` and all 19 locale dictionaries. English and Simplified
Chinese copy must use the approved product terms; other dictionaries receive
real translations rather than silently falling back.

```ts
'settings.agentNetwork.title': 'Network proxy',
'settings.agentNetwork.hint': 'Applies only to this CLI. Open Design traffic is unchanged.',
'settings.agentNetwork.mode.inherit': 'Follow system',
'settings.agentNetwork.mode.direct': 'Direct',
'settings.agentNetwork.mode.custom': 'Custom',
'settings.agentNetwork.proxyUrl': 'Proxy URL',
'settings.agentNetwork.noProxy': 'Bypass addresses',
'settings.agentNetwork.username': 'Username',
'settings.agentNetwork.password': 'Password',
'settings.agentNetwork.save': 'Save proxy settings',
```

Use `.agent-network-*` selectors in `artifacts.css`, existing spacing/border/
surface/focus tokens, and responsive stacking within the current Settings
column. Do not add hardcoded palette classes or colors.

- [ ] **Step 6: Run component, Settings, style, and type checks**

Run:

```bash
pnpm --filter @open-design/web test -- tests/components/AgentNetworkProxySection.test.tsx tests/state/config.test.ts tests/providers/connection-test.test.ts tests/styles/settings-polish.test.ts
pnpm --filter @open-design/web typecheck
pnpm guard
```

Expected: all selected tests, web typecheck, and guard PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/web/src/components/AgentNetworkProxySection.tsx apps/web/tests/components/AgentNetworkProxySection.test.tsx apps/web/src/components/SettingsDialog.tsx apps/web/src/styles/workspace/artifacts.css apps/web/src/i18n/types.ts apps/web/src/i18n/locales/{en,zh-CN,zh-TW,ar,de,es-ES,fa,fr,hu,id,it,ja,ko,pl,pt-BR,ru,th,tr,uk}.ts
git commit -m "feat(web): add per-cli proxy settings"
```

---

### Task 6: Add the `od config proxy` parity surface

**Files:**

- Create: `apps/daemon/src/runtimes/agent-network-cli.ts`
- Modify: `apps/daemon/src/cli.ts`
- Create: `apps/daemon/tests/runtimes/agent-network-cli.test.ts`
- Create: `apps/daemon/tests/config-proxy-cli.test.ts`
- Modify: `apps/daemon/tests/cli-startup.test.ts`

**Interfaces:**

- Consumes: Task 1 update/view types, `/api/app-config`, and
  `/api/test/connection`.
- Produces: `parseAgentNetworkProxyCommand`, `mergeAgentNetworkCliUpdate`, and
  the `od config proxy get|set|test|unset` command group.

- [ ] **Step 1: Write RED pure-parser and real-CLI HTTP tests**

The pure tests cover all verbs, missing IDs, exact modes, custom URL required
for a new entry, omitted-field merge, inherit/unset deletion, password file
and stdin, mutually exclusive `--clear-password`, unknown flags, and no
`--password`. The real CLI stub test captures GET/PUT/test traffic and ensures
stdout never contains the credential.

```ts
it('sets an authenticated custom policy without printing the password', async () => {
  const passwordFile = join(tempDir, 'proxy-password.txt');
  await writeFile(passwordFile, 'proxy-password-value\n');
  const result = await runCli([
    'config', 'proxy', 'set', 'codex',
    '--mode', 'custom',
    '--url', 'http://proxy.test:8080',
    '--username', 'alice',
    '--password-file', passwordFile,
    '--json',
    '--daemon-url', stub.baseUrl,
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain('proxy-password-value');
  expect(stub.requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/app-config' });
  expect(JSON.parse(stub.requests.at(-1)!.body)).toMatchObject({
    agentNetwork: {
      codex: {
        mode: 'custom',
        password: 'proxy-password-value',
      },
    },
  });
});
```

- [ ] **Step 2: Run CLI tests to verify RED**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/agent-network-cli.test.ts tests/config-proxy-cli.test.ts tests/cli-startup.test.ts
```

Expected: FAIL because `od config proxy` and its parser do not exist.

- [ ] **Step 3: Implement pure command parsing and map updates**

Create `runtimes/agent-network-cli.ts` with no process exit or fetch calls:

```ts
export type AgentNetworkProxyCommand =
  | { verb: 'get' | 'test' | 'unset'; agentId: string }
  | {
      verb: 'set';
      agentId: string;
      mode: 'inherit' | 'direct' | 'custom';
      proxyUrl?: string;
      noProxy?: string;
      username?: string;
      password?: string;
      clearPassword?: true;
    };

export function mergeAgentNetworkCliUpdate(
  current: AgentNetworkPrefs,
  command:
    | Extract<AgentNetworkProxyCommand, { verb: 'set' }>
    | { verb: 'unset'; agentId: string },
): AgentNetworkUpdatePrefs;

export function parseAgentNetworkProxyCommand(
  args: string[],
  readPasswordFile: (path: string) => Promise<string>,
): Promise<AgentNetworkProxyCommand>;
```

`parseAgentNetworkProxyCommand` receives already parsed flag values plus a
`readPasswordFile(path)` dependency. Remove one trailing `\r?\n` from password
file/stdin content but preserve all other characters. Validate `-` stdin as a
single consumer and reject `--password-file` with `--clear-password`.

- [ ] **Step 4: Extend `runConfig` with the nested proxy group**

Add `mode`, `url`, `no-proxy`, `username`, and `password-file` to
`CONFIG_STRING_FLAGS`; add `clear-password` to `CONFIG_BOOLEAN_FLAGS`. Dispatch
`sub === 'proxy'` before the existing list/get/set/unset switch.

```ts
if (sub === 'proxy') {
  return runConfigProxy(rest, {
    fetchConfig,
    writeConfig,
    testConnection: async (agentId) => {
      const response = await fetch(`${base}/api/test/connection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'agent', agentId }),
      });
      if (!response.ok) return structuredHttpFailure(response);
      return response.json();
    },
  });
}
```

`get` prints the selected public entry or Follow system; `set` fetches and
merges the full map, then PUTs `{ agentNetwork: next }`; `unset` deletes the
entry; `test` tests the saved policy. Human and JSON output include
`passwordConfigured` only. Exit 2 covers local usage errors; existing
structured HTTP errors retain their established exit mapping.

Update `od config --help` and the startup boundary matrix in
`cli-startup.test.ts`.

- [ ] **Step 5: Run CLI tests and daemon typecheck/build**

Run:

```bash
pnpm --dir apps/daemon exec vitest run -c vitest.config.ts tests/runtimes/agent-network-cli.test.ts tests/config-proxy-cli.test.ts tests/cli-startup.test.ts
pnpm --filter @open-design/daemon typecheck
pnpm --filter @open-design/daemon build
```

Expected: all selected tests, daemon typecheck, and daemon build PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add apps/daemon/src/runtimes/agent-network-cli.ts apps/daemon/src/cli.ts apps/daemon/tests/runtimes/agent-network-cli.test.ts apps/daemon/tests/config-proxy-cli.test.ts apps/daemon/tests/cli-startup.test.ts
git commit -m "feat(cli): manage per-agent proxy settings"
```

---

### Task 7: Prove cross-layer UX, update architecture docs, and run release gates

**Files:**

- Create: `e2e/ui/settings-cli-network-proxy.test.ts`
- Modify: `e2e/ui/visual-settings.test.ts`
- Modify: `e2e/lib/playwright/visual.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/agent-adapters.md`

**Interfaces:**

- Consumes: completed Tasks 1-6.
- Produces: browser-level acceptance evidence and current architecture/user
  documentation; no new runtime interface.

- [ ] **Step 1: Write the Playwright acceptance test before the final UI wiring is considered complete**

Create a flat Playwright file importing `test`/`expect` from
`@/playwright/suite`. Mock both `/api/agents` JSON and streaming SSE, keep a
mutable app-config fixture, and capture `/api/test/connection` requests.

Define the file-local helper with this exact observable surface before the
test:

```ts
import type { Locator, Page } from '@playwright/test';

type AgentFixture = {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version?: string | null;
  models?: Array<{ id: string; label: string }>;
};

type ProxySettingsHarness = {
  appConfigWrites: Record<string, unknown>[];
  connectionBodies: Record<string, unknown>[];
  proxyUrl: Locator;
  password: Locator;
  saveProxy: Locator;
  testConnection: Locator;
  selectAgent: (agentId: string) => Promise<void>;
  selectMode: (label: 'Follow system' | 'Direct' | 'Custom') => Promise<void>;
  mode: (label: 'Follow system' | 'Direct' | 'Custom') => Locator;
  readBrowserConfig: () => Promise<Record<string, unknown>>;
  reloadSettings: () => Promise<void>;
};

async function openProxySettingsHarness(
  page: Page,
  input: { agents: AgentFixture[]; agentNetwork: Record<string, unknown> },
): Promise<ProxySettingsHarness>;
```

Implement it using the existing `openSettingsDialog`, `routeAgents`, mutable
`/api/app-config` route pattern, and complete `?stream=1` terminal `done`
fixture from neighboring Settings tests.

```ts
test('[P1] keeps independent explicit-save proxy drafts for two local CLIs', async ({ page }) => {
  const harness = await openProxySettingsHarness(page, {
    agents: [CODEX_AGENT, CLAUDE_AGENT],
    agentNetwork: {},
  });

  await harness.selectAgent('codex');
  await harness.selectMode('Custom');
  await harness.proxyUrl.fill('http://codex.proxy.test:8080');
  await harness.password.fill('codex-password');
  await harness.testConnection.click();
  expect(harness.connectionBodies.at(-1)).toMatchObject({
    mode: 'agent',
    agentId: 'codex',
    agentNetwork: {
      mode: 'custom',
      proxyUrl: 'http://codex.proxy.test:8080',
      password: 'codex-password',
    },
  });
  expect(harness.appConfigWrites).toHaveLength(0);

  await harness.saveProxy.click();
  await expect.poll(() => harness.appConfigWrites.length).toBe(1);
  expect(JSON.stringify(await harness.readBrowserConfig())).not.toContain('codex-password');

  await harness.selectAgent('claude');
  await harness.selectMode('Direct');
  await harness.saveProxy.click();
  await harness.reloadSettings();
  await harness.selectAgent('codex');
  await expect(harness.proxyUrl).toHaveValue('http://codex.proxy.test:8080');
  await harness.selectAgent('claude');
  await expect(harness.mode('Direct')).toBeChecked();
});
```

The helper named above is local to the test file and must perform complete
per-test setup; do not use `describe.serial`, shared runtime state, or a real
installed CLI.

Extend `e2e/ui/visual-settings.test.ts` with a deterministic custom-proxy
capture that contains no plaintext password. First extend the file-local
`VisualConfig` in `e2e/lib/playwright/visual.ts` with
`agentNetwork?: AgentNetworkPrefs` imported type-only from contracts, so the
visual fixture and product use the same public shape:

```ts
test('[P2] captures the settings local CLI custom proxy surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'codex',
      agentNetwork: {
        codex: {
          mode: 'custom',
          proxyUrl: 'http://proxy.corp.test:8080',
          noProxy: '.corp.test',
          username: 'alice',
          passwordConfigured: true,
        },
      },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);
  const dialog = await prepareVisualSettingsDialog(page);
  await dialog.getByRole('tab', { name: /Local CLI/i }).click();
  await expect(dialog.getByLabel('Proxy URL')).toHaveValue('http://proxy.corp.test:8080');
  await waitForVisualFonts(page);
  await captureVisual(page, 'visual-settings-local-cli-custom-proxy');
});
```

- [ ] **Step 2: Run Playwright to verify RED or expose any missing integration**

Run:

```bash
pnpm --dir e2e exec playwright test -c playwright.config.ts ui/settings-cli-network-proxy.test.ts ui/visual-settings.test.ts --workers=1
```

Expected before final fixes: FAIL at the first missing selector, draft request,
or persistence behavior. If Tasks 1-6 already satisfy it, record that the
acceptance test was introduced GREEN and use its lower-layer RED tests as the
TDD evidence; do not manufacture a failure by breaking completed code.

- [ ] **Step 3: Make only the integration corrections exposed by the browser witness**

Restrict fixes to the owned files from Tasks 4-5. The expected request and
persistence sequence is:

```text
edit custom draft -> no PUT
test draft -> POST /api/test/connection only
save draft -> one PUT /api/app-config with full agentNetwork map
daemon response -> public passwordConfigured view
localStorage -> public view with no password
reload -> GET /api/app-config restores both CLI policies
```

Re-run the same Playwright command after every correction until it passes on
the first attempt.

- [ ] **Step 4: Update current architecture and adapter documentation**

In `docs/architecture.md`, add `agentNetwork[agentId]` beside
`agentModels[agentId]` in Agent switching and state that policies apply on the
next operation only. In `docs/agent-adapters.md`, add a focused Network policy
subsection documenting the three modes, exact env mapping, precedence, local
secret storage/redaction, and the boundary excluding daemon/BYOK traffic.

Use this exact mapping table:

```markdown
| Mode | Child environment | Daemon/BYOK environment |
| --- | --- | --- |
| Follow system | Existing system + inherited proxy precedence | unchanged |
| Direct | all standard proxy variables removed | unchanged |
| Custom HTTP(S) | `HTTP_PROXY` + `HTTPS_PROXY` + normalized `NO_PROXY` | unchanged |
| Custom SOCKS5 | `ALL_PROXY` + normalized `NO_PROXY` | unchanged |
```

- [ ] **Step 5: Run focused full feature suites**

Run:

```bash
pnpm --filter @open-design/platform test
pnpm --filter @open-design/diagnostics test
pnpm --filter @open-design/contracts typecheck
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/web test
pnpm --dir e2e exec playwright test -c playwright.config.ts ui/settings-cli-network-proxy.test.ts ui/visual-settings.test.ts --workers=1
pnpm --filter @open-design/e2e typecheck
```

Expected: all commands PASS with zero failed tests.

- [ ] **Step 6: Run repository-wide handoff gates**

Run from the repository root:

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/daemon build
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints no output.

- [ ] **Step 7: Inspect the final scope and secret literals**

Run:

```bash
git status --short
git diff --stat
rg -n "proxy-password-value|codex-password|write-only-password|http-secret-value" apps packages e2e docs --glob '!**/node_modules/**'
```

Expected: status lists only files named by this plan. Credential-shaped test
fixtures appear only in tests/spec/plan text and never in production defaults,
logs, snapshots, or generated output.

- [ ] **Step 8: Commit Task 7**

```bash
git add e2e/ui/settings-cli-network-proxy.test.ts e2e/ui/visual-settings.test.ts e2e/lib/playwright/visual.ts docs/architecture.md docs/agent-adapters.md
git commit -m "test(e2e): cover per-cli proxy settings"
```

- [ ] **Step 9: Perform final branch verification**

Run:

```bash
git status --short
git log --oneline --decorate -10
```

Expected: the worktree is clean and the feature commits are visible locally.
Do not merge, push, delete a branch, or remove a worktree without separate user
authorization.
