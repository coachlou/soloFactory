import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSoloFactoryServer, builtinProfiles, validateProfiles } from "../src/server.mjs";
import { checkModels, stageTier } from "../src/providers.mjs";

const codexModels = { guide: { model: "gpt-6.1-sol", effort: "medium" }, plan: { model: "gpt-6.1-sol", effort: "low" }, code: { model: "gpt-6.1-terra", effort: "low" } };

test("stages map to the Guide, planning and review, or coding tier", () => {
  assert.equal(stageTier("interview"), "guide");
  for (const stage of ["specification", "feature-plan", "plan-review", "plan-correction-2", "recovery-plan-1", "feature-3-review", "review"]) assert.equal(stageTier(stage), "plan", stage);
  for (const stage of ["feature-3-build", "repair-1", "release-qa", ""]) assert.equal(stageTier(stage), "code", stage);
});

test("checkModels keeps a well-formed profile and refuses bad ids and efforts", () => {
  assert.equal(checkModels(null), null);
  assert.deepEqual(checkModels({ ...codexModels, advisor: 0 }), { ...codexModels, advisor: false });
  assert.throws(() => checkModels({ ...codexModels, code: { model: "x; rm -rf", effort: "low" } }), /code model/);
  assert.throws(() => checkModels({ ...codexModels, plan: { model: "opus", effort: "huge" } }), /plan effort/);
});

test("built-in Claude sends no models; built-in Codex matches the effort chart", () => {
  const [claude, codex] = builtinProfiles({});
  assert.equal(claude.models, null, "Claude runs exactly as before profiles");
  assert.deepEqual(claude.shown.code, { model: "sonnet", effort: "medium" });
  assert.deepEqual(codex.models, codexModels);
  assert.equal(builtinProfiles({ SOLOFACTORY_CODEX_MODEL: "gpt-x" })[1].models.code.model, "gpt-x", "the env override still wins");
});

test("validateProfiles refuses built-in names, duplicates and missing models", () => {
  const ok = { name: "Fast Codex", provider: "codex", models: codexModels };
  assert.deepEqual(validateProfiles([ok]), [ok]);
  for (const bad of [[{ ...ok, name: "claude" }], [{ ...ok, name: "Codex" }], [ok, { ...ok, name: "fast codex" }], [{ ...ok, models: null }], [{ ...ok, provider: "grok" }], [{ ...ok, name: " " }]])
    assert.throws(() => validateProfiles(bad), (error) => error.status === 400);
});

test("custom profiles save to the factory home, and a new run keeps its profile's models", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-profiles-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };

  const config = (await call("GET", "/api/config")).body;
  assert.deepEqual(config.profiles.builtins.map((p) => p.name), ["Claude", "Codex"]);
  assert.deepEqual(config.profiles.custom, []);

  assert.equal((await call("PUT", "/api/profiles", { custom: [{ name: "Claude", provider: "claude", models: codexModels }] })).status, 400);
  const saved = await call("PUT", "/api/profiles", { custom: [{ name: "Mine", provider: "codex", models: codexModels }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, "profiles.json"), "utf8")).custom, saved.body.custom);
  assert.deepEqual((await call("GET", "/api/config")).body.profiles.custom, saved.body.custom);

  const transcript = [{ role: "assistant", content: config.opening.message }, { role: "user", content: "A daily tracker." }];
  const guide = (await call("POST", "/api/interview/turn", { provider: "fixture", messages: transcript })).body;
  const run = { provider: "fixture", transcript, coverage: guide.coverage, brief: guide.brief };
  assert.equal((await call("POST", "/api/jobs", { ...run, models: { guide: { model: "opus", effort: "max" } } })).status, 400, "a half profile is refused");
  const job = await call("POST", "/api/jobs", { ...run, models: codexModels });
  assert.equal(job.status, 202);
  assert.deepEqual(job.body.job.models, codexModels);
});

// The hub's profile helpers, run from the page source like the other hub tests.
test("hub profile helpers name-check and save into the custom list", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const PROFILE_TIERS"), end = source.indexOf("function pickFiles(");
  assert.ok(start > 0 && end > start);
  const { profileRows, profileNameError, profileSaveList } = new Function(`${source.slice(start, end)}; return { profileRows, profileNameError, profileSaveList };`)();
  const [claude, codex] = builtinProfiles({});
  assert.deepEqual(profileRows(claude), claude.shown);
  const rows = profileRows(codex); rows.code.effort = "max";
  assert.equal(codex.models.code.effort, "low", "editing rows never changes the built-in");
  const all = [claude, codex, { name: "Mine", provider: "codex", models: codexModels }];
  assert.match(profileNameError("", all), /Name/);
  assert.match(profileNameError("codex", all), /already exists/);
  assert.match(profileNameError("x".repeat(41), all), /40/);
  assert.equal(profileNameError("Night", all), "");
  const edit = { provider: "codex", models: rows };
  assert.deepEqual(profileSaveList([all[2]], edit, "Mine"), [{ name: "Mine", provider: "codex", models: rows }]);
  assert.equal(profileSaveList([all[2]], edit, "Night").length, 2);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const hook of ["sec.hasBar", "sec.prompt.acts", "sec.prompt.onName", "Profile: {{provider}}"]) assert.ok(html.includes(hook), hook);
});
