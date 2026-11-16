import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Settings page source checks, run from the page source like the other hub tests.
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function readOnlyField"), end = source.indexOf("function backgroundText");
const readOnlyField = new Function(`${source.slice(start, end)}; return readOnlyField;`)();

test("settings that cannot be edited render as text, not controls", () => {
  const sel = readOnlyField({ isSelect: true, options: [{ v: "all", label: "Every feature" }], value: "all", envLine: "SOLOFACTORY_FEATURE_REVIEW" });
  assert.equal(sel.text, "Every feature");
  assert.deepEqual([sel.isText, sel.isSelect, sel.isInput, sel.isToggle], [true, false, false, false]);
  assert.match(sel.envLine, /set SOLOFACTORY_FEATURE_REVIEW before starting/);
  assert.equal(readOnlyField({ isInput: true, value: 2, hasUnit: true, unit: "min", envLine: "" }).text, "2 min");
  assert.equal(readOnlyField({ isToggle: true, toggleText: "On" }).text, "On");
  // Every non-profile field goes through it; the profile section is rebuilt editable after.
  assert.match(source, /for \(const f of sec\.fields\) Object\.assign\(f, readOnlyField\(f\)\);\s*v\.cfg\.sections\[0\] = this\.profileSection\(\);/);
});

test("Settings and the Guide Profile button show and set the same profile", () => {
  assert.match(source, /shown = this\.profile\(\);/);
  assert.match(source, /localStorage\.setItem\("solofactory\.profile\." \+ pid, name\); localStorage\.setItem\("solofactory\.profile", name\)/);
  assert.match(source, /this\.useProfile\(name, \{ profEdit: null \}\)/);
  assert.match(source, /this\.useProfile\(pick, \{ profEdit: null \}\)/);
});

test("form controls share the page font", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /input,\s*select,\s*textarea\s*\{\s*font:\s*inherit/);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<sc-if value="\{\{fd\.isText\}\}"/);
});
