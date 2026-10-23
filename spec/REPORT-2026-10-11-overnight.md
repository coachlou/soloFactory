# Overnight report — 2026-10-11

Branch `wip/feature-slice-recovery`. Nothing pushed, nothing released, nothing installed.
:4173, `~/.solofactory` and photo-library run 4f2dd1cf untouched; plan 42d97519 still unapproved.

## Bottom line

- **Smoke test (real provider, case tables):** IN PROGRESS — see "Smoke status" below.
- **Planner trivia fixed:** real-provider plans kept losing their bounded correction budget to
  validator bookkeeping, not to real defects. Four commits loosen exactly those rules.
- **Codex inbox:** new entry (Pause bypassed by a repair turn) fixed, test-first.
- **Design issue to decide (not built):** schema/validator failures spend the same correction
  budget as genuine reviewer blocks.

## Commits

| Commit | Why |
|---|---|
| 5122ce5 | A case may cite no check (constraint case); all case problems reported in one correction |
| 5dc444b | Inbox bookkeeping; rejects now go to `spec/REJECTS-codex.md` |
| 0b9265a | Case sources match the requirement by file, not exact locator text |
| a903a72 | Cases no longer have to re-cite every requirement source file |
| 91fdd3d | Case `expect`/`action` may be short ("28"); plan-request names the controller's Node, prompt says Node/npm need no compatibility entry |
| bfaaacc | Pending Pause parks before a gate-failure repair turn; no budget spent; resume reruns checks |
| 637182a | Inbox entry marked done |

Suite: 256/256.

## Honest loosening

These validator rules were relaxed because every real-provider failure on them was trivia:
- case refs may be empty (cases *together* must still cover every requirement ref — kept);
- case source locators are free text, so they match by file only;
- there is no case-side source coverage any more.

What still holds source fidelity: `assertConsolidation` against a reviewed plan (exact path +
locator), and the plan reviewer. A planner can now cite a requirement's file with a vague
locator and pass the schema check; only the reviewer catches that.

The npm fix was prompt-only at first. A follow-up commit makes `wbs.mjs` skip compatibility entries
that just name the controller's toolchain ("npm", "npm CLI (…)", "Node.js", with no version digits).
Any other unverified entry still fails the plan, including "Node 18" and "node-canvas".

Pause fix check: park() now may commit a red tree. Nothing treats HEAD as a green checkpoint —
feature/slice checkpoints record their own SHAs, and HEAD-bound repair-plan baselines are taken
after the park (park already committed before this change).

## Evidence (real-provider plan rounds, ~$3–6 each)

| Run | Blocks |
|---|---|
| 290f1cf4 | empty case refs; exact locator mismatch |
| ff1a6994 | npm compatibility; real reviewer block; reworded locator |
| 254040e1 | real block (`node --check` isn't a test); "cites requirements.json but no case does"; real block |
| 040de7db | npm compatibility; `expect: "28"` too short; real block (store.load shape vs PLAN.md) |

Roughly half of all correction rounds were validator trivia.

## Schema-fix budget (built on request)

A plan that fails the schema check (bad JSON, missing field, case-table rule, or a repair plan's
mapping check) now gets up to 3 schema-fix turns (`PLAN_SCHEMA_FIXES` in `src/wbs.mjs`) before
it may spend a correction. Reviewer blocks still use the correction budget, which is unchanged.
Fixed at 3, independent of `SOLOFACTORY_MAX_REPAIRS`. Feature planning stores `job.planSchemaFixes`
(reset only with the existing owner input-revision reset); repair planning stores
`phase.schemaFixes` per preparation, so each owner-requested preparation gets its own 3.
Owner-submitted amendments get none. Worst case adds 3 planner turns (~$3–6 each) per plan.

## Pause fix ceiling

Covered: Pause pending when a deterministic gate fails → parks before the repair turn (all modes
route through `verifyWithRepairs`, bfaaacc). Pause pending when a feature review blocks → parks
before the repair turn; the blockers are kept on the cursor, so resume repairs them without a
second review turn (3dc63ac; recovery features use the same path). The final whole-app review
does the same through `job.reviewFailure` (follow-up commit). Planning now honors Pause before a
plan review and before a correction (`job.planBlockers`). Pausing during repair-plan preparation
stops it, and the next step is retry-plan. The job API reports `pendingPause`. Fixture-tested only;
the installed worker has none of these fixes.

## Gate timeouts (Codex inbox)

A gate killed at its time limit used to be treated as a failed check, so a repair turn spent an
attempt on no assertion failure (live: MODEL-ROOT aggregate proof, repair-19). Now a timed-out
gate returns `gate_timeout`: the run parks, no repair runs, no attempt is spent, and the message
names `SOLOFACTORY_GATE_MINUTES` (default 5, 1–60; install keeps at least 10). Resume reruns the
gates. Ceiling: the limit is per server, not per proof, and needs a restart to change. A per-proof
`timeoutMinutes` in the plan is the upgrade if one global limit proves too blunt. A hanging app
also parks rather than being repaired; the owner decides.

## Codex review (retry, range 3e265b9..f31bcfc)

Four findings, all accepted, each reproduced by a failing test first, fixed in one commit:

- P1: resume dropped a feature's recorded review blockers before the repair saved; a shutdown
  mid-repair left `repairing` with no blockers and the next resume crashed. Now it rechecks.
- P2: a Pause during the last blocked repair-plan review parked as a retryable `plan_failed`,
  dodging the exhausted-budget guard. Pauses now fire only before a turn that would run (same
  reorder in feature planning).
- P2: a recovery precheck that hit the gate time limit was handed to the builder as its failure.
  Now it parks as `gate_timeout`; resume reruns the precheck.
- P2: "Node.js (latest LTS required)" slipped through the controller-toolchain exemption. Version
  words in the parenthetical now count as a real requirement.

Suite: 267/267.

## Other

- `.claude/launch.json` has an uncommitted `smoke-watchdog-plan4` config (MAX_REPAIRS=4) used for
  smoke planning.
- Known flake: `test/process.test.mjs` "agent activity extends the idle deadline" fails
  occasionally under full-suite load; passes on rerun.

## Smoke status

(updated below as it progresses)
- 040de7db (smoke-cases-3, pre-91fdd3d code in memory): failed `plan_blocked` at 06:26 after 4
  corrections. The last correction was spent on a case-source schema error, which the
  schema-fix budget (f34c4f9) now handles separately. Not a recovery-path result.
- a943a5da (smoke-cases-4): started on HEAD 236d7e1 with `smoke-watchdog-plan4`. Next steps:
  plan approval, then restart with MAX_REPAIRS=0, resume, plant fault, prepare repair plan, stop at ready.

## Staged verification (ordering only, per the Codex amendment)

- After a repair the failed gate runs first (behind install), then the full set; feature gates unchanged.
- Final integration reruns every verified feature's build-time proofs once (additive). Repair runs rerun only their own plan's features.
- Feature reviewer reads gate logs and caseResults instead of rerunning proof commands.
- Dropped after the amendment: planner guidance moving per-feature regression to final, and the post-review same-candidate skip. No reuse/cache.
- Suite 269/269. Measurement and shadow-selection pilot (amendment items 1–4) still open.

## Measurement (amendment items 1–2)

- `src/measure.mjs` derives per-phase agent time, tokens and gate cost from the event log; exposed as telemetry `measurement` and `scripts/measure-run.mjs`.
- Smoke run a943a5da: agent 5202s vs controller gates 15.7s. On this app, gate optimization has nothing to save; agent turns (review ≈ implement per feature) dominate.

## Update 2026-10-11 19:50Z — smoke run a943a5da completed
Real provider, f31bcfc: F1–F3 verified, final integration and review passed, deployed. The planted
fault was unreachable (after `process.exit`), so recovery was not exercised and the release gate
stays open. A prepare-plan request against the stale-evidence park overwrote the run error; fixed in
a547f61. Measurements: spec/PROGRESS-2026-10-11-planning-efficiency.md.
