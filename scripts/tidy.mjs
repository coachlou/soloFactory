#!/usr/bin/env node
// npm run tidy: list local branches merged into main or whose upstream is gone, plus their
// worktrees; delete them only after a y/N confirm. Never forces anything.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";

const KEEP = new Set(["main", "claude/ecstatic-tesla-stfhsz", "scrappy-pipeline"]);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tryGit = (...args) => {
  try { return { ok: true, out: git(...args) }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() }; }
};
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

const here = real(git("rev-parse", "--show-toplevel"));
const mainTip = git("rev-parse", "main");
const merged = new Set(git("branch", "--merged", "main", "--format=%(refname:short)").split("\n").filter(Boolean));

const worktrees = new Map(); // branch -> path
let path = null;
for (const line of git("worktree", "list", "--porcelain").split("\n")) {
  if (line.startsWith("worktree ")) path = line.slice(9);
  else if (line.startsWith("branch refs/heads/")) worktrees.set(line.slice(18), path);
}

const rows = git("for-each-ref", "refs/heads", "--format=%(refname:short)\t%(objectname)\t%(upstream:track)").split("\n");
const candidates = [];
const skipped = [];
for (const row of rows.filter(Boolean)) {
  const [branch, sha, track] = row.split("\t");
  const gone = track === "[gone]";
  if (KEEP.has(branch) || !(merged.has(branch) || gone)) continue;
  const wt = worktrees.get(branch);
  if (wt && real(wt) === here) { skipped.push(`${branch}: this is the worktree you are in`); continue; }
  if (wt && sha === mainTip) { skipped.push(`${branch}: at main's tip with no commits, may be a session just started (${wt})`); continue; }
  if (wt) {
    const status = tryGit("-C", wt, "status", "--porcelain");
    if (!status.ok) { skipped.push(`${branch}: could not read ${wt} (${status.out})`); continue; }
    if (status.out) { skipped.push(`${branch}: untracked or modified files in ${wt}`); continue; }
  }
  candidates.push({ branch, wt, why: merged.has(branch) ? "merged into main" : "upstream gone" });
}

for (const s of skipped) console.log(`skip  ${s}`);
if (!candidates.length) { console.log("Nothing to tidy."); process.exit(0); }
console.log(`\nWill delete ${candidates.length}:`);
for (const c of candidates) console.log(`  ${c.branch}  (${c.why})${c.wt ? `  + worktree ${c.wt}` : ""}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("\nDelete these? [y/N] ")).trim().toLowerCase();
rl.close();
if (answer !== "y" && answer !== "yes") { console.log("Nothing deleted."); process.exit(0); }

let failed = 0;
for (const c of candidates) {
  if (c.wt) {
    const r = tryGit("worktree", "remove", c.wt); // no --force: git refuses dirty or locked worktrees
    if (!r.ok) { failed++; console.log(`kept  ${c.branch}: worktree not removed (${r.out})`); continue; }
  }
  // -d, never -D: git refuses a branch it cannot prove is merged (e.g. squash-merged, upstream gone)
  const r = tryGit("branch", "-d", c.branch);
  if (r.ok) console.log(`gone  ${c.branch}`);
  else { failed++; console.log(`kept  ${c.branch}: ${r.out}`); }
}
process.exit(failed ? 1 : 0);
