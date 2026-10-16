// Owner waiver: a stuck reviewer BUG test is retired by the owner, the reviewer is told, and Resume returns.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, continuationAction } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

test("waiving a stuck BUG test removes it, records the owner's decision and re-opens Resume", async () => {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "solo-factory-waive-")));
  await store.init();
  const job = await store.create({ brief: { workingName: "W", acceptanceScenarios: ["x"] }, transcript: [{ role: "user", content: "x" }], provider: "fixture" });
  await mkdir(path.join(store.appDir(job.id), "qa"), { recursive: true });
  await writeFile(path.join(store.appDir(job.id), "qa/port-80.test.mjs"), "// faulty\n");
  await store.commit("qa test");
  Object.assign(job, { state: "failed", error: { code: "quality_gate_failed", message: "gate" }, attempt: 2, repairBudgetLimit: 2,
    bugProofs: [{ id: "BUG-1", proof: { command: ["node", "--test", "qa/port-80.test.mjs"] }, description: "port 80" }] });
  await store.writeState(job);
  const factory = new SoloFactory({ store, provider: createFixtureProvider(), maxRepairs: 2 });
  const before = continuationAction(job, { maxRepairs: 2 });
  assert.equal(before.action, "prepare-plan");
  assert.equal(before.alternatives[0].proof, "BUG-1");
  await assert.rejects(factory.waiveProof(job.id, "BUG-9"), /not a stuck review test/);
  const waived = await factory.waiveProof(job.id, "BUG-1", "fetch cannot set Host");
  assert.deepEqual(waived.bugProofs, []);
  assert.equal(waived.waivedProofs[0].id, "BUG-1");
  assert.match(waived.ownerDecisions[0].text, /waived BUG-1.*fetch cannot set Host/);
  await assert.rejects(access(path.join(store.appDir(job.id), "qa/port-80.test.mjs")));
  assert.equal(continuationAction(waived, { maxRepairs: 2 }).action, "resume");
});
