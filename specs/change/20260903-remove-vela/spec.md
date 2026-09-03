---
id: 20260903-remove-vela
name: Remove Vela Integrations
status: proposed
created: '2026-09-03'
---

## Overview

### Problem Statement

Open Design still ships Vela CLI binaries and retains active Vela/AMR behavior
across the daemon, web application, packaged runtime, platform packagers, and
release scripts. The repository has otherwise moved to a single-player local
product, so these cloud-specific paths add install weight, platform failures,
stale UI, and a large compatibility surface that the product no longer wants
to support.

### Goals

- Remove every active Vela and AMR product capability.
- Stop shipping, resolving, invoking, or validating Vela CLI on macOS,
  Windows, Linux AppImage, Linux deb, and Linux headless distributions.
- Remove AMR agent selection, login, model discovery, billing, media
  generation, analytics mirroring, and dedicated recovery behavior.
- Remove matching web UI, daemon API, configuration, prompts, error codes,
  packaging flags, release inputs, and maintained tests.
- Migrate active preferences away from removed providers without deleting
  projects, generated files, or historical runs.
- Preserve only the minimum read compatibility needed to display historical
  records that already identify `amr` or Vela.

### Non-Goals

- Do not remove other local agent CLIs or BYOK providers.
- Do not remove non-Vela media providers or general media generation.
- Do not rewrite, delete, or relabel historical run and analytics records.
- Do not substitute another paid agent or media model for Vela automatically.
- Do not retain hidden feature flags, disabled routes, no-op Vela adapters, or
  compatibility stubs that could reactivate the integration.

### Success Criteria

- No supported build or runtime contains a Vela executable, Vela package,
  active `amr` agent definition, `vela/*` media model, or Vela network call.
- New app configuration cannot select `amr` or store AMR-specific model/env
  preferences.
- Existing app configuration selecting `amr` is normalized to no selection;
  existing project metadata selecting `vela/*` has that model field removed.
- Historical runs remain readable and keep their original identifiers.
- All affected package tests/builds, `pnpm guard`, and `pnpm typecheck` pass.
- Real macOS and Linux packaged artifacts and Windows packaging manifests prove
  that Vela resources and local resolver dependencies are absent.

## Design

### Removal Boundary

The change removes active Vela behavior from four connected layers in one PR:

1. **Product runtime:** remove the AMR runtime definition, Vela command
   integration, login/account/model/billing paths, Vela media adapters,
   Vela-specific child evidence, and Vela analytics delivery.
2. **Public surfaces:** remove AMR/Vela web controls, status and recovery UI,
   active API DTOs/routes, media catalogue entries, prompt instructions, and
   active analytics emission.
3. **Distribution:** remove Vela CLI resolution, validation, binary and
   companion-tree copying, CLI flags, environment forwarding, container
   mappings, package dependencies, and release-script prerequisites on every
   platform.
4. **Migration:** retire active selections while preserving historical facts.

Deleting only the package dependency is insufficient because it leaves runtime
paths that fail after installation. Hiding UI is also insufficient because
daemon APIs and stored configuration could still invoke the integration.

### Runtime and API Design

- Remove `amrAgentDef` from the shipped runtime registry and delete its runtime
  definition and model/billing probes.
- Delete daemon Vela command, authentication, account, analytics, child
  evidence, and media modules once all callers are removed.
- Remove AMR/Vela route dependencies and branches from composition roots,
  run creation/resume, connection tests, diagnostics, and analytics lifecycle.
- Remove dedicated AMR/Vela API shapes and error codes when they are not needed
  to decode historical persisted state.
- Requests to removed endpoints receive the normal unmatched-route 404.
- Requests naming `amr` or `vela/*` through surviving generic endpoints fail
  through the existing unknown-agent or unsupported-model validation; no new
  Vela-specific fallback is added.

### Web and Contract Design

- Remove AMR account/login/plan/balance controls, model-switcher entries,
  reminders, Cloud links, status polling, and Vela-specific recovery actions.
- Remove `vela/*` choices from image and video catalogues while preserving all
  other providers and generic media workflows.
- Remove active AMR/Vela configuration and analytics types from shared
  contracts together with their consumers.
- Historical DTO fields or enum literals may remain only where removing them
  would make an existing stored run unreadable. They must not be accepted by
  new configuration, emitted by new analytics, or appear in selectable UI.

### Configuration and Data Migration

- Add `amr` to the daemon's retired agent set so app-config reads and writes
  remove `agentId`, `agentModels.amr`, `agentCliEnv.amr`, and
  `agentCliEnvIntent.amr`.
- Normalize project metadata transactionally during daemon database startup.
  For valid JSON objects, remove `imageModel` or `videoModel` only when the
  value begins with `vela/`. Preserve every other metadata field byte-for-byte
  in meaning and leave invalid JSON untouched for existing diagnostics.
- The migration is idempotent and does not replace a removed selection with a
  paid provider. The next UI read displays the normal unselected/default state.
- Historical run, conversation, message, event, and analytics rows are not
  rewritten or deleted. Read paths may render legacy `amr` identifiers as
  plain historical labels without offering actions.

### Packaging and Release Matrix

| Platform | Required removal |
| --- | --- |
| macOS | Vela dependency resolution, binary copy, strict validation, bundled resource, and build flag |
| Windows | Vela resource planning/copy, companion OpenCode tree, installer payload entry, and build flag |
| Linux AppImage | Vela copy, packaged resource, and build flag |
| Linux deb | Any inherited Vela resource or package input |
| Linux headless | Vela environment forwarding and installed resource lookup |
| Containerized Linux | Host binary mount and `OPEN_DESIGN_VELA_CLI_BIN` remapping |
| Release automation | Vela environment checks, downloads, strict flags, and platform-package lock entries |

Remove `@powerformer/vela-cli` from `tools/pack/package.json` and regenerate the
lockfile so all platform-specific Vela binary packages disappear. Remove the
`--require-vela-cli` option rather than leaving an ignored compatibility flag.

### Error and Compatibility Behavior

- Stale app configuration is repaired locally and silently because the user
  cannot act on a retired provider.
- A stale Vela media selection is cleared without deleting the project or its
  generated artifacts. A future render requires choosing a supported model.
- Historical failed AMR runs remain inspectable; retry/resume actions that
  would relaunch AMR are not offered.
- No Vela network request, device login, background poll, child process, or
  analytics mirror may run after startup.
- Removal must fail closed: any remaining active import, registry entry,
  packaged resource, CLI option, or release input is a test failure.

### Test Strategy

Implementation follows red-green tests at the cheapest layer that observes
each contract:

- tools-pack tests first prove all platform builds omit Vela resources,
  options, and dependency resolution;
- daemon tests prove `amr` is absent from the runtime registry, stale app
  preferences are normalized, Vela project metadata is migrated idempotently,
  and generic validation rejects removed identifiers;
- web tests prove AMR/Vela controls and media choices are absent while local
  agent, BYOK, and non-Vela media paths remain available;
- contracts tests prove active unions and prompts no longer advertise Vela;
- release-script tests prove no platform lane requests a Vela binary;
- source-boundary tests reject new active Vela imports or packaging references,
  with an explicit allowlist limited to historical compatibility and archival
  documentation;
- package-scoped tests/typechecks/builds run for daemon, web, packaged,
  contracts, tools-pack, and tools-release;
- final gates run `pnpm guard` and `pnpm typecheck`;
- real macOS and Linux artifacts are inspected for absence of Vela binaries;
  Windows manifests/payload tests provide the equivalent deterministic proof.

### Delivery

This removal is independent of the macOS installed-data fix and lands on its
own `refactor/remove-vela` branch. It does not merge, push, install, or delete
another worktree without separate authorization.
