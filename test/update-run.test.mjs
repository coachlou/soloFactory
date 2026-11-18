import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUpdateRunner, headlessUpdatePrompt } from "../src/update-run.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";

const reply = (version) => async () => ({ ok: true, json: async () => ({ version }) });
async function installed() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-updrun-"));
  await mkdir(path.join(root, ".ailib"), { recursive: true });
  await writeFile(path.join(root, ".ailib", "manifest.yaml"), "app: 0.11.0\n");
  await mkdir(path.join(root, "app"), { recursive: true });
  await writeFile(path.join(root, "app", "package.json"), JSON.stringify({ version: "0.11.0" }));
  return root;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the update prompt runs only U2 on this folder and never restarts SoloFactory itself", () => {
  const prompt = headlessUpdatePrompt("/x/sf");
  assert.match(prompt, /Run only its U2 command, with "\/x\/sf"/);
  assert.match(prompt, /never stop, start or restart SoloFactory/);
  assert.match(prompt, /never touch the projects\/ folder/);
  assert.match(prompt, /Never install, upgrade or switch Node yourself/);
});

test("Update now refuses outside an install, while busy, with an unknown provider or nothing newer", async () => {
  const root = await installed();
  try {
    const base = { root, home: path.join(root, "home"), appRoot: path.join(root, "app"), current: "0.11.0", busy: () => null, newer: async () => "0.11.1", agent: async () => assert.fail("agent ran") };
    const dev = await mkdtemp(path.join(os.tmpdir(), "sf-dev-"));
    assert.equal((await createUpdateRunner({ ...base, root: dev }).start("claude")).status, 409);
    assert.equal((await createUpdateRunner(base).start("bash")).status, 400);
    const busy = await createUpdateRunner({ ...base, busy: () => "Something is building." }).start("claude");
    assert.deepEqual([busy.status, busy.error], [409, "Something is building."]);
    const none = createUpdateRunner({ ...base, newer: async () => null });
    assert.equal((await none.start("codex")).status, 409);
    assert.equal(none.running, false);
    // Two clicks at once: the second is refused while the first is still checking for a newer version.
    const slow = createUpdateRunner({ ...base, newer: () => new Promise((r) => setTimeout(() => r(null), 20)) });
    const [a, b] = await Promise.all([slow.start("claude"), slow.start("claude")]);
    assert.deepEqual([a.status, b.status, b.error], [409, 409, "An update is already running."]);
    await rm(dev, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a changed app version restarts; an unchanged one records a failure and does not", async () => {
  const root = await installed();
  try {
    let restarts = 0;
    const base = { root, home: path.join(root, "home"), appRoot: path.join(root, "app"), current: "0.11.0", busy: () => null, newer: async () => "0.11.1", onUpdated: () => { restarts += 1; } };
    const thrown = createUpdateRunner({ ...base, agent: async () => { await writeFile(path.join(root, "app", "package.json"), JSON.stringify({ version: "0.11.1" })); throw new Error("timed out"); } });
    await thrown.start("claude");
    await settle();
    assert.equal((await thrown.status()).last.state, "restarting"); // the swap happened, so restart onto it
    assert.equal(restarts, 1);
    restarts = 0;
    await writeFile(path.join(root, "app", "package.json"), JSON.stringify({ version: "0.11.0" }));
    const same = createUpdateRunner({ ...base, agent: async () => ({ code: 1, message: "" }) });
    assert.equal((await same.start("claude")).status, 202);
    await settle();
    const failed = (await same.status()).last;
    assert.equal(failed.state, "failed");
    assert.match(failed.message, /exit 1/);
    assert.equal(restarts, 0);

    let release;
    const agent = async ({ provider, cwd }) => {
      assert.deepEqual([provider, cwd], ["codex", root]);
      await new Promise((resolve) => { release = resolve; });
      await writeFile(path.join(root, "app", "package.json"), JSON.stringify({ version: "0.11.1" }));
      return { code: 0, message: "Updated to 0.11.1." };
    };
    const runner = createUpdateRunner({ ...base, agent });
    await runner.start("codex");
    assert.equal(runner.running, true);
    assert.equal((await runner.start("codex")).status, 409); // one at a time
    assert.equal((await runner.status()).last.state, "running");
    release();
    await settle();
    const done = JSON.parse(await readFile(path.join(root, "home", "update.json"), "utf8"));
    assert.deepEqual([done.state, done.from, done.to, done.message], ["restarting", "0.11.0", "0.11.1", "Updated to 0.11.1."]);
    assert.equal(restarts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the route needs a JSON POST from this machine and blocks new runs while updating", async () => {
  const root = await installed();
  let release;
  const app = await createSoloFactoryServer({ root, home: path.join(root, "home"), updateCheck: true, fetch: reply("99.0.0"), updateAgent: () => new Promise((resolve) => { release = () => resolve({ code: 1, message: "stopped" }); }), onUpdated: () => assert.fail("restarted") });
  try {
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const post = (pathName, body, headers = { "content-type": "application/json" }) => fetch(url + pathName, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await fetch(url + "/api/update/run").then((r) => r.json())).available, true);
    assert.equal((await post("/api/update/run", { provider: "claude" }, { "content-type": "text/plain" })).status, 403);
    assert.equal((await post("/api/update/run", { provider: "claude" }, { "content-type": "application/json", origin: "https://evil.example" })).status, 403);
    const started = await post("/api/update/run", { provider: "claude" });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).update.to, "99.0.0");
    const job = await post("/api/jobs", { brief: "x" });
    assert.equal(job.status, 409);
    assert.match((await job.json()).error, /updating/);
    release();
    await settle();
    assert.equal((await fetch(url + "/api/update/run").then((r) => r.json())).last.state, "failed");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
