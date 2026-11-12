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

// failures: gate -> how many of its first runs fail. timedOut makes them time out instead.
async function setup(t, failures, { timedOut = false } = {}) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-flaky-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "single" });
  const fixture = createFixtureProvider();
  const stages = [];
  const runs = {};
  const provider = { id: "fixture", async run(options) { stages.push(options.context.stage); return fixture.run(options); } };
  const commandRunner = async ({ gate }) => {
    runs[gate] = (runs[gate] ?? 0) + 1;
    if (runs[gate] <= (failures[gate] ?? 0)) return timedOut ? { code: null, timedOut: true, output: "" } : { code: 1, output: `${gate} run ${runs[gate]} failed: expected failed, got transcribing` };
    return { code: 0, output: "passed" };
  };
  const factory = new SoloFactory({ store, provider, commandRunner, deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9978" }) });
  t.after(() => factory.shutdown());
  return { store, job, factory, stages, runs };
}
const repairs = (stages) => stages.filter((stage) => stage.startsWith("repair")).length;
const eventsOf = async (store, id) => (await readFile(path.join(store.jobDir(id), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("a final test gate that fails once and passes on the rerun completes with no repair, and is recorded", async (t) => {
  const { store, job, factory, stages, runs } = await setup(t, { test: 1 });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed");
  assert.equal(repairs(stages), 0, "the rerun cost no repair turn");
  assert.equal(runs.test, 2);
  assert.equal(done.flakyGates.length, 1);
  assert.equal(done.flakyGates[0].gate, "test");
  assert.match(done.flakyGates[0].output, /test run 1 failed/);
  const events = await eventsOf(store, job.id);
  assert.equal(events.filter((event) => event.type === "gate.flaky").length, 1);
  const request = JSON.parse(await readFile(path.join(store.appDir(job.id), ".factory", "review-request.json"), "utf8"));
  assert.deepEqual(request.flakyGates.map((item) => item.gate), ["test"], "the final review is told");
});

test("a final test gate that fails twice goes to repair with the rerun's output", async (t) => {
  const { store, job, factory, stages, runs } = await setup(t, { test: 2 });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed");
  assert.equal(repairs(stages), 1);
  assert.equal(runs.test, 3, "two runs, then one after the repair");
  assert.equal(done.flakyGates, undefined);
  const events = await eventsOf(store, job.id);
  assert.match(events.find((event) => event.type === "gate.failed" && event.gate === "test")?.message ?? "", /test/);
  assert.match(await readFile(path.join(store.appDir(job.id), ".factory", "last-failure-1.txt"), "utf8"), /test run 2 failed/);
});

test("a timed-out test gate is not rerun", async (t) => {
  const { job, factory, runs } = await setup(t, { test: 1 }, { timedOut: true });
  const done = await factory.start(job.id);
  assert.equal(done.error?.code, "gate_timeout");
  assert.equal(runs.test, 1);
});

test("a build failure is not rerun (only test and proof gates are)", async (t) => {
  const { job, factory, stages, runs } = await setup(t, { build: 1 });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed");
  assert.equal(runs.build, 2, "one failure, then one run after the repair");
  assert.equal(repairs(stages), 1);
  assert.equal(done.flakyGates, undefined);
});

// Feature mode: the fixture plans a skeleton and a UI feature. runner(options, final) decides each gate run.
async function featureRun(t, runner, { npmTestProof = false } = {}) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-flaky-features-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  const stages = [];
  const provider = { id: "fixture", async run(options) {
    stages.push(options.context.stage);
    const result = await fixture.run(options);
    if (npmTestProof && options.context.stage === "feature-plan") {
      const file = path.join(options.cwd, ".factory/slices.json");
      const plan = JSON.parse(await readFile(file, "utf8"));
      const item = plan.slices[1].acceptance[0];
      // A proof whose command is npm test: its cases merge into the test gate at final integration.
      item.proof.command = ["npm", "test"];
      item.cases = [{ id: "UI-1-C", surface: "cli", action: "use it", expect: "it works", refs: item.refs, sources: [{ path: ".factory/ACCEPTANCE.md", locator: "Acceptance contract" }] }];
      await writeFile(file, JSON.stringify(plan, null, 2));
    }
    return result;
  } };
  const commandRunner = (options) => runner(options, /^test-\d+\.log$/.test(path.basename(options.logPath)));
  const factory = new SoloFactory({ store, provider, commandRunner, deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9979" }), autoStartRepairs: false });
  t.after(() => factory.shutdown());
  return { store, job, factory, stages };
}

test("a cased npm test that fails once at final integration and passes on the rerun leaves its cases passed", async (t) => {
  let finals = 0;
  const { store, job, factory, stages } = await featureRun(t, async (options, final) => {
    const events = options.env?.SOLOFACTORY_CASE_EVENTS;
    const fail = final && ++finals === 1;
    if (events) await writeFile(events, `${JSON.stringify({ type: fail ? "test:fail" : "test:pass", name: "[UI-1-C] works" })}\n`);
    return fail ? { code: 1, output: "[UI-1-C] expected failed, got transcribing" } : { code: 0, output: "passed" };
  }, { npmTestProof: true });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed", done.error?.message);
  assert.equal(finals, 2);
  assert.equal(repairs(stages), 0);
  assert.equal(done.caseResults["UI-1-C"].status, "passed", "the rerun's case results replace the first run's");
  assert.equal(done.flakyGates.length, 1);
  assert.equal((await store.events(job.id, 1000)).filter((event) => event.type === "gate.flaky").length, 1);
});

test("a gate that fails once while a feature is built is not rerun: it goes to repair", async (t) => {
  const runs = {};
  const { store, job, factory, stages } = await featureRun(t, async (options) => {
    const log = path.basename(options.logPath);
    runs[log] = (runs[log] ?? 0) + 1;
    return log === "test-SLICE-UI-0.log" && runs[log] === 1 ? { code: 1, output: "UI proof failed" } : { code: 0, output: "passed" };
  });
  const done = await factory.start(job.id);
  assert.equal(done.state, "completed", done.error?.message);
  assert.equal(repairs(stages), 1);
  assert.equal(done.flakyGates, undefined);
  assert.equal((await store.events(job.id, 1000)).filter((event) => event.type === "gate.rerun").length, 0);
});
