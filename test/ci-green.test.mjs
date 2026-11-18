import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ciVerdict, WORKFLOW } from "../scripts/ci-green.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "abc1234" + "0".repeat(33);
const run = (extra) => ({ path: WORKFLOW, name: "test", status: "completed", conclusion: "success", created_at: "2026-11-16T10:00:00Z", ...extra });

test("ciVerdict: green only when the newest test-workflow run on the commit succeeded", () => {
  assert.equal(ciVerdict([run()], sha), null);
  assert.match(ciVerdict([], sha), /no CI run of the test workflow for abc1234/);
  assert.match(ciVerdict(undefined, sha), /no CI run/);
  assert.match(ciVerdict([run({ status: "in_progress", conclusion: null })], sha), /still in_progress/);
  assert.match(ciVerdict([run({ conclusion: "failure", html_url: "https://x/1" })], sha), /finished failure \(https:\/\/x\/1\)/);
  // A rerun that passed after a failure counts; a newer failure after a pass does not.
  assert.equal(ciVerdict([run({ conclusion: "failure" }), run({ created_at: "2026-11-16T11:00:00Z" })], sha), null);
  assert.match(ciVerdict([run(), run({ conclusion: "failure", created_at: "2026-11-16T11:00:00Z" })], sha), /finished failure/);
  // Other workflows on the same commit never stand in for the test workflow.
  assert.match(ciVerdict([run({ path: ".github/workflows/other.yml", name: "other" })], sha), /no CI run/);
});

// A throwaway repo with the real hooks, a stub ci-green and a stub npm test, so the hooks run end to end.
async function hookRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-hooks-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  await mkdir(path.join(dir, "scripts", "hooks"), { recursive: true });
  for (const hook of ["pre-commit", "pre-push"]) {
    await copyFile(path.join(repo, "scripts", "hooks", hook), path.join(dir, "scripts", "hooks", hook));
    await chmod(path.join(dir, "scripts", "hooks", hook), 0o755);
  }
  await writeFile(path.join(dir, "scripts", "ci-green.mjs"), `console.log("ci-green " + process.argv[2]); process.exit(process.env.CI_GREEN === "1" ? 0 : 1);\n`);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.0.0", scripts: { test: "echo suite-ran GIT_DIR=$GIT_DIR." } }));
  git("config", "core.hooksPath", "scripts/hooks");
  return { dir, git };
}

test("pre-commit refuses a staged .mjs file that does not parse and accepts one that does", async () => {
  const { dir, git } = await hookRepo();
  await writeFile(path.join(dir, "bad.mjs"), "export const x = ;\n");
  git("add", "-A");
  const refused = spawnSync("git", ["commit", "-qm", "bad"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pre-commit: bad\.mjs does not parse/);
  await writeFile(path.join(dir, "bad.mjs"), "export const x = 1;\n");
  git("add", "-A");
  assert.equal(spawnSync("git", ["commit", "-qm", "good"], { cwd: dir, encoding: "utf8" }).status, 0);
});

test("pre-push: a release push to main needs green CI, then runs the suite; other pushes skip the CI check", async () => {
  const { dir, git } = await hookRepo();
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "1.1.0", scripts: { test: "echo suite-ran GIT_DIR=$GIT_DIR." } }));
  git("commit", "-qam", "release");
  const release = git("rev-parse", "HEAD");
  const push = (line, env = {}) => spawnSync("sh", ["scripts/hooks/pre-push", "origin", "x"], { cwd: dir, input: `${line}\n`, encoding: "utf8", env: { ...process.env, ...env } });

  const red = push(`refs/heads/main ${release} refs/heads/main ${base}`);
  assert.notEqual(red.status, 0);
  assert.match(red.stderr, /release push \(1\.0\.0 -> 1\.1\.0\)/);
  assert.doesNotMatch(red.stdout, /suite-ran/);

  const green = push(`refs/heads/main ${release} refs/heads/main ${base}`, { CI_GREEN: "1" });
  assert.equal(green.status, 0);
  assert.match(green.stdout, new RegExp(`ci-green ${release}`));
  assert.match(green.stdout, /suite-ran/);

  // Same version on both sides: the suite runs and the CI check does not.
  await writeFile(path.join(dir, "notes.txt"), "x");
  git("add", "-A"); git("commit", "-qm", "docs");
  const plain = push(`refs/heads/main ${git("rev-parse", "HEAD")} refs/heads/main ${release}`, { GIT_DIR: path.join(dir, ".git") }); // git exports GIT_DIR to hooks
  assert.equal(plain.status, 0);
  assert.doesNotMatch(plain.stdout, /ci-green/);
  assert.match(plain.stdout, /suite-ran/);
  assert.match(plain.stdout, /GIT_DIR=\./); // the suite never inherits the hook's GIT_DIR

  // A branch push runs neither: that is where a release commit gets its CI run.
  const branch = push(`refs/heads/release ${release} refs/heads/release ${base}`);
  assert.equal(branch.status, 0);
  assert.equal(branch.stdout.trim(), "");
});
