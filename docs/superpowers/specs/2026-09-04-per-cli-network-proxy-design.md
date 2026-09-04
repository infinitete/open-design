# Per-CLI Network Proxy Design

## Status

Approved during brainstorming on 2026-09-04.

## Goal

Allow users to choose an independent network policy for every local CLI in
Settings -> Models & Providers so Open Design remains usable on corporate and
otherwise restricted networks. A CLI may inherit the machine proxy, bypass all
inherited proxies, or use its own HTTP(S) or SOCKS5 proxy.

The policy applies consistently to that CLI's detection, model discovery,
connection test, and future runs. It does not change Open Design's own network
traffic or a CLI process that is already running.

## Current State

Open Design already has most of the lower-level plumbing:

- `agentCliEnv` stores a small allowlisted set of environment overrides per
  CLI. It is intended for executable paths, CLI homes, API credentials, and
  provider base URLs.
- `spawnEnvForAgent` merges the OS proxy, the daemon's inherited environment,
  and configured CLI environment before a child is spawned.
- `packages/platform/src/proxy-env.ts` discovers macOS and Windows system
  proxies and normalizes case variants of `HTTP_PROXY`, `HTTPS_PROXY`,
  `ALL_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY`.
- CLI connection tests and ordinary runs already use the shared runtime launch
  path.

Provider base URLs are not forward proxies. For example,
`ANTHROPIC_BASE_URL` selects an Anthropic-compatible API endpoint, whereas
`HTTPS_PROXY` selects the network hop used to reach an endpoint. The UI and
configuration model must keep those concepts separate.

## Confirmed Product Decisions

1. Every local CLI has three modes: **Follow system**, **Direct**, and
   **Custom**.
2. Custom mode exposes one proxy URL plus an optional bypass list. The URL may
   use `http://`, `https://`, or `socks5://`.
3. HTTP(S) proxy URLs are applied to both HTTP and HTTPS requests. SOCKS5 proxy
   URLs are applied through `ALL_PROXY`.
4. Authenticated proxies are supported with separate username and password
   fields. Users do not put credentials in the proxy URL.
5. The feature covers all built-in local CLIs and user-defined local CLI
   profiles. It is keyed by stable CLI ID rather than a hardcoded subset.
6. A CLI policy affects only that CLI's child-process traffic: detection,
   model discovery, connection testing, and runs. Open Design updates, plugin
   downloads, media generation, BYOK requests, and other daemon traffic keep
   their existing system/daemon network behavior.
7. Proxy credentials use the existing local-secret threat model: they are
   stored under the daemon data root and protected by local file permissions.
   They are not stored in a project, browser `localStorage`, diagnostics,
   analytics, or logs, and are never returned in plaintext by a read API or
   CLI command.

## Configuration Contract

Add a semantic `agentNetwork` map to the shared app-config contract. Entries
are keyed by the runtime's stable CLI ID. Keep three representations so a
stored secret never leaks into the public read shape:

```ts
// Daemon-internal persisted shape; never exported from packages/contracts.
type StoredAgentNetworkPolicy =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      password?: string;
    };

// GET /api/app-config and the browser's in-memory AppConfig shape.
type AgentNetworkPolicyView =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      passwordConfigured: boolean;
    };

// Write shape for entries in UpdateAppConfigRequest.agentNetwork.
type AgentNetworkPolicyUpdate =
  | { mode: 'direct' }
  | {
      mode: 'custom';
      proxyUrl: string;
      noProxy?: string;
      username?: string;
      password?: string;       // write-only replacement
      clearPassword?: true;    // mutually exclusive with password
    };
```

`inherit` is the default and is represented by no entry. Switching a CLI to
Follow system removes its entry. This avoids redundant stored state while
leaving `direct` distinguishable from the default.

`AppConfigPrefs.agentNetwork` uses a map of `AgentNetworkPolicyView` and
`UpdateAppConfigRequest` overrides that field with a map of
`AgentNetworkPolicyUpdate`. The daemon keeps `StoredAgentNetworkPolicy`
private. A custom policy returned from `GET /api/app-config` sets
`passwordConfigured` from the stored value. The web app therefore knows
whether a saved credential exists without receiving it.

`PUT /api/app-config` keeps its top-level partial-update behavior. When an
`agentNetwork` map is supplied, it is the desired full map, with these
write-only secret rules for each retained custom entry:

- omitted password input preserves the existing password;
- a new password replaces the existing password;
- an explicit clear-password signal removes it;
- removing the whole CLI entry also removes its saved password.

An absent `agentNetwork` top-level field leaves all policies unchanged; an
explicit empty map clears them all. Public response-only fields such as
`passwordConfigured` are ignored on write.

Existing installations require no migration. With no `agentNetwork` field,
every CLI follows the current system-proxy behavior. Existing
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and other `agentCliEnv` values keep
their present meaning and are not converted.

## Validation

The daemon is the authoritative validation boundary. The browser and CLI may
provide earlier feedback but may not relax these rules.

- A CLI ID must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Unknown but
  syntactically valid IDs may be stored so temporarily unavailable and custom
  profiles retain their settings; an entry has no effect until that ID is
  selected as a runtime.
- The map accepts at most 128 entries. `proxyUrl` is limited to 2,048
  characters, `noProxy` to 4,096, `username` to 256, and `password` to 1,024.
- A custom policy requires an absolute proxy URL with one of the three
  supported schemes and a host. Paths, query strings, fragments, and embedded
  URL credentials are rejected.
- Private, loopback, and intranet proxy hosts are allowed. This is local
  operator configuration rather than a remote, attacker-selected daemon fetch.
- Control characters are rejected from all values.
- `noProxy` is a comma-separated standard bypass list. A wildcard is preserved;
  otherwise loopback defaults (`localhost`, `127.0.0.1`, and `::1`) are always
  added and de-duplicated.
- A password without a username is rejected. A username with an empty password
  remains valid for proxy servers that support that form.

Validation failures return HTTP 400 with the existing
`INVALID_APP_CONFIG_VALUE` code and a field path rooted at `agentNetwork`.
They leave the previous persisted policy unchanged.

## Runtime Policy Resolution

Introduce one daemon-owned policy resolver close to the runtime spawning
layer. Product DTOs remain out of `packages/platform`; that package continues
to own generic proxy-environment discovery and normalization only.

The resolver receives the selected CLI ID, its saved or draft policy, the
daemon base environment, and the current OS proxy environment. It produces the
environment used by every CLI operation.

### Follow system

No per-CLI entry exists. Preserve the current precedence:

```text
system proxy < daemon inherited environment < allowed CLI environment
```

Later sources win. Existing lowercase/uppercase normalization remains intact.

### Direct

Merge all non-proxy environment as usual, then remove every case variant of:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- `NO_PROXY`
- `NODE_USE_ENV_PROXY`

This is an explicit negative policy. It must not be represented only as
`NO_PROXY=*`, because not every CLI or dependency implements that convention
consistently.

### Custom

Discard inherited proxy endpoint and bypass variables, then apply the custom
policy last:

- `http://` or `https://`: set both `HTTP_PROXY` and `HTTPS_PROXY`;
- `socks5://`: set `ALL_PROXY`;
- set normalized `NO_PROXY` with the required loopback additions;
- set `NODE_USE_ENV_PROXY=1`;
- emit lowercase aliases on POSIX through the existing platform helper.

The resolver URL-encodes the separate username and password into the proxy URL
only in the in-memory child environment. The combined credential URL is never
persisted or logged.

Policy lookup is by the effective runtime ID. The existing
`byok-opencode -> opencode` alias applies only to `agentCliEnv`; BYOK provider
traffic is explicitly outside this feature and must not inherit OpenCode's
per-CLI network policy accidentally.

Every spawn-like path must use the same resolver. This includes executable
and auth probes that launch the CLI, dynamic model listing, the Settings
connection test, headless runs, ordinary chat runs, retries, and resumptions.
Binary path inspection that performs no child network activity does not need a
proxy environment.

Policies are evaluated at operation start. Saving a change does not mutate or
restart an already running child process.

## Settings UX

Settings -> Models & Providers -> Local CLI shows a Network Proxy area for the
currently selected CLI. It is present for every runtime/profile, even when
that CLI has no existing `AGENT_CLI_ENV_FIELDS` entry.

The area contains:

- a three-way Follow system / Direct / Custom mode control;
- in Custom mode, proxy URL, bypass addresses, username, and masked password;
- concise protocol examples and a note that the setting affects only the
  selected CLI;
- a saved-password indicator plus an explicit Clear password action.

Changing the selected CLI swaps to that CLI's independent draft. The draft is
not copied to another CLI. Follow system is initially selected for legacy and
unconfigured profiles.

The existing advanced CLI settings remain responsible for provider base URLs,
homes, config directories, API keys, and binary paths. Copy and labels must no
longer describe provider base URLs as network proxies.

The existing Test connection action sends the currently visible draft policy,
including a write-only new password when one was entered. If the password
field is untouched and `passwordConfigured` is true, the daemon uses the saved
password for the test. A test never persists the draft. A successful test does
not imply that Settings was saved.

Saving uses the existing app-config endpoint. A rejected save leaves the
dialog open with its draft and displays an actionable error. The app-wide
configuration is updated only from the daemon's accepted response, preventing
the UI from claiming a policy is active after a failed write.

Proxy passwords are component-local draft state. They are omitted by the
web config serializer and never written to browser `localStorage`.

## `od` CLI Surface

Extend the existing `od config` capability rather than adding a parallel
configuration store:

```text
od config proxy get <cli-id> [--json]
od config proxy set <cli-id> --mode <inherit|direct|custom> [options] [--json]
od config proxy test <cli-id> [--json]
od config proxy unset <cli-id> [--json]
```

Custom options are `--url`, `--no-proxy`, `--username`,
`--password-file <path|->`, and `--clear-password`. Reading a password from
stdin or a file keeps it out of shell history. `--password` is deliberately
not supported.

`get` and all JSON output expose only `passwordConfigured`, never the
credential. `set --mode inherit` and `unset` are equivalent. When updating an
existing custom policy, omitted ordinary fields retain their current public
values; a newly created custom policy requires `--url`. Omitted password input
preserves the saved password and `--clear-password` removes it.

`test` invokes the same agent connection-test endpoint as the Settings UI and
tests the saved policy. It does not persist anything. This capability takes no
model prompt, so a prompt-file option is not applicable; password stdin uses
the purpose-specific `--password-file -` contract.

## HTTP and Secret Boundaries

`/api/app-config` remains the persistence endpoint used by both web Settings
and `od config`. Its GET and successful PUT responses pass the config through
an `agentNetwork` public-view mapper that removes proxy passwords. Internal
daemon consumers continue to read the persisted form.

The connection-test request gains an optional draft network policy for the
selected CLI. The daemon validates it with the same parser as persisted
config, resolves a saved password only when the draft explicitly says to keep
it, and passes the resulting environment only to the spawned test CLI.

The daemon stores the password in its existing data-root app configuration,
not a project or repository. Atomic app-config writes must create the
temporary file with POSIX mode `0600` and ensure the renamed destination is
owner-readable/writable only; Windows relies on the user's data-directory
ACL. This applies to the whole existing app-config file, which already stores
other local CLI secrets. Diagnostics exporters, app-config debug output,
analytics, and error serializers must add this field to their secret-redaction
coverage.

No code should log a full proxy URL after credentials have been attached.
User-facing diagnostics may show the scheme and redacted host/port only.

## Error Handling

Configuration errors are detected before persistence or spawn and identify
the field without echoing its value. Examples include an unsupported scheme,
missing custom URL, credentials embedded in the URL, password without a
username, or an over-limit bypass list.

Connection failures stay attached to the existing test/run result and retain
the runtime phase. Proxy authentication failure, connection refusal, DNS
failure, and timeout may be classified when the selected CLI provides a
recognizable signal; otherwise the original redacted CLI error is returned.
Open Design must not report a test as successful merely because the proxy
socket accepted a connection: assistant output from the real CLI smoke request
remains the success condition.

A CLI that ignores standard proxy variables is not marked compatible by
declaration. The UI explains that behavior depends on the selected CLI and the
connection test supplies the observable result.

## Component Boundaries

- `packages/contracts` owns public app-config and connection-test DTOs.
- `packages/platform` owns generic proxy env keys, normalization, stripping,
  system discovery, and deterministic merge helpers. It does not import app or
  runtime configuration types.
- `apps/daemon/src/app-config.ts` owns persisted-policy validation,
  secret-preserving updates, public redaction, and data-root persistence.
- A focused module under `apps/daemon/src/runtimes/` owns the per-CLI policy to
  child-environment translation. `spawnEnvForAgent` remains the single final
  environment assembly path.
- Existing detection, model, connection-test, and run modules pass the policy
  through rather than reimplementing it.
- `apps/web/src/components/SettingsDialog.tsx` owns the user workflow and
  component-local password draft. Shared web config/types own only the public
  non-secret state.
- `apps/daemon/src/cli.ts` owns `od config proxy` parsing and uses the existing
  HTTP endpoints rather than reading config files directly.

No new top-level daemon source file is introduced. Cross-app behavior tests
belong in `e2e/` and must follow that layer's `AGENTS.md` before implementation.

## Testing Strategy

Implementation follows RED -> minimal implementation -> GREEN at the cheapest
layer that proves each contract.

### Contract and persistence

- Accept direct and valid custom policies; default missing entries to inherit.
- Reject malformed IDs, maps over the count limit, oversized/control-character
  values, unsupported schemes, URL credentials, and invalid credential pairs.
- Preserve, replace, and explicitly clear an existing password correctly.
- Clear an entry when switching to inherit and clear all on an explicit empty
  map.
- Prove GET and PUT responses, logs, diagnostics, and CLI JSON never expose a
  password.
- Prove the browser config serializer never writes a proxy password to
  `localStorage`.

### Runtime resolver

- Cover all three modes and left-to-right precedence.
- Cover uppercase/lowercase inherited variable variants on Windows and POSIX.
- Prove Direct removes all endpoint, bypass, and Node proxy flags while
  preserving unrelated environment variables.
- Prove HTTP(S) and SOCKS5 mappings, loopback bypass augmentation, wildcard
  bypass, de-duplication, and credential URL encoding.
- Prove a custom policy does not change the daemon process environment or BYOK
  dispatcher.

### Daemon integration

Use fake CLIs that record a sanitized environment to prove detection/model
listing, connection testing, and real run spawning receive the same effective
policy. Include built-in and custom-profile IDs. Retries and resumed runs must
resolve the current policy at the start of the new operation.

### Web and CLI

- Web component tests cover per-CLI draft isolation, mode transitions, saved
  password keep/replace/clear behavior, validation, and save rejection.
- CLI tests cover get/set/test/unset, merge behavior, password file/stdin,
  noninteractive errors, exit codes, and human/JSON redaction.
- A Playwright test configures different policies for two CLIs in Models &
  Providers, switches between them, saves, reloads, and observes the correct
  independent state.

Parser or provider calls are not required for this feature's tests. Use fake
runtime executables and existing replay mocks; do not spend provider budget.

## Acceptance Criteria

1. A user can configure Follow system, Direct, or Custom independently for any
   built-in or custom local CLI profile.
2. HTTP(S), SOCKS5, bypass addresses, and separately entered proxy credentials
   produce the specified child environment.
3. Detection, model discovery, connection tests, and new runs for one CLI use
   its policy; other CLIs and daemon-owned network traffic do not.
4. Direct mode defeats inherited/system proxy variables reliably.
5. Existing installations and existing `agentCliEnv` provider-base-url fields
   retain their current behavior without migration.
6. Proxy passwords remain local, never enter browser persistence, and never
   appear in public config responses, CLI output, logs, analytics, or
   diagnostics.
7. Settings and `od config proxy` operate through the same daemon contracts and
   report rejected saves/tests accurately.
8. Required repository gates pass: `pnpm guard`, `pnpm typecheck`, focused
   package/app tests, and the scoped Playwright suite.

## Out of Scope

- Changing daemon-wide proxy settings or Open Design's own outbound traffic.
- Applying per-CLI policy to BYOK, media providers, updates, plugins,
  connectors, or downloads.
- PAC files, automatic proxy discovery beyond the existing OS integration,
  proxy chaining, SSH tunnels, TLS interception certificate management, or
  per-destination routing beyond `NO_PROXY`.
- Per-project or per-conversation proxy policies.
- Restarting or mutating a CLI process that is already running.
- Claiming compatibility for a CLI that ignores the standard proxy environment
  variables.
- Adding an OS keychain abstraction in the first release.
