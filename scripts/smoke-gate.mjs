#!/usr/bin/env node
// Release smoke gate (docs/sdlc-hardening-spec.md 3a), run by build-distro.sh --check. Quiet unless package.json's
// version is untagged and the release touches prompts, adapters, the Guide skill or the controller. Then every
// smoke brief needs a passing real-provider row at or after the last commit that touched one of those files.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SMOKE_PATHS = ["src/prompts.mjs", "src/providers.mjs", "skills/factory-guide.md", "src/factory.mjs"];

// null when the release may ship; otherwise the message to print. eligibleCommits are the full hashes a row's short
// commit may match: the last commit that touched a SMOKE_PATHS file, and every commit after it.
export function smokeGateProblem({ version, latestTag, changed, eligibleCommits, rows, briefs, progress }) {
  if (!latestTag || latestTag === `v${version}`) return null;
  const touched = changed.filter((file) => SMOKE_PATHS.includes(file));
  if (!touched.length) return null;
  const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[: ]`);
  const lines = progress.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  const end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const entry = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
  if (entry.some((line) => /^- Smoke: waived, \S/.test(line))) return null;
  const eligible = (commit) => typeof commit === "string" && commit.length >= 7 && eligibleCommits.some((full) => full.startsWith(commit));
  // Rows from before a row recorded its provider are real runs: fixture runs were only ever dry runs to a scratch ledger.
  const missing = briefs.filter((name) => !rows.some((row) => row.brief === name && row.result === "passed" && row.provider !== "fixture" && eligible(row.commit)));
  if (!missing.length) return null;
  return `smoke gate: ${version} changes ${touched.join(", ")} since ${latestTag}, but smoke/results.jsonl has no passing real-provider row since the last change to them for ${missing.join(", ")}. Run node scripts/smoke.mjs, or add "- Smoke: waived, <reason>" under "## ${version}" in PROGRESS.md.`;
}

// The highest Node major a smoke brief's text requires ("Node 24", "Node.js 24+"), or null when it names none.
export function briefNodeMajor(body) {
  const majors = [...JSON.stringify(body.brief ?? {}).matchAll(/\bNode(?:\.js)?\s+v?(\d{2})\b/gi)].map((match) => Number(match[1]));
  return majors.length ? Math.max(...majors) : null;
}

// A brief that requires a newer Node than the one running the controller stops at planning: the plan reviewer
// rightly refuses a runtime the controller lacks (plan-request.json toolchain is process.version). Checked before
// any real run spends anything. Fixture runs cost nothing and never reach a plan review, so they are not checked.
export function smokeNodeProblem(name, body, provider, nodeVersion) {
  if (provider === "fixture") return null;
  const required = briefNodeMajor(body);
  const running = Number(String(nodeVersion).replace(/^v/, "").split(".")[0]);
  if (required === null || running >= required) return null;
  return `${name} requires Node ${required}, but the controller runs Node ${running} (${nodeVersion}). Put a Node ${required}+ first on PATH (e.g. PATH=/opt/node${required}/bin:$PATH), then rerun.`;
}

function main(repo) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let latestTag = null;
  try { latestTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"); } catch { return 0; } // shallow CI checkout: no tags, nothing to compare
  const lines = (text) => text.split("\n").filter(Boolean);
  const read = (...parts) => { try { return readFileSync(path.join(repo, ...parts), "utf8"); } catch { return ""; } };
  const rows = lines(read("smoke", "results.jsonl")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const briefs = readdirSync(path.join(repo, "smoke", "briefs")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(path.join(repo, "smoke", "briefs", f), "utf8")).brief.workingName);
  // The newest commit since the tag that touched a gated file; a row must be at it or later. With only uncommitted
  // gated edits there is no such commit yet, so HEAD is the earliest commit a row can be at.
  const lastTouch = git("log", "-1", "--format=%H", `${latestTag}..HEAD`, "--", ...SMOKE_PATHS);
  const eligibleCommits = lastTouch ? [lastTouch, ...lines(git("rev-list", `${lastTouch}..HEAD`))] : [git("rev-parse", "HEAD")];
  const problem = smokeGateProblem({
    version: JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version,
    latestTag,
    changed: lines(git("diff", "--name-only", latestTag)), // tag vs working tree: uncommitted edits count
    eligibleCommits,
    rows, briefs, progress: readFileSync(path.join(repo, "PROGRESS.md"), "utf8"),
  });
  if (problem) { console.error(`distro: ${problem}`); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
