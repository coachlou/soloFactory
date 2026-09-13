import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { buildRecoveryPacket, SoloFactory, validateMetrics } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = {
  workingName: "Pocket Pulse",
  acceptanceScenarios: ["A user records a score."],
};
const transcript = [
  { role: "assistant", content: "What should we build?" },
  { role: "user", content: "A daily tracker with clear acceptance behavior." },
];

test("metrics validation accepts route lists and aggregate route maps", () => {
  const base = { uptimeSeconds: 1, requests: { total: 2, errors: 0 }, latencyMs: { average: 3 } };
  assert.equal(validateMetrics({ ...base, routes: [] }).routes.length, 0);
  assert.deepEqual(validateMetrics({ ...base, routes: { "/health": 1 } }).routes, { "/health": 1 });
  assert.throws(() => validateMetrics({ ...base, routes: "private-path" }), /invalid schema/);
});

test("full lifecycle reaches completed only after real health and metrics checks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-test-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const factory = new SoloFactory({ store, provider: createFixtureProvider() });
  t.after(() => factory.shutdown());

  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.match(result.deployment.url, /^http:\/\/127\.0\.0\.1:/);

  const health = await fetch(`${result.deployment.url}/health`);
  assert.equal(health.ok, true);
  await fetch(result.deployment.url);
  const telemetry = await factory.telemetry(job.id);
  assert.ok(telemetry.app.requests.total >= 2);
  assert.equal(typeof telemetry.app.latencyMs.average, "number");
  assert.ok(telemetry.events.filter((event) => event.type === "gate.passed").length >= 5);
});

test("deployment-only recovery does not replay agent work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-deploy-resume-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  let agentTurns = 0;
  let failDeployment = true;
  const provider = { id: "fixture", run(options) { agentTurns += 1; return fixture.run(options); } };
  const factory = new SoloFactory({
    store,
    provider,
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => {
      if (failDeployment) {
        const error = new Error("metrics contract failed");
        error.code = "invalid_metrics";
        throw error;
      }
      return { mode: "fixture", status: "live", url: "http://127.0.0.1:9976" };
    },
  });
  const failed = await factory.start(job.id);
  assert.equal(failed.failedState, "deploying");
  const turnsBeforeResume = agentTurns;
  failDeployment = false;
  const resumed = await factory.resume(job.id);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.failedState, null);
  assert.equal(agentTurns, turnsBeforeResume);
});

test("a failed gate triggers bounded repair and a complete gate rerun", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-repair-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  let calls = 0;
  const commandRunner = async ({ executable }) => {
    calls += 1;
    if (calls === 2) return { code: 1, output: "intentional test failure" };
    return { code: 0, output: `${executable} passed` };
  };
  const factory = new SoloFactory({
    store,
    provider: createFixtureProvider(),
    commandRunner,
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9999" }),
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(result.attempt, 1);
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "gate.failed").length, 1);
  assert.ok(events.filter((event) => event.type === "gate.passed").length >= 6);
});

test("startup recovery makes in-flight state explicitly interrupted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-recover-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  job.state = "building";
  await store.writeState(job);
  await store.recoverInterrupted();
  const recovered = await store.read(job.id);
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.error.code, "process_restarted");
});

test("artifact access is an explicit allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-artifact-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  await assert.rejects(() => store.artifact(job.id, "../../state"), /Unknown artifact/);
});

test("a failed build preserves its workspace and resumes the same run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-resume-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  const failingProvider = {
    id: "fixture",
    async run(options) {
      if (options.context.stage === "build") {
        await writeFile(path.join(options.cwd, "partial-work.txt"), "preserve me\n");
        const error = new Error("Package registry could not be reached.");
        error.code = "network_unavailable";
        error.details = {
          diagnostics: [{ code: "network_unavailable", title: "Package network failed", action: "Restore network access, then resume." }],
          autoResumes: 0,
          logPath: path.join(options.cwd, ".factory", "logs", "build.log"),
        };
        throw error;
      }
      return fixture.run(options);
    },
  };
  const firstFactory = new SoloFactory({ store, provider: failingProvider });
  const failed = await firstFactory.start(job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failedState, "building");
  assert.equal(failed.recovery.canResume, true);
  assert.match(failed.recovery.automaticRetry, /blocker was detected/);
  assert.match(buildRecoveryPacket(failed), /Do not start over/);

  const resumedFactory = new SoloFactory({
    store,
    provider: fixture,
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9998" }),
  });
  const resumed = await resumedFactory.resume(job.id);
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.state, "completed", resumed.error?.message);
  assert.equal(await readFile(path.join(store.appDir(job.id), "partial-work.txt"), "utf8"), "preserve me\n");
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "job.resumed").length, 1);
});

test("slice strategy runs every vertical slice with per-slice gates and records evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-slices-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "slices" });
  const calls = [];
  const commandRunner = async ({ executable, args }) => {
    calls.push([executable, ...args].join(" "));
    return { code: 0, output: "passed" };
  };
  const factory = new SoloFactory({
    store,
    provider: createFixtureProvider(),
    commandRunner,
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9971" }),
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(result.attempt, 0);
  assert.deepEqual(result.slicePlanIds, ["SLICE-SKELETON", "SLICE-UI"]);
  assert.deepEqual(result.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  assert.equal(result.sliceIndex, 2);
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "slice.started").length, 2);
  assert.equal(events.filter((event) => event.type === "slice.completed").length, 2);
  assert.equal(events.filter((event) => event.type === "agent.started" && event.message.includes("build-slice-")).length, 2);
  const installs = calls.filter((line) => line.includes("npm install"));
  assert.equal(installs.length, 1, "install runs once on the walking skeleton, not per slice");
  const telemetry = await factory.telemetry(job.id);
  assert.equal(telemetry.summary.strategy, "slices");
  assert.equal(telemetry.summary.slicesPlanned, 2);
  assert.equal(telemetry.summary.slicesCompleted, 2);
  assert.ok(telemetry.sliceStats["SLICE-SKELETON"].verifyRuns >= 1);
  const ui = await readFile(path.join(store.appDir(job.id), "index.html"), "utf8");
  assert.match(ui, /Record your daily score/);
});

test("a failing gate inside a slice is repaired within that slice and the run completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-slice-repair-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "slices" });
  let call = 0;
  const commandRunner = async () => {
    call += 1;
    if (call === 4) return { code: 1, output: "intentional slice gate failure" };
    return { code: 0, output: "passed" };
  };
  const factory = new SoloFactory({
    store,
    provider: createFixtureProvider(),
    commandRunner,
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9972" }),
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(result.attempt, 1);
  assert.deepEqual(result.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  assert.equal(result.sliceStats["SLICE-UI"].repairs, 1);
  assert.equal(result.sliceStats["SLICE-UI"].verifyRuns, 2);
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "gate.failed").length, 1);
  assert.equal(events.filter((event) => event.type === "slice.completed").length, 2);
});

test("a slice-mode run failing inside a slice build preserves its workspace and resumes the same run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-slice-resume-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "slices" });
  const fixture = createFixtureProvider();
  const failingProvider = {
    id: "fixture",
    async run(options) {
      if (options.context.stage.startsWith("build-slice-")) {
        await writeFile(path.join(options.cwd, "partial-slice.txt"), "preserve me\n");
        const error = new Error("Package registry could not be reached.");
        error.code = "network_unavailable";
        error.details = {
          diagnostics: [{ code: "network_unavailable", title: "Package network failed", action: "Restore network access, then resume." }],
          autoResumes: 0,
          logPath: path.join(options.cwd, ".factory", "logs", "build-slice.log"),
        };
        throw error;
      }
      return fixture.run(options);
    },
  };
  const firstFactory = new SoloFactory({ store, provider: failingProvider });
  const failed = await firstFactory.start(job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failedState, "building");
  assert.equal(failed.recovery.canResume, true);
  const parked = await store.read(job.id);
  assert.equal(parked.sliceIndex, 0);

  const resumedFactory = new SoloFactory({
    store,
    provider: fixture,
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9973" }),
  });
  const resumed = await resumedFactory.resume(job.id);
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.state, "completed", resumed.error?.message);
  assert.deepEqual(resumed.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  assert.equal(resumed.sliceIndex, 2);
  assert.equal(await readFile(path.join(store.appDir(job.id), "partial-slice.txt"), "utf8"), "preserve me\n");
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "job.resumed").length, 1);
});

test("a slice run gets a second-opinion plan review before any build turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-planreview-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "slices" });
  const factory = new SoloFactory({
    store,
    provider: createFixtureProvider(),
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9974" }),
  });
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(result.planReviewed, true);
  const events = await store.events(job.id, 500);
  const started = events.filter((event) => event.type === "agent.started").map((event) => event.message);
  assert.equal(started.filter((message) => message.includes("plan-review")).length, 1);
  const reviewIndex = started.findIndex((message) => message.includes("plan-review"));
  const firstBuild = started.findIndex((message) => message.includes("build-slice-"));
  assert.ok(reviewIndex >= 0 && firstBuild > reviewIndex, "plan review must run before the first build turn");
});

test("a plan review that leaves the plan invalid parks the run and resume recovers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-planreview-fail-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "slices" });
  const fixture = createFixtureProvider();
  const corruptingProvider = {
    id: "fixture",
    async run(options) {
      if (options.context.stage === "plan-review") {
        await writeFile(
          path.join(options.cwd, ".factory", "slices.json"),
          `${JSON.stringify({ slices: [{ id: "SLICE-A", title: "Broken", objective: "A plan that omits the frozen scenario.", acceptance: ["Something that delivers nothing tagged"], demo: "Observe the broken plan parking the run." }] }, null, 2)}\n`,
        );
      }
      return fixture.run(options);
    },
  };
  const firstFactory = new SoloFactory({ store, provider: corruptingProvider });
  const failed = await firstFactory.start(job.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "invalid_slice_plan");
  assert.match(failed.error.message, /SC-1/);
  assert.equal(failed.failedState, "specifying");
  assert.equal(failed.recovery.canResume, true);

  const resumedFactory = new SoloFactory({
    store,
    provider: fixture,
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9975" }),
  });
  const resumed = await resumedFactory.resume(job.id);
  assert.equal(resumed.state, "completed", resumed.error?.message);
  assert.deepEqual(resumed.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  const events = await store.events(job.id, 500);
  assert.equal(events.filter((event) => event.type === "job.resumed").length, 1);
});

test("a project is a git repo: app at the root, evidence gitignored, commits at stage boundaries", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "solo-factory-project-"));
  const store = new JobStore(project);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const factory = new SoloFactory({
    store,
    provider: createFixtureProvider(),
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9998" }),
  });
  t.after(() => factory.shutdown());
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);

  assert.equal(store.appDir(job.id), project);
  assert.equal(store.jobDir(job.id), path.join(project, ".solofactory", "runs", job.id));
  await readFile(path.join(project, "factory.json"), "utf8");
  const log = await store.git("log", "--format=%s");
  assert.deepEqual(log.split("\n"), ["factory: reviewing passed gates", "factory: building passed gates", "factory: specification"]);
  assert.equal(await store.git("status", "--porcelain"), "", "evidence and logs must be ignored");
  assert.equal(await store.git("ls-files", ".solofactory"), "");
});

test("init scaffolds project context once and never overwrites it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solofactory-context-"));
  const store = new JobStore(root);
  await store.init();
  const identity = path.join(root, ".aai", "identity.md");
  assert.match(await readFile(identity, "utf8"), new RegExp(`\\*\\*Name:\\*\\* ${path.basename(root)}`));
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /Read `\.aai\/instructions\.md`/);
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /^\.aai\/memory\/$/m);
  await writeFile(identity, "# mine\n");
  await writeFile(path.join(root, "AGENTS.md"), "# theirs\n");
  await store.init();
  assert.equal(await readFile(identity, "utf8"), "# mine\n");
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# theirs\n") && agents.includes("ambient folder"));
  assert.equal(agents.split("ambient folder").length, 2, "anchor appended exactly once");
});
