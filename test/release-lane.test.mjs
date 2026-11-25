import test from "node:test";
import assert from "node:assert/strict";
import { isPatchBump, laneGateProblem, patchLaneProblems } from "../scripts/release-lane.mjs";

const pkg = (version, extra = {}) => JSON.stringify({ name: "solo-factory", version, scripts: { test: "node --test" }, ...extra }, null, 2);
const base = {
  version: "0.13.1",
  latestTag: "v0.13.0",
  newestTag: "v0.13.0",
  changes: [{ status: "M", file: "public/styles.css" }, { status: "M", file: "PROGRESS.md" }, { status: "M", file: "package.json" }],
  pkgBefore: pkg("0.13.0"),
  pkgAfter: pkg("0.13.1"),
};

test("a patch is same major.minor, higher patch, no prerelease", () => {
  assert.equal(isPatchBump("0.13.1", "v0.13.0"), true);
  assert.equal(isPatchBump("0.13.4", "v0.13.1"), true);
  assert.equal(isPatchBump("0.14.0", "v0.13.0"), false);
  assert.equal(isPatchBump("1.0.0", "v0.13.0"), false);
  assert.equal(isPatchBump("0.13.0", "v0.13.0"), false);
  assert.equal(isPatchBump("0.13.1-rc1", "v0.13.0"), false);
  assert.equal(isPatchBump("0.13.1", "v0.13.0-rc1"), false);
});

test("hub page, docs, tests and a version-only package.json change are patch-safe", () => {
  assert.deepEqual(patchLaneProblems({
    ...base,
    changes: [...base.changes, { status: "A", file: "public/icon.svg" }, { status: "M", file: "docs/manual/index.html" },
      { status: "A", file: "test/chat-box.test.mjs" }, { status: "M", file: "README.md" }, { status: "M", file: "smoke/results.jsonl" }],
  }), []);
  assert.equal(laneGateProblem(base), null);
});

test("anything the engine, Guide, installer or update path reads sends the release to the full lane", () => {
  for (const file of ["src/factory.mjs", "src/server.mjs", "skills/factory-guide.md", "distro/run.sh", "docs/INSTALL.md",
    "templates/aai/instructions.md", "scripts/hooks/pre-push", ".github/workflows/test.yml", "smoke/briefs/x.json", "distro/INSTALL.md"]) {
    const problem = laneGateProblem({ ...base, changes: [...base.changes, { status: "M", file }] });
    assert.match(problem, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), file);
    assert.match(problem, /Bump the minor version/);
  }
});

test("a deletion or rename, even of a patch-safe file, is not patch-safe", () => {
  assert.match(patchLaneProblems({ ...base, changes: [{ status: "D", file: "public/old.css" }] })[0], /deleted/);
  assert.match(patchLaneProblems({ ...base, changes: [{ status: "R", file: "public/new.css" }] })[0], /changed \(R\)/);
});

test("package.json may change only its version", () => {
  const deps = laneGateProblem({ ...base, pkgAfter: pkg("0.13.1", { dependencies: { yaml: "^2.0.0" } }) });
  assert.match(deps, /more than its version/);
  assert.match(laneGateProblem({ ...base, pkgAfter: "{ not json" }), /could not be compared/);
});

test("quiet for a minor or major release, a tagged version, or no tags (CI)", () => {
  const risky = [...base.changes, { status: "M", file: "src/factory.mjs" }];
  assert.equal(laneGateProblem({ ...base, version: "0.14.0", changes: risky }), null);
  assert.equal(laneGateProblem({ ...base, version: "0.13.0", changes: risky }), null);
  assert.equal(laneGateProblem({ ...base, latestTag: "v0.13.1", changes: risky }), null);
  assert.equal(laneGateProblem({ ...base, latestTag: null, changes: risky }), null);
});

test("a patch must sit on the newest release tag", () => {
  const old = laneGateProblem({ ...base, version: "0.12.1", latestTag: "v0.12.0", newestTag: "v0.13.0" });
  assert.match(old, /v0\.13\.0 is newer/);
});
