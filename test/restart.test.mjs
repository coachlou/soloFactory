// Restart from slice on a planned (v2) run: the rewound features start clean, nothing else is refilled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

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
