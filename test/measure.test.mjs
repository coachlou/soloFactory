import test from "node:test";
import assert from "node:assert/strict";
import { activity, formatMeasurement, measureRun } from "../src/measure.mjs";

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
