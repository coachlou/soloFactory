// Planned-feature (slices.json v2) execution: the PRD acceptance matrix at the factory level.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const deployer = async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9981" });
const passing = async () => ({ code: 0, output: "passed" });

// A default (planned) run whose fixture turns can be post-processed per stage by `after`.
async function plannedRun({ after = async () => {}, commandRunner = passing } = {}) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-features-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  assert.equal(job.planVersion, 2);
  const fixture = createFixtureProvider();
  const provider = { id: "fixture", async run(options) {
    const result = await fixture.run(options);
    await after(options.context.stage, options.cwd);
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

  const resumed = await make().resume(job.id);
  assert.equal(resumed.state, "failed");
  assert.deepEqual(resumed.sliceDone, ["SLICE-SKELETON"]);
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
