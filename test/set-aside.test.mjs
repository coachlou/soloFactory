// Continue past a blocked feature (PRD stage 4): a feature that runs out of repairs is set aside, features
// that don't depend on it keep building, and the run parks once with the blocked feature's work restored.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score.", "A user exports scores.", "A user sees history."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
// A copy of the fixture's UI obligation (it carries valid sources), with its own id, files and proof.
const extra = (ui, id, dependsOn, file, check) => ({
  ...ui, id, title: `Feature ${id}`, dependsOn, closes: [check], writes: [file],
  acceptance: [{ ...ui.acceptance[0], id: `${id}-A`, behavior: `${id} works end to end`, refs: [check], proof: { command: ["node", "--test", file], expect: "passes" } }],
});

test("a blocked feature is set aside, independent features still build, and the run parks with its work restored", async () => {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-set-aside-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  const builds = [];
  let blockUI = true;
  const provider = { id: "fixture", async run(options) {
    const { stage } = options.context;
    if (stage.startsWith("build-slice-")) builds.push(stage.slice("build-slice-".length));
    if (stage === "feature-plan") {
      await fixture.run(options);
      const file = path.join(options.cwd, ".factory/slices.json");
      const value = JSON.parse(await readFile(file, "utf8"));
      for (const slice of value.slices) slice.writes = slice.dependsOn.length ? ["index.html", "ui.test.mjs"] : ["*"];
      value.slices[1].acceptance[0].proof.command = ["node", "--test", "ui.test.mjs"];
      // EXTRA needs only the skeleton; LATER needs the UI. Their files sit outside the skeleton's "*", so no merge check reaches the UI.
      const ui = value.slices[1];
      const [kept, exported, history] = ui.closes;
      value.slices.push(extra(ui, "SLICE-EXTRA", ["SLICE-SKELETON"], "extra/extra.test.mjs", exported), extra(ui, "SLICE-LATER", ["SLICE-UI"], "later/later.test.mjs", history));
      ui.closes = [kept];
      for (const item of ui.acceptance) item.refs = item.refs.filter((ref) => ref === kept);
      await writeFile(file, JSON.stringify(value, null, 2));
      return { message: "planned" };
    }
    if (stage === "build-slice-SLICE-EXTRA") { await mkdir(path.join(options.cwd, "extra"), { recursive: true }); await writeFile(path.join(options.cwd, "extra/extra.test.mjs"), "export {};\n"); return { message: "built" }; }
    if (stage === "build-slice-SLICE-LATER") { await mkdir(path.join(options.cwd, "later"), { recursive: true }); await writeFile(path.join(options.cwd, "later/later.test.mjs"), "export {};\n"); return { message: "built" }; }
    return fixture.run(options);
  } };
  // The UI's proof keeps failing until the owner steps in.
  const commandRunner = async ({ logPath }) => (blockUI && path.basename(logPath).startsWith("proof-UI-") ? { code: 1, output: "ui failed" } : { code: 0, output: "passed" });
  const make = () => new SoloFactory({ store, provider, commandRunner, deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9985" }) });

  const parked = await make().start(job.id);
  assert.equal(parked.state, "failed");
  assert.deepEqual(parked.sliceDone, ["SLICE-SKELETON", "SLICE-EXTRA"], "the independent feature built past the blocked one");
  assert.ok(!builds.includes("SLICE-LATER"), "the dependent feature waited");
  assert.equal(parked.featureCursor?.id, "SLICE-UI", "the run parks on the blocked feature, as before");
  assert.match(parked.error.message, /SLICE-LATER/);
  assert.match(await readFile(path.join(store.appDir(job.id), "index.html"), "utf8"), /Record your daily score/, "its work is back in the tree");
  await access(path.join(store.appDir(job.id), "extra/extra.test.mjs"));
  const events = await store.events(job.id, 1000);
  assert.ok(events.some((event) => event.type === "slice.set_aside" && event.slice === "SLICE-UI"));

  // Its budget is spent, so the next step is the owner's repair plan, exactly as when a feature blocks the run.
  await assert.rejects(make().resume(job.id), /repair plan/);
  blockUI = false;
  const ready = await make().planRecovery(job.id);
  assert.equal(ready.recoveryPhase?.status, "ready", ready.error?.message);
  const recovered = await make().startRecovery(job.id, ready.recoveryPhase.planDigest);
  assert.equal(recovered.state, "completed", recovered.error?.message);
});
