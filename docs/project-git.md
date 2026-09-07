# Project Git versioning

Project Git versions an Open Design **user project**, not the Open Design source
checkout. Each enabled project owns one repository and one target branch. The web
project status bar and `od git` use the same daemon HTTP API.

## Start and connect

New supported projects initialize local versioning automatically when system Git
and a Git author identity are available. Existing database projects remain opt-in:
open **Version settings**, preview enabling, then confirm. Missing Git or identity
leaves initialization pending without blocking project creation or ordinary edits.
Install/configure Git yourself; Open Design does not install it or change your
account credentials. The currently unsupported Orbit portable subtype also remains
pending; do not interpret that state as a complete checkpoint.

In **Version settings**, enter an HTTPS or SSH repository URL and branch, inspect
the connection preview, then confirm that exact preview. Empty, compatible, plain
and incompatible repositories have different preview outcomes; a detected remote
is not already a binding. To use another computer, choose **Open from Git** or:

```bash
od git status --project PROJECT_ID --json
od git enable --project EXISTING_PROJECT_ID --json
od git enable --project EXISTING_PROJECT_ID --preview ENABLE_PREVIEW_ID --json
od git bind-preview --project PROJECT_ID --url ssh://git@example.com/team/design --branch main --json
od git bind --project PROJECT_ID --preview PREVIEW_ID --json
od git open --url ssh://git@example.com/team/design --branch main --json
```

Use the host's normal noninteractive Git authentication. Do not put passwords or
tokens in repository URLs. Local filesystem transports, repository hooks, filters,
recursive submodules and repository-provided executable helpers are not enabled by
this feature. Required missing resource bytes stop complete recovery; LFS payloads
and submodule contents are not automatically fetched or installed.

## Saving and synchronization

Manual edits checkpoint after five seconds of quiet. Agent success, failure and
cancellation settle only after project writers, messages and files settle. No
semantic change means no new checkpoint. The daemon checks remotes every sixty
seconds even with the page closed. Network retries back off through five seconds,
thirty seconds, two minutes and five minutes, with jitter.

**Pause** stops automatic remote synchronization, not local checkpoints. **Sync
now** performs one synchronization. Unbinding disconnects the remote; it does not
erase local history. Authentication/offline errors leave local history available
and must not be read as a successful remote save. “Synced” requires a confirmed
remote reference, not merely a successful local commit.

Closing a page does not stop the daemon. Exiting the daemon does stop background
checking until it starts again and finishes recovery.

```bash
od git pause --project PROJECT_ID --json
od git sync --project PROJECT_ID --json
od git resume --project PROJECT_ID --json
od git unbind --project PROJECT_ID --json
od git operation OPERATION_ID --json
```

Mutating CLI commands support `--prompt-file FILE` or `--prompt-file -` for JSON
input and `--idempotency-key KEY`; accepted work is polled to a public operation
result. Reads support `--json`. Use `od git --help` for the full command list.

Raw HTTP differs from CLI output: a mutation returns HTTP202 with
`{"operationId":"..."}`. Poll `GET /api/project-git-operations/OPERATION_ID` until
the operation succeeds, fails or requires user action. A successful preview is at
`result.preview`; use its `id` in the confirmation request, retaining its original
revision/basis. The CLI performs this polling and prints the **operation** (`id`,
`status`, `result`), not the initial202 envelope. A preview operation succeeding
does not itself enable, bind or restore the project.

## History, restore and conflicts

Open **History** to inspect commits, files and conversations. Restore first creates
a preview tied to the current project/content revisions and Git heads. Confirming
creates a **new child commit of the current HEAD**: intervening history remains.
It protects dirty content rather than resetting the branch or clearing your index.
If the basis changes, obtain a fresh preview; never relabel an old request with a
new revision. Old editor saves and task starts are rejected with HTTP409
`PROJECT_STATE_CHANGED` after the project epoch changes.

A complete portable version restores supported settings and chat as well as files.
A plain **file version** restores files while retaining current settings and chat;
the preview identifies this distinction. Older HTML-only history remains visible
as legacy history and can be migrated without pretending it contains complete
conversation records. Pause external editors while a restore is being applied.

```bash
od git log --project PROJECT_ID --json
od git show --project PROJECT_ID --commit OID --conversations --json
od git restore-preview --project PROJECT_ID --commit OID --json
od git restore --project PROJECT_ID --preview PREVIEW_ID --json
od git conflicts --project PROJECT_ID --json
```

For a resolution, save the original conflict basis and choices to `resolution.json`
(substitute the actual OIDs, revisions and IDs; do not reuse these example values):

```json
{
  "expectedProjectRevision": 4,
  "basis": {
    "projectRevision": 4,
    "contentRevision": 9,
    "localHead": "1111111111111111111111111111111111111111",
    "remoteHead": "2222222222222222222222222222222222222222",
    "bindingGeneration": 2
  },
  "resolutions": [
    { "conflictId": "CONFLICT_ID", "kind": "select", "selectedSide": "remote" }
  ]
}
```

```bash
od git resolve --project PROJECT_ID --operation CONFLICT_OPERATION_ID --prompt-file resolution.json --json
```

Conflict review shows base, local and remote values. Select an explicit resolution
and submit its original conflict basis. Chat conflicts are structured records;
conflict markers are not injected into message text. A remote history rewrite is
not authorization to force-push or discard either side. Protected references and
recovery state retain evidence for an explicit next action.

## Portable project content

The tracked `.open-design` format has `schemaVersion: 1`. It carries project
settings, conversation/message records, safe historical display context, structured
comments, historical forms and resource bytes alongside project files. Metadata ID
path segments are `id-` plus SHA-256 of the canonical JSON original ID; JSON retains
the original IDs. Resource digests have nonempty `locations` preserving every
declared purpose/path/source-label alias, including several uses of identical bytes.

Restored messages display their original text and safe adjuncts through normal
chat, including images and historical feedback rating/reasons/timestamps. Historical
question forms and task events are read-only: they cannot resume a run, submit old
answers, apply selectors/styles, grant plugin permissions or replay telemetry.
Live database edits and cleared feedback remain authoritative. Declared plugin
display assets are frozen as inert bytes; historical plugins are not activated.

SQLite databases, credentials, native run handles, plugin trust/capabilities,
telemetry delivery state and machine-specific source directories are not portable
project content. Required dependencies must exist and pass path/byte validation;
an incomplete archive is not described as complete recovery.

## Recovery and external editors

You can commit from another computer or external editor. Open Design checks Git
state and content digests before applying changes; do not modify its protected
references or recovery files. Two local daemons cannot own the same Git common
directory and branch as simultaneous writable bindings.

Materialization has separate preparation, protection, file, database, reference
and index stages. Git, SQLite and the filesystem are **not one atomic transaction**.
After interruption, startup recovers the durable journal before admitting writes.
If recovery remains blocked, retain the repository and diagnostics and follow the
reported next step; do not hard-reset, force-push, delete lock files blindly or
recursively clear the workspace. Retrying acknowledged work must not manufacture
duplicate commits.

The daemon data-directory authority remains the root `AGENTS.md`; this feature
does not introduce another data root. See [architecture](architecture.md) for the
service boundary and [Quickstart](../QUICKSTART.md) for lifecycle commands.
