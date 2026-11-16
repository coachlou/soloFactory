# Four-tier gates: spec

Status: built on branch `feat/four-tier-gates` (2026-11-16). Source: the four-tier validation article
(rules, this change works, main works, ready to release) and its audit in project files
`reviews/four-tier-ci-assessment.md`.

## Why only these four

The 0.11.0 smoke runs were measured with `scripts/measure-run.mjs`:

| Run | Wall | Controller gates | Planning |
|---|---|---|---|
| Habit Ledger | 16 min | 36 s | 6.2 min |
| Voice Notes | 19 min | 48 s | 6.0 min |
| Household Inventory | 26 min | 19 s | 6.5 min |

- In the app pipeline, the gates are already scoped per feature and fast. The time goes to agent stages.
- Reusing passed gate results and giving the tests a time budget would each save seconds, so neither is built.
- For apps, feature flags, phased rollout and telemetry gates are skipped: each app is local and has one user.

## Tiers after this change

| Tier | SoloFactory's own repo | Apps SoloFactory builds |
|---|---|---|
| 1 Rules | `pre-commit` hook: `node --check` on staged `.mjs` files (G3) | install, lint (if declared), secrets, declared writes |
| 2 This change works | `npm test` locally; `pre-push` runs it when you push to main | each feature's proofs plus the earlier features it touched |
| 3 Main works | GitHub Actions `test` on Linux for every push and PR | integration pass, final review bound to the tested source |
| 4 Ready to release | smoke gate; **CI must be green on the release commit** (G1); stage budgets in smoke rows (G2) | deploy checks; **early crash offers rollback** (G4) |

## G1. Release only from a commit that passed Linux CI

Problem:
- `pre-push` tests on macOS, but members run Linux under WSL.
- Nothing stops a release commit that failed CI from reaching main. The update notice reads main's
  `package.json` (`src/update-check.mjs`), so members see a new version the moment main moves.

Build:
- `scripts/ci-green.mjs [sha]` (default HEAD) asks GitHub, through `gh api`, for the Actions runs of that exact commit.
  - Exit 0 only when the newest run of the `test` workflow on that sha finished with `success`.
  - Otherwise it exits 1 and says why: no run, still running, failed, or `gh` missing or not signed in.
- The verdict is a pure function, `ciVerdict(runs)`, unit-tested in `test/ci-green.test.mjs`.
- The versioned `pre-push` hook (G3) runs the check when a push to main changes the `version` in `package.json`,
  compared with the remote main. That is a release push.
- Release flow: push the release commit to a branch first, let CI pass, then push the same commit to main.
- `git push --no-verify` remains the owner's explicit override.

Not changed: CI, the smoke gate, `update-check.mjs`.

## G2. Agent-stage minutes and budgets in the smoke ledger

Problem: the smoke row holds only the total wall time. A regression in planning or review time
(Codex: review 19 min vs Claude's 4) shows up only if someone opens `measure-run` by hand.

Build:
- `summarizeRun` (`src/measure.mjs`) adds one `stageMin` object to each row: `planning`, `implement`, `review`,
  `repair` and `gates`. Each value is minutes rounded to one decimal, taken from `measureRun`, which already computes them.
- `STAGE_BUDGETS` (exported) holds the budgets:
  - planning 8 min per run
  - implement 3 min per feature
  - review 1.5 min per feature
  - repair 5 min per run
  - gates 3 min per run

  The current runs sit well under these: planning about 6 min, review 0.6-0.8 min per feature, gates under 1 min.
- `overBudget(row)` lists each stage over its budget, as `review 19.0 min > 7.5`.
  - It is printed by `scripts/smoke.mjs` after each run.
  - It is shown in a new *Over budget* column of `smoke.mjs table`.
- The table also gains *Plan*, *Review*, *Repair* and *Gates* minute columns. Rows written before this change show those cells empty.
- `SMOKE_BUDGETS="review=2,planning=10"` overrides the budgets for one smoke session.
- A budget is a tripwire to investigate, never a failure. The smoke gate and the ledger's pass or fail are unchanged.

## G3. Versioned git hooks

Problem: the full-suite `pre-push` lives only in one checkout's `.git/hooks`. Fresh clones and worktrees
don't have it, and there is no fast tier-1 check.

Build:
- `scripts/hooks/pre-commit`: runs `node --check` on every staged `.mjs` file, so a syntax error never gets committed. Takes seconds.
- `scripts/hooks/pre-push`: when the push updates main, it runs:
  - the G1 check, if this is a release push
  - `npm test`, the same as the old local hook
- `npm run hooks` runs `git config core.hooksPath scripts/hooks`, which turns the hooks on for that clone.
- The old `.git/hooks/pre-push` is left in place. Git ignores it once `core.hooksPath` is set, so nothing is deleted.

## G4. A crash right after deploy offers rollback

Problem: when a new release's app exits on its own soon after going live, the Live app panel shows only
*Stopped*. The rollback offer looks the same as on a healthy app.

Build:
- In the `deployLocal` exit handler (`src/factory.mjs`), an exit that no owner, server or replacement caused
  (`stoppedBy: "exited"`), within `EARLY_CRASH_MS` (2 min) of the deployment's `startedAt`, records
  `deployment.earlyExit = { afterSeconds, exitCode }`.
  - The `deployment.stopped` event message then says it stopped N seconds after going live.
- `releaseExtras` (`src/server.mjs`) passes `earlyExit` through. The Live app panel shows an amber attention line:
  - With a rollback offer: *The app stopped N s after this release went live (exit C). Rolling back to <name> may fix it, or Relaunch to try again.*
  - Without one: the same line with Relaunch only.
- Nothing rolls back on its own. Rollback stays the owner's confirmed action from the approved rollback feature.
- A Relaunch that stays up clears the line, because a new deployment record has no `earlyExit`.

## Engine and UI rules

- No gate, proof, repair or review behavior changes. G4 adds one field and one message.
- The UI change adds one attention line. Every existing control stays.
- Nothing in the repo or the owner's folders is deleted.
