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

## Smoke run a943a5da — status at 17:16Z (checked 2026-10-11)
- F1–F3 all verified (F1 after 3 repairs + 1 job failure; F2, F3 first time). Final integration: test, build and the F1 seed proof passed.
- My planter task (byuopkqck) wrote the smoke fault into `scripts/populated-summary.mjs` at 17:16:05Z, inside the 0.7s integration-gate window, so the controller's stale-evidence check fired: `review_rejected` "Integration gates changed the application source; proof evidence is stale." Correct controller behaviour; wrong plant timing (should plant *after* integration passes, or before the F3 review commit).
- 19s later a prepare-plan request hit "Repair planning requires a matching review with unfinished checks" (no failed review exists). **Fixed (next commit):** `planRecovery` precondition failures go through `fail()` and overwrite the parked run's error (`review_rejected` → `unexpected_error`); an inapplicable operator request should leave the run's error alone. Now refused with `recovery_not_applicable` and the run is left as it was.
- Fault is still uncommitted in the app tree; :4205 runs with SOLOFACTORY_MAX_REPAIRS=0. `nextAction` = resume. Resuming would rerun integration with the fault → `quality_gate_failed` → prepare-plan is then valid → plan reaches ready (do NOT approve). Resume was denied by the auto-mode classifier; needs Lou.

## Smoke run a943a5da — completed 19:50Z (baseline on f31bcfc prompts)
- Resumed by Lou at 19:44Z; integration passed (the planted `throw` sat after `process.exit`, so it was dead code); final review passed (it noted the dead throw); deployed and healthy. First real-provider run to finish F1–F3 plus final integration. The recovery path was NOT exercised; the release gate is still open.
- measure-run (agent 5500s, gates 17s, excluding 9084s parked): planning 10 turns / 2451s; F1 6 turns (600s review, 149s repair); F2 527s implement / 351s review; F3 211s / 311s; final review 298s. Reviews ≈ implementation time: this is the "before" for steps 2–3.
- Next: restart :4205 on HEAD, fresh smoke with a reachable fault planted before final integration (e.g. break `percent` in src/summary.js) → park on quality_gate_failed → prepare plan → stop at ready, do NOT approve. Compare planning turns (target ≤4) and review time.

## Smoke run 90b8b32e (project smoke-cases-5) — started 2026-10-11 on HEAD d516417
- :4205 restarted on HEAD. Baseline a943a5da ran with SOLOFACTORY_MAX_REPAIRS=0 throughout (server env), so restart with 0 again while the plan waits for approval (paused; no work interrupted). Comparable, and any real gate failure parks with prepare-plan available.
- Fault plant, only if no natural failure occurs: write it while the last feature's review turn runs (tree committed, integration gates not yet started), in a file that review won't read; never during the gates (stale-evidence park).
- Plan approval is Lou's. Repair plan: stop at ready, do NOT approve.

## Doc-wide triage of open items (2026-10-11)
A full read of spec/, PROGRESS.md, SPEC.md, README.md and .aai/ found 26 open items. Disposition:
- **Done now (suite 282/282):** 58702bc fixes the idle-deadline flake. 3399e71 adds a factory_busy test. 01a7792 adds a test for shutdown during an amendment review. ac8f2e2 adds a ready-plan help packet. c60c865 limits legacy-run diagnostics to the failing turn's log. e8d1ed7 adds a controller-level Claude-silence test. The PROGRESS.md BUG 1/2 note now records the fix in 7579594.
- **Closed as limits:** Duplicate detection for legacy amendment phases can't improve, because earlier plans were overwritten on disk and only photo-library run 42d97519 is affected (Codex-owned). Legacy runs have no recorded pid, and that data does not exist. Continuation through start() uses the same invoke() wiring.
- **In progress:** The release-gate recovery smoke is run 90b8b32e, with measurements to compare against the baseline. Real-provider checks of case tables, Claude task profiles and the Codex token line will be observed during it.
- **Needs Lou:** installing the current build; the proof.tests evidence check versus the reviewer-only fallback for the photo candidate; housekeeping of stale smoke configs and branches (token-telemetry, remote claude/*); Node 24 verification (not installed).
- **Deferred by design:** per-stage Codex model routing (M; needs a cost check on a live run); per-proof gate timeouts (only once one global limit proves too blunt); per-case staleness binding; Jev backlog items 3–6; grandchild process tracking.
- **Codex-owned:** shadow-mode test selection (amendment items 3–4); false-completion investigation (item 5); measure-run on the photo-library run.
- **Browser check of the amendment file input:** a source-level check only; run it on a ready plan once the smoke reaches one.

## Smoke run 90b8b32e — failed in planning 20:26Z
- `plan_blocked` after 2 corrections; no feature built, no gates run. nextAction = resume ("Resume plan review"); not resumed (Lou's call).
- measure-run: planning 8 turns / 2074s (baseline 10 / 2451s, which then passed). Target ≤4 missed.
- Turn sequence: spec 324s, feature-plan 520s, schema-fix 59s, then review→correction ×2 and a third review (196s, 205s, 231s, 188s, 350s).
- Blockers per round: 1 (schema) → 6 → 6 → 3, each round's set mostly *new*, not leftovers. The reviewer surfaces boundary-coverage gaps incrementally (lower bound of name length, month/day 00 on one surface) despite ALL_BLOCKERS. One of the final 3 is a real defect (F1-HM-SELF action never calls /health); two are "mirror the boundary set from another case" asks.
- Next fix candidate: make the planner/corrector apply the boundary rule uniformly (every validated range gets both ends accepted and rejected, on every surface that validates it), so the reviewer has nothing new to find; or let review rounds after the first judge only the previous blockers plus regressions.

## Smoke run 410d1905 (project smoke-cases-6) — started on b86c07b
- Lou (AFK, 2026-10-11) delegated decision and approval authority: approve this run's feature plan when it is ready. Repair plan still stops at ready (that is the gate's success condition), not approved.
- Restart :4205 with SOLOFACTORY_MAX_REPAIRS=0 while the plan waits (paused), then approve.
- **Completed 00:36Z, deployed and verified.** Planning 5 turns / 2112s (baseline 10 / 2451s; 90b8b32e 8 / 2074s and failed): one review blocked (5 blockers), one correction, approved. Features: implement 402/203/263s, review 286/262/229s; final review 288s. Wall 4348s, agent 4330s, gates 16.8s.
- No human approval step exists for an initial feature plan: `plan.approved` comes from the plan reviewer and building starts at once. My "pause for approval" assumption was wrong.
- Recovery path NOT exercised: final integration failed naturally (F1-SEEDED-SCRIPT proof rerun), but MAX_REPAIRS was the default 2, so repair-1 fixed it and the run finished.
- MAX_REPAIRS also caps feature-plan corrections (src/factory.mjs:614), so a run can't start with 0. Next run: POST /pause on `plan.approved` (parks after the current turn), restart :4205 with 0 while paused, resume.

## Smoke run 29924815 (smoke-cases-7) — failed in planning 01:23Z
- `plan_blocked` after 2 corrections. Blockers per round: 6 → 1 → 1. Round 3 blocked POPULATED-SUMMARY-SCRIPT for having no cases table; correction-1 had deliberately left it case-less (schema: cases optional, proof pending integration, failure path proved by SEEDED-SUMMARY-E2E) and review 2 accepted it. Reviewer variance plus a checklist line the controller doesn't enforce.
- Not resumed: assertPlanReviewable refuses an already-blocked plan digest, and slices.json is not hand-edited.
- Fix (next commit): PLAN_CHECKLIST case coverage applies only to requirements with a cases table; failure paths are needed somewhere in the plan, not duplicated.
- Finding for Lou: b86c07b's "step its action never performs" rule appeared verbatim as a round-1 blocker, so first drafts still miss checklist rules the planner was given. ≤4 planning turns depends on better first drafts, not more checklist lines.
- Next: re-review scoping (later rounds judge prior blockers, regressions and unrunnable proofs only). Stopping rule: if the next run with both fixes fails planning on another novel blocker, stop iterating prompts and leave Lou the blocker lists.

## Smoke run 3a3f59e8 (smoke-cases-8) — started on 18fba53
- Has the cases-optional fix, not re-review scoping (35d732a, committed after launch; the server loaded 18fba53).
- Watcher b9jz6ices POSTs pause on `plan.approved`. Then: restart :4205 with SOLOFACTORY_MAX_REPAIRS=0, resume, park on a gate failure (plant during the last feature review only if none occurs), POST recovery-plan, stop at ready, do NOT approve, measure.
- If it fails planning: the next run goes on HEAD with both fixes; the stopping rule applies to that run.
- 35d732a: later plan-review rounds get `priorBlockers` (accumulated) in plan-review-request.json and check those plus regressions/unrunnable proofs only. Suite 284/284.

## (Superseded) resume notes for the 3a3f59e8 smoke — done; see the CURRENT STATE section at the end
**Bottom line:** run 3a3f59e8 passed planning (8 turns incl. spec: plan, schema-fix, review 4 blockers → correction → review 1 new blocker → correction → approved 02:14Z). A pause was POSTed on approval; the run parks after its current turn (build-slice-SKELETON-STORE). Recovery path still not exercised.

State outside the repo (background tasks from the old context are NOT tracked after a clear):
- :4205 server runs from this worktree on 18fba53 code. Env: `PORT=4205 SOLOFACTORY_HOME=.solofactory/smoke-watchdog SOLOFACTORY_ROOT=.solofactory/smoke-watchdog SOLOFACTORY_PROGRESS_MINUTES=2` (repair budget default 2). Find its pid with `lsof -nP -iTCP:4205 -sTCP:LISTEN` (NOT `lsof -ti`, which once matched a Claude Helper).
- Run: `J=2026-10-12-3a3f59e8`, project dir `.solofactory/smoke-watchdog/projects/smoke-cases-8`, events `$P/.solofactory/runs/$J/events.jsonl`. State: `curl -s localhost:4205/api/jobs/$J`.
- Routes: POST `/api/jobs/$J/pause`, `/resume`, `/recovery-plan` (prepare repair plan), `/recovery-start` (= approve: NEVER call). `nextAction` in the job JSON names the next valid endpoint.

- **Update 02:25Z:** steps 1–2 done. Paused, :4205 restarted (pid via lsof) on HEAD code with SOLOFACTORY_MAX_REPAIRS=0, resumed into feature 1 review. Continue from step 3.

Next steps:
1. Wait until state is paused. Kill the :4205 server (pid from lsof above), restart it in the background with the same env plus `SOLOFACTORY_MAX_REPAIRS=0` (restarting on HEAD 35d732a code is fine; the plan is already approved).
2. POST `/resume`. Any gate failure now parks with nextAction prepare-plan.
3. If no failure by the last feature: plant a fault WHILE the last feature's review turn runs (tree committed, gates not started), in a file review won't read. Template: `.solofactory/smoke-watchdog/plant.sh` (paths are for old run a943a5da/smoke-cases-4; update R/EV; note the old plant was dead code after `process.exit`, so make the fault reachable, e.g. break an exported function the proof calls). Never plant during gates (stale-evidence park).
4. On park: POST `/recovery-plan`; wait for the repair plan to reach ready; do NOT approve. Browser-check the amendment file input on the ready plan (in-app browser, http://localhost:4205).
5. `node scripts/measure-run.mjs <events.jsonl>`; record results here; the release gate passes when the repair plan reaches ready.
6. Commit notes (specific files). Push only with Lou's permission (the last permission was used for a8b442b).

## Smoke run 3a3f59e8 — RELEASE-GATE RECOVERY SMOKE: repair plan READY 03:05:57Z (not approved)
**Result:** first real-provider run through the recovery path. Gate condition (a parked run's repair plan reaches ready) met, via the owner-amendment path. Plan c094c539 is ready and NOT approved; nextAction approve-plan.
- Sequence: paused on plan.approved → :4205 restarted on 35d732a code with SOLOFACTORY_MAX_REPAIRS=0 → resumed 02:25Z → F1, F2 reviewed clean, F3 gates passed, no natural failure → fault planted 02:46:30Z (`throw` after imports in scripts/populated-summary.mjs) during F3 review 1 → reviewer-changed-source recheck as expected → F3 review 2 caught it → parked `review_rejected`, nextAction prepare-plan (02:52Z).
- POST recovery-plan → repair plan 6e20928e (351s) → review 1 blocked once (valid: SUM-SCRIPT proof named a [SUM-SCRIPT-OK] test the objective forbade writing) → `plan_failed` after 0 corrections, because MAX_REPAIRS=0 also caps repair-plan corrections (artifact of the park setup).
- Amendment (Claude, under Lou's delegated authority): one-sentence objective change (also add that test), POSTed to /recovery-review → reviewed once → ready (c094c539).
- Browser check: on the ready plan the "Corrected plan file (.json)" input renders, accepts .json, enabled; its Submit button is disabled until a file is chosen. Not exercised: an actual file selection/submission through the page (submitted via API).
- UI nit, not fixed: on the ready plan the replace-plan explanation ("Replaces the ready plan with your corrected plan…") renders directly under the "Prepare repair plan" button, so it reads as that button's description.
- measure-run: wall 5839s, agent 5734s, gates 7.7s. Planning 8 turns / 2754s (spec, plan, schema-fix, 3 reviews 4→1→approve, 2 corrections; ran on 18fba53, without 35d732a). Implement 610/365/264s, review 285/316/422s (F3 incl. the planted-fault recheck). Repair planning 718s (plan, review, amendment review).
- Planning target ≤4 still missed; 35d732a (re-review scoping) is untested on a real run.
- Open for Lou: merge/release decision for wip/feature-slice-recovery (Claude never merges); whether an amendment-path ready counts, or a run with the default budget should reach ready through automatic corrections.

## CURRENT STATE — read this first after /clear (03:15Z 2026-10-12)
- Recovery smoke DONE: run 3a3f59e8 repair plan c094c539 is ready, NOT approved. Never call /recovery-start on it.
- :4205 still runs from this worktree (35d732a code, SOLOFACTORY_MAX_REPAIRS=0). Leave it or stop it (pid via `lsof -nP -iTCP:4205 -sTCP:LISTEN`); restart with the default budget before any new smoke.
- Waiting on Lou: (1) does an amendment-path ready satisfy the release gate, or run one more smoke with default budget that reaches ready via automatic corrections; (2) merge/release of wip/feature-slice-recovery (Claude never merges); (3) push of commits after a8b442b.
- Next dev work if Lou wants it: a real run on HEAD to test 35d732a (re-review scoping) against the ≤4 planning-turn target; stopping rule applies (another novel late-round blocker → stop iterating prompts, hand Lou the blocker lists). Optional UI nit: replace-plan explanation renders under "Prepare repair plan".
- 2026-10-12 03:20Z: Lou AFK until later today; delegated decision and approval authority until he returns ("keep working until I'm back"). Scheduled task solofactory-resume-after-reset fires 00:25 local (04:25Z); it reschedules itself after any further usage-limit stop. Interpreted as: decide and keep going; still never push/merge/PR, never approve recovery plans, never touch the photo library.
- 03:25Z check: suite 284/284 on 2dfb535; :4205 is NOT running (nothing to stop). 5-hour limit 91%, resets 04:20Z (resume task at 04:25Z is fine). **Weekly Fable is 99% until 2026-10-15 10:00Z**, and spec/plan-review/recovery-planning/feature-review/final-review route to fable. Decision (delegated authority): start the next smoke with `SOLOFACTORY_CLAUDE_REASONING_MODEL=opus SOLOFACTORY_CLAUDE_REASONING_EFFORT=medium` added to the :4205 env, so it runs at all. Caveat for the ≤4-turn comparison: reviewer model changed (fable/low → opus/medium), so a turn-count change is not attributable to 35d732a alone.
