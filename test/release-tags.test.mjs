// Each good release of a generated app is tagged solofactory/release/<n> in the app's own repo (SPEC §4).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, RELEASE_TAG_PREFIX } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const types = async (store, id) => (await store.events(id, Infinity)).map((event) => event.type);
const tags = async (store) => (await store.git("tag", "--list", `${RELEASE_TAG_PREFIX}*`)).split("\n").filter(Boolean).sort();

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-release-tags-"));
  const dir = path.join(root, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const store = new JobStore(dir);
  await store.init();
  const factories = [];
  t.after(() => Promise.all(factories.map((factory) => factory.shutdown())));
  const release = async (options = {}) => {
    const job = await store.create({ brief, transcript, provider: "fixture" });
    const factory = new SoloFactory({ store: options.store ?? store, provider: createFixtureProvider(), ...options.factory });
    factories.push(factory);
    const result = await factory.start(job.id);
    assert.equal(result.state, "completed", result.error?.message);
    return result;
  };
  return { root, dir, store, factories, release };
}

test("each release that passes its deploy checks is tagged in order at the commit that shipped", async (t) => {
  const { store, release } = await project(t);
  const first = await release();
  assert.deepEqual({ number: first.release.number, tag: first.release.tag }, { number: 1, tag: "solofactory/release/1" });
  assert.equal(first.release.commit, await store.git("rev-list", "-n", "1", first.release.tag), "the tag points at the shipped commit");
  assert.ok((await types(store, first.id)).includes("release.tagged"));
  assert.equal((await store.read(first.id)).release.tag, first.release.tag, "the run record keeps the release");

  const second = await release();
  assert.equal(second.followOn, true);
  assert.equal(second.release.number, 2);
  assert.deepEqual(await tags(store), ["solofactory/release/1", "solofactory/release/2"]);
  assert.equal(await store.git("cat-file", "-t", second.release.tag), "tag", "an annotated tag");
  assert.match(await store.git("tag", "-l", "--format=%(contents)", second.release.tag), /Release 2: Pocket Pulse \(run /);
  assert.equal(await store.git("rev-parse", "HEAD"), second.release.commit);
  assert.equal(await store.git("status", "--porcelain"), "", "nothing left uncommitted");
});

test("a project shipped before release tags carries on its count", async (t) => {
  const { store, release } = await project(t);
  const first = await release();
  // What an older SoloFactory left behind: a shipped run with no release record and no tag.
  await store.git("tag", "-d", first.release.tag);
  const legacy = await store.read(first.id);
  delete legacy.release;
  await store.writeState(legacy);
  const second = await release();
  assert.equal(second.release.number, 2, "the earlier shipped run counts");
  assert.deepEqual(await tags(store), ["solofactory/release/2"]);
});

test("a failed tag never fails the deploy", async (t) => {
  const { store, release } = await project(t);
  const broken = Object.create(store);
  broken.git = async (...args) => {
    if (args[0] === "tag" && args.includes("-a")) throw new Error("tag refused");
    return store.git(...args);
  };
  const result = await release({ store: broken });
  assert.equal(result.deployment.status, "live");
  assert.equal(result.release, undefined);
  assert.ok((await types(store, result.id)).includes("release.tag_failed"));
  assert.deepEqual(await tags(store), []);
});

test("rollback keeps the rolled-back release's tag, names the release it went back to, and never reuses a number", async (t) => {
  const { root, store, factories, release } = await project(t);
  const first = await release();
  const second = await release();
  await Promise.all(factories.map((factory) => factory.shutdown()));

  const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true });
  t.after(() => app.close().catch(() => {}));
  await app.appsRestarted;
  const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
  const { job: shown } = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${second.id}`)).json();
  assert.equal(shown.rollbackTo.release, 1, "the offer names the release it goes back to");
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${second.id}/rollback`, { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const { job: rolled } = await response.json();
  assert.match(rolled.rollback.message, /Rolled back to Pocket Pulse \(release 1\)/);
  assert.deepEqual({ release: rolled.rollback.release, previousRelease: rolled.rollback.previousRelease }, { release: 2, previousRelease: 1 });
  assert.equal(await store.git("rev-list", "-n", "1", second.release.tag), second.release.commit, "the rolled-back release keeps its tag");
  await app.close();

  const third = await release();
  assert.equal(third.release.number, 3, "a rolled-back release's number is not reused");
  assert.deepEqual(await tags(store), ["solofactory/release/1", "solofactory/release/2", "solofactory/release/3"]);
  assert.equal(first.release.number, 1);
});
