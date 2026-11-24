import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { proofResults, runEvidence, runSummary } from "../src/summary.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";
import { JobStore } from "../src/store.mjs";

const plan = { plan: { slices: [{ id: "S1", title: "Add a recipe" }, { id: "S2", title: "Search recipes" }, { id: "S3", title: "Share a list" }] } };
const events = [
  { type: "gate.failed", gate: "test", feature: "S1", message: "test failed", cases: { passed: 3, failed: 1 } },
  { type: "gate.passed", gate: "test", feature: "S1", message: "test passed", cases: { passed: 4 } },
  { type: "gate.passed", gate: "test", feature: "S2", message: "test passed", cases: { passed: 2 } },
  { type: "gate.passed", gate: "review", slice: "S2", message: "Feature S2 review passed" },
  { type: "job.completed", message: "Working app" },
];

test("a completed release says what was built, checked and is live", () => {
  const job = { state: "completed", sliceDone: ["S1", "S2"], approvedPlan: plan, deployment: { url: "http://127.0.0.1:4100" } };
  const proofs = proofResults(events);
  assert.deepEqual(proofs.map((p) => [p.gate, p.feature, p.status]), [["test", "S1", "passed"], ["test", "S2", "passed"], ["review", "S2", "passed"]]);
  assert.equal(runSummary(job, proofs),
    "Built 2 features: Add a recipe and Search recipes. 3 checks passed, covering 6 test cases. It is live at http://127.0.0.1:4100.");
  const evidence = runEvidence({ ...job, risks: [] }, proofs, ["build.log"]);
  assert.equal(evidence.deployChecks, "Health, metrics and home page answered at deploy.");
  assert.equal(evidence.riskLine, "No package changes or deleted files.");
  assert.deepEqual(evidence.logs, ["build.log"]);
});

test("a release with a waived proof and a confirmed backup says so", () => {
  const job = { state: "completed", sliceDone: ["S1"], approvedPlan: plan, deployment: { url: "http://x" }, waivedProofs: [{ id: "BUG-1", reason: "r" }], dataBackup: { needed: true, confirmedAt: "t" } };
  assert.equal(runSummary(job, []),
    "Built 1 feature: Add a recipe. It is live at http://x. You waived 1 proof (BUG-1), and you confirmed the data backup before it went live.");
});

test("a parked or rolled-back run never claims to be live", () => {
  const parked = { state: "paused", sliceDone: ["S1"], approvedPlan: plan, deployment: { url: "http://old" } };
  assert.equal(runSummary(parked, proofResults(events.slice(0, 1))),
    "Built 1 feature: Add a recipe. 1 check last failed. The run is paused, so nothing from it is live yet.");
  const rolled = { state: "completed", rolledBack: true, brief: { workingName: "Recipes" }, deployment: { url: "http://x" } };
  assert.equal(runSummary(rolled, []), "Built Recipes. This release was rolled back, so it is not what is live now.");
});

test("an old run without logs, risks or gate events reports them as not recorded", () => {
  const evidence = runEvidence({ state: "completed", deployment: { url: "http://x" } }, [], []);
  assert.deepEqual([evidence.proofs, evidence.logs, evidence.riskLine, evidence.risks], [null, null, null, null]);
});

test("the job route returns the summary and the logs route serves only this run's .log files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-summary-"));
  const store = new JobStore(path.join(root, "projects", "alpha"));
  await store.init();
  const old = await store.create({ brief: { workingName: "Old" }, transcript: [], provider: "fixture" });
  await store.writeState({ ...old, state: "completed", startedAt: "2026-01-01T00:00:00.000Z", deployment: { url: "http://x" } });
  const job = await store.create({ brief: { workingName: "Recipes" }, transcript: [], provider: "fixture" });
  await store.writeState({ ...job, state: "completed", startedAt: "2026-02-01T00:00:00.000Z", sliceDone: ["S1"], approvedPlan: plan, deployment: { url: "http://x" }, risks: [] });
  for (const event of events) await store.appendEvent(job.id, event);
  const logs = path.join(store.appDir(job.id), ".factory", "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, "build.log"), `${"a".repeat(70 * 1024)}END`);
  await writeFile(path.join(logs, "notes.txt"), "secret");
  await writeFile(path.join(root, "outside.log"), "outside");
  await symlink(path.join(root, "outside.log"), path.join(logs, "link.log"));
  const app = await createSoloFactoryServer({ home: path.join(root, ".aai/memory/solofactory"), root, fixtureMode: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/jobs`;
  try {
    const body = await (await fetch(`${base}/${job.id}`)).json();
    assert.match(body.job.summary, /^Built 1 feature: Add a recipe\. 3 checks passed/);
    assert.deepEqual(body.job.evidence.logs, ["build.log", "link.log"]);
    const tail = await fetch(`${base}/${job.id}/logs/build.log`);
    assert.equal(tail.status, 200);
    const text = await tail.text();
    assert.equal(text.length, 64 * 1024);
    assert.ok(text.endsWith("END"));
    for (const name of ["..%2Foutside.log", "a%2Fb.log", "notes.txt", "missing.log", "link.log", "%E0%A4%A"]) {
      assert.equal((await fetch(`${base}/${job.id}/logs/${name}`)).status, 404, name);
    }
    // An earlier run's logs were rewritten by the later run, so it has none of its own.
    const older = await (await fetch(`${base}/${old.id}`)).json();
    assert.equal(older.job.evidence.logs, null);
    assert.equal((await fetch(`${base}/${old.id}/logs/build.log`)).status, 404);
  } finally {
    await app.close?.();
    app.server.close();
  }
});
