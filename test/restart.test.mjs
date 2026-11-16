// Restart from slice on a planned (v2) run: the rewound features start clean, nothing else is refilled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const deployer = async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9983" });

test("restart from slice keeps the run's repair count, rebuilds with a normal budget and no stale session or repair plan", async () => {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-restart-v2-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  let parkAtReview = true;
  const seen = [];
  let lastStage = "";
  const provider = { id: "fixture", async run(options) {
    const { stage } = options.context;
    lastStage = stage;
    if (parkAtReview && stage === "review") throw Object.assign(new Error("reviewer crashed"), { code: "unexpected_error" });
    if (stage.startsWith("build-slice-") || stage.startsWith("repair-")) {
      const state = await store.read(job.id);
      seen.push({ stage, resume: options.resumeSessionId ?? null, attempt: state.attempt, limit: state.repairBudgetLimit });
    }
    return { ...(await fixture.run(options)), sessionId: `session-${stage}` };
  } };
  // SLICE-UI's first test gate fails once, so the parked run has spent a repair.
  let failed = false;
  const commandRunner = async ({ logPath }) => {
    if (parkAtReview && !failed && lastStage === "build-slice-SLICE-UI" && path.basename(logPath).startsWith("test-")) { failed = true; return { code: 1, output: "test failed" }; }
    return { code: 0, output: "passed" };
  };
  const make = () => new SoloFactory({ store, provider, commandRunner, deployer });

  const parked = await make().start(job.id);
  assert.equal(parked.state, "failed");
  assert.equal(parked.attempt, 1, "one repair was spent before parking");
  const skeleton = parked.sliceStats["SLICE-SKELETON"];
  // A repair plan in flight when the owner chose to rewind instead.
  parked.recoveryPhase = { id: "R1", status: "running", done: [], index: 0, stats: {}, cursor: { id: "RECOVERY-1", substage: "implementing" } };
  await store.writeState(parked);

  parkAtReview = false;
  seen.length = 0;
  const restarted = await make().restartFromSlice(job.id, "SLICE-UI");
  assert.equal(restarted.state, "completed", restarted.error?.message);
  const rebuild = seen.find((entry) => entry.stage === "build-slice-SLICE-UI");
  assert.equal(rebuild.resume, null, "the rebuilt feature starts a fresh agent session, not the parked one");
  assert.equal(rebuild.attempt, 1, "the run's repair count is not reset, so repair labels and logs never collide");
  assert.equal(rebuild.limit, 1 + make().maxRepairs, "the rebuilt feature gets exactly its normal budget");
  assert.deepEqual(restarted.sliceStats["SLICE-SKELETON"], skeleton, "features before the restart point keep their records");
  assert.equal(restarted.recoveryPhase ?? null, null, "the rewind discarded the repair plan's work");
  assert.equal(restarted.recoveryPhaseHistory.at(-1).id, "R1", "and the plan is archived, not lost");
});

// Brief A: apps the server stopped start again when SoloFactory starts (docs/live-app-restart-rollback-spec.md).
const appSource = `import http from "node:http";
http.createServer((q, r) => r.end(q.url === "/health" ? "ok" : JSON.stringify({ uptimeSeconds: 1, requests: { total: 0, errors: 0 }, latencyMs: { average: 0 }, routes: [] }))).listen(process.env.PORT);`;

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// One project under root/projects/demo whose newest completed run's app was live when the server last stopped.
async function liveProject(t, { source = appSource } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-restart-apps-"));
  const dir = path.join(root, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const store = new JobStore(dir);
  await store.init();
  await writeFile(path.join(dir, "app.mjs"), source);
  const cmd = ["npm", "run", "x"];
  await writeFile(path.join(dir, "factory.json"), JSON.stringify({ version: 1, healthPath: "/health", metricsPath: "/_factory/metrics", commands: { install: cmd, test: cmd, build: cmd, start: ["node", "app.mjs"] } }));
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const port = await freePort();
  job.state = "completed";
  job.deployment = { mode: "local", status: "live", url: `http://127.0.0.1:${port}`, port };
  await store.writeState(job);
  const servers = [];
  const start = async () => {
    const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true });
    servers.push(app);
    await app.appsRestarted;
    return app;
  };
  t.after(() => Promise.all(servers.map((app) => app.close().catch(() => {}))));
  return { root, store, job, port, start };
}

const types = async (store, id) => (await store.events(id, Infinity)).map((event) => event.type);

test("an app running when SoloFactory stops is live again after a restart, on the same port", async (t) => {
  const { store, job, port, start } = await liveProject(t);
  const first = await start(); // the app died with an earlier server: found dead, restarted
  let state = await store.read(job.id);
  assert.equal(state.deployment.status, "live");
  assert.equal(state.deployment.port, port);
  assert.equal(await (await fetch(`${state.deployment.url}/health`)).text(), "ok");
  await first.close(); // clean stop: shutdown marks it stoppedBy server, then kills it
  state = await store.read(job.id);
  assert.equal(state.deployment.stoppedBy, "server");
  await assert.rejects(fetch(`${state.deployment.url}/health`));
  await start();
  state = await store.read(job.id);
  assert.equal(state.deployment.status, "live");
  assert.equal(state.deployment.port, port, "the old port is reused when free");
  assert.ok((await types(store, job.id)).includes("deployment.restarted"));
});

test("an app the owner stopped stays stopped after a restart", async (t) => {
  const { store, job, start } = await liveProject(t);
  const first = await start();
  const response = await fetch(`http://127.0.0.1:${await new Promise((resolve) => first.server.listen(0, "127.0.0.1", () => resolve(first.server.address().port)))}/api/jobs/${job.id}/stop-app`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await store.read(job.id)).deployment.stoppedBy, "owner");
  await first.close();
  await start();
  const state = await store.read(job.id);
  assert.equal(state.deployment.status, "stopped");
  assert.equal(state.deployment.stoppedBy, "owner");
});

test("when the old port is taken the app comes back on a new port and the event names both", async (t) => {
  const { store, job, port, start } = await liveProject(t);
  const squatter = createNetServer((socket) => socket.destroy()); // holds the port, answers nothing
  await new Promise((resolve) => squatter.listen(port, resolve));
  t.after(() => new Promise((resolve) => squatter.close(resolve)));
  await start();
  const state = await store.read(job.id);
  assert.equal(state.deployment.status, "live");
  assert.notEqual(state.deployment.port, port);
  const event = (await store.events(job.id, Infinity)).find((item) => item.type === "deployment.restarted");
  assert.match(event.message, new RegExp(`port ${port}\\b.*port ${state.deployment.port}\\b`));
});

test("an app that fails its health check on restart stays stopped with deployment.restart_failed", async (t) => {
  const { store, job, start } = await liveProject(t, { source: "process.exit(1);" });
  await start();
  const state = await store.read(job.id);
  assert.equal(state.deployment.status, "stopped");
  const events = await types(store, job.id);
  assert.ok(events.includes("deployment.restart_failed"));
  assert.ok(!events.includes("deployment.restarted"));
  assert.equal(events.filter((type) => type === "deployment.restart_failed").length, 1, "no retry");
});

test("SOLOFACTORY_RESTART_APPS=0 relaunches nothing", async (t) => {
  const { store, job, start } = await liveProject(t);
  process.env.SOLOFACTORY_RESTART_APPS = "0";
  t.after(() => { delete process.env.SOLOFACTORY_RESTART_APPS; });
  await start();
  const state = await store.read(job.id);
  assert.equal(state.deployment.status, "stopped");
  assert.equal(state.deployment.stoppedBy, "server");
  assert.ok(!(await types(store, job.id)).some((type) => type.startsWith("deployment.restart")));
});

test("an older completed run behind a newer undismissed run is never relaunched", async (t) => {
  const { store, job, start } = await liveProject(t);
  const newer = await store.create({ brief, transcript, provider: "fixture" });
  newer.state = "failed";
  newer.followOn = true;
  await store.writeState(newer);
  await start();
  const state = await store.read(job.id);
  assert.equal(state.deployment.status, "stopped");
  assert.ok(!(await types(store, job.id)).some((type) => type.startsWith("deployment.restart")));
});
