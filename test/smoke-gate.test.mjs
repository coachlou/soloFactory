import test from "node:test";
import assert from "node:assert/strict";
import { smokeGateProblem } from "../scripts/smoke-gate.mjs";

const touch = "abc1234" + "0".repeat(33);
const later = "def5678" + "0".repeat(33);
const base = {
  version: "0.10.18",
  latestTag: "v0.10.17",
  changed: ["src/prompts.mjs"],
  eligibleCommits: [touch, later],
  rows: [],
  briefs: ["Habit Ledger", "Voice Notes"],
  progress: "## Unreleased\n\n## 0.10.18: x (2026-11-10)\n\n- Docs: none.\n\n## 0.10.17: y\n",
};
const row = (brief, extra = {}) => ({ brief, result: "passed", commit: "abc1234", provider: "claude", ...extra });

test("quiet without a tag, on a tagged version, or when no gated file changed", () => {
  assert.equal(smokeGateProblem({ ...base, latestTag: null }), null);
  assert.equal(smokeGateProblem({ ...base, latestTag: "v0.10.18" }), null);
  assert.equal(smokeGateProblem({ ...base, changed: ["README.md"] }), null);
});

test("a gated release needs a passing row for every brief at or after the last gated change", () => {
  const none = smokeGateProblem(base);
  assert.match(none, /src\/prompts\.mjs/);
  assert.match(none, /Habit Ledger, Voice Notes/);
  assert.equal(smokeGateProblem({ ...base, rows: [row("Habit Ledger"), row("Voice Notes", { commit: "def5678" })] }), null);
  const one = smokeGateProblem({ ...base, rows: [row("Habit Ledger")] });
  assert.match(one, /for Voice Notes\./);
  assert.doesNotMatch(one, /Habit Ledger/);
});

test("failed rows, rows before the last gated change, summarize rows and fixture rows do not count", () => {
  for (const extra of [{ result: "failed (run_budget_reached)" }, { commit: "0000000" }, { commit: "?" }, { provider: "fixture" }]) {
    assert.ok(smokeGateProblem({ ...base, rows: [row("Habit Ledger", extra), row("Voice Notes")] }), JSON.stringify(extra));
  }
  // Rows written before rows recorded a provider are real runs.
  const { provider, ...legacy } = row("Habit Ledger");
  assert.equal(smokeGateProblem({ ...base, rows: [legacy, row("Voice Notes")] }), null);
});

test("a waiver under the version's own heading satisfies the gate", () => {
  const waived = (progress) => smokeGateProblem({ ...base, progress });
  assert.equal(waived("## Unreleased\n\n## 0.10.18: x\n\n- Smoke: waived, docs-only prompt typo\n\n## 0.10.17: y\n"), null);
  assert.ok(waived("## Unreleased\n\n- Smoke: waived, wrong place\n\n## 0.10.18: x\n\n## 0.10.17: y\n"));
  assert.ok(waived("## 0.10.18: x\n\n## 0.10.17: y\n\n- Smoke: waived, older release\n"));
  assert.ok(waived("## 0.10.18: x\n\n- Smoke: waived,\n"), "a waiver needs a reason");
});
