import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeProxyAwareEnv, resolveSystemProxyEnv } from '@open-design/platform';
import { resolveProjectRelativePath } from '../home-expansion.js';
import type { StoredAgentNetworkPolicy } from '../storage/agent-network-config.js';
import { applyAgentNetworkPolicy } from './network-policy.js';
import { expandConfiguredEnv } from './paths.js';
import { resolveProjectRootFromNestedModule } from '../project-root.js';
import {
  applySandboxRuntimeEnv,
  isSandboxModeEnabled,
  resolveSandboxRuntimeConfig,
  type SandboxRuntimeConfig,
} from '../sandbox-mode.js';

type RuntimeEnvMap = NodeJS.ProcessEnv | Record<string, string>;
type SpawnEnvOptions = {
  resolvedBin?: string | null;
  networkPolicy?: StoredAgentNetworkPolicy;
};

const RUNTIME_MODULE_PROJECT_ROOT = resolveProjectRootFromNestedModule(
  path.dirname(fileURLToPath(import.meta.url)),
);

// Build the env passed to spawn() for a given agent adapter.
//
// Auth/config precedence for Local CLI launches:
//
// 1. Provider BYOK is separate. It is used by OpenDesign's direct provider
//    API calls and is not automatically mapped into Local CLI launches.
// 2. The inherited launch env represents the user's local CLI setup
//    (OAuth/login files, CLI homes, or user-owned API-key env). Preserve it
//    so Claude Code/Codex behave like they do in the user's terminal.
// 3. `configuredEnv` comes from Settings -> Local CLI ->
//    "Advanced: proxy & custom paths". It is an explicit low-level CLI env
//    override, so it wins over inherited env, including API-key variables.
//    BASE_URL is optional: when omitted, the underlying CLI uses its own
//    official default endpoint.
export function spawnEnvForAgent(
  agentId: string,
  baseEnv: RuntimeEnvMap,
  configuredEnv: unknown = {},
  systemProxyEnv: RuntimeEnvMap = resolveSystemProxyEnv(),
  options: SpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  const sandboxRuntime = sandboxRuntimeConfigForBaseEnv(baseEnv);
  const expandedConfiguredEnv = expandConfiguredEnv(configuredEnv);
  const env = mergeProxyAwareEnv(
    process.platform,
    systemProxyEnv,
    baseEnv,
    expandedConfiguredEnv,
  );
  if (agentId === 'claude') {
    return finalizeRuntimeEnv(env, sandboxRuntime, options.networkPolicy);
  }
  if (agentId === 'codex') {
    // Name the rollout root the codex CLI is about to write into. Child
    // evidence is read back from `<CODEX_HOME>/sessions/.../rollout-*.jsonl`,
    // and `collectCodexChildEvidence` deliberately refuses a homedir fallback
    // so it can never attribute one install's sessions to another. That leaves
    // the caller owing it an explicit root — which nothing supplied, so the
    // collector's `CODEX_HOME` guard was false on every default install and a
    // complex Run's native Children went unobserved. The plan still locked
    // complex, then failed certification for evidence the daemon simply never
    // looked for.
    if (!env.CODEX_HOME?.trim()) {
      const home = os.homedir();
      if (home) env.CODEX_HOME = path.join(home, '.codex');
    }
    return finalizeRuntimeEnv(env, sandboxRuntime, options.networkPolicy);
  }
  if (agentId === 'opencode' || agentId === 'byok-opencode') {
    stripKeysCaseInsensitive(env, [
      'OPENCODE',
      'OPENCODE_PID',
      'OPENCODE_RUN_ID',
      'OPENCODE_SERVER_PASSWORD',
    ]);
    // OpenCode is bun-based and, left to its defaults, walks up from its cwd to
    // the nearest project root and runs `bun install` there at startup to set up
    // local plugins. When that root is a pnpm workspace (the daemon's own repo,
    // or a project nested inside it), the install replaces the pnpm `.pnpm` store
    // with a bun `node_modules/.bun` + `bun.lock` and breaks the workspace.
    // Disable project-config discovery (and its install) so OpenCode only honors
    // the config the daemon injects via OPENCODE_CONFIG_CONTENT.
    if (!env.OPENCODE_DISABLE_PROJECT_CONFIG?.trim()) {
      env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
    }
    return finalizeRuntimeEnv(env, sandboxRuntime, options.networkPolicy);
  }
  if (agentId === 'mimo') {
    stripKeysCaseInsensitive(env, [
      'MIMOCODE',
      'MIMOCODE_PID',
      'MIMOCODE_RUN_ID',
      'MIMOCODE_SERVER_PASSWORD',
    ]);
    // MiMo builds on the same toolchain as OpenCode and has the same
    // workspace-corruption risk when project-config discovery walks up from
    // cwd to a pnpm workspace root and runs its own install. Disable it so
    // MiMo only honors the config injected through MIMOCODE_CONFIG_CONTENT.
    if (!env.MIMOCODE_DISABLE_PROJECT_CONFIG?.trim()) {
      env.MIMOCODE_DISABLE_PROJECT_CONFIG = 'true';
    }
    return finalizeRuntimeEnv(env, sandboxRuntime, options.networkPolicy);
  }
  return finalizeRuntimeEnv(env, sandboxRuntime, options.networkPolicy);
}

function sandboxRuntimeConfigForBaseEnv(
  baseEnv: RuntimeEnvMap,
): SandboxRuntimeConfig | null {
  if (!isSandboxModeEnabled(baseEnv)) return null;
  const dataDir = baseEnv.OD_DATA_DIR?.trim();
  if (!dataDir) return null;
  const resolvedDataDir = resolveProjectRelativePath(
    dataDir,
    RUNTIME_MODULE_PROJECT_ROOT,
  );
  return resolveSandboxRuntimeConfig(true, resolvedDataDir);
}

function reapplySandboxRuntimeEnv(
  env: NodeJS.ProcessEnv,
  sandboxRuntime: SandboxRuntimeConfig | null,
): NodeJS.ProcessEnv {
  if (!sandboxRuntime) return env;
  return applySandboxRuntimeEnv(env, sandboxRuntime);
}

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

function sanitizeProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const val = env[key];
    if (typeof val === 'string' && val.trim() && !val.includes('://')) {
      env[key] = `http://${val.trim()}`;
    }
  }
}

function stripKeysCaseInsensitive(
  env: NodeJS.ProcessEnv,
  keysToStrip: readonly string[],
): void {
  const keysUpper = new Set(keysToStrip.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (keysUpper.has(key.toUpperCase())) delete env[key];
  }
}

function applyWindowsUserCacheEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'win32') return;

  // GUI-launched Windows daemons can inherit enough PATH to resolve a CLI
  // while still missing the profile/cache variables CLIs use at startup.
  const userProfile =
    envValue(env, 'USERPROFILE') ||
    envValue(env, 'HOME') ||
    os.homedir();
  if (!userProfile) return;

  setEnvIfMissing(env, 'USERPROFILE', userProfile);
  const localAppData =
    envValue(env, 'LOCALAPPDATA') ||
    path.win32.join(userProfile, 'AppData', 'Local');
  setEnvIfMissing(env, 'LOCALAPPDATA', localAppData);
  setEnvIfMissing(
    env,
    'APPDATA',
    path.win32.join(userProfile, 'AppData', 'Roaming'),
  );
  const tempDir = path.win32.join(localAppData, 'Temp');
  setEnvIfMissing(env, 'TEMP', tempDir);
  setEnvIfMissing(env, 'TMP', tempDir);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const existingKey = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  const value = existingKey ? env[existingKey] : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? (value as string) : null;
}

function setEnvIfMissing(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  if (envValue(env, key)) return;
  const existingKey = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  env[existingKey ?? key] = value;
}
