import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSoloFactoryServer } from "../src/server.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { COVERAGE_KEYS } from "../src/interview.mjs";

test("HTTP journey goes from Guide turn to a reachable generated app", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const config = await getJson(`${base}/api/config`);
  assert.equal(config.providers[0].authenticated, true);

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
    brief: { workingName: "Preserved fixture" },
    transcript: [{ role: "user", content: "Build the preserved app." }],
    provider: "fixture",
  });
  job.state = "failed";
  job.stage = "Run failed";
  job.error = { code: "unexpected_error", message: "Codex timed out." };
  job.stageHistory.push({ state: "building", label: "Building", startedAt: new Date().toISOString(), endedAt: null });
  await app.store.writeState(job);
  const logDir = path.join(app.store.appDir(job.id), ".factory", "logs");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, "build.log"),
    "getaddrinfo ENOTFOUND registry.npmjs.org\nxcodebuild requires Xcode; active developer directory '/Library/Developer/CommandLineTools'\n",
  );

  const failed = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  assert.equal(failed.recovery.canResume, true);
  assert.equal(failed.recovery.actions.length, 2);
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

test("HTTP journey with the vertical-slice strategy completes and serves the final slice", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-http-slices-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const config = await getJson(`${base}/api/config`);
  assert.equal(config.sdlcOptions.length, 2);
  const transcript = [
    { role: "assistant", content: config.opening.message },
    { role: "user", content: "Build a tiny private daily tracker with no login and observable save behavior." },
  ];
  const guide = await postJson(`${base}/api/interview/turn`, { provider: "fixture", messages: transcript });
  assert.equal(guide.status, "ready");
  transcript.push({ role: "assistant", content: guide.message });

  const started = await postJson(`${base}/api/jobs`, {
    provider: "fixture",
    transcript,
    coverage: guide.coverage,
    brief: guide.brief,
    sdlc: "slices",
  });
  assert.equal(started.job.sdlc, "slices");
  let job = started.job;
  const deadline = Date.now() + 60_000;
  while (!["completed", "failed"].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await getJson(`${base}/api/jobs/${job.id}`)).job;
  }
  assert.equal(job.state, "completed", job.error?.message);
  assert.deepEqual(job.sliceDone, ["SLICE-SKELETON", "SLICE-UI"]);

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
  const failNext = new Set(); // project dirs whose next specification turn throws
  const providerFactory = () => ({
    ...fixture,
    run: async (args) => {
      if (args.context?.stage === "specification") {
        if (failNext.delete(args.cwd)) throw new Error("fixture specification failure");
        if (held.has(args.cwd)) await held.get(args.cwd).promise;
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

  const dequeued = await postJson(`${base}/api/jobs/${a4.id}/cancel`, {});
  assert.equal(dequeued.dequeued, true);
  assert.equal((await getJson(`${base}/api/jobs/${a4.id}`)).job.state, "cancelled");
  const a5 = (await submit()).job;
  await postJson(`${base}/api/jobs/${a3.id}/dismiss`, {});
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
