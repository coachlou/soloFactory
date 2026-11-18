import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSoloFactoryServer } from "../src/server.mjs";
import { JobStore } from "../src/store.mjs";

// A queued run waits behind the run that holds its project, so the project list shows that run, not the newest.
test("a project with a parked run and a queued run behind it reports the parked run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-lastrun-"));
  const store = new JobStore(path.join(root, "projects", "gamma"));
  await store.init();
  const brief = { workingName: "Voice Notes" };
  const held = await store.create({ brief, transcript: [], provider: "fixture" });
  // A run is parked only after it started. Without startedAt the scheduler saw no blocker and started
  // the queued run, and the test passed only while that start lost the race with the fetch below.
  await store.writeState({ ...held, state: "interrupted", startedAt: new Date().toISOString() });
  const queued = await store.create({ brief, transcript: [], provider: "fixture" });
  const app = await createSoloFactoryServer({ home: path.join(root, ".aai/memory/solofactory"), root, fixtureMode: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const { projects } = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/projects`)).json();
    const gamma = projects.find((p) => p.id === "projects/gamma");
    assert.equal(gamma.runCount, 2);
    assert.deepEqual([gamma.lastRun.id, gamma.lastRun.state], [held.id, "interrupted"]);
    assert.notEqual(gamma.lastRun.id, queued.id);
  } finally {
    await app.close?.();
    app.server.close();
  }
});
