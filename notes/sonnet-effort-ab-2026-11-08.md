# Sonnet builder effort A/B — 2026-11-08

Same smoke brief (`.solofactory/smoke/job-ordered.json`), one run per arm, Opus judgment stages fixed at **low**,
Sonnet builders and repairs at the arm's effort, $15 ceiling, fresh factory home per arm.

| Sonnet effort | Outcome | Features | Repairs | Total | Sonnet | Opus | Wall time | `npm test` rerun |
|---|---|---|---|---|---|---|---|---|
| low    | completed | 3 | 2 | $4.57 | $1.04 | $3.53 | 12 min | pass |
| **medium** | completed | 3 | **0** | **$4.11** | **$0.97** | $3.14 | **12 min** | pass |
| high   | completed | 3 | 0 | $4.61 | $1.41 | $3.20 | 14 min | pass |
| xhigh  | completed | 3 | 1 | $8.20 | $4.55 | $3.66 | 31 min | pass |

## Decision
Keep the shipped defaults: **Sonnet medium** for builders/repairs, **Opus low** for judgment.
Medium was cheapest, tied fastest, and the only arm besides high with zero repairs; high bought nothing for +45% Sonnet spend;
xhigh cost 4.7x the Sonnet spend and 2.6x the time. The earlier uncommitted bump (Sonnet high, Opus medium) was reverted.
Opus is ~75% of every run's cost, so judgment effort is the bigger lever; Opus medium was not tested.

## Caveats
- n=1 per arm; repair counts are noisy at this sample size.
- low and xhigh ran before the test-command prompt fix below; medium and high ran with it. Low's repairs were not the
  test-command bug (its plan used `node --test test/*.test.js`), so the comparison holds, but rerun low if it matters.

## Fixes found along the way
1. **Factory prompt bug (uncommitted, `src/prompts.mjs`).** Planned runs (planVersion 2) call `specificationPrompt(false)`,
   which skipped the slice-contract text carrying TEST_SCRIPT_RULE. Plans then named `node --test test/`, which Node 26
   loads as a module and fails. The rule now sits in the shared spec tail; `test/consolidation.test.mjs` asserts it. 400/400 pass.
2. **Collision Guard mod (`~/.claude/mods/collision-guard/hooks/register.tsx`, applied with approval).** In `-p`/SDK sessions
   its `$.ui.ask` failed and counted as Cancel, so factory agents could not rewrite files another session touched.
   It now only asks in interactive sessions. Backup: `/tmp/sfab/register.tsx.bak`.
