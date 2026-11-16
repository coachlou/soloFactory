import test from "node:test";
import assert from "node:assert/strict";
import { activity, formatMeasurement, formatSmokeTable, measureRun, overBudget, parseBudgets, STAGE_BUDGETS, summarizeRun } from "../src/measure.mjs";

let clock = Date.parse("2026-10-11T00:00:00Z");
const ev = (type, fields = {}, advance = 1000) => ({ at: new Date(clock += advance).toISOString(), type, ...fields });

test("activity classifies agent labels", () => {
  assert.equal(activity("feature-plan"), "planning");
  assert.equal(activity("recovery-plan-review-p1-2"), "planning");
  assert.equal(activity("build-slice-A"), "implement");
  assert.equal(activity("feature-review-A-1"), "review");
  assert.equal(activity("repair-3"), "repair");
});

test("measures per feature, repeats on unchanged candidates, parked time and gaps", () => {
  const events = [
    ev("agent.started", { stage: "feature-plan", feature: null }), ev("agent.completed", { stage: "feature-plan", feature: null, usage: { inputTokens: 10, outputTokens: 2 } }, 5000),
    ev("agent.started", { stage: "build-slice-A", feature: "A" }), ev("agent.completed", { stage: "build-slice-A", feature: "A", usage: null }, 20000),
    ev("gate.started", { gate: "test", command: ["npm", "test"], feature: "A", candidate: "c1" }), ev("gate.passed", { gate: "test", feature: "A", durationMs: 300 }),
    ev("gate.started", { gate: "proof-A1", command: ["node", "e2e.mjs"], feature: "A", candidate: "c1" }), ev("gate.failed", { gate: "proof-A1", feature: "A", durationMs: 50, message: "proof-A1 failed" }),
    ev("job.paused"), ev("job.resumed", {}, 60000),
    // Resume reruns on the same candidate: an exact repeat, and npm test is reusable after its pass.
    ev("gate.started", { gate: "test", command: ["npm", "test"], feature: "A", candidate: "c1" }), ev("gate.passed", { gate: "test", feature: "A", durationMs: 300 }),
    ev("agent.started", { stage: "repair-1", feature: "A" }), ev("agent.completed", { stage: "repair-1", feature: "A", usage: { inputTokens: 5, outputTokens: 1 } }, 8000),
    ev("gate.started", { gate: "test", command: ["npm", "test"], feature: "A", candidate: "c2" }), ev("gate.passed", { gate: "test", feature: "A", durationMs: 300 }),
    ev("gate.started", { gate: "proof-A1", command: ["node", "e2e.mjs"], feature: null, candidate: "c2" }), ev("gate.failed", { gate: "proof-A1", feature: null, durationMs: 300000, message: "proof-A1 timed out" }),
    ev("agent.started", { stage: "review", feature: null }),
  ];
  const m = measureRun(events);
  const a = m.buckets.find((b) => b.id === "A");
  assert.deepEqual([a.agent.turns, a.agent.byActivity.implement, a.agent.byActivity.repair], [2, 20000, 8000]);
  assert.deepEqual([a.gates.runs, a.gates.failed, a.gates.repeats, a.gates.unchangedRepeats, a.gates.reusable], [4, 1, 2, 1, 1]);
  assert.equal(a.agent.turnsWithoutUsage, 1);
  const integration = m.buckets.find((b) => b.id === "integration");
  assert.deepEqual([integration.gates.timedOut, integration.gates.repeats, integration.gates.unchangedRepeats, integration.agent.interrupted], [1, 1, 0, 1]);
  assert.equal(m.buckets.find((b) => b.id === "planning").agent.byActivity.planning, 5000);
  assert.equal(m.parkedMs, 60000);
  assert.equal(m.tokens.inputTokens, 15);
  assert.match(formatMeasurement(m), /\| A \| 2 \|/);
  assert.ok(m.unavailable.some((note) => /token usage/.test(note)));
});

test("legacy events without feature, command or candidate fields are attributed by slice and labelled", () => {
  const events = [
    ev("slice.started", { slice: "S1" }),
    ev("agent.started", { message: "codex started build-slice-S1" }), ev("agent.completed", { stage: "build-slice-S1" }, 4000),
    ev("gate.started", { gate: "test", message: "test: npm test" }), ev("gate.passed", { gate: "test", durationMs: 100 }),
    ev("gate.started", { gate: "test", message: "test: npm test" }), ev("gate.passed", { gate: "test", durationMs: 100 }),
    ev("slice.completed", { slice: "S1" }),
    ev("gate.started", { gate: "build", message: "build: npm run build" }), ev("gate.passed", { gate: "build", durationMs: 100 }),
  ];
  const m = measureRun(events);
  const s1 = m.buckets.find((b) => b.id === "S1");
  assert.deepEqual([s1.agent.byActivity.implement, s1.gates.runs, s1.gates.repeats, s1.gates.candidateUnknown], [4000, 2, 1, 2]);
  assert.equal(m.buckets.find((b) => b.id === "integration").gates.runs, 1);
  assert.ok(m.unavailable.some((note) => /lower bound/.test(note)));
});

test("legacy recovery runs: features come from recovery labels, and parking ends when work starts again", () => {
  // Photo-library snapshot shape: no slice.started, recovery.slice.completed per feature, and work
  // that resumes through recovery transitions with no job.resumed event.
  const phase = "0f8c2a1e-5b6d-4c3e-9a7f-1b2c3d4e5f60";
  const events = [
    ev("job.paused"),
    ev("agent.started", { message: `codex started recovery-${phase}-F1-PHOTO` }, 50000), ev("agent.completed", { stage: `recovery-${phase}-F1-PHOTO` }, 4000),
    ev("gate.started", { gate: "test", message: "test: npm test" }), ev("gate.passed", { gate: "test", durationMs: 100 }),
    ev("agent.started", { message: "codex started repair-1" }), ev("agent.completed", { stage: "repair-1" }, 3000),
    ev("recovery.slice.completed", { slice: "F1-PHOTO" }),
    ev("agent.started", { message: `codex started recovery-${phase}-F2-ALBUM-review-1` }), ev("agent.completed", { stage: `recovery-${phase}-F2-ALBUM-review-1` }, 2000),
    ev("recovery.slice.completed", { slice: "F2-ALBUM" }),
    ev("gate.started", { gate: "build", message: "build: npm run build" }), ev("gate.passed", { gate: "build", durationMs: 100 }),
  ];
  const m = measureRun(events);
  const f1 = m.buckets.find((b) => b.id === "F1-PHOTO");
  assert.deepEqual([f1?.agent.byActivity.implement, f1?.agent.byActivity.repair, f1?.gates.runs], [4000, 3000, 1]);
  assert.equal(m.buckets.find((b) => b.id === "F2-ALBUM")?.agent.byActivity.review, 2000);
  assert.equal(m.buckets.find((b) => b.id === "integration").gates.runs, 1);
  assert.equal(m.parkedMs, 50000);
  assert.ok(m.parkedMs + m.activeMs <= m.wallMs);
});

test("a turn still running when the run parks is reported as overlap, not hidden by a zero clamp", () => {
  const events = [
    ev("agent.started", { stage: "build-slice-A", feature: "A" }),
    ev("job.paused", {}, 1000), ev("agent.completed", { stage: "build-slice-A", feature: "A" }, 5000),
    ev("job.resumed", {}, 1000),
  ];
  const m = measureRun(events);
  assert.ok(m.unavailable.some((note) => /overlap/.test(note)));
  assert.match(formatMeasurement(m), /overlap/);
});

test("summarizeRun gives one smoke-ledger row", () => {
  clock = Date.parse("2026-11-09T00:00:00Z");
  const usage = { inputTokens: 10, outputTokens: 5, costUsd: 1.5 };
  const events = [
    ev("agent.started", { stage: "feature-plan" }), ev("plan.blocked"), ev("agent.completed", { usage }),
    ev("agent.started", { stage: "repair-a" }, 60_000), ev("agent.completed", { usage }, 60_000),
  ];
  const state = { id: "r1", provider: "claude", state: "completed", completedAt: "2026-11-09T00:03:00Z", brief: { workingName: "Demo" }, sliceDone: ["A", "B"], slicePlanIds: ["A", "B"], sliceStats: { A: { repairs: 1 } } };
  const row = summarizeRun(state, events, { arm: "x", commit: "abc" });
  assert.deepEqual({ ...row }, { at: "2026-11-09T00:03:00Z", commit: "abc", brief: "Demo", arm: "x", provider: "claude", run: "r1", result: "passed", features: 2, planned: 2, firstPass: 1, repairs: 1, planBlocks: 1, reviewsRun: 0, reviewsSkipped: 0, skippedFindings: 0, unattributedFindings: 0, costUsd: 3, costPerFeature: 1.5, wallMin: 2, stageMin: { planning: 0, implement: 0, review: 0, repair: 1, gates: 0 } });
  assert.match(formatSmokeTable([row]), /\| 2026-11-09 \| abc \| Demo \| x \| passed \| 2 of 2 \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| \$3\.00 \| \$1\.50 \| 2 min \| 0\.0 \| 0\.0 \| 1\.0 \| 0\.0 \|  \|/);
  assert.equal(summarizeRun({ ...state, state: "failed", error: { code: "run_budget_reached" } }, []).result, "failed (run_budget_reached)");
});

test("summarizeRun counts scoped reviews, skipped features, every final finding on them, and unattributed findings", () => {
  const state = { id: "r2", state: "completed", sliceDone: ["A", "B"], sliceStats: { A: { reviews: 2 }, B: { reviews: 0 } }, recoveryPhase: { stats: { R1: { reviews: 0, batched: true }, R2: { reviews: 1 } } } };
  // R1 is a batched recovery feature; the null finding sits in files no feature declares.
  const events = [ev("review.finding", { feature: "B" }), ev("review.finding", { feature: "A" }), ev("review.finding", { feature: "R1" }), ev("review.finding", { feature: "R1" }), ev("review.finding", { feature: null }), ev("review.bug", { feature: "B" })];
  const row = summarizeRun(state, events);
  assert.deepEqual([row.reviewsRun, row.reviewsSkipped, row.skippedFindings, row.unattributedFindings], [3, 2, 3, 1]);
});

test("stage budgets flag a slow stage, scale per feature, and leave old ledger rows alone", () => {
  const row = { features: 5, stageMin: { planning: 6, implement: 10, review: 19, repair: 0.3, gates: 0.8 } };
  assert.deepEqual(overBudget(row), ["review 19.0 min > 7.5"]);
  assert.deepEqual(overBudget({ ...row, stageMin: { ...row.stageMin, planning: 9.25 } }), ["planning 9.3 min > 8", "review 19.0 min > 7.5"]);
  // No finished feature still gets one feature's budget.
  assert.deepEqual(overBudget({ features: 0, stageMin: { review: 2 } }), ["review 2.0 min > 1.5"]);
  assert.deepEqual(overBudget({ features: 3, wallMin: 20 }), []);
  assert.match(formatSmokeTable([{ ...row, at: "2026-11-16T00:00:00Z", commit: "c", brief: "B", arm: "", result: "passed", planned: 5, firstPass: 5, repairs: 0, planBlocks: 0, costUsd: 1, costPerFeature: 0.2, wallMin: 36 }]), /\| 6\.0 \| 19\.0 \| 0\.3 \| 0\.8 \| review 19\.0 min > 7\.5 \|$/);
  // A legacy row renders empty stage cells instead of failing.
  assert.match(formatSmokeTable([{ at: "2026-11-09", commit: "c", brief: "B", result: "passed", features: 1, planned: 1, wallMin: 3 }]), /\| 3 min \|  \|  \|  \|  \|  \|$/);
});

test("SMOKE_BUDGETS overrides a stage in its own unit and refuses nonsense", () => {
  const budgets = parseBudgets("review=4, planning=10");
  assert.deepEqual(budgets.review, { perFeature: 4 });
  assert.deepEqual(budgets.planning, { min: 10 });
  assert.deepEqual(budgets.gates, STAGE_BUDGETS.gates);
  assert.deepEqual(parseBudgets(undefined), STAGE_BUDGETS);
  assert.throws(() => parseBudgets("speed=3"), /SMOKE_BUDGETS/);
  assert.throws(() => parseBudgets("review=-1"), /SMOKE_BUDGETS/);
  assert.deepEqual(overBudget({ features: 5, stageMin: { review: 19 } }, budgets), []);
});
