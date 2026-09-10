/**
 * Which coverage profile a packaged smoke run should execute.
 *
 * `core` installs, starts, inspects and uninstalls. `full` additionally
 * exercises the deeper packaged-runtime checks (reinstall over a running
 * instance, upgrade persistence, and the longer app-shell walk) that a routine
 * lane does not need. `skip` does not run the smoke at all.
 */
export type PackagedSmokeProfile = 'core' | 'full' | 'skip';

/**
 * Resolve the profile from the value the release workflows hand down.
 *
 * The subtlety this exists for: **an empty string is "nothing was chosen", not
 * a profile.** The value crosses three layers that each treat emptiness
 * differently, and all three have to agree or a release lane silently runs the
 * wrong coverage:
 *
 * 1. `notify-release-feishu.yml` computes the mode with a `||` chain whose last
 *    arm yields `''` for any branch its special cases do not name.
 * 2. A `workflow_call` `default:` applies only when an input is **omitted**.
 *    Passing `''` is not omission, so the declared `core` default never fires.
 * 3. `??` falls back only on `null`/`undefined`, so an empty environment
 *    variable survives it intact.
 *
 * On `release/v0.18.1` that produced `smokeProfile === ''`, so
 * `verifyCoreOnly` was false, the run took the `full` path and died on a
 * fixture only a genuine `full` request configured. `release/v0.18.0` never
 * showed it: its branch name matched a special case that produced `skip`, so
 * the smoke never ran at all.
 *
 * Hence: empty (unset, or whitespace) means unset means `core`, and an
 * unrecognised value is an error rather than a silent "not core" — a typo must
 * not silently select the deeper path the way `''` did.
 */
export function resolvePackagedSmokeProfile(
  raw: string | undefined | null,
): PackagedSmokeProfile {
  const normalized = raw?.trim() ?? '';
  if (normalized.length === 0) return 'core';
  if (normalized === 'core' || normalized === 'full' || normalized === 'skip') {
    return normalized;
  }
  throw new Error(
    `unsupported packaged smoke profile ${JSON.stringify(raw)}; expected core, full, skip, or empty for the core default`,
  );
}
