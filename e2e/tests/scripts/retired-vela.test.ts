import { describe, expect, test } from "vitest";

import {
  findRetiredVelaViolations,
  type RetiredVelaSourceEntry,
} from "../../../scripts/guard.ts";

describe("retired Vela/AMR source boundary", () => {
  test("rejects retired tokens in active source trees", () => {
    const entries: readonly RetiredVelaSourceEntry[] = [
      { path: "tools/pack/src/example.ts", content: "spawnSync('vela', ['agent', 'run'])" },
      { path: "apps/web/src/example.tsx", content: "agentId === 'amr'" },
      { path: "packages/contracts/src/example.ts", content: "export const VELA_BIN = 'x';" },
      { path: "apps/daemon/src/example.ts", content: "upstream amr-client call" },
      { path: ".github/workflows/example.yml", content: "run: pnpm exec vela-agent sync" },
      { path: ".github/scripts/example.sh", content: "export REQUIRE_VELA_CLI=true" },
      { path: "tools/release/scripts/example.py", content: "amr_profile = 'prod'" },
    ];

    const violations = findRetiredVelaViolations(entries);
    expect(violations.map(({ path }) => path)).toEqual(entries.map(({ path }) => path));
    // Every violation reports the exact matched token for the failure log.
    for (const violation of violations) {
      expect(violation.token.length).toBeGreaterThan(0);
    }
  });

  test("allows the approved archived documents under specs/change/", () => {
    const violations = findRetiredVelaViolations([
      { path: "specs/change/0001-remove-vela.md", content: "Vela integration removal plan (amr, vela-)" },
    ]);
    expect(violations).toEqual([]);
  });

  test("allows exactly the historical-compatibility files that still decode old rows", () => {
    const historicalCompatEntries: readonly RetiredVelaSourceEntry[] = [
      // `vela/` image/video model prefix normalization for stored rows.
      { path: "apps/daemon/src/db.ts", content: "next.imageModel.startsWith('vela/')" },
      // Retired agent-id set + retired env-var strip list.
      { path: "apps/daemon/src/app-config.ts", content: "'amr', 'VELA_BIN'" },
      // Decodes stored AMR_* failure codes.
      { path: "apps/daemon/src/run-failure-classification.ts", content: "errorCode === 'AMR_INSUFFICIENT_BALANCE'" },
      // Historical failure-detail union members emitted by the classifier above.
      { path: "packages/contracts/src/analytics/events/shared-enums.ts", content: "| 'amr_insufficient_balance'" },
      // Still sweeps the historical hosted-runtime log home for diagnostics.
      { path: "packages/diagnostics/src/agent-logs.ts", content: 'join(dataDir, "amr", "opencode-home")' },
      // Hosts this regex.
      { path: "scripts/guard.ts", content: "/\\bvela\\b|vela_|vela-|\\bamr\\b|amr_|amr-/i" },
      // Approved archived documents.
      { path: "CHANGELOG.md", content: "vela amr" },
      { path: "RELEASE-NOTES-0.10.0.md", content: "vela amr" },
      {
        path: "apps/landing-page/app/content/blog/open-design-0-13-0-stay-in-flow.md",
        content: "vela amr",
      },
    ];

    expect(findRetiredVelaViolations(historicalCompatEntries)).toEqual([]);
  });

  test("does not allow the retired token anywhere else, including docs outside the archive", () => {
    const violations = findRetiredVelaViolations([
      { path: "CHANGELOG.md", content: "clean" },
      { path: "apps/landing-page/app/content/blog/another-post.md", content: "vela" },
      { path: "specs/current/ci.md", content: "amr" },
      { path: "apps/daemon/src/some-other-file.ts", content: "veLa" },
    ]);
    expect(violations).toEqual([
      { path: "apps/landing-page/app/content/blog/another-post.md", token: "vela" },
      { path: "specs/current/ci.md", token: "amr" },
      { path: "apps/daemon/src/some-other-file.ts", token: "veLa" },
    ]);
  });
});
