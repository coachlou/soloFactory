import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AREAS as SERVER_AREAS, REPORTABLE_STATES } from "../src/feedback.mjs";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("const FEEDBACK_AREAS"), end = source.indexOf("const PROFILE_TIERS");
const h = new Function(`${source.slice(start, end)}; return { FEEDBACK_AREAS, REPORTABLE, FEEDBACK_MAILTO, feedbackFields, feedbackMissing, feedbackLinks, backgroundText, updateLabel };`)();

test("the form's areas and reportable states match the server's", () => {
  assert.deepEqual(h.FEEDBACK_AREAS, SERVER_AREAS);
  assert.deepEqual(h.REPORTABLE, REPORTABLE_STATES);
});

test("required fields are named; only the mode's own fields are sent, trimmed", () => {
  assert.deepEqual(h.feedbackMissing("problem", { title: " x ", happened: "" }), ["What happened", "Expected result"]);
  assert.deepEqual(h.feedbackMissing("improvement", { title: "t", friction: "f", outcome: "o" }), []);
  assert.deepEqual(h.feedbackFields("problem", { title: " t ", happened: "h", expected: "e", friction: "leak" }), { title: "t", happened: "h", expected: "e", context: "" });
});

test("links carry only the title or fingerprint, never the report body", () => {
  assert.equal(h.feedbackLinks(null, "problem", "t", null), null);
  const l = h.feedbackLinks({ base: "https://github.com/o/r/issues" }, "problem", "Crash on save", "fp-123");
  assert.equal(l.search, "https://github.com/o/r/issues?q=" + encodeURIComponent("is:issue fp-123"));
  assert.equal(l.github, "https://github.com/o/r/issues/new?template=problem.yml&title=" + encodeURIComponent("[Problem] Crash on save"));
  assert.match(h.feedbackLinks({ base: "b" }, "improvement", "x".repeat(150), null).search, new RegExp(`${"x".repeat(100)}$`));
  assert.ok(!h.FEEDBACK_MAILTO.includes("body="));
});

test("banner and update texts", () => {
  assert.equal(h.backgroundText("Notes", "building", 2), "“Notes” is building in the background · 2 queued.");
  assert.equal(h.backgroundText("Notes", "verifying", 0), "“Notes” is verifying in the background.");
  assert.equal(h.updateLabel({ current: "0.11.0" }), "Up to date (0.11.0)");
  assert.equal(h.updateLabel({ disabled: true }), "Update checks off");
  assert.equal(h.updateLabel({ error: true }), "Couldn't check");
});
