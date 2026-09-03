// Shared logic that maps a failed run's error code + agent into the failure
// UI: which contextual button the gray error card shows and whether to
// override the error text. Kept in its own module so ChatPane / ProjectView /
// AssistantMessage can import it without a circular dependency.
import {
  isModelWindowLimitFailure,
  readMembershipConcurrencyResetAt,
  readModelWindowResetAt,
} from '@open-design/contracts';

// Primary action offered in the gray error card.
//   - retry:                       re-run with the current agent.
//   - launch-terminal-auth:        Antigravity-specific. agy's `-p`
//                                  print mode cannot complete Google
//                                  Sign-In on its own (no input field
//                                  for the auth code), so OD spawns a
//                                  system Terminal running `agy` and
//                                  the user finishes OAuth there.
//   - launch-terminal-switch-model: Antigravity-specific. agy has no
//                                  `--model` flag (upstream #35), so
//                                  switching to a model with available
//                                  quota means opening agy's TUI and
//                                  using its Switch Model picker. The
//                                  daemon spawns the same terminal as
//                                  launch-terminal-auth — the button
//                                  label is the only thing that changes.
// Both terminal-launch actions pair with `secondaryRetry: true` so the
// user has a Retry button after the external step completes (OAuth /
// switching models happens out-of-band; we can't auto-retry from the
// daemon side).
export type RunFailurePrimaryAction =
  | 'retry'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model'
  // No self-contained recovery button. Used when retrying is futile (e.g. a
  // hard quota / exhausted credits), so the card shows guidance copy without
  // a dead Retry.
  | 'none';

// i18n keys for the gray-card text override (null = show the raw error).
// Keys ending in a value with `{agent}` are interpolated at render time via
// t(key, { agent }) (see ChatPane displayError)
export type RunFailureMessageKey =
  | 'chat.connectionDropped'
  | 'chat.runError.signInMessage.other'
  | 'chat.runError.cliMissingMessage'
  | 'chat.runError.promptTooLargeMessage'
  | 'chat.runError.modelUnavailableMessage'
  | 'chat.runError.rateLimitedMessage'
  | 'chat.runError.modelWindowLimitMessage'
  | 'chat.runError.modelWindowLimitMessageNoTime'
  | 'chat.runError.membershipConcurrencyLimitMessage'
  | 'chat.runError.membershipConcurrencyLimitMessageNoTime'
  | 'chat.runError.upstreamUnavailableMessage'
  | 'chat.runError.toolLoopMessage'
  | 'chat.runError.outputInvalidMessage'
  | 'chat.runError.runtimeConfigMessage'
  | 'chat.runError.quotaExhaustedMessage'
  | 'chat.runError.workspaceCreditsMessage'
  | 'chat.runError.timedOutMessage'
  | 'chat.runError.inactivityTimeoutMessage'
  | 'chat.runError.emptyOutputMessage'
  | 'chat.runError.sessionExpiredMessage'
  | 'chat.runError.gitBashMissingMessage'
  | 'chat.runError.cpuUnsupportedMessage'
  | 'chat.runError.cliSessionRefusedMessage'
  | 'chat.runError.strategyTaskStateMismatchMessage'
  | null;

// i18n keys for the unified error card's TITLE (the "error type" line above the
// detail message). Frontend-only mapping from error code → human-readable type;
// the daemon does not yet emit a type name (the raw status label is just the
// word "error"). A full backend type ⇄ frontend pairing is a later effort.
export type RunFailureTitleKey =
  | 'chat.runError.title.connectionDropped'
  | 'chat.runError.title.signInRequired'
  | 'chat.runError.title.rateLimited'
  | 'chat.runError.title.modelWindowLimit'
  | 'chat.runError.title.membershipConcurrencyLimit'
  | 'chat.runError.title.cliMissing'
  | 'chat.runError.title.promptTooLarge'
  | 'chat.runError.title.modelUnavailable'
  | 'chat.runError.title.upstreamUnavailable'
  | 'chat.runError.title.toolLoop'
  | 'chat.runError.title.outputInvalid'
  | 'chat.runError.title.runtimeConfig'
  | 'chat.runError.title.quotaExhausted'
  | 'chat.runError.title.timedOut'
  | 'chat.runError.title.emptyOutput'
  | 'chat.runError.title.sessionExpired'
  | 'chat.runError.title.gitBashMissing'
  | 'chat.runError.title.artifactMissing'
  | 'chat.runError.title.cpuUnsupported'
  | 'chat.runError.title.cliSessionRefused'
  | 'chat.runError.title.strategyTaskHalted'
  | 'chat.runError.title.generic';

export interface RunFailureUi {
  primaryAction: RunFailurePrimaryAction;
  // Title shown above the detail message — names the failure type.
  titleKey: RunFailureTitleKey;
  // Override the gray error card's text (e.g. quota failures get a clearer
  // explanation than the raw upstream string).
  messageKey: RunFailureMessageKey;
  // Interpolation values for `messageKey`, for the cases whose copy names
  // something the daemon read off the failure (e.g. when a rolling model window
  // reopens). Absent for every message that is a fixed sentence.
  messageVars?: Record<string, string>;
  // Show a secondary plain "retry" button alongside the primary action (used
  // by the terminal-launch cases, where retry is manual after the external
  // step completes).
  secondaryRetry: boolean;
}

/**
 * The two window-limit message keys, narrowed away from `RunFailureMessageKey`
 * (which includes `null` for the cases that keep the raw upstream string) so
 * callers can hand the result straight to `t()` without a non-null assertion.
 */
export type ModelWindowLimitMessageKey =
  | 'chat.runError.modelWindowLimitMessage'
  | 'chat.runError.modelWindowLimitMessageNoTime';

/**
 * The copy a rolling model-window rejection should render, or null when the
 * text is some other failure.
 *
 * Two surfaces need this and they arrive from opposite directions: the chat
 * card already knows the daemon's `model_window_limit` classification and only
 * wants the instant, while the Home composer fails before a run exists and has
 * nothing but the raw upstream sentence. Sharing one reader keeps them from
 * disagreeing about what counts as a window limit.
 */
export function modelWindowLimitCopy(
  rawMessage: string | null | undefined,
): { messageKey: ModelWindowLimitMessageKey; retryAt?: string } | null {
  if (!isModelWindowLimitFailure(rawMessage)) return null;
  const parsed = readModelWindowResetAt(rawMessage);
  // Shape-valid but not a real instant (`2026-13-45T…`) counts as unreadable,
  // so the message key and the variable can never disagree about whether a
  // time exists — the card would otherwise render "Invalid Date".
  const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
  return retryAt
    ? { messageKey: 'chat.runError.modelWindowLimitMessage', retryAt }
    // Promising a time we could not read is worse than not naming one.
    : { messageKey: 'chat.runError.modelWindowLimitMessageNoTime' };
}

/**
 * The instant a model window reopens, rendered for a reader in `locale`.
 *
 * The gateway reports UTC; a user waiting on a clock needs their own. Date and
 * time are both shown because the wait can cross midnight, and the year is left
 * off because a rolling window never reaches one.
 *
 * Returns the input untouched if it cannot be formatted, so the copy degrades
 * to a machine-readable instant rather than to a gap.
 */
export function formatModelWindowRetryAt(retryAt: string, locale: string): string {
  const parsed = new Date(retryAt);
  if (!Number.isFinite(parsed.getTime())) return retryAt;
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed);
  } catch {
    return retryAt;
  }
}

// Small helper for the common shape: a named failure type + actionable copy,
// recovered by re-running once the user has followed the instruction.
function retryWithGuidance(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
): RunFailureUi {
  return {
    primaryAction: 'retry',
    titleKey,
    messageKey,
    secondaryRetry: false,
  };
}

// Quota/billing dead ends where retrying the same request reproduces the
// failure: guidance copy without a dead Retry button.
function guidanceOnly(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
): RunFailureUi {
  return {
    primaryAction: 'none',
    titleKey,
    messageKey,
    secondaryRetry: false,
  };
}

// Agent-agnostic failure codes that carry a clear root cause and a concrete
// fix, mapped the same way regardless of which agent produced them. The daemon
// already classifies these into failure_category / user_action
// (apps/daemon/src/run-failure-classification.ts); this is the user-facing half
// of that taxonomy — a human-readable type name plus a one-line instruction,
// with the raw upstream string preserved in the card's collapsible source area.
const AGENT_AGNOSTIC_FAILURE_UI: Record<string, RunFailureUi> = {
  // The run completed but did not leave a deliverable file. Name the actual
  // missing outcome in the compact card and keep the raw reason in details.
  ARTIFACT_NOT_FOUND: retryWithGuidance(
    'chat.runError.title.artifactMissing',
    null,
  ),
  // CLI binary not found on PATH (user_action: install_cli).
  AGENT_UNAVAILABLE: retryWithGuidance(
    'chat.runError.title.cliMissing',
    'chat.runError.cliMissingMessage',
  ),
  // Input exceeded the model context window (user_action: reduce_context).
  AGENT_PROMPT_TOO_LARGE: retryWithGuidance(
    'chat.runError.title.promptTooLarge',
    'chat.runError.promptTooLargeMessage',
  ),
  // Guard halted a repeating, non-progressing tool loop (user_action: retry
  // after checking the real target).
  TOOL_LOOP_DETECTED: retryWithGuidance(
    'chat.runError.title.toolLoop',
    'chat.runError.toolLoopMessage',
  ),
  // Model emitted a fabricated role marker and was aborted; a plain retry
  // usually recovers.
  ROLE_MARKER_HALLUCINATION: retryWithGuidance(
    'chat.runError.title.outputInvalid',
    'chat.runError.outputInvalidMessage',
  ),
  // Checked-in runtime def failed strict validation (user_action: fix_config);
  // the user can't self-repair, so the copy points at update/support.
  AGENT_RUNTIME_DEF_INVALID: retryWithGuidance(
    'chat.runError.title.runtimeConfig',
    'chat.runError.runtimeConfigMessage',
  ),
  // A strategy-task continuation (clarification answer) arrived after the
  // daemon's OD Next protocol gate already settled the task — typically a
  // sticky `blocked` verdict. This is a task-lifecycle rejection, not an
  // engine failure: name the halted task and point at retrying the request
  // or starting a new one instead of showing the generic "task failed" card.
  STRATEGY_TASK_STATE_MISMATCH: retryWithGuidance(
    'chat.runError.title.strategyTaskHalted',
    'chat.runError.strategyTaskStateMismatchMessage',
  ),
};

// Failure causes keyed by the daemon's fine-grained `failure_detail`, for the
// cases where the coarse `error_code` alone is wrong or too vague. This layer
// can OVERRIDE a code mapping — e.g. `hard_quota` and a transient 429 share
// `error_code: RATE_LIMITED`, but only the transient one should offer Retry.
// Applied after the Antigravity agent-specific handling (which owns its own
// quota/auth flows) and before the generic code branches.
const DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  // Provider quota / billing hard-stop: retrying reproduces the failure, so
  // drop Retry and show guidance copy.
  hard_quota: guidanceOnly(
    'chat.runError.title.quotaExhausted',
    'chat.runError.quotaExhaustedMessage',
  ),
  workspace_credits_exhausted: guidanceOnly(
    'chat.runError.title.quotaExhausted',
    'chat.runError.workspaceCreditsMessage',
  ),
  // CLI binary missing detected only from text (leaks in as the opaque
  // AGENT_EXECUTION_FAILED code, not AGENT_UNAVAILABLE) — reuse the same
  // "install the CLI, then retry" card the code path already renders.
  cli_not_installed: retryWithGuidance(
    'chat.runError.title.cliMissing',
    'chat.runError.cliMissingMessage',
  ),
};

// Agent-agnostic failure causes keyed by the daemon's `failure_detail`,
// resolved BEFORE the Antigravity branch (unlike DETAIL_FAILURE_UI above).
// These are engine-neutral run outcomes — a timeout, an empty result, a stale
// resumed session, a missing Git Bash — that carry the same named type + fix
// for every agent. They leak in under the opaque AGENT_EXECUTION_FAILED
// / process-exit codes, so without this the card would only show the raw
// stderr.
const AGENT_AGNOSTIC_DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  // Hard wall-clock timeout for the run (daemon user_action: retry). A plain
  // retry — optionally with a smaller task — usually gets through.
  timeout: retryWithGuidance(
    'chat.runError.title.timedOut',
    'chat.runError.timedOutMessage',
  ),
  // The agent stalled (no new output for too long) and was cut off as a
  // timeout. Distinct copy from a hard timeout, same retry recovery.
  inactivity_timeout: retryWithGuidance(
    'chat.runError.title.timedOut',
    'chat.runError.inactivityTimeoutMessage',
  ),
  // Run terminated without producing any output (daemon user_action: retry);
  // usually transient, so name it and offer a straight retry.
  empty_output: retryWithGuidance(
    'chat.runError.title.emptyOutput',
    'chat.runError.emptyOutputMessage',
  ),
  // A resumed agent session id went stale; the daemon already cleared it so the
  // next run starts fresh (#3408). Name it as recoverable and offer Retry.
  session_resume_expired: retryWithGuidance(
    'chat.runError.title.sessionExpired',
    'chat.runError.sessionExpiredMessage',
  ),
  // Windows: the agent needs Git Bash to spawn and it isn't installed
  // (daemon user_action: install_cli). Point at installing Git for Windows,
  // then retry — same "install the dependency, then re-run" shape as
  // cli_missing.
  git_bash_missing: retryWithGuidance(
    'chat.runError.title.gitBashMissing',
    'chat.runError.gitBashMissingMessage',
  ),
  // The bundled agent binary needs a CPU instruction set (AVX2) this device
  // doesn't have, so it crashes on launch — retrying reproduces the crash and
  // switching models doesn't help (the runtime binary is the problem).
  // The fix is updating OpenDesign to a build that bundles a compatible
  // (baseline) runtime, so show guidance copy without a dead Retry button.
  cpu_unsupported: guidanceOnly(
    'chat.runError.title.cpuUnsupported',
    'chat.runError.cpuUnsupportedMessage',
  ),
};

// Resolve the failure UI for a failed run:
//   - ACP CLI refused the session → named type + change-the-CLI guidance
//   - agent-agnostic root cause (cli missing, prompt too large, tool loop,
//     bad output, bad runtime def) → named type + fix
//   - agent-agnostic failure_detail (timeout, empty output, stale resumed
//     session, missing Git Bash) → named type + retry, for every agent
//   - fine-grained failure_detail (hard quota, workspace credits,
//     text-detected cli-missing) → named type + fix, overriding a too-coarse
//     code
//   - Antigravity auth/quota → terminal-launch actions
//   - everything else → plain retry
// Unknown agents (including historical ids of retired runtimes) fall through
// to the generic branches and render as plain text — never a button that
// selects, authorizes, or upgrades a retired runtime.
export function resolveRunFailureUi(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  rawMessage?: string | null,
): RunFailureUi {
  // An ACP agent CLI that answered `initialize` and then refused to open a
  // session. Resolved before every other branch, and before the static
  // agent-agnostic table, because this code carries a prescription of its own
  // (change the CLI build, then retry) that the generic mappings would erase.
  // The daemon deliberately sends only the code plus the runtime identity as
  // data — a sentence composed there could never be translated (see
  // runtimes/acp-handshake-failure.ts).
  //
  // The copy names the installed build without quoting a version number. The
  // daemon does have a detected version, but reading the one THIS run started
  // with costs a pre-spawn probe on every launch, so naming it is deliberately
  // left to a follow-up rather than paid for on the failure path here.
  if (code === 'AGENT_CLI_SESSION_REFUSED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.cliSessionRefused',
      messageKey: 'chat.runError.cliSessionRefusedMessage',
      secondaryRetry: false,
    };
  }
  // Agent-agnostic codes resolve first so an agent-specific run that hits one
  // of them still gets the specific guidance instead of the generic fallback.
  const agnostic = typeof code === 'string' ? AGENT_AGNOSTIC_FAILURE_UI[code] : undefined;
  if (agnostic) return agnostic;
  // A rolling per-model window (the hosted gateway's `model_limit_exceeded`)
  // resolves before every agent branch. The reset instant is read from the
  // same upstream text the card already displays, through the shared
  // contracts reader.
  if (detail === 'model_window_limit') {
    // The daemon already decided this IS a window limit, so read the instant
    // directly rather than re-deciding from the text — an upstream rewording
    // that the daemon still classified must not silently lose the card.
    const parsed = readModelWindowResetAt(rawMessage);
    const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.modelWindowLimit',
      messageKey: retryAt
        ? 'chat.runError.modelWindowLimitMessage'
        : 'chat.runError.modelWindowLimitMessageNoTime',
      ...(retryAt ? { messageVars: { retryAt } } : {}),
      secondaryRetry: false,
    };
  }
  // Membership concurrency is a temporary policy gate carried inside an ACP
  // fatal envelope. Keep the Retry button manual, name the wait explicitly,
  // and preserve the upstream reset instant when one is present.
  if (detail === 'membership_concurrency_limit') {
    const parsed = readMembershipConcurrencyResetAt(rawMessage);
    const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.membershipConcurrencyLimit',
      messageKey: retryAt
        ? 'chat.runError.membershipConcurrencyLimitMessage'
        : 'chat.runError.membershipConcurrencyLimitMessageNoTime',
      ...(retryAt ? { messageVars: { retryAt } } : {}),
      secondaryRetry: false,
    };
  }
  // Engine-neutral failure_detail (timeout, empty output, stale resumed
  // session, missing Git Bash) resolves before the agent branches so it
  // applies to every agent.
  const agnosticDetail =
    typeof detail === 'string' ? AGENT_AGNOSTIC_DETAIL_FAILURE_UI[detail] : undefined;
  if (agnosticDetail) return agnosticDetail;
  // Antigravity's auth flow is terminal-only — see the
  // `launch-terminal-auth` action comment for why. Without this branch
  // the user sees the daemon-emitted guidance text and would have to
  // open a terminal themselves; with it they get a one-click button
  // that opens Terminal.app / x-terminal-emulator / cmd with `agy`
  // running, and a Retry button to redo the chat after OAuth completes.
  if (agentId === 'antigravity') {
    if (code === 'AGENT_AUTH_REQUIRED') {
      return {
        primaryAction: 'launch-terminal-auth',
        titleKey: 'chat.runError.title.signInRequired',
        messageKey: null,
        secondaryRetry: true,
      };
    }
    // Quota: each Antigravity model has its own quota, so the action
    // is "open agy, switch model" rather than "sign in." Same handler
    // spawns the same terminal; only the label changes.
    if (code === 'RATE_LIMITED') {
      return {
        primaryAction: 'launch-terminal-switch-model',
        titleKey: 'chat.runError.title.rateLimited',
        messageKey: null,
        secondaryRetry: true,
      };
    }
  }
  // Fine-grained daemon classification overrides a too-coarse code (e.g.
  // hard_quota vs a transient 429 both arriving as RATE_LIMITED). Placed after
  // the Antigravity agent branch so its bespoke quota/auth flow still wins,
  // and before the generic code branches so it can correct them.
  const detailUi = typeof detail === 'string' ? DETAIL_FAILURE_UI[detail] : undefined;
  if (detailUi) return detailUi;
  // Agent-neutral: a mid-response connection drop (any agent) gets a clear,
  // localized "lost connection — retry" message instead of the raw SDK string.
  // Not a retry-futile case: the break is the user's own network path.
  if (code === 'AGENT_CONNECTION_DROPPED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.connectionDropped',
      messageKey: 'chat.connectionDropped',
      secondaryRetry: false,
    };
  }
  // Sign-in required (any non-antigravity agent — that one is handled above).
  // The agent's login lives in the user's own terminal, so Open Design can't
  // sign in for them: surface a "{agent} 尚未登录，请本地检查登录状态"
  // message and offer Retry as the primary action (re-run after they log in
  // locally).
  if (code === 'AGENT_AUTH_REQUIRED' || code === 'UNAUTHORIZED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.signInRequired',
      messageKey: 'chat.runError.signInMessage.other',
      secondaryRetry: false,
    };
  }
  // Non-antigravity rate limit / upstream outage: name the type and explain
  // the recovery (wait & retry / switch model). Antigravity's own
  // RATE_LIMITED was handled above (per-model quota → switch model in
  // terminal).
  if (code === 'RATE_LIMITED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.rateLimited',
      messageKey: 'chat.runError.rateLimitedMessage',
      secondaryRetry: false,
    };
  }
  if (code === 'UPSTREAM_UNAVAILABLE') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.upstreamUnavailable',
      messageKey: 'chat.runError.upstreamUnavailableMessage',
      secondaryRetry: false,
    };
  }
  return {
    primaryAction: 'retry',
    titleKey: 'chat.runError.title.generic',
    messageKey: null,
    secondaryRetry: false,
  };
}
