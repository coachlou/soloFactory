import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The hub's attachment helpers, run from the page source like the other hub tests.
const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("const ATTACH_ACCEPT"), end = source.indexOf("class Live extends Component");
const { attachLabel, composeMessage, shownUserText } = new Function(`${source.slice(start, end)}; return { attachLabel, composeMessage, shownUserText };`)();

test("attachments label as chips and ride inside the turn", () => {
  const doc = { name: "spec.md", text: "x".repeat(2400) };
  const img = { name: "mock.png", path: ".factory/uploads/m1abc-mock.png", url: "blob:1" };
  assert.equal(attachLabel(doc), "spec.md · 3k chars");
  assert.equal(attachLabel(img), "mock.png · image");
  const sent = composeMessage("Build this", [{ name: "spec.md", text: "# Spec\nTimer\n" }, img]);
  assert.match(sent, /^Build this\n\n--- Attached document: spec.md ---\n# Spec\nTimer\n--- End of spec.md ---/);
  assert.match(sent, /Attached image: \.factory\/uploads\/m1abc-mock\.png \(open this file/);
  assert.equal(composeMessage("", [{ name: "a.txt", text: "hi" }]), "--- Attached document: a.txt ---\nhi\n--- End of a.txt ---");
  // The thread names the files; the Guide still gets the whole text.
  assert.equal(shownUserText(sent), "Build this\n\nAttached: spec.md\n\nAttached image: mock.png");
});

test("the composer shows removable chips and the thread shows images", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<sc-for list="\{\{attachments\}\}" as="f">/);
  assert.match(html, /<button onClick="\{\{f\.remove\}\}" aria-label="\{\{f\.aria\}\}"/);
  assert.match(html, /<sc-for list="\{\{m\.images\}\}" as="src">/);
  assert.match(source, /v\.onAttach = \(\) => this\.attach\(\);/);
  assert.match(source, /\/api\/interview\/upload\?name=/);
});
