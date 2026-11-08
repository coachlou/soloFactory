import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateChecker, isNewer } from "../src/update-check.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const reply = (version) => async () => ({ ok: true, json: async () => ({ version }) });

test("version comparison is numeric and ignores prereleases or junk", () => {
  assert.equal(isNewer("0.10.13", "0.10.9"), true);
  assert.equal(isNewer("0.10.9", "0.10.13"), false);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.10.13", "0.10.13"), false);
  assert.equal(isNewer("v0.11.0", "0.10.13"), true);
  assert.equal(isNewer("0.11.0-rc1", "0.10.13"), false);
  assert.equal(isNewer(undefined, "0.10.13"), false);
});

test("a newer release yields a notice with the runbook prompt; the same version does not", async () => {
  const newer = await createUpdateChecker({ current: "0.10.9", fetch: reply("0.10.13") })();
  assert.equal(newer.newer, true);
  assert.equal(newer.latest, "0.10.13");
  assert.match(newer.prompt, /version 0\.10\.13/);
  assert.match(newer.prompt, /repos\/coachlou\/aimm\/contents\/aai-release\/solofactory\/INSTALL\.md/);
  const same = await createUpdateChecker({ current: "0.10.13", fetch: reply("0.10.13") })();
  assert.equal(same.newer, false);
  assert.equal(same.prompt, null);
});

test("offline, HTTP errors and bad bodies answer { error: true } and are retried, successes are cached", async () => {
  for (const fetch of [
    async () => { throw new TypeError("fetch failed"); },
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
    reply("not-a-version"),
  ]) {
    const result = await createUpdateChecker({ current: "0.10.13", fetch })();
    assert.equal(result.error, true);
    assert.equal(result.newer, undefined);
  }
  let calls = 0;
  let online = false;
  const check = createUpdateChecker({ current: "0.10.13", fetch: async () => { calls += 1; if (!online) throw new Error("offline"); return reply("0.10.14")(); } });
  assert.equal((await check()).error, true);
  online = true;
  assert.equal((await check()).newer, true); // the error was not cached
  await check();
  assert.equal(calls, 2); // within the window a reload reuses the answer
  await check({ force: true });
  assert.equal(calls, 3); // the button always asks again
});

test("the server never checks under node --test unless told to, and serves the stubbed answer when it is", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "sf-update-"));
  const off = await createSoloFactoryServer({ home, fetch: async () => assert.fail("network reached") });
  const on = await createSoloFactoryServer({ home, updateCheck: true, fetch: reply("99.0.0") });
  try {
    for (const app of [off, on]) await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const get = (app) => fetch(`http://127.0.0.1:${app.server.address().port}/api/update?force=1`).then((r) => r.json());
    assert.equal((await get(off)).disabled, true);
    const answer = await get(on);
    assert.equal(answer.newer, true);
    assert.equal(answer.latest, "99.0.0");
  } finally {
    await off.close();
    await on.close();
    await rm(home, { recursive: true, force: true });
  }
});
