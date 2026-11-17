import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/tidy.mjs");

test("tidy lists, skips dirty and protected, deletes only on y", () => {
  const root = mkdtempSync(join(tmpdir(), "tidy-"));
  const repo = join(root, "repo");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  const commit = (msg) => git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", msg);
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commit("root");
    for (const b of ["done", "dirty", "claude/ecstatic-tesla-stfhsz", "open"]) {
      git("checkout", "-qb", b, "main"); commit(b); git("checkout", "-q", "main");
      if (b !== "open") git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", `m ${b}`, b);
    }
    git("worktree", "add", "-q", join(root, "wt-done"), "done");
    git("worktree", "add", "-q", join(root, "wt-dirty"), "dirty");
    writeFileSync(join(root, "wt-dirty", "scratch.txt"), "x");
    git("branch", "fresh"); git("worktree", "add", "-q", join(root, "wt-fresh"), "fresh");

    const run = (input) => spawnSync("node", [script], { cwd: repo, input, encoding: "utf8" });

    const no = run("n\n");
    assert.match(no.stdout, /skip {2}dirty: untracked or modified/);
    assert.match(no.stdout, /skip {2}fresh: at main's tip/);
    assert.match(no.stdout, /done {2}\(merged into main\) {2}\+ worktree/);
    assert.doesNotMatch(no.stdout, /ecstatic|open|^ {2}main/m);
    assert.match(no.stdout, /Nothing deleted/);
    assert.ok(existsSync(join(root, "wt-done")));

    const yes = run("y\n");
    assert.equal(yes.status, 0, yes.stdout + yes.stderr);
    assert.match(yes.stdout, /gone {2}done/);
    assert.ok(!existsSync(join(root, "wt-done")));
    const left = git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
    assert.deepEqual(left, ["claude/ecstatic-tesla-stfhsz", "dirty", "fresh", "main", "open"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
