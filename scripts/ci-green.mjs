#!/usr/bin/env node
// Release gate (docs/four-tier-gates-spec.md G1): a release commit must have passed the Linux CI `test` workflow,
// because members run Linux (WSL) and the local pre-push suite runs on macOS. Asks GitHub through `gh api`.
//
//   node scripts/ci-green.mjs [sha]   exit 0 when the newest `test` run on that exact commit succeeded
//
// Run by scripts/hooks/pre-push on a push to main that changes package.json's version. Release flow: push the
// release commit to a branch first, let CI pass, then push the same commit to main.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW = ".github/workflows/test.yml";

// runs: GitHub's workflow_runs for one head_sha. null when green; otherwise the reason to print.
export function ciVerdict(runs, sha) {
  const short = String(sha).slice(0, 7);
  const ours = (runs ?? []).filter((run) => run.path === WORKFLOW || run.path?.startsWith(`${WORKFLOW}@`) || run.name === "test")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const newest = ours[0];
  if (!newest) return `no CI run of the test workflow for ${short} yet. Push it to a branch first (git push origin HEAD:release-check), wait for CI, then push main.`;
  if (newest.status !== "completed") return `CI for ${short} is still ${newest.status}${newest.html_url ? ` (${newest.html_url})` : ""}. Wait for it to pass, then push again.`;
  if (newest.conclusion !== "success") return `CI for ${short} finished ${newest.conclusion}${newest.html_url ? ` (${newest.html_url})` : ""}. Fix forward on a branch; release only a commit whose CI passed.`;
  return null;
}

function main(sha) {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let full;
  try { full = run("git", ["rev-parse", sha]); } catch { console.error(`ci-green: unknown commit ${sha}`); return 1; }
  let body;
  try { body = JSON.parse(run("gh", ["api", `repos/{owner}/{repo}/actions/runs?head_sha=${full}&per_page=50`])); }
  catch (error) {
    console.error(`ci-green: could not ask GitHub for the CI result of ${full.slice(0, 7)} (${String(error.stderr || error.message).trim().split("\n")[0]}). Install gh and run gh auth login, or push with --no-verify to override.`);
    return 1;
  }
  const problem = ciVerdict(body.workflow_runs, full);
  if (problem) { console.error(`ci-green: ${problem}`); return 1; }
  console.error(`ci-green: CI passed on ${full.slice(0, 7)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv[2] ?? "HEAD");
