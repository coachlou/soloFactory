import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createSoloFactoryServer } from "../src/server.mjs";
import { assertPlanReviewable } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { COVERAGE_KEYS } from "../src/interview.mjs";
import { digest } from "../src/feature-recovery.mjs";
import { runInputs, sourceSet } from "../src/review.mjs";

test("HTTP journey goes from Guide turn to a reachable generated app", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const config = await getJson(`${base}/api/config`);
  assert.equal(config.providers[0].authenticated, true);
  const manual = await fetch(`${base}/manual`);
  assert.equal(manual.status, 200);
  assert.match(await manual.text(), /SoloFactory/);

  const transcript = [
    { role: "assistant", content: config.opening.message },
    { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." },
  ];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  assert.equal(guide.status, "ready");
  assert.ok(COVERAGE_KEYS.every((key) => guide.coverage[key] === "complete"));
  transcript.push({ role: "assistant", content: guide.message });

  const started = await postJson(`${base}/api/jobs`, {
    provider: "fixture",
    transcript,
    coverage: guide.coverage,
    brief: guide.brief,
  });
  let job = started.job;
  const deadline = Date.now() + 30_000;
  while (!["completed", "failed"].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  }
  assert.equal(job.state, "completed", job.error?.message);
  assert.equal((await fetch(job.deployment.url)).ok, true);

  const telemetry = await getJson(`${base}/api/jobs/${job.id}/telemetry`);
  assert.equal(telemetry.job.state, "completed");
  assert.ok(telemetry.app.requests.total >= 2);
  const prd = await fetch(`${base}/api/jobs/${job.id}/artifacts/prd`);
  assert.equal(prd.ok, true);
  assert.match(await prd.text(), /Pocket Pulse/);
});

test("HTTP recovery explains legacy blockers and resumes the same run id", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-resume-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({
    brief: { workingName: "Preserved fixture", acceptanceScenarios: ["A user records a score."] },
    transcript: [{ role: "user", content: "Build the preserved app." }],
    provider: "fixture",
  });
  job.state = "failed";
  job.stage = "Run failed";
  job.error = { code: "unexpected_error", message: "Codex timed out." };
  job.stageHistory.push({ state: "building", label: "Building", startedAt: new Date().toISOString(), endedAt: null });
  await app.store.writeState(job);
  // A build-stage recovery retains the spec/intake produced before the build.
  const cwd = app.store.appDir(job.id);
  await createFixtureProvider().run({ cwd, context: { stage: "specification", job } });
  await writeFile(path.join(cwd, ".factory", "requirements.json"), JSON.stringify({ brief: job.brief, transcript: job.transcript }));
  const logDir = path.join(cwd, ".factory", "logs");
  await mkdir(logDir, { recursive: true });
  // An earlier, finished turn whose output merely mentions an auth word must not become a blocker.
  await writeFile(path.join(logDir, "specification.log"), "The API returns 401 Unauthorized for a missing token.\n");
  await utimes(path.join(logDir, "specification.log"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  await writeFile(
    path.join(logDir, "build.log"),
    "getaddrinfo ENOTFOUND registry.npmjs.org\nxcodebuild requires Xcode; active developer directory '/Library/Developer/CommandLineTools'\n",
  );

  const failed = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  assert.equal(failed.recovery.canResume, true);
  assert.equal(failed.recovery.actions.length, 2);
  assert.doesNotMatch(JSON.stringify(failed.recovery), /sign-in|Sign in/, "only the failing turn's log is diagnosed");
  assert.match(failed.recovery.automaticRetry, /predates activity-aware recovery/);
  const packetResponse = await fetch(`${base}/api/jobs/${job.id}/recovery-packet`);
  assert.equal(packetResponse.ok, true);
  assert.match(await packetResponse.text(), /Preserved workspace/);

  const accepted = await postJson(`${base}/api/jobs/${job.id}/resume`, {});
  assert.equal(accepted.job.id, job.id);
  let resumed = { state: "resuming" };
  const deadline = Date.now() + 30_000;
  while (!["completed", "failed"].includes(resumed.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    resumed = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  }
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.state, "completed", resumed.error?.message);
});

test("completed runs cannot manufacture recovery packets", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-completed-recovery-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({
    brief: { workingName: "Already finished" },
    transcript: [{ role: "user", content: "Build it." }],
    provider: "fixture",
  });
  job.state = "completed";
  job.stage = "Application is live and verified";
  job.error = null;
  job.recovery = null;
  await app.store.writeState(job);

  const response = await fetch(`${base}/api/jobs/${job.id}/recovery-packet`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "That run does not need recovery." });
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${response.status} ${url}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.ok, true, `${response.status} ${JSON.stringify(value)}`);
  return value;
}

test("HTTP journey: a run without sdlc plans features, gets approval, then builds; single mode is refused", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-slices-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const config = await getJson(`${base}/api/config`);
  assert.deepEqual(config.sdlcOptions.map((option) => option.id), ["slices"]);
  const transcript = [
    { role: "assistant", content: config.opening.message },
    { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." },
  ];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  assert.equal(guide.status, "ready");
  transcript.push({ role: "assistant", content: guide.message });

  const single = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief, sdlc: "single" }) });
  assert.equal(single.status, 400);
  assert.match((await single.json()).error, /always plan features first/);
  assert.equal((await getJson(`${base}/api/board`)).columns.queued?.length ?? 0, 0, "a refused request creates no run");

  const started = await postJson(`${base}/api/jobs`, {
    provider: "fixture",
    transcript,
    coverage: guide.coverage,
    brief: guide.brief,
  });
  assert.equal(started.job.sdlc, "slices");
  assert.equal(started.job.planVersion, 2);
  let job = started.job;
  const deadline = Date.now() + 60_000;
  while (!["completed", "failed"].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  }
  assert.equal(job.state, "completed", job.error?.message);
  assert.deepEqual(job.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);
  const card = (await getJson(`${base}/api/board`)).columns.completed.find((c) => c.jobId === job.id);
  assert.deepEqual(card.slices, { done: 2, total: 2, current: null, substage: null, repairs: 0 });
  assert.equal(job.approvedPlan.plan.version, 2);
  const events = await app.store.events(job.id, 500);
  const approved = events.findIndex((event) => event.type === "plan.approved");
  const firstBuild = events.findIndex((event) => event.type === "agent.started" && event.message.includes("build-slice-"));
  assert.ok(approved >= 0 && firstBuild > approved, "no build turn before the plan is approved");

  const telemetry = await getJson(`${base}/api/jobs/${job.id}/telemetry`);
  assert.equal(telemetry.summary.strategy, "slices");
  assert.equal(telemetry.summary.slicesCompleted, 2);
  assert.ok(telemetry.app.requests.total >= 2);

  const homePage = await fetch(job.deployment.url);
  assert.equal(homePage.ok, true);
  assert.match(await homePage.text(), /Record your daily score/);
  const slicesArtifact = await fetch(`${base}/api/jobs/${job.id}/artifacts/slices`);
  assert.equal(slicesArtifact.ok, true);
  assert.match(await slicesArtifact.text(), /SLICE-SKELETON/);
});

test("feedback preview reports a failed run without touching its evidence", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-feedback-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true, issuesUrl: "https://github.com/acme/solo-factory/issues" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({
    brief: { workingName: "Leaky", promise: "PRIVATE BRIEF" },
    transcript: [{ role: "user", content: "TRANSCRIPT SECRET" }],
    provider: "fixture",
  });
  job.state = "failed";
  job.failedState = "verifying";
  job.error = { code: "quality_gate_failed", message: "test failed. See /Users/x/log.log.", details: { gate: "test", output: "AGENT OUTPUT sk-abcdefghijklmnop" } };
  await app.store.writeState(job);
  await app.store.appendEvent(job.id, { type: "gate.failed", state: "verifying", gate: "test", durationMs: 50, message: "test failed /Users/x/log.log" });
  const jobDir = app.store.jobDir(job.id);
  const before = await Promise.all(["state.json", "events.jsonl"].map((f) => readFile(path.join(jobDir, f), "utf8")));

  const config = await getJson(`${base}/api/config`);
  assert.equal(config.version, JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual(config.issues, { base: "https://github.com/acme/solo-factory/issues", available: true });

  const fields = { title: "Test gate", happened: "<script>alert(1)</script>", expected: "pass" };
  const preview = await postJson(`${base}/api/feedback/preview`, { mode: "problem", fields, jobId: job.id, includeDiagnostics: true });
  assert.equal(preview.fingerprint, "fixture:quality_gate_failed:verifying:test");
  assert.equal(preview.redacted, false);
  assert.match(preview.markdown, /\| Error code \| quality_gate_failed \|/);
  assert.match(preview.markdown, /\| gate\.failed \| verifying \| test \| 50ms \|/);
  assert.match(preview.markdown, /<script>alert\(1\)<\/script>/);
  for (const forbidden of ["TRANSCRIPT", "PRIVATE BRIEF", "/Users/", "AGENT OUTPUT", "sk-", job.id]) assert.equal(preview.markdown.includes(forbidden), false, `leaked: ${forbidden}`);

  const without = await postJson(`${base}/api/feedback/preview`, { mode: "problem", fields, jobId: job.id, includeDiagnostics: false });
  assert.equal(without.fingerprint, null);
  assert.doesNotMatch(without.markdown, /diagnostics|lifecycle/i);

  const after = await Promise.all(["state.json", "events.jsonl"].map((f) => readFile(path.join(jobDir, f), "utf8")));
  assert.deepEqual(after, before, "preview must not mutate run evidence");
});

test("feedback preview works without an issues URL and rejects bad input with clear codes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-feedback-nourl-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true, issuesUrl: "https://gitlab.com/a/b/issues" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await getJson(`${base}/api/config`)).issues, null);

  const improvement = await postJson(`${base}/api/feedback/preview`, {
    mode: "improvement",
    fields: { title: "Faster resume", friction: "Slow", outcome: "Fast", frequency: "often", area: "recovery" },
  });
  assert.match(improvement.markdown, /- Frequency: often\n- Area: recovery/);

  const tooLarge = await fetch(`${base}/api/feedback/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "problem", fields: { title: "t", happened: "h".repeat(5000), expected: "e" } }) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "feedback_too_large");
  const invalid = await fetch(`${base}/api/feedback/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "improvement", fields: { title: "t", friction: "f", outcome: "o", frequency: "once", area: "kitchen" } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "feedback_invalid");
});

test("projects are discovered git repos; switching never interrupts a run", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-projects-"));
  const interviewCalls = [];
  const fixture = createFixtureProvider();
  const providerFactory = () => ({ ...fixture, run: (args) => (args.context?.stage === "interview" && interviewCalls.push(args), fixture.run(args)) });
  const app = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  let listing = await getJson(`${base}/api/projects`);
  assert.equal(listing.active, "projects/default");
  assert.deepEqual(listing.projects.map((p) => p.id), ["projects/default"]);

  const config = await getJson(`${base}/api/config`);
  const transcript = [{ role: "assistant", content: config.opening.message }, { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." }];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  const started = await postJson(`${base}/api/jobs`, { provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief });

  const switched = await postJson(`${base}/api/projects`, { name: "Second App!" });
  assert.equal(switched.active, "projects/second-app", "creating a project switches the view without a cancel");
  assert.equal((await getJson(`${base}/api/health`)).busyJobId, null, "busyJobId is scoped to the viewed project");
  assert.deepEqual((await getJson(`${base}/api/jobs`)).jobs, []);
  assert.equal(app.store.project, path.join(home, "projects", "second-app"));

  const done = await waitForJob(base, started.job.id, ["completed"]);
  assert.equal(done.state, "completed", "the run in the other project kept going");
  const back = await postJson(`${base}/api/projects/select`, { id: "projects/default" });
  assert.equal(back.projects.find((p) => p.id === "projects/default").lastRun.state, "completed");
  const projectDir = path.join(home, "projects", "default");
  assert.equal(interviewCalls.at(-1).cwd, projectDir, "the guide runs inside the active project");
  assert.equal(interviewCalls.at(-1).logPath, path.join(projectDir, ".aai", "memory", "interviews", "guide.log"));

  // A folder seeded by hand (no .git) is a project; selecting it initialises the repo and context.
  await mkdir(path.join(home, "projects", "seeded", "docs"), { recursive: true });
  assert.ok((await getJson(`${base}/api/projects`)).projects.some((p) => p.id === "projects/seeded"));
  await postJson(`${base}/api/projects/select`, { id: "projects/seeded" });
  assert.ok(await stat(path.join(home, "projects", "seeded", ".git")).catch(() => null));
  assert.ok(await stat(path.join(home, "projects", "seeded", ".aai", "identity.md")).catch(() => null));
  assert.equal((await fetch(`${base}/api/projects/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "../etc" }) })).status, 404);
});

test("briefs queue per project, overlap across projects, and wait behind a parked run", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-queue-"));
  const fixture = createFixtureProvider();
  const held = new Map(); // project dir -> release()
  const failNext = new Set(); // project dirs whose next build turn throws
  const providerFactory = () => ({
    ...fixture,
    run: async (args) => {
      // Any build turn, so a resume that skips specification is held too.
      if (args.context?.stage !== "interview") {
        if (held.has(args.cwd)) await held.get(args.cwd).promise;
        if (failNext.delete(args.cwd)) throw new Error("fixture specification failure");
      }
      return fixture.run(args);
    },
  });
  const hold = (dir) => { let release; const promise = new Promise((resolve) => (release = resolve)); held.set(dir, { promise, release }); };
  const release = (dir) => { held.get(dir)?.release(); held.delete(dir); };
  const app = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory, maxActiveRuns: 2 });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const config = await getJson(`${base}/api/config`);
  const transcript = [{ role: "assistant", content: config.opening.message }, { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." }];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  const submit = () => postJson(`${base}/api/jobs`, { provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief });
  const dirA = path.join(home, "projects", "default");
  const dirB = path.join(home, "projects", "beta");

  hold(dirA);
  const a1 = (await submit()).job;
  const a2 = (await submit()).job;
  assert.equal(a2.state, "queued", "a second brief in a busy project is accepted, not refused");
  assert.equal(a2.queuePosition, 1);
  await waitForJob(base, a1.id, ["specifying"]);

  hold(dirB);
  await postJson(`${base}/api/projects`, { name: "beta" });
  const b1 = (await submit()).job;
  await waitForJob(base, b1.id, ["specifying"]);
  const health = await getJson(`${base}/api/health`);
  assert.equal(health.activeRuns.length, 2, "two projects run at once under maxActiveRuns=2");
  const projects = (await getJson(`${base}/api/projects`)).projects;
  assert.equal(projects.find((p) => p.id === "projects/default").queued, 1);
  assert.equal(projects.find((p) => p.id === "projects/default").activeJobId, a1.id);

  const board = await getJson(`${base}/api/board`);
  assert.equal(board.active, 2);
  assert.deepEqual(board.columns.specifying.map((c) => c.jobId).sort(), [a1.id, b1.id].sort());
  const queuedCard = board.columns.queued.find((c) => c.jobId === a2.id);
  assert.equal(queuedCard.project, "default", "a queued card names its project");
  assert.equal(queuedCard.startedAt, null);

  release(dirA);
  assert.equal((await waitForJob(base, a1.id, ["completed"])).state, "completed");
  assert.equal((await waitForJob(base, a2.id, ["completed"])).state, "completed", "the queued brief starts when its project frees up");
  release(dirB);
  assert.equal((await waitForJob(base, b1.id, ["completed"])).state, "completed");

  // A parked run holds its project's queue until the owner resolves it.
  await postJson(`${base}/api/projects/select`, { id: "projects/default" });
  failNext.add(dirA);
  const a3 = (await submit()).job;
  assert.equal((await waitForJob(base, a3.id, ["failed"])).state, "failed");
  const a4 = (await submit()).job;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const waiting = (await getJson(`${base}/api/jobs/${a4.id}`)).job;
  assert.equal(waiting.state, "queued");
  assert.equal(waiting.blockedBy, a3.id);
  const parkedBoard = await getJson(`${base}/api/board`);
  assert.ok(parkedBoard.columns.parked.some((c) => c.jobId === a3.id), "a failed run sits in parked");
  assert.equal(parkedBoard.columns.queued.find((c) => c.jobId === a4.id).blockedBy, a3.id);

  const dequeued = await postJson(`${base}/api/jobs/${a4.id}/cancel`, {});
  assert.equal(dequeued.dequeued, true);
  assert.equal((await getJson(`${base}/api/jobs/${a4.id}`)).job.state, "cancelled");
  const a5 = (await submit()).job;
  // Dismiss hard-resets the tree, so it is refused while a resume of that run waits in the queue:
  // two held runs elsewhere fill both slots, so the resume cannot launch yet and a3 still reads parked.
  const dirC = path.join(home, "projects", "gamma");
  hold(dirB);
  hold(dirC);
  await postJson(`${base}/api/projects/select`, { id: "projects/beta" });
  const b2 = (await submit()).job;
  await postJson(`${base}/api/projects`, { name: "gamma" });
  const c1 = (await submit()).job;
  await waitForJob(base, b2.id, ["specifying"]);
  await waitForJob(base, c1.id, ["specifying"]);
  failNext.add(dirA);
  await postJson(`${base}/api/jobs/${a3.id}/resume`, {});
  const refused = await fetch(`${base}/api/jobs/${a3.id}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /writer/);
  release(dirB);
  release(dirC);
  assert.equal((await waitForJob(base, b2.id, ["completed"])).state, "completed");
  assert.equal((await waitForJob(base, c1.id, ["completed"])).state, "completed");
  assert.equal((await waitForJob(base, a3.id, ["failed"])).state, "failed");
  assert.equal((await getJson(`${base}/api/jobs/${a5.id}`)).job.state, "queued", "the start still waits behind the re-parked run");
  // The parked state lands just before the run releases the project.
  while ((await getJson(`${base}/api/health`)).activeRuns.length) await new Promise((resolve) => setTimeout(resolve, 20));
  // Setting aside a failed follow-on rewinds the app to the release before it, keeping owner data.
  await writeFile(path.join(dirA, "half-built.js"), "// left by the failed run\n");
  await mkdir(path.join(dirA, "data"), { recursive: true });
  await writeFile(path.join(dirA, "data", "habits.json"), '["day 1"]');
  await postJson(`${base}/api/jobs/${a3.id}/dismiss`, {});
  assert.equal(existsSync(path.join(dirA, "half-built.js")), false, "the failed run's work is rolled back");
  assert.equal(await readFile(path.join(dirA, "data", "habits.json"), "utf8"), '["day 1"]', "owner data survives the rollback");
  assert.equal((await waitForJob(base, a5.id, ["completed"])).state, "completed", "dismissing the parked run releases the queue");
});

test("a job still queued when the server stopped starts on the next boot", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-queue-restart-"));
  const first = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => first.server.listen(0, "127.0.0.1", resolve));
  const firstBase = `http://127.0.0.1:${first.server.address().port}`;
  const config = await getJson(`${firstBase}/api/config`);
  const transcript = [{ role: "assistant", content: config.opening.message }, { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." }];
  const guide = await postJson(`${firstBase}/api/interview/turn`, { provider: "fixture", messages: transcript });
  // Created on disk but never enqueued, which is exactly what a stop leaves behind: the in-memory queue is gone.
  const queued = await first.store.create({ brief: guide.brief, transcript, provider: "fixture" });
  await first.close();

  const second = await createSoloFactoryServer({ home, fixtureMode: true });
  const base = await listen(second, t);
  assert.equal((await waitForJob(base, queued.id, ["completed"])).state, "completed");
});

test("a completed job in a non-active project is still reachable by id after a restart", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-restart-lookup-"));
  const first = await createSoloFactoryServer({ home, fixtureMode: true });
  const firstBase = await listen(first, t);
  const config = await getJson(`${firstBase}/api/config`);
  const transcript = [{ role: "assistant", content: config.opening.message }, { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." }];
  const guide = await postJson(`${firstBase}/api/interview/turn`, { provider: "fixture", messages: transcript });
  await postJson(`${firstBase}/api/projects`, { name: "beta" });
  const betaJob = (await postJson(`${firstBase}/api/jobs`, { provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief })).job;
  assert.equal((await waitForJob(firstBase, betaJob.id, ["completed"])).state, "completed");
  await first.close();

  // Restart with a different project active; jobProject's in-memory map is gone, so lookups
  // must be reseeded from disk rather than defaulting to whichever project is now active.
  const second = await createSoloFactoryServer({ home, fixtureMode: true });
  const base = await listen(second, t);
  await postJson(`${base}/api/projects/select`, { id: "projects/default" });
  const found = await getJson(`${base}/api/jobs/${betaJob.id}`);
  assert.equal(found.job.id, betaJob.id, "the beta project's job resolves from its own store, not the active project's");
});

async function listen(app, t) {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function waitForJob(base, id, states, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    job = (await getJson(`${base}/api/jobs/${id}`)).job;
    if (states.includes(job.state) || (job.state === "failed" && !states.includes("failed"))) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return job;
}

test("operational errors from the server, browser, and chat land in one scrubbed log", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-errors-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  assert.equal((await fetch(`${base}/api/jobs/no-such-run`)).status, 404);
  const logged = await fetch(`${base}/api/errors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "chat", action: "resume", message: "boom at /Users/owner/secret/app with sk-abcdefghijkl" }) });
  assert.equal(logged.status, 202);
  const invalid = await fetch(`${base}/api/errors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "someone", message: "x" }) });
  assert.equal(invalid.status, 400);

  const { errors } = await getJson(`${base}/api/errors`);
  assert.deepEqual(errors.map((entry) => entry.source), ["server", "chat"]);
  assert.equal(errors[0].status, 404);
  assert.equal(errors[1].action, "resume");
  assert.equal(errors[1].message, "boom at [redacted] with [redacted]");
  assert.ok(errors.every((entry) => entry.at && entry.version));
  assert.match(await readFile(path.join(home, "errors.jsonl"), "utf8"), /"source":"chat"/);
});

test('Guide and recovery packet receive full matching review diagnostics without rewriting history', async t => {
  const { prepareReview } = await import('../src/review.mjs');
  const { buildRecovery } = await import('../src/factory.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-review-guide-'));
  const calls = [];
  const fixture = createFixtureProvider();
  const app = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory: () => ({ id: 'fixture', async run(args) { calls.push(args); return fixture.run(args); } }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: {workingName:'Blocked photo library',mustHaves:['Years and Months browsing','Real EXIF extraction'],acceptanceScenarios:['A matching import updates its saved album.']},transcript:[{role:'user',content:'Recover missing features'}],provider:'fixture',sdlc:'single' });
  const cwd = app.store.appDir(job.id);
  await fixture.run({cwd,context:{stage:'specification',job}});
  await writeFile(path.join(cwd,'.factory/requirements.json'),JSON.stringify({brief:job.brief}));
  job.reviewRequest = await prepareReview(cwd,job);
  await fixture.run({cwd,context:{stage:'review',job}});
  const file = path.join(cwd,'.factory/review-result.json');
  const report = JSON.parse(await readFile(file,'utf8'));
  report.verdict='blocked';report.blockers=['No metadata pipeline'];
  report.checks[0].status='unverified';report.checks[1].status='missing';
  await writeFile(file,JSON.stringify(report));
  job.state='failed';job.failedState='reviewing';job.attempt=2;
  job.error={code:'review_rejected',message:'Review blocked: MH-1 is unverified.',details:{}};
  job.recovery=buildRecovery(job,cwd);
  await app.store.writeState(job);
  const before=JSON.stringify(await app.store.read(job.id));
  const packet=await (await fetch(`${base}/api/jobs/${job.id}/recovery-packet`)).text();
  for(const text of ['Years and Months browsing','Real EXIF extraction','No metadata pipeline','Prepare repair plan','Resume does not renew','2 automatic repairs']) assert.ok(packet.includes(text),text);
  await postJson(`${base}/api/interview/turn`,{provider:'fixture',messages:[{role:'user',content:'What does MH-1 mean?'}]});
  const call=calls.find(x=>x.context.stage==='interview');
  assert.match(call.prompt,/Years and Months browsing/);
  assert.match(call.prompt,/Real EXIF extraction/);
  assert.match(call.prompt,/No metadata pipeline/);
  assert.match(call.prompt,/Guide runs read-only/);
  assert.match(call.prompt,/"strategy": "single"/);
  assert.equal(JSON.stringify(await app.store.read(job.id)),before);
});

test('HTTP feature recovery requires matching approval and respects the project writer', async t => {
  const { prepareReview } = await import('../src/review.mjs');
  const { buildRecovery } = await import('../src/factory.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-feature-recovery-'));
  const fixture = createFixtureProvider();
  let releasePlan;
  const holdPlan = new Promise(resolve => { releasePlan = resolve; });
  let planningStarted;
  const sawPlan = new Promise(resolve => { planningStarted = resolve; });
  const app = await createSoloFactoryServer({ home, fixtureMode: true, autoStartRepairs: false, providerFactory: () => ({
    id: 'fixture', async run(args) {
      if (args.context.stage.startsWith('recovery-plan-')) { planningStarted(); await holdPlan; }
      return fixture.run(args);
    },
  }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { releasePlan(); return app.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: 'Recovery HTTP', mustHaves: ['Edit live albums'], acceptanceScenarios: ['New photos enter a saved album'] }, transcript: [{ role: 'user', content: 'Recover existing behavior' }], provider: 'fixture', sdlc: 'single' });
  const cwd = app.store.appDir();
  await mkdir(path.join(cwd, '.factory'), { recursive: true });
  await writeFile(path.join(cwd, '.factory/requirements.json'), JSON.stringify(job.brief));
  for (const stage of ['specification', 'build']) await fixture.run({ cwd, context: { stage, job } });
  job.reviewRequest = await prepareReview(cwd, job); job.reviewContractDigest = job.reviewRequest.contractDigest;
  await fixture.run({ cwd, context: { stage: 'review', job } });
  const reportPath = path.join(cwd, '.factory/review-result.json'); const report = JSON.parse(await readFile(reportPath));
  report.verdict = 'blocked'; report.blockers = ['Missing live rules']; report.checks[0].status = 'missing';
  await writeFile(reportPath, JSON.stringify(report)); await app.store.commit('fixture baseline');
  job.startedAt = new Date().toISOString(); job.state = 'failed'; job.failedState = 'reviewing'; job.error = { code: 'review_rejected', message: 'Missing live rules' };
  job.attempt = 2; job.recovery = { ...buildRecovery(job, cwd), canResume: true }; await app.store.writeState(job); // stored canResume predates the exhausted gate
  const exhausted = await fetch(`${base}/api/jobs/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(exhausted.status, 409); assert.match((await exhausted.json()).error, /Prepare a repair plan/);
  assert.equal((await app.store.read(job.id)).attempt, 2);
  const guide = await postJson(`${base}/api/interview/turn`, { provider: 'fixture', messages: [{ role: 'user', content: 'Queue a later feature after recovery' }] });
  const waiting = await postJson(`${base}/api/jobs`, { provider: 'fixture', transcript: [{ role: 'user', content: 'Build this after the preserved recovery completes' }], coverage: guide.coverage, brief: guide.brief });
  assert.equal(waiting.job.state, 'queued', 'a later release must wait behind the parked run');
  await postJson(`${base}/api/jobs/${job.id}/recovery-plan`, {}); await sawPlan;
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/recovery-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
  releasePlan();
  let ready; const deadline = Date.now() + 20_000;
  do { await new Promise(r => setTimeout(r, 50)); ready = (await getJson(`${base}/api/jobs/${job.id}`)).job; } while (!['paused', 'failed'].includes(ready.state) && Date.now() < deadline);
  assert.equal(ready.recoveryPhase?.status, 'ready', ready.error?.message);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/recovery-start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planDigest: 'wrong' }) })).status, 409);
  await postJson(`${base}/api/jobs/${job.id}/recovery-start`, { planDigest: ready.recoveryPhase.planDigest });
  let after;
  do { await new Promise(r => setTimeout(r, 100)); after = (await getJson(`${base}/api/jobs/${job.id}`)).job; } while (!['completed', 'failed'].includes(after.state) && Date.now() < deadline);
  assert.equal(after.state, 'completed', after.error?.message);
  assert.equal(after.sdlc, 'single'); assert.deepEqual(after.recoveryPhase.done, ['RECOVERY-1']);
});

test('HTTP: a saved plan_failed run with a stale Resume banner presents planning retry everywhere', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-plan-failed-'));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: 'Plan failed', mustHaves: ['Browse'], acceptanceScenarios: ['Browse works'] }, transcript: [{ role: 'user', content: 'Recover' }], provider: 'fixture', sdlc: 'slices' });
  Object.assign(job, { state: 'failed', failedState: 'reviewing', attempt: 1,
    error: { code: 'unexpected_error', message: 'Repair plan review is still blocked.', details: {} },
    recoveryPhase: { id: 'r1', status: 'plan_failed', request: { checks: [{ id: 'MH-1', text: 'Browse' }] }, planBlockers: ['MH-1 has no obligation'], done: [] },
    recovery: { version: 2, status: 'needs_owner', title: 'The run paused before completion', summary: 'Stopped safely.', actions: ['Review the recovery packet and the named log, then resume this run from its preserved files.'], canResume: true, automaticRetry: 'No automatic retry was needed or safe.' } });
  await app.store.writeState(job);
  const stateFile = path.join(app.store.jobDir(job.id), 'state.json');
  const saved = await readFile(stateFile, 'utf8');
  const { job: shown } = await getJson(`${base}/api/jobs/${job.id}`);
  assert.equal(shown.recovery.canResume, false);
  assert.deepEqual([shown.nextAction.action, shown.nextAction.label, shown.nextAction.endpoint], ['retry-plan', 'Retry repair-plan preparation', `/api/jobs/${job.id}/recovery-plan`]);
  assert.ok(shown.recovery.actions.some(text => /Retry repair-plan preparation/.test(text)));
  const listed = (await getJson(`${base}/api/jobs`)).jobs.find(item => item.id === job.id);
  assert.equal(listed.nextAction.action, 'retry-plan');
  const refused = await fetch(`${base}/api/jobs/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.match(body.error, /Retry repair-plan preparation/); assert.equal(body.nextAction.endpoint, `/api/jobs/${job.id}/recovery-plan`);
  assert.equal(await readFile(stateFile, 'utf8'), saved, 'presentation derives the banner; it never rewrites the saved job');
  // The dashboard renders the derived action, not the saved flag.
  const dashboard = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(dashboard, /recovery\?\.canResume/);
  assert.match(dashboard, /nextAction\?\.action !== "resume"/);
  assert.match(dashboard, /next\?\.action === "retry-plan"/);
});

test('HTTP: a repair plan blocked after its corrections offers a corrected-plan review and refuses an unchanged retry', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-plan-blocked-'));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: 'Plan blocked', mustHaves: ['Browse'], acceptanceScenarios: ['Browse works'] }, transcript: [{ role: 'user', content: 'Recover' }], provider: 'fixture', sdlc: 'slices' });
  // A run that reached repair planning has its frozen contract on disk.
  await mkdir(path.join(app.store.appDir(), '.factory'), { recursive: true });
  for (const file of ['requirements.json', 'PRD.md', 'PLAN.md', 'ACCEPTANCE.md']) await writeFile(path.join(app.store.appDir(), '.factory', file), file);
  const sourcesDigest = digest(await sourceSet(app.store.appDir(), runInputs(job)));
  Object.assign(job, { state: 'failed', failedState: 'specifying', attempt: 1,
    error: { code: 'plan_blocked', message: 'The repair plan is still blocked after 2 corrections: MH-1 has no obligation', details: {} },
    recoveryPhase: { id: 'r1', status: 'plan_failed', corrections: 2, request: { checks: [{ id: 'MH-1', text: 'Browse' }], sourcesDigest }, planBlockers: ['MH-1 has no obligation'], done: [] } });
  await app.store.writeState(job);
  const { job: shown } = await getJson(`${base}/api/jobs/${job.id}`);
  const saved = await readFile(path.join(app.store.jobDir(job.id), 'state.json'), 'utf8');
  assert.equal(shown.nextAction.action, 'amend-plan');
  assert.match(shown.nextAction.reason, /Automatic plan corrections are exhausted/);
  assert.equal(shown.nextAction.alternatives[0].action, 'revise-inputs');
  assert.ok(shown.recovery.actions.some(text => text.startsWith('Submit corrected plan for review')), shown.recovery.actions.join(' | '));
  assert.ok(!shown.recovery.actions.some(text => /retry repair-plan/i.test(text)));
  const refused = await fetch(`${base}/api/jobs/${job.id}/recovery-plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.match(body.error, /Submit corrected plan for review/); assert.equal(body.nextAction.action, 'amend-plan'); assert.deepEqual(body.blockers, ['MH-1 has no obligation']);
  assert.equal(await readFile(path.join(app.store.jobDir(job.id), 'state.json'), 'utf8'), saved);
  assert.match(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), /next\?\.action === "amend-plan"/);
});

test('HTTP: Resume of an exhausted initial plan refuses a plan the reviewer already blocked before queueing', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-plan-unchanged-'));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: 'Plan unchanged', mustHaves: ['Browse'], acceptanceScenarios: ['Browse works'] }, transcript: [{ role: 'user', content: 'Build' }], provider: 'fixture' });
  assert.equal(job.planVersion, 2);
  const plan = { version: 2, slices: [] };
  await mkdir(path.join(app.store.appDir(), '.factory'), { recursive: true });
  await writeFile(path.join(app.store.appDir(), '.factory/slices.json'), JSON.stringify(plan, null, 2));
  Object.assign(job, { state: 'failed', failedState: 'specifying', planCorrections: 2, planBlockedDigests: [digest(plan)],
    error: { code: 'plan_blocked', message: 'The feature plan is still blocked after 2 corrections: MH-1 has no obligation', details: {} } });
  await app.store.writeState(job);
  const stateFile = path.join(app.store.jobDir(job.id), 'state.json');
  const { job: shown } = await getJson(`${base}/api/jobs/${job.id}`);
  assert.equal(shown.nextAction.label, 'Resume plan review');
  const saved = await readFile(stateFile, 'utf8');
  const refused = await fetch(`${base}/api/jobs/${job.id}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'plan_unchanged');
  assert.equal(await readFile(stateFile, 'utf8'), saved);
});

test('HTTP: a new spec file added to a parked run becomes one of its inputs', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-new-input-'));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: 'New spec', mustHaves: ['Browse'], acceptanceScenarios: ['Browse works'] }, transcript: [{ role: 'user', content: 'Build' }], provider: 'fixture' });
  const plan = { version: 2, slices: [] };
  await mkdir(path.join(app.store.appDir(), '.factory'), { recursive: true });
  for (const file of ['requirements.json', 'PRD.md', 'PLAN.md', 'ACCEPTANCE.md']) await writeFile(path.join(app.store.appDir(), '.factory', file), file);
  await writeFile(path.join(app.store.appDir(), '.factory/slices.json'), JSON.stringify(plan));
  const add = (name, body, id = job.id) => fetch(`${base}/api/jobs/${id}/inputs?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  // Only a parked run takes a new input: a live planning turn would see its inputs move underneath it.
  assert.equal((await add('EXTRA.md', 'x')).status, 409);
  Object.assign(job, { state: 'failed', failedState: 'specifying', planCorrections: 2, planBlockedDigests: [digest(plan)],
    planBaseline: { inputs: digest(await sourceSet(app.store.appDir(), runInputs(job))) },
    error: { code: 'plan_blocked', message: 'The feature plan is still blocked after 2 corrections: MH-1 has no obligation', details: {} } });
  await app.store.writeState(job);
  await assert.rejects(assertPlanReviewable(app.store, await app.store.read(job.id), 2), error => error.code === 'plan_unchanged');
  assert.equal((await add('script.sh', 'rm -rf /')).status, 400);
  assert.equal((await add('EMPTY.md', '')).status, 400);
  const added = await add('EXTRA.md', '§9 Albums sort by capture date.');
  assert.equal(added.status, 200);
  const { path: relative } = await added.json();
  assert.match(relative, /^\.factory\/uploads\/[a-z0-9]+-EXTRA\.md$/);
  assert.equal(await readFile(path.join(app.store.appDir(), relative), 'utf8'), '§9 Albums sort by capture date.');
  const saved = await app.store.read(job.id);
  assert.ok(runInputs(saved).includes(relative), 'the run records the file as an attachment, so every digest and review sees it');
  await assertPlanReviewable(app.store, saved, 2);
});

test("HTTP: an image uploaded for another brief while a run builds does not stop that run", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-uploads-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const upload = async (name, body) => {
    const response = await fetch(`${base}/api/interview/upload?name=${name}`, { method: "POST", body });
    assert.equal(response.ok, true);
    return (await response.json()).path;
  };

  const config = await getJson(`${base}/api/config`);
  const mine = await upload("mockup.png", "own mockup");
  const transcript = [
    { role: "assistant", content: config.opening.message },
    { role: "user", content: `Build a tiny private daily tracker with no login and observable save behavior.\nAttached image: ${mine}` },
  ];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  transcript.push({ role: "assistant", content: guide.message });
  let job = (await postJson(`${base}/api/jobs`, { provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief })).job;
  await upload("other-brief.png", "next idea");

  const deadline = Date.now() + 60_000;
  while (!["completed", "failed"].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  }
  assert.equal(job.state, "completed", job.error?.message);
  assert.deepEqual(job.approvedPlan.sources.map((item) => item.path).filter((file) => file.includes("uploads/")), [mine]);
});

// A parked run whose repair budget is spent, with repair-plan preparation held mid-turn until aborted.
async function planningInFlight(home) {
  const { prepareReview } = await import("../src/review.mjs");
  const { buildRecovery } = await import("../src/factory.mjs");
  const fixture = createFixtureProvider();
  let planningStarted;
  const sawPlan = new Promise((resolve) => { planningStarted = resolve; });
  const providerFactory = () => ({ id: "fixture", async run(args) {
    if (args.context.stage.startsWith("recovery-plan-")) {
      planningStarted();
      await new Promise((resolve) => args.signal.aborted ? resolve() : args.signal.addEventListener("abort", resolve, { once: true }));
      throw Object.assign(new Error("worker stopped"), { code: "agent_failed" });
    }
    return fixture.run(args);
  } });
  const app = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const job = await app.store.create({ brief: { workingName: "Shutdown fixture", mustHaves: ["Edit live albums"], acceptanceScenarios: ["New photos enter a saved album"] }, transcript: [{ role: "user", content: "Recover existing behavior" }], provider: "fixture", sdlc: "single" });
  const cwd = app.store.appDir();
  await mkdir(path.join(cwd, ".factory"), { recursive: true });
  await writeFile(path.join(cwd, ".factory/requirements.json"), JSON.stringify(job.brief));
  for (const stage of ["specification", "build"]) await fixture.run({ cwd, context: { stage, job } });
  job.reviewRequest = await prepareReview(cwd, job); job.reviewContractDigest = job.reviewRequest.contractDigest;
  await fixture.run({ cwd, context: { stage: "review", job } });
  const reportPath = path.join(cwd, ".factory/review-result.json"); const report = JSON.parse(await readFile(reportPath));
  report.verdict = "blocked"; report.blockers = ["Missing live rules"]; report.checks[0].status = "missing";
  await writeFile(reportPath, JSON.stringify(report)); await app.store.commit("fixture baseline");
  job.startedAt = new Date().toISOString(); job.state = "failed"; job.failedState = "reviewing"; job.error = { code: "review_rejected", message: "Missing live rules" };
  job.attempt = 2; job.recovery = buildRecovery(job, cwd); await app.store.writeState(job);
  await postJson(`${base}/api/jobs/${job.id}/recovery-plan`, {});
  await sawPlan;
  return { app, base, job, providerFactory };
}
const stateFile = (app, id) => readFile(path.join(app.store.jobDir(id), "state.json"), "utf8");
const post = (url, body = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Smoke 2026-10-10: stopping the server mid-plan saved the run as owner-cancelled and offered Retry plan.
test("HTTP: server shutdown interrupts an active run and keeps its stage, budget and continuation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-http-shutdown-"));
  const { app, job, providerFactory } = await planningInFlight(home);
  const live = JSON.parse(await stateFile(app, job.id));
  assert.equal(live.state, "specifying");
  await app.close();
  const saved = JSON.parse(await stateFile(app, job.id));
  assert.equal(saved.state, "interrupted", saved.error?.message);
  assert.equal(saved.error.code, "process_restarted");
  assert.equal(saved.failedState, live.state, "the stage it stopped in is preserved, as a restart records it");
  assert.equal(saved.attempt, 2, "the spent repair budget is preserved");
  assert.deepEqual(saved.featureCursor, live.featureCursor);
  assert.equal(saved.recoveryPhase.request.id, live.recoveryPhase.request.id, "the interrupted preparation's evidence is kept");
  const events = await app.store.events(job.id, 1000);
  assert.ok(events.some((event) => event.type === "job.interrupted"));
  assert.ok(!events.some((event) => event.type === "job.cancelled"));

  const again = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory });
  const base = await listen(again, t);
  const reopened = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  assert.equal(reopened.state, "interrupted");
  assert.equal(reopened.nextAction.action, "retry-plan");
});

test("HTTP: owner cancellation is final; plan, resume and start are refused and the saved run is unchanged", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-http-owner-cancel-"));
  const { app, base, job } = await planningInFlight(home);
  t.after(() => app.close());
  assert.equal((await post(`${base}/api/jobs/${job.id}/cancel`)).status, 202);
  const cancelled = await waitForJob(base, job.id, ["cancelled"]);
  assert.equal(cancelled.state, "cancelled", cancelled.error?.message);
  assert.equal(cancelled.error.code, "cancelled");
  assert.equal(cancelled.nextAction.action, "none");
  assert.equal(cancelled.recovery.canResume, false);
  const before = await stateFile(app, job.id);
  for (const [action, body] of [["recovery-plan", {}], ["resume", {}], ["recovery-start", { planDigest: "anything" }]]) {
    const response = await post(`${base}/api/jobs/${job.id}/${action}`, body);
    assert.equal(response.status, 409, action);
    assert.equal(await stateFile(app, job.id), before, `${action} leaves the saved run unchanged`);
  }
  // The controller refuses the same actions directly, before any write.
  const { SoloFactory } = await import("../src/factory.mjs");
  const factory = new SoloFactory({ store: app.store, provider: createFixtureProvider() });
  await assert.rejects(factory.planRecovery(job.id));
  await assert.rejects(factory.resume(job.id));
  await assert.rejects(factory.startRecovery(job.id, "anything"));
  assert.equal(await stateFile(app, job.id), before, "a refused controller action leaves the saved run unchanged");
});

test("close() finishes promptly while a browser holds keep-alive and stalled requests open", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-close-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  // The run page's live updates: a keep-alive connection left idle after a poll.
  const poller = net.connect(port, "127.0.0.1");
  poller.on("error", () => {});
  poller.write("GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  await new Promise((resolve) => poller.once("data", resolve));
  // A request mid-flight that never completes its body; server.close() alone waits on it forever.
  const stalled = net.connect(port, "127.0.0.1");
  stalled.on("error", () => {});
  stalled.write("POST /api/projects HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 3000, `close() took ${Date.now() - started}ms`);
  poller.destroy();
  stalled.destroy();
});

test("the activity stream keeps rare stage and gate rows under thousands of tool events", async () => {
  // The dashboard is a browser script, so its two pure helpers are lifted out by source and run here.
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const helpers = source.match(/const eventKind = [\s\S]*?\n}\n/)[0];
  const streamRows = new Function(`${helpers}; return streamRows;`)();
  const events = [{ type: "stage.started", at: "0", message: "building" }, { type: "gate.passed", at: "1", message: "test" }];
  for (let i = 0; i < 2000; i += 1) events.push({ type: "item.completed", at: String(2 + i), message: "Completed Bash npm test" });
  const all = streamRows(events, "all");
  assert.equal(all.length, 302);
  assert.deepEqual(all.slice(-2).map((entry) => entry.type), ["gate.passed", "stage.started"], "oldest rare rows stay, newest first");
  assert.equal(all[0].at, "2001");
  assert.deepEqual(streamRows(events, "gate").map((entry) => entry.type), ["gate.passed"]);
});

test("the pipeline view's time so far leaves out pauses and stops", async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const lift = (name) => source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0];
  const stateRunningMs = new Function(`${lift("runningMs")}${lift("stateRunningMs")}; return stateRunningMs;`)();
  const at = (minute) => Date.parse("2026-10-14T00:00:00Z") + minute * 60_000;
  const iso = (minute) => new Date(at(minute)).toISOString();
  const job = {
    // Building ran 10 minutes, parked 3 hours, then ran 20 more after the resume; verifying is still underway.
    stageHistory: [
      { state: "building", startedAt: iso(0), endedAt: iso(190) },
      { state: "building", startedAt: iso(190), endedAt: iso(210) },
      { state: "verifying", startedAt: iso(210) },
    ],
    idleGaps: [[at(10), at(190)]],
  };
  assert.deepEqual(stateRunningMs(job, at(215)), { building: 30 * 60_000, verifying: 5 * 60_000 });
});

test("the stage rail marks finished stages done, and every stage on a completed run", async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const lift = (pattern) => source.match(pattern)[0];
  const railMarks = new Function(`${lift(/const stageOrder = .*\n/)}${lift(/function railMarks\([\s\S]*?\n}\n/)}; return railMarks;`)();
  assert.deepEqual(railMarks("reviewing"), { active: "reviewing", done: ["specifying", "building", "verifying"] });
  assert.deepEqual(railMarks("repairing"), { active: "verifying", done: ["specifying", "building"] });
  const completed = railMarks("completed");
  for (const stage of ["specifying", "building", "verifying", "reviewing", "deploying"]) assert.ok(completed.done.includes(stage), stage);
  assert.deepEqual(railMarks("queued").done, []);
});
