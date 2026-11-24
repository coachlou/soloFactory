import test from "node:test";
import assert from "node:assert/strict";
import { releaseRisks, riskLine } from "../src/risk.mjs";

const pkg = (extra) => JSON.stringify({ name: "app", version: "1.0.0", scripts: { start: "node server.js" }, ...extra });

test("deletions are flagged; renames, tests and .factory files are not", () => {
  const nameStatus = [
    "D\tsrc/billing.js",
    "R100\tsrc/old.js\tsrc/new.js",
    "D\ttest/billing.test.js",
    "D\tsrc/cart.spec.ts",
    "D\t.factory/logs/build.log",
    "M\tsrc/app.js",
    "A\tsrc/added.js",
    "",
  ].join("\n");
  assert.deepEqual(releaseRisks(nameStatus), [{ kind: "deletion", file: "src/billing.js", why: "Deleted src/billing.js" }]);
});

test("dependency adds, removals and version changes are flagged; scripts and version are not", () => {
  const before = pkg({ dependencies: { express: "^4.0.0", lodash: "^4.17.0" }, devDependencies: { vitest: "^1.0.0" } });
  const after = pkg({
    version: "1.1.0",
    scripts: { start: "node server.js", test: "vitest" },
    dependencies: { express: "^5.0.0", zod: "^3.0.0" },
    devDependencies: { vitest: "^1.0.0", eslint: "^9.0.0" },
  });
  assert.deepEqual(releaseRisks("", { before, after }).map((risk) => risk.why), [
    "Changed express from ^4.0.0 to ^5.0.0",
    "Removed lodash",
    "Added zod ^3.0.0",
    "Added eslint ^9.0.0 (dev)",
  ]);
});

test("a package.json that appears or cannot be parsed never throws", () => {
  assert.deepEqual(releaseRisks("", { before: null, after: pkg({ dependencies: { a: "1" } }) }).map((r) => r.why), ["Added a 1"]);
  assert.deepEqual(releaseRisks("", { before: "{oops", after: pkg({ dependencies: { a: "1" } }) }), []);
  assert.deepEqual(releaseRisks(undefined), []);
});

test("riskLine says what was found, nothing, or that the run predates the scan", () => {
  assert.equal(riskLine(undefined), null);
  assert.equal(riskLine([]), "No package changes or deleted files.");
  const risks = releaseRisks("D\tsrc/a.js", {
    before: pkg({ dependencies: { x: "1" } }),
    after: pkg({ dependencies: { x: "2", y: "1", z: "1" } }),
  });
  assert.equal(riskLine(risks), "Added 2 packages, changed 1 package version, deleted 1 file.");
});
