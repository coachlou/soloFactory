# Patch release lane

Status: built (`scripts/release-lane.mjs`, gate 5 in `scripts/build-distro.sh --check`). Asked by Lou on 2026-11-24
after PR 17 (the Guide chat box fix) could not ship without the full real-provider smoke set.

## The problem

The smoke gate is already path-based: a release that touches only the hub page never needs the smoke set. PR 17
needed it anyway because it merged into main behind PR 15 and PR 16, which changed `src/factory.mjs` and
`skills/factory-guide.md`. Main can only ship everything on it, so a one-line CSS fix waits for the next full release
(smoke set about $10-24 and 35-80 minutes, plus the Update now check). There was no way to ship a small fix from the
last release tag, and no rule for what a patch version may carry.

This lane is for SoloFactory's own releases. The deferred vibe-pilot *quick-fix lane* (spec v2 item 5) is a different
thing: a fast lane for changes to apps that SoloFactory builds. Nothing here changes how generated apps are built.

## Rules

1. **The version says the lane.** `X.Y.Z+1` over the newest release tag is a patch and must pass the patch lane.
   `X.Y+1.0` (or a major) is the full lane, as today. A person may always ship a patch-safe change in the full lane;
   nobody can put a risky change in the patch lane.
2. **The diff decides, with an allowlist.** Every file changed since the tag must be added or edited (not deleted or
   renamed) and match one of:
   - `public/**` (the hub page)
   - `docs/**` except `docs/INSTALL.md` (the update agent's runbook is part of the update path)
   - top-level `*.md` (README, PROGRESS, DEVELOPING, SPEC)
   - `test/**`
   - `smoke/results.jsonl`
   - `package.json`, only its `version` field
   Anything else (`src/`, `skills/`, `distro/`, `templates/`, `scripts/`, CI, smoke briefs) is a full release. An
   unknown path fails safe to the full lane. Untracked files count.
3. **Patch only from the newest tag.** Update now offers only a higher version than the installed one, so a patch on
   an older line would never reach anyone.
4. **Every other gate still runs.** The docs gate (`- Docs:` under the version's PROGRESS heading), `npm test`, Linux
   CI green on the release commit, the tag and the ambient-library sync from that exact commit.

## Why this is safe for users

- **User content.** The patch lane cannot touch the engine, the store, the installer, the update agent's runbook,
  `distro/` or the dependencies. Projects, runs and settings are read by the same code before and after, so there is
  nothing to migrate and nothing to lose.
- **Update path.** The update is the same one safe flow (Update now, the copy prompt, the update skill). The notice
  reads `package.json` on main, so the patch reaches members when main carries its version (step 8 below).
- **Smoke set.** The allowlist is a strict subset of the paths the smoke gate ignores, so a patch can never need it.

## Steps

1. Run `node scripts/release-lane.mjs` on main. It prints `patch` or `full` and why.
2. If main is `full` but the fix is small, branch from the newest tag: `git switch -c release-X.Y.Z vX.Y.(Z-1)`.
3. `git cherry-pick -x` the fix's commits. PROGRESS.md usually conflicts; keep only the fix's entry.
4. Bump `package.json` to `X.Y.Z`. Rename the fix's PROGRESS heading to `## X.Y.Z: <title> (<date>)` with a
   `- Docs:` bullet and a `- Lane: patch` bullet.
5. Run `npm test`. The lane gate fails if anything is not patch-safe.
6. Push the branch, wait for Linux CI, then tag `vX.Y.Z` on that commit and sync ambient-library from it.
7. Try Update now from `X.Y.(Z-1)` to `X.Y.Z` once.
8. Merge the release branch into main (a merge commit, through a branch and CI, as for any release push). Move the
   fix's PROGRESS entry under the patch heading on main so the next minor does not list it again.

## Not built

- No `--patch` override flag. Escalation needs no flag (bump the minor); a downgrade must not exist.
- The first release that can use this lane is the one after the release that ships it. A patch from `v0.13.0` has no
  lane gate, because the script is not in that tag.
