import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, runSpend, spendLine, continuationAction, resumeAdvice, maxRunTokens } from "../src/factory.mjs";
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
  assert.ok(spend.workers > 0 && spend.tokens === spend.workers * 1100 && spend.costUsd === null && spend.grantTurns === null && spend.resume === null, "a finished run offers no resume advice");
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
  assert.match(parked.error.message, /spent about \$2\.00, its limit of \$1\.50 \(SOLOFACTORY_MAX_RUN_COST_USD=1\.5, raised by each resume\).*Resume allows another \$1.5/);
  assert.match(parked.error.details.diagnostics[0].title, /Run cost ceiling reached/);

  await factory.resume(job.id);
  const resumed = await store.read(job.id);
  assert.equal(resumed.costAllowance, 3.5, "spent $2 plus one more $1.50 allotment");
  assert.ok(stages.length >= 3, "Resume let work continue past the first ceiling");

  // Smoke 2026-11-07 parked a second time saying "the ceiling of $3" at $6.10; the message names the raised limit.
  await assert.rejects(factory.assertWorkerBudget({ ...resumed, costAllowance: 3 }), /spent about \$4\.00, its limit of \$3\.00 \(SOLOFACTORY_MAX_RUN_COST_USD=1\.5/);
});

test("the resume advice separates clean stops, progress since the last Resume, and a stuck run", () => {
  const limit = (code) => ({ state: "failed", error: { code: "provider_error", details: { diagnostics: [{ code }] } } });
  const ev = (...types) => types.map((type) => ({ type }));
  assert.equal(resumeAdvice({ state: "running" }, []), null);
  const first = resumeAdvice(limit("run_budget_reached"), ev("gate.passed", "slice.completed"));
  assert.equal(first.tone, "ok");
  assert.match(first.text, /No processing errors: it reached its spending limit\. Since the start: 1 feature verified, 1 new check passed\./);
  const lint = (feature) => ({ type: "gate.passed", gate: "lint", feature });
  const moved = resumeAdvice(limit("run_budget_reached"), [...ev("slice.completed", "job.resumed"), lint("A"), lint("A"), lint("B")]);
  assert.match(moved.text, /Since your last Resume: 0 features verified, 2 new checks passed/, "a repair re-passing the same check counts once");
  assert.equal(resumeAdvice(limit("provider_unavailable"), ev("job.resumed")).tone, "ok", "an outage right after Resume is waiting");
  const stuck = resumeAdvice(limit("run_budget_reached"), [lint("A"), ...ev("job.resumed"), lint("A"), ...ev("gate.failed")]);
  assert.equal(stuck.tone, "bad", "re-passing a check already passed before the Resume is not progress");
  assert.match(stuck.text, /Report this run/);
  assert.equal(resumeAdvice(limit("usage_limit"), ev("job.resumed")).tone, "ok", "an exhausted window is waiting, not a loop");
  assert.equal(resumeAdvice({ state: "paused" }, ev("job.resumed")).tone, "ok");
  assert.equal(resumeAdvice({ state: "failed", error: { code: "agent_timeout" } }, ev("gate.passed")).tone, "warn");
});

test("the token ceiling parks a run that reports no cost, and Resume grants another allotment", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_TOKENS = "2000";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_TOKENS);
  const { store, job, factory, stages } = await setup(t);
  const parked = await factory.start(job.id);
  assert.equal(parked.error?.code, "run_budget_reached");
  assert.equal(stages.length, 2, "2,200 tokens after two workers, so the third never started");
  assert.match(parked.error.message, /used about 2K tokens, its limit of 2K \(SOLOFACTORY_MAX_RUN_TOKENS=2000, raised by each resume\).*Resume allows another 2K tokens/);
  assert.match(parked.error.details.diagnostics[0].title, /Run token ceiling reached/);
  assert.equal(parked.error.details.tokens, 2200);
  await factory.resume(job.id);
  assert.equal((await store.read(job.id)).tokenAllowance, 4200);
  assert.ok(stages.length >= 3, "Resume allowed more workers");
});

test("a token ceiling of 0 disables the check", async (t) => {
  process.env.SOLOFACTORY_MAX_RUN_TOKENS = "0";
  t.after(() => delete process.env.SOLOFACTORY_MAX_RUN_TOKENS);
  const { job, factory } = await setup(t);
  assert.equal((await factory.start(job.id)).state, "completed");
});

test("a run parked before tokens were recorded gets its token allotment from the spend line", async (t) => {
  const { job, factory } = await setup(t);
  Object.assign(job, { state: "failed", error: { code: "run_budget_reached", message: "ceiling", details: { workers: 5, spend: { tokens: 9000 } } } });
  await factory.store.writeState(job);
  await factory.activate(job.id, async () => {});
  assert.equal((await factory.store.read(job.id)).tokenAllowance, 9000 + maxRunTokens());
});
