// G4 (docs/four-tier-gates-spec.md): an app that exits on its own soon after going live says so, beside Relaunch and the rollback offer.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { EARLY_CRASH_MS, SoloFactory, earlyExit } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const started = "2026-11-16T12:00:00.000Z";
const after = (ms) => new Date(Date.parse(started) + ms).toISOString();

test("earlyExit: only an exit nobody asked for, within two minutes of starting", () => {
  const deployment = { status: "stopped", startedAt: started, stoppedBy: "exited", exitCode: 1 };
  assert.deepEqual(earlyExit(deployment, after(30_000)), { afterSeconds: 30, exitCode: 1 });
  assert.deepEqual(earlyExit(deployment, after(EARLY_CRASH_MS)), { afterSeconds: 120, exitCode: 1 });
  assert.equal(earlyExit(deployment, after(EARLY_CRASH_MS + 1)), null, "a later exit is not pinned on the release");
  for (const stoppedBy of ["owner", "server", "replaced"]) assert.equal(earlyExit({ ...deployment, stoppedBy }, after(5_000)), null, stoppedBy);
  assert.equal(earlyExit({ ...deployment, startedAt: undefined }, after(5_000)), null);
  assert.deepEqual(earlyExit({ ...deployment, exitCode: undefined }, after(1_000)), { afterSeconds: 1, exitCode: null });
});

test("a shipped app killed right after going live records earlyExit and says so in its stopped event; Relaunch clears it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-early-crash-"));
  const store = new JobStore(root);
  await store.init();
  await writeFile(path.join(root, "app.mjs"), `import http from "node:http";
http.createServer((q, r) => r.end(q.url === "/health" ? "ok" : JSON.stringify({ uptimeSeconds: 1, requests: { total: 0, errors: 0 }, latencyMs: { average: 0 }, routes: [] }))).listen(process.env.PORT);`);
  const cmd = ["npm", "run", "x"];
  await writeFile(path.join(root, "factory.json"), JSON.stringify({ version: 1, healthPath: "/health", metricsPath: "/_factory/metrics", commands: { install: cmd, test: cmd, build: cmd, start: ["node", "app.mjs"] } }));
  const job = await store.create({ brief, transcript, provider: "fixture" });
  Object.assign(job, { state: "completed", deployment: { mode: "local", status: "stopped", url: "http://127.0.0.1:1" } });
  await store.writeState(job);
  const factory = new SoloFactory({ store, provider: createFixtureProvider() });
  try {
    const live = await factory.relaunch(job.id);
    assert.equal(live.deployment.status, "live");
    // The app dies on its own, as far as SoloFactory can tell: nobody marked the stop first.
    const child = factory.deployments.get(job.id);
    await new Promise((resolve) => { child.once("exit", () => setImmediate(resolve)); child.kill("SIGKILL"); });
    let stopped;
    for (let i = 0; i < 100 && stopped?.deployment?.status !== "stopped"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stopped = await store.read(job.id);
    }
    assert.equal(stopped.deployment.stoppedBy, "exited");
    assert.equal(typeof stopped.deployment.earlyExit?.afterSeconds, "number");
    assert.ok(stopped.deployment.earlyExit.afterSeconds <= EARLY_CRASH_MS / 1000);
    const event = (await store.events(job.id, Infinity)).findLast((item) => item.type === "deployment.stopped");
    assert.match(event.message, /stopped on its own \d+ s after it started, so this release may be broken/);
    assert.deepEqual(event.earlyExit, stopped.deployment.earlyExit);

    const relaunched = await factory.relaunch(job.id);
    assert.equal(relaunched.deployment.status, "live");
    assert.equal(relaunched.deployment.earlyExit, undefined, "a fresh deployment carries no crash note");
    // The owner's Stop is never an early crash.
    const owner = await factory.stopDeployment(job.id);
    assert.equal(owner.deployment.stoppedBy, "owner");
    assert.equal((await store.read(job.id)).deployment.earlyExit, undefined);
  } finally {
    await factory.shutdown();
  }
});

test("the Live app panel shows the crash line only while stopped, naming the rollback target when there is one", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("  appVals() {"), source.indexOf("\n  post(r, action"));
  const make = new Function("state", "formatSpan", `return { ${code} };`);
  const deployment = { url: "http://127.0.0.1:5000", status: "stopped", stoppedBy: "exited", earlyExit: { afterSeconds: 12, exitCode: 1 } };
  const vals = (jobs) => Object.assign(make({ jobs }, String), { state: {} }).appVals();

  const alone = vals([{ id: "j1", state: "completed", deployment }]);
  assert.equal(alone.crashNote, "The app stopped on its own 12 s after it started (exit 1), so this release may be broken. Relaunch to try again, or check the app's log.");
  assert.equal(alone.canRollback, false);

  const update = vals([{ id: "j2", state: "completed", deployment, rollbackTo: { jobId: "j1", name: "Pocket Pulse v1", date: started } }]);
  assert.match(update.crashNote, /may be broken\. Rolling back to Pocket Pulse v1 may fix it, or Relaunch to try again\.$/);
  assert.equal(update.canRollback, true, "the rollback stays the owner's confirmed action");

  assert.equal(vals([{ id: "j1", state: "completed", deployment: { ...deployment, status: "live" } }]).crashNote, "");
  assert.equal(vals([{ id: "j1", state: "completed", deployment: { ...deployment, earlyExit: undefined } }]).crashNote, "");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<sc-if value="\{\{app\.crashNote\}\}"[\s\S]*?color: var\(--amber\)">\{\{app\.crashNote\}\}<\/p>/);
});
