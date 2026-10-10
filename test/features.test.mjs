// Planned-feature (slices.json v2) execution: the PRD acceptance matrix at the factory level.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { digest } from "../src/feature-recovery.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const deployer = async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9981" });
const passing = async () => ({ code: 0, output: "passed" });

// A default (planned) run whose fixture turns can be post-processed per stage by `after`.
async function plannedRun({ after = async () => {}, commandRunner = passing, uploads = {} } = {}) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-features-")));
  await store.init();
  // Supplied specs and prototype handoffs arrive at intake and are attached by the brief's own transcript.
  for (const [name, body] of Object.entries(uploads)) {
    await mkdir(path.join(store.appDir(), ".factory/uploads"), { recursive: true });
    await writeFile(path.join(store.appDir(), ".factory/uploads", name), body);
  }
  const attached = Object.keys(uploads).map((name) => ({ role: "user", content: `Attached file: .factory/uploads/${name}` }));
  const job = await store.create({ brief, transcript: [...transcript, ...attached], provider: "fixture" });
  assert.equal(job.planVersion, 2);
  const fixture = createFixtureProvider();
  const provider = { id: "fixture", async run(options) {
    const result = await fixture.run(options);
    await after(options.context.stage, options.cwd, options.context);
    return result;
  } };
  const make = (overrides = {}) => new SoloFactory({ store, provider, commandRunner, deployer, ...overrides });
  return { store, job, make, factory: make() };
}

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const patch = async (file, change) => { const value = await json(file); change(value); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); };
const started = async (store, id) => (await store.events(id, 1000)).filter((event) => event.type === "agent.started").map((event) => event.message);
const count = (messages, needle) => messages.filter((message) => message.includes(needle)).length;

test("a plan verdict with the wrong digest runs zero implementation turns", async () => {
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage === "plan-review-1") await patch(path.join(cwd, ".factory/plan-review-result.json"), (verdict) => { verdict.planDigest = "0".repeat(64); });
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "plan_verdict_invalid");
  assert.equal(result.approvedPlan, undefined);
  assert.equal(count(await started(store, job.id), "build-slice-"), 0);
});

test("a planning reviewer that edits the plan cannot approve it, and nothing is built", async () => {
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage === "plan-review-1") await patch(path.join(cwd, ".factory/slices.json"), (plan) => { plan.slices[1].title = "Reviewer rewrite"; });
  } });
  const result = await factory.start(job.id);
  assert.equal(result.error.code, "plan_verdict_invalid");
  assert.equal(count(await started(store, job.id), "build-slice-"), 0);
});

test("a planning turn that writes app source runs zero implementation turns", async () => {
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage === "feature-plan") await writeFile(path.join(cwd, "server.js"), "// planner wrote code\n");
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "plan_mutation");
  assert.equal(result.approvedPlan, undefined);
  assert.equal(count(await started(store, job.id), "build-slice-"), 0);
});

test("resume after the approved plan was edited fails closed with no new build turn", async () => {
  let crash = true;
  const { store, job, make } = await plannedRun({ after: async (stage) => {
    if (stage === "build-slice-SLICE-SKELETON" && crash) { crash = false; throw Object.assign(new Error("agent crashed"), { code: "unexpected_error" }); }
  } });
  const parked = await make().start(job.id);
  assert.equal(parked.state, "failed");
  assert.ok(parked.approvedPlan);
  await patch(path.join(store.appDir(job.id), ".factory/slices.json"), (plan) => { plan.slices[0].title = "Edited after approval"; });
  const before = count(await started(store, job.id), "build-slice-");
  const resumed = await make().resume(job.id);
  assert.equal(resumed.state, "failed");
  assert.equal(resumed.error.code, "stale_plan");
  assert.equal(count(await started(store, job.id), "build-slice-"), before);
});

test("each scoped review sees only its own feature's checks, so later features never block it", async () => {
  const requests = {};
  const { job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage.startsWith("feature-review-")) requests[stage] = await json(path.join(cwd, ".factory/review-request.json"));
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  const ids = (stage) => requests[stage].checks.map((check) => check.id);
  assert.deepEqual(ids("feature-review-SLICE-SKELETON-1"), ["SKELETON-1"]);
  assert.ok(ids("feature-review-SLICE-UI-1").includes("SC-1") && ids("feature-review-SLICE-UI-1").includes("UI-1"));
  assert.match(requests["feature-review-SLICE-UI-1"].candidate, /^[0-9a-f]{64}$/);
});

test("a feature with green gates but missing behavior is never done; resume does not refill its budget", async () => {
  const block = async (stage, cwd) => {
    if (!stage.startsWith("feature-review-SLICE-UI-")) return;
    await patch(path.join(cwd, ".factory/review-result.json"), (report) => {
      report.verdict = "blocked";
      report.blockers = ["The score form is not wired to storage"];
      report.checks[0].status = "missing";
    });
  };
  const { store, job, make } = await plannedRun({ after: block });
  const failed = await make().start(job.id);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.sliceDone, ["SLICE-SKELETON"]);
  assert.equal(failed.sliceIndex, 1);
  assert.equal(failed.featureCursor.id, "SLICE-UI");
  const events = await store.events(job.id, 1000);
  assert.equal(events.filter((event) => event.type === "slice.completed" && event.slice === "SLICE-UI").length, 0);
  let turns = await started(store, job.id);
  assert.equal(count(turns, "repair-"), 2, "two repairs exhaust the feature budget");

  await assert.rejects(make().resume(job.id), { code: "repair_plan_required" });
  const after = await store.read(job.id);
  assert.equal(after.state, "failed");
  assert.equal(after.attempt, failed.attempt);
  assert.deepEqual(after.sliceDone, ["SLICE-SKELETON"]);
  turns = await started(store, job.id);
  assert.equal(count(turns, "repair-"), 2, "resume does not replenish the feature budget");
});

test("final integration has its own two-repair budget after every feature is verified", async () => {
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage !== "review") return;
    await patch(path.join(cwd, ".factory/review-result.json"), (report) => {
      report.verdict = "blocked";
      report.blockers = ["Whole-app regression"];
      report.checks[0].status = "missing";
    });
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  const events = await store.events(job.id, 1000);
  const lastFeature = events.findLastIndex((event) => event.type === "slice.completed");
  const finalRepairs = events.slice(lastFeature).filter((event) => event.type === "agent.started" && event.message.includes("repair-"));
  assert.equal(finalRepairs.length, 2);
  assert.equal(count(await started(store, job.id), "repair-"), 2, "no feature repairs were spent");
});

test("a reviewer that edits the candidate voids its verdict and forces fresh checks and a fresh review", async () => {
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage === "feature-review-SLICE-UI-1") await writeFile(path.join(cwd, "reviewer-edit.js"), "export const x = 1;\n");
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  const turns = await started(store, job.id);
  assert.equal(count(turns, "feature-review-SLICE-UI-1"), 1);
  assert.equal(count(turns, "feature-review-SLICE-UI-2"), 1);
  assert.equal(result.sliceStats["SLICE-UI"].reviews, 2);
  const events = await store.events(job.id, 1000);
  assert.ok(events.some((event) => event.type === "gate.failed" && /verdict is void/.test(event.message)));
});

test("a reviewer that edits the candidate every time stops at the review cap", async () => {
  let n = 0;
  const { store, job, factory } = await plannedRun({ after: async (stage, cwd) => {
    if (stage.startsWith("feature-review-SLICE-SKELETON-")) await writeFile(path.join(cwd, "reviewer-edit.js"), `export const x = ${++n};\n`);
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "review_unstable");
  assert.deepEqual(result.sliceDone ?? [], []);
  assert.equal(count(await started(store, job.id), "build-slice-SLICE-UI"), 0, "a dependent never starts");
});

test("a pause after checks resumes at review: no rebuild, no duplicate completion", async () => {
  let factory;
  let jobId;
  let paused = false;
  const commandRunner = async () => {
    if (!paused) { paused = true; await factory.pause(jobId); }
    return { code: 0, output: "passed" };
  };
  const run = await plannedRun({ commandRunner });
  ({ factory } = run);
  jobId = run.job.id;
  const result = await factory.start(jobId);
  assert.equal(result.state, "paused");
  assert.equal(result.featureCursor.id, "SLICE-SKELETON");
  assert.equal(result.featureCursor.substage, "reviewing");

  const resumed = await run.make().resume(jobId);
  assert.equal(resumed.state, "completed", resumed.error?.message);
  const turns = await started(run.store, jobId);
  assert.equal(count(turns, "build-slice-SLICE-SKELETON") + count(turns, "slice-resume-SLICE-SKELETON"), 1, "implementation ran once");
  assert.equal(count(turns, "feature-review-SLICE-SKELETON-"), 1, "review ran once");
  const events = await run.store.events(jobId, 1000);
  assert.equal(events.filter((event) => event.type === "slice.completed" && event.slice === "SLICE-SKELETON").length, 1);
});

test("a failed checkpoint commit does not advance the cursor; resume retries the commit", async () => {
  const { store, job, make } = await plannedRun();
  const commit = store.commit.bind(store);
  store.commit = async (message) => {
    if (message === "factory: feature SLICE-SKELETON verified") throw new Error("disk full");
    return commit(message);
  };
  const failed = await make().start(job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "checkpoint_failed");
  assert.deepEqual(failed.sliceDone ?? [], []);
  assert.equal(failed.featureCursor.substage, "committing");

  store.commit = commit;
  const resumed = await make().resume(job.id);
  assert.equal(resumed.state, "completed", resumed.error?.message);
  assert.match(resumed.sliceStats["SLICE-SKELETON"].commit, /^[0-9a-f]{40}$/);
  assert.equal(count(await started(store, job.id), "feature-review-SLICE-SKELETON-"), 1, "the reviewed candidate is not reviewed again");
});

test("each distinct obligation proof runs as its own gate, and a failing proof blocks the feature", async () => {
  const calls = [];
  const proof = ["node", "--test", "ui.test.mjs"];
  const commandRunner = async ({ executable, args }) => {
    const argv = [executable, ...args];
    calls.push(argv.join(" "));
    return argv.join(" ") === proof.join(" ") ? { code: 1, output: "ui.test.mjs: 1 failing" } : { code: 0, output: "passed" };
  };
  const { store, job, factory } = await plannedRun({ commandRunner, after: async (stage, cwd) => {
    if (stage === "feature-plan") await patch(path.join(cwd, ".factory/slices.json"), (plan) => { plan.slices[1].acceptance[0].proof.command = proof; });
  } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.sliceDone, ["SLICE-SKELETON"]);
  assert.equal(calls.filter((line) => line === proof.join(" ")).length, 3, "the proof reran after each of two repairs");
  const events = await store.events(job.id, 1000);
  assert.ok(events.some((event) => event.type === "gate.failed" && event.gate === "proof-UI-1"));
});

test("a feature that exhausts its budget gets a repair plan that keeps verified features and the approved plan", async () => {
  const { store, job, make } = await plannedRun({ after: async (stage, cwd) => {
    if (!stage.startsWith("feature-review-SLICE-UI-")) return;
    await patch(path.join(cwd, ".factory/review-result.json"), (report) => { report.verdict = "blocked"; report.blockers = ["Not wired"]; report.checks[0].status = "missing"; });
  } });
  const failed = await make().start(job.id);
  assert.equal(failed.state, "failed");
  const ready = await make().planRecovery(job.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  assert.deepEqual(ready.recoveryPhase.request.checks.map((check) => check.id), ["SC-1"], "only checks the unfinished features close");
  assert.deepEqual(ready.recoveryPhase.request.completed, ["SLICE-SKELETON"]);
  assert.equal(digest(ready.recoveryPhase.request.priorPlan), digest(failed.approvedPlan.plan));
  assert.deepEqual((await store.read(job.id)).sliceDone, ["SLICE-SKELETON"]);
  const deployed = [];
  const result = await make({ deployer: async (...args) => { deployed.push(args); return deployer(); } }).startRecovery(job.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(deployed.length, 1);
});

const late = async (cwd, name, body) => {
  await mkdir(path.join(cwd, ".factory/uploads"), { recursive: true });
  await writeFile(path.join(cwd, ".factory/uploads", name), body);
};

test("a supplied input edited after plan approval stops the run before review or deploy", async () => {
  let deployed = 0;
  const { store, job, make } = await plannedRun({ uploads: { "SPEC.md": "v1" }, after: async (stage, cwd) => {
    if (stage === "build-slice-SLICE-UI") await late(cwd, "SPEC.md", "v2: new scope");
  } });
  const result = await make({ deployer: async () => { deployed++; return deployer(); } }).start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "inputs_changed");
  assert.equal(count(await started(store, job.id), "feature-review-SLICE-UI-"), 0);
  assert.equal(deployed, 0);
  await assert.rejects(make().resume(job.id), { code: "repair_plan_required" });
});

test("a supplied input edited during the final review voids it and the run fails closed without deploying", async () => {
  let deployed = 0;
  const { job, make } = await plannedRun({ uploads: { "SPEC.md": "v1" }, after: async (stage, cwd) => {
    if (stage === "review") await late(cwd, "SPEC.md", "v2: new scope");
  } });
  const result = await make({ deployer: async () => { deployed++; return deployer(); } }).start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "inputs_changed");
  assert.equal(deployed, 0);
});

test("an upload for another brief during a run does not affect it", async () => {
  const { job, make } = await plannedRun({ uploads: { "SPEC.md": "v1" }, after: async (stage, cwd) => {
    if (stage === "build-slice-SLICE-UI" || stage === "review") await late(cwd, `${stage}-next-brief.png`, "image for a queued brief");
  } });
  const result = await make().start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.deepEqual(result.approvedPlan.sources.map((item) => item.path).filter((file) => file.includes("uploads")), [".factory/uploads/SPEC.md"]);
});

test("changed inputs get a repair plan that keeps verified features and names the change", async () => {
  const { store, job, make } = await plannedRun({ uploads: { "SPEC.md": "v1" }, after: async (stage, cwd) => {
    if (stage === "feature-plan") await patch(path.join(cwd, ".factory/slices.json"), (plan) => { plan.slices[1].acceptance[0].sources.push({ path: ".factory/uploads/SPEC.md", locator: "§1" }); });
    if (stage === "build-slice-SLICE-UI") await late(cwd, "SPEC.md", "v2: new scope");
  } });
  const failed = await make().start(job.id);
  assert.equal(failed.error.code, "inputs_changed");
  const ready = await make().planRecovery(job.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  const request = ready.recoveryPhase.request;
  assert.equal(request.review, null);
  assert.deepEqual(request.inputsChanged, [".factory/uploads/SPEC.md"]);
  assert.match(request.blockers[0], /SPEC\.md changed/);
  assert.deepEqual(request.completed, ["SLICE-SKELETON"]);
  assert.deepEqual(request.checks.map((check) => check.id), ["SC-1"]);
  const result = await make().startRecovery(job.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, "completed", result.error?.message);
  assert.deepEqual((await store.read(job.id)).sliceDone, ["SLICE-SKELETON"]);
});

for (const corrected of [false, true]) test(`a feature plan omitting detailed supplied requirements ${corrected ? "is corrected before" : "blocks before any"} build`, async () => {
  const sourceRequests = [];
  const { store, job, factory } = await plannedRun({ uploads: { "SPEC.md": "§3 EXIF offsets: group by calendar day in the capture offset.\n" }, after: async (stage, cwd) => {
    const planFile = path.join(cwd, ".factory/slices.json");
    if (stage === "feature-plan") sourceRequests.push((await json(path.join(cwd, ".factory/plan-request.json"))).sources);
    if (corrected && stage.startsWith("plan-correction-")) await patch(planFile, (plan) => {
      plan.slices[1].acceptance.push({ id: "EXIF-1", behavior: "Calendar-day grouping honors EXIF offsets", refs: plan.slices[1].closes.slice(0, 1), sources: [{ path: ".factory/uploads/SPEC.md", locator: "§3 EXIF offsets" }], proof: { command: ["npm", "test"], expect: "exif offsets test passes" } });
    });
    if (!stage.startsWith("plan-review-")) return;
    const cited = (await json(planFile)).slices.some((slice) => slice.acceptance.some((item) => item.sources?.some((ref) => ref.path === ".factory/uploads/SPEC.md" && /EXIF offsets/.test(ref.locator))));
    if (!cited) await patch(path.join(cwd, ".factory/plan-review-result.json"), (verdict) => { verdict.verdict = "blocked"; verdict.blockers = ["SPEC.md §3 EXIF offsets has no obligation"]; });
  } });
  const result = await factory.start(job.id);
  assert.ok(sourceRequests[0].some((ref) => ref.path === ".factory/uploads/SPEC.md"), "the planner sees supplied specs");
  if (corrected) {
    assert.equal(result.state, "completed", result.error?.message);
    assert.ok(result.approvedPlan.plan.slices[1].acceptance.some((item) => item.id === "EXIF-1"));
    assert.match(result.approvedPlan.sourcesDigest, /^[0-9a-f]{64}$/);
  } else {
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "plan_blocked");
    assert.match(result.error.message, /EXIF offsets/);
    assert.equal(count(await started(store, job.id), "build-slice-"), 0);
  }
});

test("inputs changed after every feature verified reopen only the features that cited them", async () => {
  const { job, make } = await plannedRun({ uploads: { "SPEC.md": "v1" }, after: async (stage, cwd) => {
    if (stage === "feature-plan") await patch(path.join(cwd, ".factory/slices.json"), (plan) => { plan.slices[1].acceptance[0].sources.push({ path: ".factory/uploads/SPEC.md", locator: "§1" }); });
    if (stage === "review") await late(cwd, "SPEC.md", "v2: new scope");
  } });
  const failed = await make().start(job.id);
  assert.equal(failed.error.code, "inputs_changed");
  assert.deepEqual(failed.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  const ready = await make().planRecovery(job.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  assert.deepEqual(ready.recoveryPhase.request.checks.map((check) => check.id), ["SC-1"], "SLICE-UI cited SPEC.md, so its check reopens");
  assert.ok(ready.recoveryPhase.request.blockers.some((line) => /SC-1 was closed by a verified feature/.test(line)));
  const result = await make().startRecovery(job.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, "completed", result.error?.message);
});

// A proof pending integration: not run or reviewed with its feature, run before the final review,
// and the check it proves is reported pending, not verified, until then.
async function pendingRun(proof, { plan = () => {}, after: extra = async () => {}, commandRunner = null } = {}) {
  const featureReviewChecks = [];
  const commands = [];
  const run = await plannedRun({
    commandRunner: commandRunner ?? (async ({ args }) => { commands.push(args.join(" ")); return { code: args.includes("test/populated.test.mjs") ? proof.code : 0, output: "populated test output" }; }),
    after: async (stage, cwd, context) => {
      if (stage === "feature-plan") await patch(path.join(cwd, ".factory/slices.json"), (p) => {
        const ui = p.slices[1];
        ui.acceptance.push({ id: "POP-1", behavior: "A populated history renders once every feature is integrated", refs: ui.closes.slice(0, 1), sources: ui.acceptance[0].sources, proof: { command: ["node", "--test", "test/populated.test.mjs"], expect: "populated test passes", pending: "integration" } });
        plan(p);
      });
      if (stage === "feature-review-SLICE-UI-1") featureReviewChecks.push(...(await json(path.join(cwd, ".factory/review-request.json"))).checks.map((check) => check.id));
      await extra(stage, cwd, context);
    },
  });
  const result = await run.factory.start(run.job.id);
  const events = await run.store.events(run.job.id, 1000);
  return { ...run, result, events, featureReviewChecks, commands };
}

test("a proof pending integration runs before the final review and its check is pending until then", async () => {
  const { result, events, featureReviewChecks } = await pendingRun({ code: 0 });
  assert.equal(result.state, "completed", result.error?.message);
  const owned = result.approvedPlan.plan.slices[1].closes[0];
  const ledger = result.outstandingProofs.find((entry) => entry.obligation.id === "POP-1");
  assert.equal(ledger.status, "passed");
  assert.match(ledger.candidate, /^[a-f0-9]{64}$/);
  assert.ok(ledger.verifiedAt);
  assert.ok(!featureReviewChecks.includes("POP-1") && !featureReviewChecks.includes(owned), "the feature review neither runs the pending proof nor verifies its check");
  const uiDone = events.findIndex((event) => event.type === "slice.completed" && event.slice === "SLICE-UI");
  assert.match(events[uiDone].message, new RegExp(`${owned} pending integration proof`));
  const proofGate = events.findIndex((event) => event.type === "gate.started" && event.gate === ledger.gate);
  assert.ok(proofGate > uiDone, "the pending proof never runs while its feature is built");
  const finalReview = events.findIndex((event, i) => i > uiDone && event.type === "agent.started" && /\breview\b/.test(event.message) && !event.message.includes("feature-review"));
  assert.ok(proofGate < finalReview, "the pending proof runs before the final review");
  assert.ok(result.reviewRequest.checks.some((check) => check.id === ledger.key), "the final review covers the pending obligation");
});

test("a failing proof pending integration stops the run before it completes", async () => {
  const { result } = await pendingRun({ code: 1 });
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "quality_gate_failed");
  assert.match(result.error.details?.gate, /^proof-.*POP-1$/);
  assert.equal(result.deployment ?? null, null);
});

test("a pending proof that exhausts its budget gets a repair plan from the failed obligation, not a review", async () => {
  const proof = { code: 1 };
  const { result, factory, store } = await pendingRun(proof);
  assert.equal(result.error.code, "quality_gate_failed");
  assert.equal(result.recovery.canResume, false);
  await assert.rejects(factory.resume(result.id), /repair plan/i);
  const ready = await factory.planRecovery(result.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  const request = ready.recoveryPhase.request;
  assert.equal(request.review, null);
  assert.deepEqual(request.checks.map((check) => check.id), ["SC-1"]);
  assert.ok(request.blockers.some((item) => /populated\.test\.mjs/.test(item) && /populated test output/.test(item)), request.blockers.join("\n"));
  proof.code = 0;
  const done = await factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(done.state, "completed", done.error?.message);
  assert.ok((await store.events(done.id, 2000)).some((event) => event.type === "gate.passed" && /POP-1$/.test(event.gate ?? "")), "the original pending proof still runs and passes");
});

test("a pending proof on a prerequisite keeps the check it supports pending at the closing feature", async () => {
  const { result, events, featureReviewChecks } = await pendingRun({ code: 0 }, { plan: (p) => {
    p.slices[1].acceptance.pop();
    p.slices[0].acceptance.push({ id: "PRE-1", behavior: "Populated history survives a restart of the skeleton", refs: ["SC-1"], sources: p.slices[0].acceptance[0].sources, proof: { command: ["node", "--test", "test/populated.test.mjs"], expect: "populated test passes", pending: "integration" } });
  } });
  assert.equal(result.state, "completed", result.error?.message);
  assert.ok(!featureReviewChecks.includes("SC-1"), "the closing feature's review does not verify a check with proof still pending");
  const uiDone = events.find((event) => event.type === "slice.completed" && event.slice === "SLICE-UI");
  assert.match(uiDone.message, /SC-1 pending integration proof/);
});

test("obligation ids shared by the original and a repair plan do not collide in the final review", async () => {
  let planned = false;
  const { result, factory } = await pendingRun({ code: 0 }, { after: async (stage, cwd, context) => {
    if (stage.startsWith("recovery-plan-") && !stage.includes("review")) {
      planned = true;
      await patch(path.join(cwd, context.job.recoveryPhase.planFile), (p) => {
        p.slices[0].acceptance.push({ id: "POP-1", behavior: "Recovered populated history renders end to end", refs: p.slices[0].closes, sources: p.slices[0].acceptance[0].sources, proof: { command: ["node", "--test", "test/populated.test.mjs"], expect: "populated test passes", pending: "integration" } });
      });
    }
    if (stage === "review" && !planned) await patch(path.join(cwd, ".factory/review-result.json"), (r) => { r.verdict = "blocked"; r.blockers = ["SC-1 is not demonstrated"]; r.checks.find((c) => c.id === "SC-1").status = "missing"; });
  } });
  assert.equal(result.error?.code, "review_rejected");
  const ready = await factory.planRecovery(result.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  const done = await factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(done.state, "completed", done.error?.message);
  const ids = done.reviewRequest.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate review check ids");
  assert.equal(ids.filter((id) => id.endsWith("/POP-1")).length, 2, "both plans' POP-1 obligations are reviewed");
});


test("a deferred proof sharing npm test keeps all its repair targets after deduplication", async () => {
  let integrated = false;
  const proof = { code: 1 };
  const { result, factory } = await pendingRun(proof, {
    plan: p => {
      const item = p.slices[1].acceptance.at(-1);
      item.proof.command = ["npm", "test"];
      p.slices[1].acceptance.push({ ...structuredClone(item), id: "POP-2", behavior: "Integrated standalone detail works", refs: [] });
    },
    after: async stage => { if (stage === "feature-review-SLICE-UI-1") integrated = true; },
    commandRunner: async ({ executable, args }) => ({ code: integrated && executable === "npm" && args[0] === "test" ? proof.code : 0, output: "shared integration failure" }),
  });
  assert.equal(result.error.code, "quality_gate_failed");
  assert.equal(result.error.details.gate, "test");
  assert.equal(result.recovery.canResume, false);
  const ready = await factory.planRecovery(result.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  assert.equal(ready.recoveryPhase.request.checks.length, 2);
  assert.ok(ready.recoveryPhase.request.checks.some(c => c.id === "SC-1"));
  assert.ok(ready.recoveryPhase.request.checks.some(c => c.id.endsWith("/POP-2")));
  proof.code = 0;
  const done = await factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(done.state, "completed", done.error?.message);
  assert.ok(done.outstandingProofs.every(e => e.status === "passed"));
});

test("a standalone deferred obligation is a repair target even without MH or SC refs", async () => {
  const proof = { code: 1 };
  const { result, factory } = await pendingRun(proof, { plan: p => { p.slices[1].acceptance.at(-1).refs = []; } });
  const ready = await factory.planRecovery(result.id);
  assert.equal(ready.recoveryPhase.status, "ready", ready.error?.message);
  const check = ready.recoveryPhase.request.checks[0];
  assert.equal(check.id, result.outstandingProofs[0].key);
  assert.match(check.text, /populated history/);
  proof.code = 0;
  const done = await factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(done.state, "completed", done.error?.message);
});

test("a deployment repair invalidates passed integration evidence and reruns its proof", async () => {
  let deploys = 0;
  let proofRunsAfterDeploy = 0;
  let originalCandidate;
  const run = await pendingRun({ code: 0 });
  const factory = run.make({
    deployer: async ({ job, appDir }) => {
      deploys++;
      if (deploys === 1) {
        assert.equal(job.outstandingProofs[0].status, "passed");
        originalCandidate = job.outstandingProofs[0].candidate;
        await writeFile(path.join(appDir, "changed.js"), "// changed application candidate\n");
        const error = new Error("launch failed"); error.code = "deployment_exited"; throw error;
      }
      return deployer();
    },
    commandRunner: async ({ args }) => {
      if (args.includes("test/populated.test.mjs") && deploys) {
        proofRunsAfterDeploy++;
        const job = (await run.store.list()).find(j => j.state === "verifying");
        assert.equal(job.outstandingProofs[0].status, "pending");
      }
      return passing();
    },
  });
  // Fresh job in the isolated fixture; never reuse the completed run's state.
  const job = await run.store.create({ brief, transcript, provider: "fixture" });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed", done.error?.message);
  assert.equal(deploys, 2);
  assert.ok(proofRunsAfterDeploy >= 2, "proof runs after deployment repair and again after final review");
  assert.notEqual(done.outstandingProofs[0].candidate, originalCandidate);
  assert.ok(done.outstandingProofs.every(e => e.status === "passed"));
});


test("each manifest gate sharing a proof command retains the integration target", async () => {
  const { factory, store, job } = await plannedRun();
  const key = "a".repeat(64) + ":A/B";
  const manifest = { commands: { install: ["npm", "test"], test: ["npm", "test"], build: ["npm", "test"] } };
  for (const failedGate of ["install", "test", "build"]) {
    let calls = 0;
    const at = ["install", "test", "build"].indexOf(failedGate) + 1;
    factory.commandRunner = async () => ({ code: ++calls === at ? 1 : 0, output: "shared manifest failure" });
    const error = await factory.verify(await store.read(job.id), manifest, undefined, {
      includeInstall: true, proofs: [{ id: "A.B", key, proof: { command: ["npm", "test"] } }],
    });
    assert.equal(error.details.gate, failedGate);
    assert.deepEqual(error.details.proofKeys, [key]);
  }
});


test("integration evidence binds the source after ordinary installation creates a lockfile", async () => {
  let integrated = false;
  let installed = false;
  const run = await pendingRun({ code: 0 }, {
    after: async stage => { if (stage === "feature-review-SLICE-UI-1") integrated = true; },
    commandRunner: async ({ executable, args, cwd }) => {
      if (integrated && executable === "npm" && args[0] === "install" && !installed) {
        installed = true;
        await writeFile(path.join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n');
      }
      return passing();
    },
  });
  assert.equal(run.result.state, "completed", run.result.error?.message);
  // Planned runs install per feature; explicitly exercise an integrated install (as deploy repairs do).
  const checked = await run.factory.verifyWithRepairs(run.result, await run.factory.readManifest(run.store.appDir()), undefined, { includeInstall: true });
  assert.ok(installed);
  const reviewed = await run.factory.reviewAndVerify(checked);
  assert.equal(reviewed.outstandingProofs[0].status, "passed");
});
