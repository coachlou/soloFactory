import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { briefNodeMajor, smokeGateProblem, smokeNodeProblem } from "../scripts/smoke-gate.mjs";

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

test("a brief's Node requirement is the highest Node major its text names", () => {
  assert.equal(briefNodeMajor({ brief: { constraints: ["Node 24, no runtime npm dependencies"] } }), 24);
  assert.equal(briefNodeMajor({ brief: { constraints: ["Node.js 22+ works", "prefer Node v26"] } }), 26);
  assert.equal(briefNodeMajor({ brief: { deployment: "Local Node server listening on PORT" } }), null, "no version digits");
});

test("a real smoke run refuses a brief that needs a newer Node than the controller, before spending", () => {
  const body = { brief: { constraints: ["Node 24, no runtime npm dependencies"] } };
  assert.match(smokeNodeProblem("habit-ledger", body, "claude", "v22.23.4"), /habit-ledger requires Node 24, but the controller runs Node 22 \(v22\.23\.4\)\. Put a Node 24\+ first on PATH/);
  assert.equal(smokeNodeProblem("habit-ledger", body, "claude", "v24.22.1"), null);
  assert.equal(smokeNodeProblem("habit-ledger", body, "claude", "v26.0.0"), null);
  assert.equal(smokeNodeProblem("habit-ledger", body, "fixture", "v22.23.4"), null, "fixture runs are free and never plan-reviewed");
  assert.equal(smokeNodeProblem("x", { brief: {} }, "claude", "v22.23.4"), null);
});

test("every stored smoke brief names the Node it needs", async () => {
  const dir = new URL("../smoke/briefs/", import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
    assert.ok(briefNodeMajor(JSON.parse(await readFile(new URL(file, dir), "utf8"))) >= 22, file);
  }
});
