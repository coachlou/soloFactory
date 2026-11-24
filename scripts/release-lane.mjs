#!/usr/bin/env node
// Release lanes (docs/patch-release-lane-spec.md). A patch version (X.Y.Z+1 over the newest release tag) may ship
// only what the patch lane allows: hub page, docs and tests, nothing the engine, the Guide, the installer or the
// update path reads. Anything else needs a minor version and the full release. The diff decides, never a person:
// a person can always choose the full lane, but cannot talk a change into the patch lane.
//
//   node scripts/release-lane.mjs          # print the lane the changes since the newest tag qualify for
//   node scripts/release-lane.mjs --check  # gate (build-distro.sh --check): fail a patch version whose diff is not patch-safe
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The patch lane allowlist. Fail-safe: a path that matches none of these sends the release to the full lane.
// docs/INSTALL.md is the runbook the update agent follows (Update now, the copy prompt, the update skill), so it is
// part of the update path, not plain docs.
export const PATCH_SAFE = [
  { pattern: /^public\//, why: "hub page" },
  { pattern: /^docs\/(?!INSTALL\.md$)/, why: "docs" },
  { pattern: /^[A-Za-z0-9_-]+\.md$/, why: "top-level docs" },
  { pattern: /^test\//, why: "tests" },
  { pattern: /^smoke\/results\.jsonl$/, why: "smoke ledger" },
];

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(String(version ?? "").trim());
  return match ? { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null;
}

// True when version is a patch release on top of tag: same X.Y, higher Z, no prerelease suffix on either.
export function isPatchBump(version, tag) {
  const a = parseVersion(version);
  const b = parseVersion(tag);
  if (!a || !b || a.prerelease || b.prerelease) return false;
  return a.parts[0] === b.parts[0] && a.parts[1] === b.parts[1] && a.parts[2] > b.parts[2];
}

// Why a change set is not patch-safe; [] means it may ship in the patch lane. changes are git name-status pairs
// ({ status: "M", file }); pkgBefore/pkgAfter are package.json's text at the tag and now.
export function patchLaneProblems({ changes, pkgBefore, pkgAfter }) {
  const problems = [];
  for (const { status, file } of changes) {
    if (file === "package.json") continue;
    if (!/^[AM]$/.test(status)) { problems.push(`${file} is ${status === "D" ? "deleted" : `changed (${status})`}; only added or edited files can ship in a patch`); continue; }
    if (!PATCH_SAFE.some(({ pattern }) => pattern.test(file))) problems.push(`${file} is outside the patch lane (hub page, docs, tests)`);
  }
  if (changes.some(({ file }) => file === "package.json")) {
    try {
      const strip = (text) => { const { version, ...rest } = JSON.parse(text); return JSON.stringify(rest); };
      if (strip(pkgBefore) !== strip(pkgAfter)) problems.push("package.json changes more than its version (dependencies, scripts or engines)");
    } catch {
      problems.push("package.json could not be compared");
    }
  }
  return problems;
}

// null when the release may go on; otherwise the message to print. newestTag is the highest release tag in the repo,
// latestTag the nearest one behind HEAD.
export function laneGateProblem({ version, latestTag, newestTag, changes, pkgBefore, pkgAfter }) {
  if (!latestTag || latestTag === `v${version}` || !isPatchBump(version, latestTag)) return null;
  if (newestTag && newestTag !== latestTag) {
    return `release lane: ${version} is a patch on ${latestTag}, but ${newestTag} is newer. Cut a patch only from the newest release tag; Update now never offers an older line.`;
  }
  const problems = patchLaneProblems({ changes, pkgBefore, pkgAfter });
  if (!problems.length) return null;
  return `release lane: ${version} is a patch version, but the changes since ${latestTag} are not patch-safe:\n  - ${problems.join("\n  - ")}\nBump the minor version and follow the full release, or cut the patch branch from ${latestTag} with only the patch-safe commits.`;
}

function main(repo, check) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let latestTag;
  try { latestTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"); } catch { return 0; } // CI checkout: no tags
  const newestTag = git("tag", "--list", "v[0-9]*", "--sort=-v:refname").split("\n").find((t) => parseVersion(t) && !parseVersion(t).prerelease) ?? null;
  // Tag vs working tree, as the smoke gate does: uncommitted edits count. -M so a rename shows as R, not D + A.
  const changes = git("diff", "--name-status", "-M", latestTag).split("\n").filter(Boolean)
    .map((line) => { const [status, ...files] = line.split("\t"); return { status: status[0], file: files.at(-1) }; })
    .concat(git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean).map((file) => ({ status: "A", file })));
  let pkgBefore = "";
  try { pkgBefore = git("show", `${latestTag}:package.json`); } catch {}
  const pkgAfter = readFileSync(path.join(repo, "package.json"), "utf8");
  const version = JSON.parse(pkgAfter).version;
  if (check) {
    const problem = laneGateProblem({ version, latestTag, newestTag, changes, pkgBefore, pkgAfter });
    if (problem) { console.error(`distro: ${problem}`); return 1; }
    return 0;
  }
  const problems = patchLaneProblems({ changes, pkgBefore, pkgAfter });
  const [x, y, z] = parseVersion(latestTag).parts;
  if (!changes.length) console.log(`release lane: nothing changed since ${latestTag}.`);
  else if (!problems.length) console.log(`release lane: patch. The ${changes.length} changed files since ${latestTag} are patch-safe; this can ship as ${x}.${y}.${z + 1} (or as ${x}.${y + 1}.0 in the full lane).`);
  else console.log(`release lane: full. Since ${latestTag}:\n  - ${problems.join("\n  - ")}\nShip as ${x}.${y + 1}.0, or cut a patch branch from ${latestTag} with only patch-safe commits.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), process.argv.includes("--check"));
}
