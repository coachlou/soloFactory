import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { buildRecoveryPacket, continuationAction, SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { createProvider } from "../src/providers.mjs";
import { normalizeFailure, repeatedFailure, RunMonitor, supervisionStatus, watchConfig, workerAlive } from "../src/watchdog.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker." }];
const config = { progressMs: 1_000, loopThreshold: 3, tickMs: 60_000 };

async function newJob(prefix) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), prefix)));
  await store.init();
  return { store, job: await store.create({ brief, transcript, provider: "fixture" }) };
}

test("settings are validated with documented defaults and ranges", () => {
  assert.deepEqual(watchConfig({}), { progressMs: 20 * 60_000, loopThreshold: 3, gateMs: 5 * 60_000, tickMs: 15_000 });
  assert.equal(watchConfig({ SOLOFACTORY_PROGRESS_MINUTES: "0" }).progressMs, 0);
  assert.equal(watchConfig({ SOLOFACTORY_GATE_MINUTES: "20" }).gateMs, 20 * 60_000);
  for (const env of [{ SOLOFACTORY_PROGRESS_MINUTES: "241" }, { SOLOFACTORY_PROGRESS_MINUTES: "-1" }, { SOLOFACTORY_LOOP_THRESHOLD: "1" }, { SOLOFACTORY_LOOP_THRESHOLD: "abc" }, { SOLOFACTORY_GATE_MINUTES: "0" }, { SOLOFACTORY_GATE_MINUTES: "61" }]) {
    assert.throws(() => watchConfig(env), /must be a whole number/);
  }
});

test("status separates waiting, unknown and needs-checking, and only on a monotonic clock", () => {
  const command = { worker: { kind: "command", startedMono: 0 }, activityMono: null, progressMono: 0, stageMono: 0 };
  assert.equal(supervisionStatus(command, 10_000_000, config), "Waiting for command", "a command inside its deadline is never 'stalled'");
  const silent = { worker: { kind: "agent", startedMono: 100 }, activityMono: null, progressMono: 0, stageMono: 0 };
  assert.equal(supervisionStatus(silent, 10_000_000, config), "Progress unknown", "silence is not evidence of either progress or a stall");
  const chatter = { worker: { kind: "agent", startedMono: 100 }, activityMono: 5_000, progressMono: 0, stageMono: 0 };
  assert.equal(supervisionStatus(chatter, 500, config), "Working");
  assert.equal(supervisionStatus(chatter, 5_000, config), "Progress needs checking");
  assert.equal(supervisionStatus(chatter, 5_000, { progressMs: 0 }), "Working", "0 disables the warning");

  // A wall clock jumping a day ahead (or a server asleep) does not age the run: only `now` counts.
  let mono = 0;
  const monitor = new RunMonitor({ jobId: "j", emit: () => {}, config, now: () => mono, wall: () => Date.now() + 86_400_000 });
  monitor.spawned({ kind: "agent", label: "build", pid: 1 });
  mono = 10; monitor.activity();
  assert.equal(monitor.snapshot().status, "Working");
});

test("monitor counts accepted results once per stage and emits only on notable transitions", () => {
  let mono = 0;
  const events = [];
  const monitor = new RunMonitor({ jobId: "j", emit: (event) => events.push(event.status), config, now: () => mono });
  monitor.observe({ type: "stage.started", message: "Building" });
  monitor.spawned({ kind: "agent", label: "build", pid: 1 });
  mono = 10; monitor.activity();
  mono = 500; monitor.observe({ type: "gate.passed", gate: "test" });
  assert.equal(monitor.snapshot().lastProgressType, "gate.passed");
  // The same result again in the same stage is chatter, not progress.
  mono = 2_000; monitor.observe({ type: "gate.passed", gate: "test" }); monitor.observe({ type: "agent_output", message: "still working" });
  for (let i = 0; i < 20; i += 1) { mono += 100; monitor.tick(); }
  assert.equal(monitor.snapshot().status, "Progress needs checking");
  assert.equal(monitor.snapshot().incident.trigger, "progress_window");
  monitor.exited();
  assert.deepEqual(events, ["Progress needs checking", "Working"], "twenty ticks produce two events, not twenty");
});

test("failure identity ignores volatile output; unknown or changed candidates are never a loop", () => {
  assert.equal(normalizeFailure("at 2026-10-10T12:00:01.123Z /tmp/x-1/a.js took 1234ms port :54321"), normalizeFailure("at 2026-10-11T09:30:00Z /tmp/y-2/a.js took 88ms port :60001"));
  const a = { scope: "S1:test", code: "quality_gate_failed", gate: "test", checks: [], digest: "d", candidate: "c1" };
  assert.equal(repeatedFailure([a, a, a], 3).count, 3);
  assert.equal(repeatedFailure([a, a], 3), null);
  assert.equal(repeatedFailure([{ ...a, candidate: null }, { ...a, candidate: null }, { ...a, candidate: null }], 3), null);
  assert.equal(repeatedFailure([a, { ...a, candidate: "c2" }, a], 3), null);
  assert.equal(repeatedFailure([a, { ...a, digest: "e" }, a], 3), null);
});

// Fails every test gate with output whose timestamps differ, so only normalization makes them equal.
const failingTests = async ({ executable, logPath }) => path.basename(logPath).startsWith("test-")
  ? { code: 1, output: `FAIL records a score at ${new Date().toISOString()} (${Math.random() * 100 | 0}ms)` }
  : { code: 0, output: `${executable} passed` };

test("controller: three unchanged failures stop repairs before the budget is spent", async () => {
  const { store, job } = await newJob("solo-watch-loop-");
  const factory = new SoloFactory({ store, provider: createFixtureProvider(), commandRunner: failingTests, maxRepairs: 5, watch: config, deployer: async () => { throw new Error("must not deploy"); } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.details.loop.count, 3);
  assert.equal(result.attempt, 2, "two repair turns left the code unchanged; the third is never dispatched");
  assert.match(result.error.message, /unchanged code/);
  assert.equal(result.watch.incident.trigger, "repeated_failure");
  assert.equal(result.watch.observed.status, "Action needed");
  // A new invocation drops the last park's incident but keeps the durable history; a restart
  // during it then reports its own trigger, never the stale loop.
  const seen = await factory.activate(job.id, async () => {
    const running = await store.read(job.id);
    await store.writeState({ ...running, state: "building", error: null });
    return running.watch;
  });
  assert.equal(seen.incident, undefined);
  assert.equal(seen.attempts.length, 3);
  await store.recoverInterrupted();
  assert.match(buildRecoveryPacket({ ...(await store.read(job.id)), recovery: { actions: [] } }), /Trigger: process_restarted/);
  await store.writeState(result);
  const next = continuationAction(result, { maxRepairs: 5 });
  assert.match(next.reason, /unchanged/);
  // Resume on the same code re-detects the loop at once: history is never cleared.
  const resumed = await factory.resume(job.id);
  assert.equal(resumed.attempt, 2);
  assert.ok(resumed.error.details.loop);
});

test("controller: a second activation while a run is active is refused and writes nothing", async () => {
  const { store, job } = await newJob("solo-watch-busy-");
  const other = await store.create({ brief, transcript, provider: "fixture" });
  const factory = new SoloFactory({ store, provider: createFixtureProvider(), watch: config });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = factory.activate(job.id, () => held);
  const before = JSON.stringify(await store.read(other.id));
  let ran = false;
  // A double click on another run, or on the same one, must not start a second writer.
  for (const id of [other.id, job.id]) {
    await assert.rejects(factory.activate(id, async () => { ran = true; }), (error) => error.code === "factory_busy");
  }
  assert.equal(ran, false);
  assert.equal(JSON.stringify(await store.read(other.id)), before);
  release("done");
  assert.equal(await first, "done");
  assert.equal(await factory.activate(other.id, async () => "second"), "second", "the guard lifts once the active run ends");
});

test("controller: repairs that change code are not a loop and stay bounded by the budget", async () => {
  const { store, job } = await newJob("solo-watch-changed-");
  const fixture = createFixtureProvider();
  let n = 0;
  const provider = { id: "fixture", async run(options) {
    if (/^repair-/.test(options.context.stage)) await writeFile(path.join(options.cwd, `attempt-${(n += 1)}.txt`), String(n));
    return fixture.run(options);
  } };
  const factory = new SoloFactory({ store, provider, commandRunner: failingTests, maxRepairs: 4, watch: config, deployer: async () => { throw new Error("must not deploy"); } });
  const result = await factory.start(job.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error.details.loop, undefined);
  assert.equal(result.attempt, 4, "the original repair budget still bounds changing attempts");
});

test("controller: the progress window warns but never stops a run, and monitoring ends with it", async () => {
  const { store, job } = await newJob("solo-watch-window-");
  const fixture = createFixtureProvider();
  // An agent that is busy (activity) for longer than the window before finishing normally.
  const provider = { id: "fixture", async run(options) {
    options.context.onSpawn({ pid: process.pid }, { hardTimeoutMs: 60_000 });
    options.context.onActivity();
    await new Promise((resolve) => setTimeout(resolve, 40));
    options.context.onActivity();
    return fixture.run(options);
  } };
  const factory = new SoloFactory({ store, provider, watch: { progressMs: 5, loopThreshold: 3, tickMs: 10 }, deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9999" }) });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  const events = await store.events(job.id, 2_000);
  const warnings = events.filter((event) => event.type === "supervision.changed" && event.status === "Progress needs checking");
  assert.ok(warnings.length >= 1, "a busy worker past the window is flagged");
  const agents = events.filter((event) => event.type === "agent.started").length;
  assert.ok(events.filter((event) => event.type === "supervision.changed").length <= 2 * agents, "events follow transitions, not ticks");
  assert.equal(factory.supervision(job.id), null, "monitoring stops when the run completes");
  assert.ok(!result.worker, "worker ownership is released");
});

test("controller: one durable continuation per stage, shared with the provider retry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-watch-codex-"));
  const bin = path.join(root, "bin");
  const countFile = path.join(root, "calls.txt");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_COUNT, JSON.stringify(args) + "\\n");
if (args[1] === "resume") {
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "continued\\n");
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-session" }));
  setTimeout(() => {}, 1500);
}
`);
  await chmod(path.join(bin, "codex"), 0o755);
  const saved = Object.fromEntries(["PATH", "SOLOFACTORY_AGENT_IDLE_MINUTES", "SOLOFACTORY_AGENT_HARD_MINUTES", "SOLOFACTORY_AGENT_BACKOFF_SECONDS", "FAKE_CODEX_COUNT"].map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, SOLOFACTORY_AGENT_IDLE_MINUTES: "0.01", SOLOFACTORY_AGENT_HARD_MINUTES: "0.1", SOLOFACTORY_AGENT_BACKOFF_SECONDS: "0", FAKE_CODEX_COUNT: countFile });

  const { store, job } = await newJob("solo-watch-codex-job-");
  const factory = new SoloFactory({ store, provider: createProvider("codex"), watch: config });
  const first = await factory.invoke(job, "build", "build", undefined);
  assert.equal(first.autoResumes, 1);
  assert.equal((await store.read(job.id)).watch.continuations.build, 1, "recorded durably before the continuation ran");

  // A later process (manual resume, or a restarted server) reads the spent allowance from disk.
  await writeFile(countFile, "");
  const reread = await store.read(job.id);
  await assert.rejects(() => new SoloFactory({ store, provider: createProvider("codex"), watch: config }).invoke(reread, "build-resume", "continue", undefined),
    (error) => error.details?.timeoutReason === "idle" && error.details.autoResumes === 0);
  assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1, "no second continuation is dispatched");
  const events = await store.events(job.id, 500);
  assert.ok(events.some((event) => event.type === "watchdog.decision" && event.decision === "continuation_refused"));
});

test("controller: a silent Claude turn outlives the idle limit: a long tool call (npm test) streams nothing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-watch-claude-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on("end", () => {});
setTimeout(() => { console.log(JSON.stringify({ type: "result", result: "built quietly", session_id: "quiet" })); process.exit(0); }, 1500);
`);
  await chmod(path.join(bin, "claude"), 0o755);
  const saved = Object.fromEntries(["PATH", "SOLOFACTORY_AGENT_IDLE_MINUTES", "SOLOFACTORY_AGENT_HARD_MINUTES"].map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  // Idle limit 0.6s, silence 1.5s: a Codex turn this quiet would be stopped.
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, SOLOFACTORY_AGENT_IDLE_MINUTES: "0.01", SOLOFACTORY_AGENT_HARD_MINUTES: "0.5" });
  const { store, job } = await newJob("solo-watch-claude-job-");
  const factory = new SoloFactory({ store, provider: createProvider("claude"), watch: config });
  const result = await factory.invoke(job, "build", "build", undefined);
  assert.equal(result.message, "built quietly");
  const events = await store.events(job.id, 500);
  assert.ok(!events.some((event) => event.type === "watchdog.decision"), "silence alone triggers no watchdog decision");
});

test("restart: a live worker parks the run; Resume appears only after it exits", async () => {
  const { store, job } = await newJob("solo-watch-restart-");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    job.state = "building";
    job.worker = { pid: child.pid, serverPid: 999_999, kind: "agent", label: "build", startedAt: new Date().toISOString() };
    await store.writeState(job);
    await store.recoverInterrupted();
    const parked = await store.read(job.id);
    assert.equal(parked.error.code, "worker_unconfirmed");
    assert.equal(parked.worker, undefined);
    const next = continuationAction(parked);
    assert.equal(next.action, "stop-worker");
    assert.equal(next.endpoint, null);
    assert.match(next.reason, new RegExp(String(child.pid)));
    child.kill();
    await once(child, "exit");
    assert.equal(continuationAction(parked).action, "resume");
  } finally { child.kill(); }

  // A recorded worker that is already gone is an ordinary interruption.
  const { store: other, job: gone } = await newJob("solo-watch-restart-gone-");
  gone.state = "building";
  gone.worker = { pid: 2 ** 22 + 12345, kind: "agent", label: "build" };
  await other.writeState(gone);
  await other.recoverInterrupted();
  assert.equal((await other.read(gone.id)).error.code, "process_restarted");
});

test("a worker whose leader died still counts as alive while its group has a member", async () => {
  // The leader spawns a grandchild into its group, prints its pid, then exits; the grandchild keeps running.
  const leader = spawn(process.execPath, ["-e", `const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(g.pid); g.unref();`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  leader.stdout.on("data", (chunk) => { out += chunk; });
  await once(leader, "exit");
  const grandchild = Number(out.trim());
  try {
    assert.ok(grandchild > 0);
    assert.equal(workerAlive(leader.pid), true);
  } finally { process.kill(-leader.pid, "SIGKILL"); }
  for (let i = 0; i < 40 && workerAlive(leader.pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(workerAlive(leader.pid), false);
});
