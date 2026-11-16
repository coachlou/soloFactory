// Brief B: data-backup hold before an update deploys, and rollback of a shipped release (docs/live-app-restart-rollback-spec.md).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, previousRelease } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";
import { dataFeatures, dataShape, shapeChanges, writeConfirmation } from "../src/data-backup.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const types = async (store, id) => (await store.events(id, Infinity)).map((event) => event.type);
const writeData = async (dir, name, value) => {
  await mkdir(path.join(dir, "data"), { recursive: true });
  await writeFile(path.join(dir, "data", name), JSON.stringify(value));
};

// A fixture provider that counts model calls and can flag the recording feature as touching data.
function provider({ touchesData = false, onStage } = {}) {
  const fixture = createFixtureProvider();
  const counter = { calls: 0, id: "fixture", async run(options) {
    counter.calls += 1;
    const result = await fixture.run(options);
    if (touchesData && options.context.stage === "feature-plan") {
      const file = path.join(options.cwd, ".factory", "slices.json");
      const plan = JSON.parse(await readFile(file, "utf8"));
      plan.slices.at(-1).touchesData = true;
      await writeFile(file, JSON.stringify(plan, null, 2));
    }
    await onStage?.(options.context.stage);
    return result;
  } };
  return counter;
}

// A project under root/projects/demo with a shipped first release, so the next run is a follow-on.
async function shippedProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-rollback-"));
  const dir = path.join(root, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const store = new JobStore(dir);
  await store.init();
  const factories = [];
  t.after(() => Promise.all(factories.map((factory) => factory.shutdown())));
  const release = async (options = {}) => {
    const job = await store.create({ brief, transcript, provider: "fixture" });
    const factory = new SoloFactory({ store, provider: options.provider ?? provider(options) });
    factories.push(factory);
    return { factory, result: await factory.start(job.id) };
  };
  const { result: first } = await release();
  assert.equal(first.state, "completed", first.error?.message);
  return { root, dir, store, factories, release, first };
}

test("an update that touches data parks before deploy until the backup is confirmed, then deploys with no model call", async (t) => {
  const { dir, store, release } = await shippedProject(t);
  await writeData(dir, "entries.json", { items: [{ id: 1, score: 5 }] });
  const counting = provider({ touchesData: true });
  const { factory, result: parked } = await release({ provider: counting });
  assert.equal(parked.state, "failed");
  assert.equal(parked.error.code, "backup_unconfirmed", parked.error.message);
  assert.deepEqual(parked.dataFeatures.map((item) => item.id), ["SLICE-UI"]);
  assert.ok((await types(store, parked.id)).includes("data.backup_requested"));
  assert.equal(parked.deployment?.status === "live", false);

  // What POST /backup-confirmed does.
  const confirmation = await writeConfirmation(store.jobDir(parked.id), parked);
  await store.writeState({ ...parked, dataBackupConfirmed: confirmation, dataBackupConfirmedAt: confirmation.at });
  const calls = counting.calls;
  const done = await factory.resume(parked.id);
  assert.equal(done.state, "completed", done.error?.message);
  assert.equal(counting.calls, calls, "the deploy continues with no review, repair or model call");
  assert.equal(done.dataBackupConfirmedAt, confirmation.at);
  assert.ok(done.dataShape.includes("file entries.json"), "the follow-on records the data's shape as it goes live");
});

test("a backup confirmed during the build never stops the deploy", async (t) => {
  const { dir, store, release } = await shippedProject(t);
  await writeData(dir, "entries.json", { items: [] });
  const onStage = async (stage) => {
    if (!stage.startsWith("build-slice-")) return;
    const job = (await store.list())[0];
    if (job.dataFeatures?.length) await writeConfirmation(store.jobDir(job.id), job);
  };
  const { result } = await release({ touchesData: true, onStage });
  assert.equal(result.state, "completed", result.error?.message);
  assert.ok(result.dataBackupConfirmedAt);
});

test("an empty data/ never asks, and a plan with no data feature never asks", async (t) => {
  const { dir, release } = await shippedProject(t);
  const { result: empty } = await release({ touchesData: true });
  assert.equal(empty.state, "completed", empty.error?.message);
  assert.equal(empty.hadData, false);
  assert.equal(empty.dataFeatures?.length ?? 0, 0);
  await writeData(dir, "entries.json", { items: [{ id: 1 }] });
  const { result: plain } = await release();
  assert.equal(plain.state, "completed", plain.error?.message);
  assert.equal(plain.dataFeatures.length, 0);
});

test("a feature that writes the store module touches data even without the planner's flag", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-datafeat-"));
  const store = new JobStore(dir);
  await store.init();
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "store.mjs"), "export const save = () => {};\n");
  await writeFile(path.join(dir, "notes.mjs"), "export const n = 1;\n");
  await store.commit("app");
  const job = { id: "x", followOn: true, hadData: true };
  const slice = (id, writes) => ({ id, title: id, writes });
  assert.deepEqual((await dataFeatures(store, job, [slice("A", ["src/store.mjs"]), slice("B", ["notes.mjs"])])).map((item) => item.id), ["A"]);
  assert.deepEqual(await dataFeatures(store, { ...job, followOn: false }, [slice("A", ["src/store.mjs"])]), [], "a first release never asks");
});

test("the data shape ignores values, ids and dates and sees added keys, columns and file patterns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "solo-factory-shape-"));
  await writeData(dir, "2026-11-01.json", { items: [{ id: 1, score: 5, at: "2026-11-01" }] });
  const before = await dataShape(dir);
  await writeData(dir, "2026-11-02.json", { items: [{ id: 99, score: 1, at: "2026-11-02" }, { id: 100, score: 2, at: "x" }] });
  assert.deepEqual(shapeChanges(before, await dataShape(dir)), [], "new records of the same kind keep the shape");
  await writeData(dir, "2026-11-03.json", { items: [{ id: 3, score: 4, at: "y", mood: "ok" }] });
  assert.match(shapeChanges(before, await dataShape(dir)).join("\n"), /added .*mood/);

  const db = path.join(dir, "data", "app.db");
  new DatabaseSync(db).exec("CREATE TABLE entries (id INTEGER, score INTEGER)");
  const withDb = await dataShape(dir);
  const handle = new DatabaseSync(db);
  handle.exec("INSERT INTO entries VALUES (1, 2)");
  handle.close();
  assert.deepEqual(shapeChanges(withDb, await dataShape(dir)), [], "rows are content, not shape");
  const alter = new DatabaseSync(db);
  alter.exec("ALTER TABLE entries ADD COLUMN mood TEXT");
  alter.close();
  assert.ok(shapeChanges(withDb, await dataShape(dir)).some((line) => line.includes("mood")), "an added column is a change");
  await writeFile(path.join(dir, "data", "photos.bin"), "x");
  assert.ok(shapeChanges(withDb, await dataShape(dir)).includes("added file photos.bin"));
});

test("rollback puts the previous release's code back and live, keeps data/, and survives a server restart", async (t) => {
  const { root, dir, store, factories, release, first } = await shippedProject(t);
  await writeData(dir, "entries.json", { items: [{ id: 1, score: 5 }] });
  const { result: second } = await release();
  assert.equal(second.state, "completed", second.error?.message);
  assert.equal(second.followOn, true);
  await Promise.all(factories.map((factory) => factory.shutdown()));
  // The new release wrote a new field and a new file after it went live.
  await writeData(dir, "entries.json", { items: [{ id: 1, score: 5, mood: "ok" }] });
  await writeData(dir, "newer.json", { kept: true });

  const servers = [];
  t.after(() => Promise.all(servers.map((app) => app.close().catch(() => {}))));
  const start = async () => {
    const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true });
    servers.push(app);
    await app.appsRestarted;
    const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
    return { app, api: (p, init) => fetch(`http://127.0.0.1:${port}/api${p}`, init) };
  };
  let { app, api } = await start();
  const post = (id) => api(`/jobs/${id}/rollback`, { method: "POST" });

  const { job: shown } = await (await api(`/jobs/${second.id}`)).json();
  assert.equal(shown.rollbackTo.jobId, first.id, "the newest shipped update offers the previous release");
  assert.equal((await post(first.id)).status, 409, "a first release or an older run has nothing to roll back to");

  const response = await post(second.id);
  assert.equal(response.status, 200, await response.clone().text());
  const { job: rolled, previous } = await response.json();
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.rollback.restore, true, "the data changed shape, so the owner is told to restore the backup");
  assert.match(rolled.rollback.message, /restore the copy of data\/ you backed up/);
  assert.equal(await store.git("rev-parse", "HEAD^{tree}"), await store.git("rev-parse", `${second.baseCommit}^{tree}`), "the tree is the previous release's");
  assert.match(await store.git("tag", "--list", `solofactory/rolled-back/${second.id}`), /rolled-back/, "the rolled-back code is tagged");
  assert.equal(previous.deployment.status, "live");
  assert.equal((await fetch(`${previous.deployment.url}/health`)).ok, true);
  assert.ok(existsSync(path.join(dir, "data", "newer.json")), "data/ is never touched");
  assert.ok((await types(store, second.id)).includes("job.rolled_back"));
  assert.equal((await post(second.id)).status, 409, "a rolled-back run cannot be rolled back again");
  assert.equal((await post(first.id)).status, 409, "the first release has no earlier release");

  // The next follow-on builds on the previous release: the rolled-back run neither blocks nor counts as the fallback.
  const list = await store.list();
  assert.equal(previousRelease({ id: "next", state: "failed", followOn: true, baseCommit: "c".repeat(40) }, [{ id: "next", state: "failed" }, ...list]).jobId, first.id);

  await app.close();
  assert.equal((await store.read(first.id)).deployment.stoppedBy, "server");
  ({ app, api } = await start());
  assert.equal((await store.read(first.id)).deployment.status, "live", "a server restart brings back the previous release");
  assert.notEqual((await store.read(second.id)).deployment?.status, "live", "never the rolled-back one");
});

test("rollback is refused while a run in the project is running or queued", async (t) => {
  const { root, store, factories, release } = await shippedProject(t);
  const { result: second } = await release();
  assert.equal(second.state, "completed", second.error?.message);
  await Promise.all(factories.map((factory) => factory.shutdown()));
  await store.create({ brief, transcript, provider: "fixture" }); // queued: startup enqueues and starts it
  const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true });
  t.after(() => app.close().catch(() => {}));
  const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${second.id}/rollback`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /running or queued run/);
  assert.equal((await store.read(second.id)).rolledBack, undefined, "nothing was rolled back");
  assert.equal(await store.git("tag", "--list", `solofactory/rolled-back/${second.id}`), "");
});

test("rollback of a same-shape update says the older version can read the data", async (t) => {
  const { root, dir, factories, release } = await shippedProject(t);
  await writeData(dir, "entries.json", { items: [{ id: 1, score: 5 }] });
  const { result: second } = await release();
  await Promise.all(factories.map((factory) => factory.shutdown()));
  await writeData(dir, "entries.json", { items: [{ id: 2, score: 9 }, { id: 3, score: 1 }] });
  const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true });
  t.after(() => app.close().catch(() => {}));
  await app.appsRestarted;
  const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
  const { job } = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${second.id}/rollback`, { method: "POST" })).json();
  assert.equal(job.rollback.restore, false);
  assert.deepEqual(job.rollback.changes, []);
  assert.match(job.rollback.message, /kept the same shape/);
});
