// Deliberately dependency-free: consumers of this predicate (the proactive
// pull error sink) must be able to tell a cancelled child from a failed one
// WITHOUT pulling in a command runner and its whole module graph. Importing
// the shared command runner for this instead dragged `runtimes/env` +
// `runtimes/registry` into route tests whose runner mocks are deliberately
// partial, turning a successful pull into `register_failed`.

/**
 * Whether a rejection is an operation WE cancelled, rather than one that
 * failed.
 *
 * The shared command runner marks a deliberate abort with
 * `name: 'AbortError'` and `code: 'ABORT_ERR'`, and keeps a separate
 * `timeout` termination for real deadline breaches. The proactive scheduler
 * cancels in-flight pulls as ordinary control flow — a higher published
 * version supersedes the one being fetched (`mergeIntentUpdate`), or the
 * intent is cleared (`clearIntent`) — so those must never be logged or
 * counted as faults.
 *
 * Deliberately narrow: a real timeout and any transport error stay failures,
 * so a genuine fault can never be swallowed as "we meant to do that".
 */
export function isAbortedOperationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.code === 'ABORT_ERR' || candidate.name === 'AbortError';
}
