# Progress: planning efficiency and the integration-rerun regression

Working file for the current stretch. Read this first after a `/clear`.

## Standing constraints (do not relax)
- Never touch the photo-library app, run 2026-10-07-4f2dd1cf, the :4173 worker or `~/.solofactory`; Codex owns them.
- Never approve recovery plans (plan 42d97519 stays unapproved). Never auto-approve.
- Push only with permission; never merge or open a PR. Stage specific files. Commit messages say why and end with the Co-Authored-By line from the session reminder.
- `wip/feature-slice-recovery` is not merged/released until a real-provider recovery smoke test passes.
- :4205 runs from this worktree at f31bcfc; do not restart it while smoke run 2026-10-11-a943a5da is active (watcher bw161apqi waits for its repair plan to reach ready; record success, do NOT approve).
- Keep src/ test-green and committed.

## Done this stretch
- 5261167 measurement: `src/measure.mjs`, `scripts/measure-run.mjs`, telemetry `measurement`. Smoke run a943a5da: wall 5400s, agent 5202s, controller gates 15.7s, planning 2451s over 10 turns.
- 5959577 planning prompts: shared `PLAN_CHECKLIST`, `CONTROLLER_FACTS`, `ALL_BLOCKERS` in src/prompts.mjs, used by planner/reviewer/corrector and repair-plan prompts; `plan.blocked` events carry `blockers` (full list). Pushed to origin? NO (5959577 is local only; 5261167 was pushed).

## Findings behind the plan
- The smoke brief fixed delivery order; the specification turn turned that into ACCEPTANCE gates 43–45 asserting a feature's *absence* ("FAIL: GET /api/summary -> 404 is the expected state") and gate 47 (`git status --porcelain`). Those cost one planning round, three F1 repairs and an F1 job failure.
- Regression in fa408cd: `featureProofs(job)` re-attaches every done feature's cases at final integration ([src/factory.mjs](../src/factory.mjs) ~1096, 1174, 1226). The approved plan's `F1-SEED-SCRIPT-STAGE-GATE` case `F1-SEED-FAIL-404` was superseded by F3's `F3-SEED-PASS` (the test file now holds only that), so the integration rerun would report the case `missing`, burn repairs on something unrepairable and fail the run. `supersedes` is normalised in src/wbs.mjs:283 but only exposed in the repair-plan schema (src/feature-recovery.mjs PLAN_SCHEMA), not `FEATURE_PLAN_SCHEMA` in src/prompts.mjs.
- Feature reviews cost $5.5–8.5 and 300–580s each (pre-fa408cd prompt): reviewers reran earlier features' tests and re-explored the repo. fa408cd's "do not rerun" prompt may already remove much of this; unmeasured.

## Plan (agreed 2026-10-11)
1. **[done, committed] Superseded cases at integration.** Fixture test in test/features.test.mjs ("a later feature's case supersedes an earlier stage obligation…") reproduced the `missing` failure; fix: `supersedes` in `FEATURE_PLAN_SCHEMA`, `featureProofs` skips obligations retired by a built feature's case, `validateFeaturePlan` rejects superseding a same-or-later feature's obligation (unknown ids left to assertConsolidation). Suite 276/276.
2. **[done, committed]** Spec prompt: delivery order → `dependsOn`; never acceptance items asserting absence or repository state (both modes, follow-on too).
3. **[done, committed]** Feature reviewer prompt: cased checks judged by their tests only; uncased directly; earlier features not reread/rerun. Suite 278/278.
4. After smoke run a943a5da ends: restart :4205 on HEAD, run one smoke, `node scripts/measure-run.mjs <run>`; compare planning turns (target ≤4) and review vs implement time. Only then decide on "contract cards" (per-feature interface/ownership cards so reviewers judge one feature in isolation).
- Open, not requested: Codex amendment items 3–4 (shadow-mode gate selection); Codex asked in spec/INBOX-codex.md to run measure-run on the photo-library run.
