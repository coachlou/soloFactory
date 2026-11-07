import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, runSpend, spendLine, continuationAction } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const usage = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, costUsd: null, models: ["m"] };

async function setup(t) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-run-budget-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "single" });
  const fixture = createFixtureProvider();
  const stages = [];
  const provider = { id: "fixture", async run(options) { stages.push(options.context.stage); return { ...(await fixture.run(options)), usage }; } };
  const factory = new SoloFactory({ store, provider, commandRunner: async () => ({ code: 0, output: "passed" }), deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9978" }) });
  t.after(() => factory.shutdown());
  return { store, job, factory, stages };
}

test("the worker ceiling parks the run before the next worker, and Resume grants another allotment", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_WORKERS = "1";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_WORKERS);
  const { job, factory, stages } = await setup(t);

  const parked = await factory.start(job.id);
  assert.equal(parked.state, "failed");
  assert.equal(parked.error.code, "run_budget_reached");
  assert.deepEqual(stages, ["specification"], "the second worker never started");
  assert.match(parked.error.message, /1 worker, 1K tokens, cost unknown, \d+m elapsed\. Resume allows another 1 workers/);
  assert.equal(parked.recovery.nextAction.action, "resume");

  const resumed = await factory.resume(job.id);
  assert.equal(stages.length, 2, "Resume allowed exactly one more worker");
  assert.equal(resumed.error?.code, "run_budget_reached");
});

test("a ceiling of 0 disables the check", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_WORKERS = "0";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_WORKERS);
  const { job, factory } = await setup(t);
  assert.equal((await factory.start(job.id)).state, "completed");
});

test("telemetry carries the spend shown before a recovery approval", async (t) => {
  const { job, factory } = await setup(t);
  await factory.start(job.id);
  const { spend } = await factory.telemetry(job.id, { probeApp: false });
  assert.ok(spend.workers > 0 && spend.tokens === spend.workers * 1100 && spend.costUsd === null && spend.grantTurns === null);
  const stored = await factory.store.read(job.id);
  const planned = runSpend({ ...stored, recoveryPhase: { plan: { slices: [{}, {}, {}] } } }, [], 2);
  assert.equal(planned.grantTurns, 8, "maxRepairs * (features + 1), the refill in runFeatureRecovery");
  assert.match(spendLine({ workers: 2, tokens: 1500000, costUsd: 4.5, elapsedMs: 125 * 60000 }), /^2 workers, 1\.5M tokens, cost \$4\.50, 2h 5m elapsed$/);
});

test("any owner continuation after the ceiling grants another allotment, not only Resume", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_WORKERS = "5";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_WORKERS);
  const { job, factory } = await setup(t);
  // Parked at the ceiling while preparing a repair plan: the only offered step is retrying the plan, not Resume.
  Object.assign(job, { state: "failed", error: { code: "run_budget_reached", message: "ceiling", details: { workers: 5 } }, recoveryPhase: { status: "plan_failed", request: {} } });
  await factory.store.writeState(job);
  assert.equal(continuationAction(job).action, "retry-plan");
  await factory.activate(job.id, async () => {});
  assert.equal((await factory.store.read(job.id)).workerAllowance, 10);
});

test("the spend counts recent approvals that verified no feature", () => {
  const phase = (done, extra = {}) => ({ approvedAt: "2026-11-01", status: "running", done, ...extra });
  const spend = (history, current) => runSpend({ recoveryPhaseHistory: history, recoveryPhase: current, createdAt: "2026-11-01" }, [], 2).idleApprovals;
  assert.equal(spend([], undefined), 0);
  assert.equal(spend([phase(["A"]), phase([]), phase([], { status: "discarded" })], phase([])), 2, "a discarded phase and an unapproved plan are not approvals");
  assert.equal(spend([phase([]), phase(["A"])], { status: "ready", done: [] }), 0, "a verified feature resets the count");
});

test("the cost ceiling parks on reported spend, skips turns with no figure, and Resume grants another allotment", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_COST_USD = "1.5";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_COST_USD);
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-run-cost-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "single" });
  const fixture = createFixtureProvider();
  const stages = [];
  // A killed or Codex turn reports no cost; it must not make the total unknown and switch the ceiling off.
  const provider = { id: "fixture", async run(options) { stages.push(options.context.stage); return { ...(await fixture.run(options)), usage: { ...usage, costUsd: stages.length === 1 ? null : 2 } }; } };
  const factory = new SoloFactory({ store, provider, commandRunner: async () => ({ code: 0, output: "passed" }), deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9978" }) });
  t.after(() => factory.shutdown());

  const parked = await factory.start(job.id);
  assert.equal(parked.error?.code, "run_budget_reached");
  assert.equal(stages.length, 2, "the first turn reported no cost; $2 is over $1.50, so the third worker never started");
  assert.match(parked.error.message, /spent about \$2\.00, the ceiling of \$1.5 \(SOLOFACTORY_MAX_RUN_COST_USD\).*Resume allows another \$1.5/);
  assert.match(parked.error.details.diagnostics[0].title, /Run cost ceiling reached/);

  await factory.resume(job.id);
  assert.equal((await store.read(job.id)).costAllowance, 3.5, "spent $2 plus one more $1.50 allotment");
  assert.ok(stages.length >= 3, "Resume let work continue past the first ceiling");
});
