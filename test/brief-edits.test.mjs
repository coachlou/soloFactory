import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSoloFactoryServer } from "../src/server.mjs";

// The fixture Guide always answers with the same sample brief, like a Guide that ignores an edit.
test("a direct edit on the brief page is saved at once and survives later Guide turns", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-edits-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };

  // Before any answer: the edit starts the draft.
  const first = await call("PATCH", "/api/interview/draft", { provider: "fixture", edits: { promise: "Track my mood daily." } });
  assert.equal(first.status, 200);
  assert.equal(first.body.draft.guide.brief.promise, "Track my mood daily.");

  const messages = [...first.body.draft.messages, { role: "user", content: "I edited the promise." }];
  const turn = await call("POST", "/api/interview/turn", { provider: "fixture", messages });
  assert.equal(turn.body.brief.promise, "Track my mood daily.", "the turn that checks the edit keeps it");

  const again = await call("POST", "/api/interview/turn", { provider: "fixture", messages: [...messages, { role: "assistant", content: turn.body.message }, { role: "user", content: "Anything else?" }] });
  assert.equal(again.body.brief.promise, "Track my mood daily.", "a later turn carrying the stale text keeps the edit");

  const list = await call("PATCH", "/api/interview/draft", { edits: { nonGoals: ["No dark mode"] } });
  assert.deepEqual(list.body.draft.guide.brief.nonGoals, ["No dark mode"]);
  assert.equal(list.body.draft.guide.brief.promise, "Track my mood daily.");

  assert.equal((await call("PATCH", "/api/interview/draft", { edits: { nonGoals: "not a list" } })).body.code, "draft_edits_invalid");
  assert.equal((await call("PATCH", "/api/interview/draft", { edits: { madeUp: "x" } })).body.code, "draft_edits_invalid");
  assert.equal((await call("PATCH", "/api/interview/draft", {})).body.code, "draft_patch_empty");
});

test("Queue's final review marks a ready brief reviewed only when it covers the brief as it stands", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-review-"));
  const app = await createSoloFactoryServer({ home, fixtureMode: true });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };

  assert.equal((await call("POST", "/api/interview/turn", { provider: "fixture", review: true, messages: [{ role: "assistant", content: "Hi" }] })).body.code, "draft_missing");

  const messages = [{ role: "assistant", content: "What do you want to build?" }, { role: "user", content: "A tiny daily tracker." }];
  const turn = await call("POST", "/api/interview/turn", { provider: "fixture", messages });
  assert.equal(turn.body.status, "ready");
  assert.equal(turn.body.reviewed, undefined, "an ordinary ready turn is not the final review");
  messages.push({ role: "assistant", content: turn.body.message });

  const review = await call("POST", "/api/interview/turn", { provider: "fixture", review: true, messages });
  assert.equal(review.body.reviewed, true);
  assert.equal((await call("GET", "/api/interview/draft")).body.draft.guide.reviewed, true);
  messages.push({ role: "assistant", content: review.body.message });

  // An edit clears the review; the fixture Guide then keeps writing the old text, so the edit is put back and
  // the review cannot vouch for the brief.
  const edited = await call("PATCH", "/api/interview/draft", { edits: { promise: "Track my mood daily." } });
  assert.equal(edited.body.draft.guide.reviewed, false);
  await call("POST", "/api/interview/turn", { provider: "fixture", messages: [...messages, { role: "user", content: "I edited the promise." }] });
  const again = await call("POST", "/api/interview/turn", { provider: "fixture", review: true, messages: [...messages, { role: "user", content: "I edited the promise." }, { role: "assistant", content: "Ok." }] });
  assert.equal(again.body.brief.promise, "Track my mood daily.");
  assert.equal(again.body.reviewed, undefined);
});
