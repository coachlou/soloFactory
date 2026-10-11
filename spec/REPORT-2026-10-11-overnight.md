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

The npm fix is prompt-only: `wbs.mjs` still throws on any compatibility item that isn't
"verified", so a planner that lists npm as blocked anyway still spends a correction.

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
route through `verifyWithRepairs`). Not covered: a repair triggered by a feature *review*
failure still runs (parking there would make resume repeat the review turn). Pending pause is
still not visible in the API.

## Other

- `.claude/launch.json` has an uncommitted `smoke-watchdog-plan4` config (MAX_REPAIRS=4) used for
  smoke planning.
- Known flake: `test/process.test.mjs` "agent activity extends the idle deadline" fails
  occasionally under full-suite load; passes on rerun.

## Smoke status

(updated below as it progresses)
