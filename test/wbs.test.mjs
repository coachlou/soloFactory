import test from "node:test";
import assert from "node:assert/strict";
import { nextExecutable, orderSlices, pendingChecks, pendingObligations, pendingProofFailure, recordPendingProofs, validateFeaturePlan, validateSlicePlan } from "../src/wbs.mjs";

const validPlan = {
  slices: [
    {
      id: "SLICE-SKELETON",
      title: "Walking skeleton",
      objective: "A health-checked server with metrics and a build.",
      acceptance: ["GET /health answers ok", "Metrics stay aggregate-only"],
    },
    {
      id: "SLICE-UI",
      title: "Recording UI",
      objective: "A page to record one score a day.",
      acceptance: ["The page lets the owner record a score"],
      dependsOn: ["SLICE-SKELETON"],
    },
    {
      id: "SLICE-TREND",
      title: "Seven-day trend",
      objective: "Show the seven-day average.",
      acceptance: ["The trend shows the seven-day average"],
      dependsOn: ["SLICE-UI"],
    },
  ],
};

test("a valid plan normalizes, keeps declared order, and answers next", () => {
  const normalized = validateSlicePlan(validPlan);
  assert.equal(normalized.slices.length, 3);
  assert.deepEqual(orderSlices(validPlan).map((slice) => slice.id), ["SLICE-SKELETON", "SLICE-UI", "SLICE-TREND"]);
  assert.equal(nextExecutable([], validPlan).id, "SLICE-SKELETON");
  assert.equal(nextExecutable(["SLICE-SKELETON"], validPlan).id, "SLICE-UI");
  assert.equal(nextExecutable(["SLICE-SKELETON", "SLICE-UI"], validPlan).id, "SLICE-TREND");
  assert.equal(nextExecutable(["SLICE-SKELETON", "SLICE-UI", "SLICE-TREND"], validPlan), null);
});

test("validation does not mutate the input plan", () => {
  const before = JSON.stringify(validPlan);
  validateSlicePlan(validPlan);
  assert.equal(JSON.stringify(validPlan), before);
  assert.notEqual(validPlan.slices, validateSlicePlan(validPlan).slices);
});

test("missing dependsOn defaults to an empty array", () => {
  const plan = { slices: [{ id: "A", title: "t", objective: "o", acceptance: ["okay"], }] };
  const normalized = validateSlicePlan(plan);
  assert.deepEqual(normalized.slices[0].dependsOn, []);
});

test("rejects structural violations", () => {
  const cases = [
    [{}, /slices array/],
    [{ slices: [] }, /at least one slice/],
    [{ slices: "nope" }, /slices array/],
    [{ slices: [null] }, /is not an object/],
    [{ slices: [{ id: "a", title: "t", objective: "o", acceptance: ["okay"] }] }, /SCREAMING_SNAKE|must match/],
    [{ slices: [{ id: "A", title: "  ", objective: "o", acceptance: ["okay"] }] }, /title/],
    [{ slices: [{ id: "A", title: "t", objective: "", acceptance: ["okay"] }] }, /objective/],
    [{ slices: [{ id: "A", title: "t", objective: "o", acceptance: [] }] }, /acceptance/],
    [{ slices: [{ id: "A", title: "t", objective: "o", acceptance: ["x"] }] }, /acceptance/],
  ];
  for (const [plan, pattern] of cases) {
    assert.throws(() => validateSlicePlan(plan), pattern, JSON.stringify(plan));
  }
});

test("rejects duplicate ids", () => {
  const plan = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["one"] },
      { id: "A", title: "t2", objective: "o2", acceptance: ["two"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan), /Duplicate slice id: A/);
});

test("rejects dependency violations", () => {
  const missing = { slices: [{ id: "A", title: "t", objective: "o", acceptance: ["okay"], dependsOn: ["GHOST"] }] };
  assert.throws(() => validateSlicePlan(missing), /unknown slice GHOST/);

  const forward = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"] },
      { id: "C", title: "t3", objective: "o3", acceptance: ["ok3"], dependsOn: ["B"] },
    ],
  };
  // B is before C, so this is legal.
  assert.doesNotThrow(() => validateSlicePlan(forward));
  const selfLater = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"], dependsOn: ["C"] },
      { id: "C", title: "t3", objective: "o3", acceptance: ["ok3"] },
    ],
  };
  assert.throws(() => validateSlicePlan(selfLater), /not an earlier slice/);

  const skeletonDep = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"], dependsOn: ["B"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"] },
    ],
  };
  assert.throws(() => validateSlicePlan(skeletonDep), /not an earlier slice|walking skeleton/);
});

test("scenario coverage requires every frozen scenario to be tagged", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["[SC-1] One scenario lands"], demo: "Observe one scenario working end to end." },
      { id: "SLICE-B", title: "t2", objective: "o2", acceptance: ["[SC-2] Second scenario lands"], demo: "Observe the second scenario working." },
    ],
  };
  assert.doesNotThrow(() => validateSlicePlan(plan, { scenarioCount: 2 }));
  const normalized = validateSlicePlan(plan, { scenarioCount: 2 });
  assert.equal(normalized.slices[0].demo, "Observe one scenario working end to end.");
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 3 }), /SC-3/);
});

test("scenario coverage names every missing scenario", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["[SC-2] Only the second scenario"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 3 }), /SC-1, SC-3/);
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 1 }), /SC-1/);
});

test("a demo that is too thin is rejected and an absent demo is fine", () => {
  const thin = { slices: [{ id: "SLICE-A", title: "t", objective: "o", acceptance: ["okay"], demo: "ok" }] };
  assert.throws(() => validateSlicePlan(thin), /demo/);
  const none = { slices: [{ id: "SLICE-A", title: "t", objective: "o", acceptance: ["okay"] }] };
  assert.doesNotThrow(() => validateSlicePlan(none));
});

test("a criterion shared between slices is rejected as re-implementation", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["The page saves a score"] },
      { id: "SLICE-B", title: "t2", objective: "o2", acceptance: ["the page saves a score"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan), /share the same acceptance criterion/);
});

// --- version-2 feature plans ---
const checks = [
  { id: "MH-1", text: "Record one score a day" },
  { id: "MH-2", text: "Show the seven-day trend" },
  { id: "SC-1", text: "The owner records a score and sees the trend move" },
];
const binding = { jobId: "job-1", contractDigest: "c".repeat(64), checks };
const ob = (id, behavior, refs) => ({ id, behavior, refs, proof: { command: ["node", "--test", "test/x.test.mjs"], expect: "all tests pass" } });
const featurePlan = (slices, extra = {}) => ({ version: 2, jobId: "job-1", contractDigest: "c".repeat(64), slices, ...extra });
const feature = (id, closes, acceptance, dependsOn = []) => ({ id, title: `Feature ${id}`, objective: "Observable outcome", demo: "Open the page and see it", closes, acceptance, dependsOn });
const fullPlan = () => featurePlan([
  feature("STORE", [], [ob("STORE-1", "Scores persist across a restart", [])]),
  feature("RECORD", ["MH-1"], [ob("RECORD-1", "Owner records one score per day", ["MH-1"])], ["STORE"]),
  feature("TREND", ["MH-2", "SC-1"], [ob("TREND-1", "Trend shows the seven-day average", ["MH-2", "SC-1"])], ["RECORD"]),
]);

test("v2: a valid plan normalizes with a prerequisite feeding a closer", () => {
  const plan = validateFeaturePlan(fullPlan(), binding);
  assert.deepEqual(plan.slices.map((s) => s.id), ["STORE", "RECORD", "TREND"]);
  assert.deepEqual(plan.slices[0].acceptance[0].proof.command, ["node", "--test", "test/x.test.mjs"]);
});

test("v2: one coherent feature is a valid plan and more than six is allowed", () => {
  assert.equal(validateFeaturePlan(featurePlan([feature("ALL", ["MH-1", "MH-2", "SC-1"], [ob("ALL-1", "Records and trends in one page", ["MH-1", "MH-2", "SC-1"])])]), binding).slices.length, 1);
  const many = Array.from({ length: 9 }, (_, i) => feature(`F${i}`, i === 8 ? ["MH-1", "MH-2", "SC-1"] : [], [ob(`F${i}-1`, `Increment number ${i} works end to end`, i === 8 ? ["MH-1", "MH-2", "SC-1"] : [])], i ? [`F${i - 1}`] : []));
  assert.equal(validateFeaturePlan(featurePlan(many), binding).slices.length, 9);
  const tooMany = Array.from({ length: 31 }, (_, i) => feature(`F${i}`, i === 30 ? ["MH-1", "MH-2", "SC-1"] : [], [ob(`F${i}-1`, `Increment number ${i} works end to end`, ["MH-1"])], i ? [`F${i - 1}`] : []));
  assert.throws(() => validateFeaturePlan(featurePlan(tooMany), binding), /limit is 30/);
});

test("v2: a plan covering every SC but omitting an MH names the MH", () => {
  const plan = fullPlan();
  plan.slices[2].closes = ["SC-1"];
  plan.slices[2].acceptance[0].refs = ["SC-1"];
  assert.throws(() => validateFeaturePlan(plan, binding), /no closing owner for MH-2 \(Show the seven-day trend\)/);
});

test("v2: unknown and duplicate owners, orphans and unproved closes are rejected", () => {
  const unknown = fullPlan(); unknown.slices[1].closes = ["MH-1", "MH-9"];
  assert.throws(() => validateFeaturePlan(unknown, binding), /unknown check MH-9/);
  const dup = fullPlan(); dup.slices[2].closes = ["MH-1", "MH-2", "SC-1"]; dup.slices[2].acceptance[0].refs.push("MH-1");
  assert.throws(() => validateFeaturePlan(dup, binding), /MH-1 has two closing owners/);
  const orphan = fullPlan(); orphan.slices[1].dependsOn = [];
  assert.throws(() => validateFeaturePlan(orphan, binding), /STORE is an orphan prerequisite/);
  const unproved = fullPlan(); unproved.slices[1].acceptance[0].refs = [];
  assert.throws(() => validateFeaturePlan(unproved, binding), /closes MH-1 but no obligation/);
  const badRef = fullPlan(); badRef.slices[0].acceptance[0].refs = ["SC-7"];
  assert.throws(() => validateFeaturePlan(badRef, binding), /unknown original checks/);
});

test("v2: empty/fuzzy acceptance, malformed proof, forward deps and metadata are rejected", () => {
  const cases = [
    [(p) => { p.slices[0].acceptance = []; }, /at least one acceptance obligation/],
    [(p) => { p.slices[0].acceptance[0].behavior = "works"; }, /concrete expected behavior/],
    [(p) => { p.slices[0].acceptance[0].proof = { command: [], expect: "ok" }; }, /executable proof command/],
    [(p) => { p.slices[0].acceptance[0].proof.command = ["bash", "-c", "true"]; }, /executable proof command/],
    [(p) => { p.slices[0].acceptance[0].proof.command = "npm test"; }, /executable proof command/],
    [(p) => { p.slices[0].acceptance[0].proof.expect = ""; }, /expected proof result/],
    [(p) => { p.slices[0].dependsOn = ["TREND"]; }, /not an earlier slice/],
    [(p) => { p.slices[1].acceptance[0].behavior = p.slices[0].acceptance[0].behavior.toUpperCase(); }, /share the behavior/],
    [(p) => { p.slices[0].demo = "ok"; }, /demo/],
    [(p) => { p.contractDigest = "d".repeat(64); }, /frozen contract/],
    [(p) => { p.jobId = "other"; }, /this run/],
    [(p) => { delete p.version; }, /version 2/],
    [(p) => { p.compatibility = [{ subject: "sharp on arm64", status: "unknown" }]; }, /Unresolved compatibility: sharp on arm64/],
    [(p) => { p.slices[2].acceptance[0].proof.pending = "later"; }, /pending may only be "integration"/],
    [(p) => { p.slices[2].acceptance[0].proof.pending = "integration"; }, /at least one obligation provable when the feature is built/],
  ];
  for (const [mutate, pattern] of cases) {
    const plan = fullPlan();
    mutate(plan);
    assert.throws(() => validateFeaturePlan(plan, binding), pattern);
  }
  assert.doesNotThrow(() => validateFeaturePlan(fullPlan(), binding));
});

test("v2: a proof pending integration keeps the checks it proves pending when its feature is verified", () => {
  const raw = fullPlan();
  raw.slices[2].acceptance.push({ ...ob("TREND-2", "Populated trend renders with a month of history", ["SC-1"]), proof: { command: ["node", "--test", "test/populated.test.mjs"], expect: "passes", pending: "integration" } });
  const plan = validateFeaturePlan(raw, binding);
  assert.equal(plan.slices[2].acceptance[1].proof.pending, "integration");
  assert.deepEqual(pendingChecks(plan.slices[2]), ["SC-1"]);
  assert.deepEqual(pendingChecks(plan.slices[1]), []);
  assert.deepEqual(pendingObligations(plan).map((item) => item.id), ["TREND-2"]);
  // A pending obligation anywhere in the plan, or outstanding from an earlier plan, keeps the check pending for whichever feature closes it.
  const closer = { id: "X", closes: ["SC-1", "MH-1"], acceptance: [] };
  assert.deepEqual(pendingChecks(closer, { plan }), ["SC-1"]);
  assert.deepEqual(pendingChecks(closer, { outstanding: [{ status: "pending", refs: ["MH-1"] }, { status: "superseded", refs: ["SC-1"] }] }), ["MH-1"]);
});


test("proof gate identity preserves component boundaries and the full plan digest", () => {
  const job = {};
  const item = (id, ref) => ({ id, refs: [ref], proof: { command: ["node", id], pending: "integration" } });
  recordPendingProofs(job, "a".repeat(64), { id: "A-B", acceptance: [item("C", "MH-1")] });
  recordPendingProofs(job, "a".repeat(64), { id: "A", acceptance: [item("B-C", "SC-1")] });
  recordPendingProofs(job, "a".repeat(8) + "b".repeat(56), { id: "A", acceptance: [item("B-C", "SC-1")] });
  assert.equal(new Set(job.outstandingProofs.map(e => e.key)).size, 3);
  assert.equal(new Set(job.outstandingProofs.map(e => e.gate)).size, 3);
  job.error = { code: "quality_gate_failed", details: { gate: job.outstandingProofs[1].gate } };
  assert.equal(pendingProofFailure(job).obligation.id, "B-C");
});


test("passed proof evidence clears pending checks only for its own plan", async () => {
  const { createHash } = await import("node:crypto");
  const plan = fullPlan();
  const closer = plan.slices[2];
  closer.acceptance.push({ ...ob("INTEGRATED", "Populated trend is integrated with history", ["SC-1"]), proof: { command: ["node", "--test", "populated.mjs"], expect: "passes", pending: "integration" } });
  const digest = p => createHash("sha256").update(JSON.stringify(p)).digest("hex");
  const job = {};
  recordPendingProofs(job, digest(plan), closer);
  job.outstandingProofs[0].status = "passed";
  assert.deepEqual(pendingChecks(closer, { plan, outstanding: job.outstandingProofs }), []);
  const later = structuredClone(plan); later.slices[2].title += " revised";
  assert.deepEqual(pendingChecks(later.slices[2], { plan: later, outstanding: job.outstandingProofs }), ["SC-1"]);
});


test("failure mappings distinguish integrated proofs from a feature gate using the same command", () => {
  const job = {};
  recordPendingProofs(job, "a".repeat(64), { id: "A", acceptance: [{ id: "B", refs: [], proof: { command: ["npm", "test"], pending: "integration" } }] });
  job.error = { code: "quality_gate_failed", details: { gate: "test", command: ["npm", "test"], proofKeys: [] } };
  assert.equal(pendingProofFailure(job), null, "a feature failure must not be treated as integration exhaustion");
  delete job.error.details.proofKeys;
  assert.equal(pendingProofFailure(job).obligation.id, "B", "older failures resolve through their command");
  job.error.details.proofKeys = [job.outstandingProofs[0].key];
  assert.equal(pendingProofFailure(job).obligation.id, "B", "a deduplicated integration gate preserves its target");
});
