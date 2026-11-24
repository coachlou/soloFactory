import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { FactoryError, SoloFactory, repairsExhausted } from "../src/factory.mjs";
import { sourceBaseline } from "../src/feature-recovery.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Start Gate", acceptanceScenarios: ["The app starts."] };
const transcript = [{ role: "user", content: "An app." }];
const metrics = JSON.stringify({ uptimeSeconds: 1, requests: { total: 0, errors: 0 }, latencyMs: { average: 0 }, routes: [] });
const goodApp = `import http from "node:http";
http.createServer((q, r) => { if (q.url === "/health") return r.end("ok"); if (q.url === "/_factory/metrics") return r.end(${JSON.stringify(metrics)}); r.end("home"); }).listen(process.env.PORT);`;
const crashApp = `console.error("Error: SESSION_SECRET must be set in production."); process.exit(1);`;
const manifest = { version: 1, healthPath: "/health", metricsPath: "/_factory/metrics", commands: { test: ["node", "-e", "0"], start: ["node", "app.mjs"] } };

async function setup(app, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-start-gate-"));
  const store = new JobStore(root);
  await store.init();
  await writeFile(path.join(root, "app.mjs"), app);
  await mkdir(path.join(root, ".factory", "logs"), { recursive: true });
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const factory = new SoloFactory({ store, provider: createFixtureProvider(), commandRunner: async () => ({ code: 0, output: "passed" }), ...options });
  return { root, store, job, factory };
}

test("the integration start gate fails a crash on launch as a repairable gate with PORT and the start log", async () => {
  const { job, factory } = await setup(crashApp);
  try {
    const failure = await factory.verify(job, manifest, new AbortController().signal, { includeInstall: false, rerun: true });
    assert.equal(failure.code, "quality_gate_failed");
    assert.equal(failure.details.gate, "start");
    assert.match(failure.details.output, /PORT=\d+ and NODE_ENV=production/);
    assert.match(failure.details.output, /SESSION_SECRET must be set in production/);
    assert.equal(repairsExhausted({ error: failure, attempt: 0 }), false);
  } finally {
    await factory.shutdown();
  }
});

test("a passing start gate stops the app again and never makes it the live release", async () => {
  const { job, store, factory } = await setup(goodApp);
  try {
    const events = [];
    const emit = factory.emit.bind(factory);
    factory.emit = async (id, event) => { events.push(event); return emit(id, event); };
    assert.equal(await factory.verify(job, manifest, new AbortController().signal, { includeInstall: false, rerun: true }), null);
    assert.ok(events.some((event) => event.type === "gate.passed" && event.gate === "start"));
    assert.equal(factory.deployments.has(job.id), false);
    assert.equal(job.startChecked, await sourceBaseline(store, { head: false }));
    assert.equal((await store.read(job.id)).deployment ?? null, null);
  } finally {
    await factory.shutdown();
  }
});

test("the start gate runs only at integration, never with a deployer or before a data backup", async () => {
  const cases = [
    [{}, { rerun: false }, {}],
    [{ deployer: async () => ({}) }, { rerun: true }, {}],
    [{}, { rerun: true }, { followOn: true, hadData: true, dataFeatures: [{ id: "F1", title: "Store notes" }] }],
  ];
  for (const [options, flags, fields] of cases) {
    const { job, factory } = await setup(crashApp, options);
    try {
      Object.assign(job, fields);
      assert.equal(await factory.verify(job, manifest, new AbortController().signal, { includeInstall: false, ...flags }), null);
    } finally {
      await factory.shutdown();
    }
  }
});

test("a deploy health failure right after a passing start check is retried once on a fresh port, with no repair", async () => {
  let deploys = 0;
  const { job, store, factory } = await setup(goodApp, {
    deployer: async ({ job: current }) => {
      deploys += 1;
      if (deploys === 1) {
        current.startChecked = await sourceBaseline(store, { head: false });
        throw new FactoryError("health_check_failed", "No successful health response.", { port: 1 });
      }
      return { mode: "fixture", status: "live", url: "http://127.0.0.1:9972" };
    },
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(deploys, 2);
  assert.equal(result.attempt ?? 0, 0);
});

test("a deploy health failure with no passing start check gets a repair turn with the port", async () => {
  let deploys = 0;
  const { root, job, factory } = await setup(goodApp, {
    deployer: async () => {
      deploys += 1;
      if (deploys === 1) throw new FactoryError("health_check_failed", "No successful health response (last: HTTP 503).", { port: 4321 });
      return { mode: "fixture", status: "live", url: "http://127.0.0.1:9973" };
    },
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(result.attempt, 1);
  assert.match(await readFile(path.join(root, ".factory", "last-failure-1.txt"), "utf8"), /PORT 4321/);
});

test("deploy failures count as exhausted once the repair budget is spent", () => {
  for (const code of ["invalid_metrics", "deployment_exited", "page_check_failed", "health_check_failed"]) {
    assert.equal(repairsExhausted({ error: { code }, attempt: 2 }), true, code);
    assert.equal(repairsExhausted({ error: { code }, attempt: 1 }), false, code);
  }
  assert.equal(repairsExhausted({ error: { code: "port_unavailable" }, attempt: 2 }), false);
});
