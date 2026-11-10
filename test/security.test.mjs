import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
// Built at runtime: a literal key-shaped string must never be committed to this repo.
const key = ["sk", "abcdefghijklmnop"].join("-");

test("a credential in a changed file fails the secrets gate without echoing it, and a repair that removes it completes", async (t) => {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-secrets-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const fixture = createFixtureProvider();
  let planted = false;
  const provider = { id: "fixture", async run(options) {
    const result = await fixture.run(options);
    const file = path.join(options.cwd, "config.mjs");
    if (!planted && /^build-slice-/.test(options.context.stage)) {
      planted = true;
      await writeFile(file, `export const key = "${key}";\n`);
    } else if (/^repair-/.test(options.context.stage)) {
      await writeFile(file, "export const key = process.env.API_KEY;\n");
    }
    return result;
  } };
  const factory = new SoloFactory({ store, provider, commandRunner: async () => ({ code: 0, output: "passed" }), deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9979" }) });
  t.after(() => factory.shutdown());
  const result = await factory.start(job.id);
  assert.equal(result.state, "completed", result.error?.message);
  const events = await store.events(job.id, 1000);
  const failed = events.find((event) => event.type === "gate.failed" && event.gate === "secrets");
  assert.ok(failed, "the secrets gate fired");
  assert.match(failed.message, /config\.mjs:1/);
  assert.ok(!JSON.stringify(events).includes(key), "the value never reaches an event");
  assert.ok(!(await readFile(path.join(store.appDir(job.id), ".factory", "last-failure-1.txt"), "utf8")).includes(key), "nor the repair's failure file");
});

test("the secrets gate skips factory inputs, owner text and a follow-on's shipped tree", async (t) => {
  const store = new JobStore(await mkdtemp(path.join(os.tmpdir(), "sf-secrets-scope-")));
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture" });
  const factory = new SoloFactory({ store, provider: createFixtureProvider() });
  t.after(() => factory.shutdown());
  const appDir = store.appDir(job.id);
  await mkdir(path.join(appDir, ".factory", "uploads"), { recursive: true });
  await writeFile(path.join(appDir, ".factory", "uploads", "spec.md"), `Use ${key} in staging.\n`);
  await writeFile(path.join(appDir, ".aai", "context.md"), `Owner note: ${key}\n`);
  assert.equal(await factory.secretsFailure(job), null, ".factory/ and .aai/ are skipped");

  await writeFile(path.join(appDir, "old.mjs"), `export const legacy = "${key}";\n`);
  await store.commit("test: shipped release");
  job.baseCommit = await store.git("rev-parse", "HEAD");
  assert.equal(await factory.secretsFailure(job), null, "a follow-on does not rescan the shipped tree");

  await writeFile(path.join(appDir, "new.mjs"), `const auth = "Bearer ${"t".repeat(20)}";\n`);
  const failure = await factory.secretsFailure(job);
  assert.equal(failure.details.gate, "secrets");
  assert.match(failure.message, /new\.mjs:1/);
  assert.doesNotMatch(failure.message, /old\.mjs/);
});
