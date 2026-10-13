// Release QA (PRD stage 3): a final-review finding arrives as a failing test, goes to the feature that owns
// the failing files, and that feature's repair is held to its declared writes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];

async function qaRun({ files, strayInRepair = false, earlierRelease = false }) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-release-qa-")));
  await store.init();
  if (earlierRelease) {
    await mkdir(path.join(store.project, "qa"), { recursive: true });
    await writeFile(path.join(store.project, "qa/BUG-OLD.test.mjs"), "import test from 'node:test';\ntest('an earlier fix holds', () => {});\n");
    await store.commit("earlier release");
  }
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  const prompts = [];
  let reviews = 0;
  let repaired = false;
  const provider = { id: "fixture", async run(options) {
    const { stage } = options.context;
    if (stage.startsWith("repair-")) { prompts.push(options.prompt); repaired = true; if (strayInRepair) await writeFile(path.join(options.cwd, "qa/BUG-1.test.mjs"), "// weakened\n"); }
    if (stage === "feature-plan") {
      await fixture.run(options);
      const file = path.join(options.cwd, ".factory/slices.json");
      const value = JSON.parse(await readFile(file, "utf8"));
      for (const slice of value.slices) slice.writes = slice.dependsOn.length ? ["index.html", "ui.test.mjs"] : ["*"];
      await writeFile(file, JSON.stringify(value, null, 2));
      return { message: "planned" };
    }
    if (stage === "review" && ++reviews === 1) {
      const request = JSON.parse(await readFile(path.join(options.cwd, ".factory/review-request.json"), "utf8"));
      await mkdir(path.join(options.cwd, "qa"), { recursive: true });
      await writeFile(path.join(options.cwd, "qa/BUG-1.test.mjs"), "import test from 'node:test';\ntest('history keeps the score', () => {});\n");
      await writeFile(path.join(options.cwd, ".factory/review-result.json"), JSON.stringify({
        version: 1, jobId: request.jobId, token: request.token, contractDigest: request.contractDigest, verdict: "blocked",
        blockers: ["History drops the score after reload"], bugs: [{ test: "qa/BUG-1.test.mjs", files, description: "History drops the score after reload" }],
        checks: request.checks.map((check) => ({ id: check.id, status: "failed", evidence: [] })),
      }));
      return { message: "review blocked" };
    }
    return fixture.run(options);
  } };
  // The bug test fails until a repair turn has run.
  const commandRunner = async ({ logPath }) => (path.basename(logPath).startsWith("proof-BUG-1") && !repaired ? { code: 1, output: "history keeps the score: failed" } : { code: 0, output: "passed" });
  const factory = new SoloFactory({ store, provider, commandRunner, deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9984" }) });
  const result = await factory.start(job.id);
  return { result, prompts, events: await store.events(job.id, 1000) };
}

test("a release finding goes to the feature owning the failing file, and its repair is scoped to that feature", async () => {
  const { result, prompts, events } = await qaRun({ files: ["index.html"] });
  assert.equal(result.state, "completed", result.error?.message);
  const bug = events.find((event) => event.type === "review.bug");
  assert.equal(bug?.feature, "SLICE-UI", "the latest feature declaring index.html owns it");
  assert.ok(events.some((event) => event.type === "gate.failed" && event.gate === "proof-BUG-1"), "the finding's test ran and failed before any repair");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /inside slice SLICE-UI/);
  assert.match(prompts[0], /qa\/BUG-1\.test\.mjs: History drops the score after reload/, "the finding reaches the repairer");
  assert.match(prompts[0], /"writes": \[\s*"index.html"/, "the feature is inlined with its writes");
  assert.doesNotMatch(prompts[0], /contract and plan/);
  const runs = events.filter((event) => event.type === "gate.started" && event.gate === "proof-BUG-1").map((event) => events.indexOf(event));
  const scoped = events.findIndex((event) => event.type === "gate.passed" && event.gate === "proof-BUG-1");
  assert.ok(runs.some((index) => index > scoped), "final integration reran the fixed bug's test");
});

test("a bug repair that edits the finding's test fails the writes gate", async () => {
  const { result, events } = await qaRun({ files: ["index.html"], strayInRepair: true });
  assert.equal(result.state, "failed");
  const failed = events.find((event) => event.type === "gate.failed" && event.gate === "writes");
  assert.match(failed?.message ?? "", /SLICE-UI changed files outside its declared writes: qa\/BUG-1\.test\.mjs/);
});

test("a finding no feature owns takes the unscoped repair", async () => {
  const { result, prompts, events } = await qaRun({ files: ["nowhere/x.js"] });
  assert.equal(result.state, "completed", result.error?.message);
  assert.equal(events.filter((event) => event.type === "review.bug").length, 0);
  assert.doesNotMatch(prompts[0], /inside slice/);
});

test("a finding fixed in an earlier release reruns at final integration", async () => {
  const { result, events } = await qaRun({ files: ["index.html"], earlierRelease: true });
  assert.equal(result.state, "completed", result.error?.message);
  assert.ok(events.some((event) => event.type === "gate.started" && event.gate === "proof-QA-BUG-OLD"));
  assert.ok(!events.some((event) => event.gate === "proof-QA-BUG-1"), "this run's findings run once, under their BUG id");
});
