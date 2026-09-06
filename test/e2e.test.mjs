import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSoloFactoryServer } from "../src/server.mjs";
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
