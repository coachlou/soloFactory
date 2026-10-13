// Declared writes (PRD stage 1): each feature lists the files it may change; the validator keeps
// independent features apart and the controller fails a feature that changes anything else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { impactedFeatures, outsideWrites, validateFeaturePlan } from "../src/wbs.mjs";

const checks = [{ id: "MH-1", text: "Record a score" }, { id: "MH-2", text: "See history" }];
const opts = { jobId: "job", contractDigest: "contract", checks };
const feature = (id, { dependsOn = [], closes = [], writes } = {}) => ({
  id, title: `Feature ${id}`, objective: `Observable ${id}`, demo: `Open the app and use ${id}`, dependsOn, closes,
  acceptance: [{ id: `${id}-A`, behavior: `Behavior ${id} works end to end`, refs: closes, proof: { command: ["node", "--test", `test/${id}.test.mjs`], expect: "passes" } }],
  ...(writes ? { writes } : {}),
});
const plan = (...slices) => ({ version: 2, jobId: "job", contractDigest: "contract", compatibility: [], slices });
const base = (writes) => feature("BASE", { closes: [], writes: writes ?? ["package.json", "factory.json", "server.mjs"] });

test("independent features with overlapping writes are rejected before any build", () => {
  assert.throws(() => validateFeaturePlan(plan(base(),
    feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1"], writes: ["src/routes/**", "test/RECORD.test.mjs"] }),
    feature("HISTORY", { dependsOn: ["BASE"], closes: ["MH-2"], writes: ["src/routes/history.js", "test/HISTORY.test.mjs"] })), opts),
  /RECORD and HISTORY both write src\/routes\/\*\* \/ src\/routes\/history\.js/);
});

test("a dependency path lets a later feature edit an earlier feature's files", () => {
  const valid = validateFeaturePlan(plan(base(),
    feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1"], writes: ["src/routes/", "./test/RECORD.test.mjs"] }),
    feature("HISTORY", { dependsOn: ["RECORD"], closes: ["MH-2"], writes: ["src/routes/history.js", "server.mjs"] })), opts);
  assert.deepEqual(valid.slices[1].writes, ["src/routes/", "test/RECORD.test.mjs"], "writes survive normalization");
  // Disjoint siblings are fine, including globs in different directories.
  validateFeaturePlan(plan(base(),
    feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1"], writes: ["src/record/*.js"] }),
    feature("HISTORY", { dependsOn: ["BASE"], closes: ["MH-2"], writes: ["src/history/*.js"] })), opts);
});

test("shared files belong to foundation features, and paths stay inside the app", () => {
  assert.throws(() => validateFeaturePlan(plan(base(), feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1", "MH-2"], writes: ["package.json", "src/**"] })), opts),
    /RECORD depends on other features but writes package\.json/);
  assert.throws(() => validateFeaturePlan(plan(base(), feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1", "MH-2"], writes: ["**"] })), opts),
    /writes package\.json, factory\.json/, "a whole-tree glob reaches the shared files");
  assert.throws(() => validateFeaturePlan(plan(base(["../outside.js"]), feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1", "MH-2"] })), opts), /outside the app/);
  assert.throws(() => validateFeaturePlan(plan(base([]), feature("RECORD", { dependsOn: ["BASE"], closes: ["MH-1", "MH-2"] })), opts), /malformed writes/);
});

test("controller and npm files are always writable", () => {
  assert.deepEqual(outsideWrites([".factory/logs/x.log", "package-lock.json", "README.md", ".gitignore", "src/a.js", "lib/b.js"], ["src"]), ["lib/b.js"]);
});

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];

async function declaredRun(stray) {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-writes-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  const provider = { id: "fixture", async run(options) {
    const result = await fixture.run(options);
    const { stage } = options.context;
    if (stage === "feature-plan") {
      const file = path.join(options.cwd, ".factory/slices.json");
      const value = JSON.parse(await readFile(file, "utf8"));
      for (const slice of value.slices) slice.writes = slice.dependsOn.length ? ["index.html", "ui.test.mjs"] : ["*"];
      // A distinct command, so the skeleton's proof is its own gate rather than deduplicated into npm test.
      value.slices[0].acceptance[0].proof.command = ["node", "--test", "server.test.mjs"];
      await writeFile(file, JSON.stringify(value, null, 2));
    }
    if (stray && stage === "build-slice-SLICE-UI") {
      await writeFile(path.join(options.cwd, "stray.mjs"), "export {};\n");
      if (stray === "committed") await store.git("add", "stray.mjs").then(() => store.git("commit", "-qm", "agent commit"));
    }
    return result;
  } };
  const factory = new SoloFactory({ store, provider, commandRunner: async () => ({ code: 0, output: "passed" }), deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9982" }) });
  const result = await factory.start(job.id);
  return { result, events: await store.events(job.id, 1000) };
}

test("a feature that stays inside its declared writes completes", async () => {
  const { result, events } = await declaredRun(false);
  assert.equal(result.state, "completed", result.error?.message);
  assert.deepEqual(result.approvedPlan.plan.slices.map((slice) => slice.writes), [["*"], ["index.html", "ui.test.mjs"]]);
  assert.equal(events.filter((event) => event.gate === "writes").length, 0);
});

test("a build turn that edits a file outside its writes fails its gates and the failure names the file", async () => {
  const { result, events } = await declaredRun(true);
  const failed = events.find((event) => event.type === "gate.failed" && event.gate === "writes");
  assert.match(failed?.message ?? "", /Feature SLICE-UI changed files outside its declared writes: stray\.mjs/);
  assert.equal(result.state, "failed");
  assert.equal(result.error.details?.gate, "writes");
  assert.match(result.error.message, /stray\.mjs/);
});

test("a stray file the build agent committed itself still fails the writes gate", async () => {
  const { result, events } = await declaredRun("committed");
  assert.match(events.find((event) => event.gate === "writes")?.message ?? "", /SLICE-UI changed files outside its declared writes: stray\.mjs/);
  assert.equal(result.state, "failed");
});

test("a change reaches the features that own the file and every built feature depending on them", () => {
  const slices = [base(), feature("RECORD", { dependsOn: ["BASE"], writes: ["src/record/"] }), feature("HISTORY", { dependsOn: ["BASE"], writes: ["src/history/"] }), feature("EXPORT", { dependsOn: ["RECORD"], writes: ["src/export/", "src/record/format.js"] })];
  const done = ["BASE", "RECORD", "HISTORY"];
  assert.deepEqual(impactedFeatures(slices, done, ["src/record/format.js", "src/export/csv.js"]), ["RECORD"], "a sibling is out of reach");
  assert.deepEqual(impactedFeatures(slices, done, ["server.mjs"]), ["BASE", "RECORD", "HISTORY"], "a foundation file reaches everything built on it");
  assert.deepEqual(impactedFeatures(slices, done, ["src/export/csv.js"]), [], "new files reach nobody");
  assert.equal(impactedFeatures([feature("OLD"), ...slices], ["OLD", ...done], ["x.js"]), null, "an older plan without writes keeps the old scope");
});

test("a later feature that edits an earlier feature's files reruns that feature's proofs in its own checks", async () => {
  const { result, events } = await declaredRun(false);
  assert.equal(result.state, "completed", result.error?.message);
  const impact = events.find((event) => event.type === "slice.impact");
  assert.equal(impact?.slice, "SLICE-UI");
  assert.deepEqual(impact.impacted, ["SLICE-SKELETON"]);
  const uiChecks = events.slice(events.indexOf(impact), events.findIndex((event) => event.type === "slice.completed" && event.slice === "SLICE-UI"));
  assert.ok(uiChecks.some((event) => event.type === "gate.started" && /^proof-SLICE-SKELETON\./.test(event.gate)), "the skeleton's proofs ran inside SLICE-UI's checks");
});
