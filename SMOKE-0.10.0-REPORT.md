# Real-provider smoke, 0.10.0 (e5f3571) — 2026-10-16

**Result: PASS.** Claude (Opus 5.5), isolated server :4206 from this worktree (:4173 untouched), brief `.solofactory/smoke/job-ordered.json` (Habit Ledger, deferred-proof ordering).

- Run 2026-10-16-b54d0f62: spec → plan (4 features) → build → completed, "Application is live and verified". ~15 min wall, $7.54 list, 14 agent turns, 0 repairs, 4/4 features, each reviewed once, 0 blockers.
- Deferred proof (FOUNDATION/FND-SEEDED-SCRIPT, pending integration) → passed; integrationVerified set; final review verdict pass.
- Independently re-run: `node scripts/populated-summary.mjs` exit 0; project `npm test` 43/43; deployed app served HTML.
- Home/project: `.solofactory/smoke-final` (gitignored). Server stopped.

## Follow-up runs (Lou: yes to failure paths and Codex; item 3 = no repair)

| Run | Provider | Result |
|---|---|---|
| 2026-10-16-86812e34 (MAX_REPAIRS=0) | Claude | Planning blocked: `plan_blocked` after 0 corrections. Dashboard showed "(1) needs you" title and "is stopped and needs you" banner (verified in browser). **Needs-you alert PASS.** |
| 2026-10-16-1fbe9c42 (MAX_REPAIRS=1, proof script faulted after feature 3) | Claude | Integration caught the planted fault, 1 repair removed it, run completed, live. **Repair path PASS.** $7.10. |
| 2026-10-16-98b89e59 (default repairs) | Codex | Spec, plan, 3/3 features built and verified; **final review parked the run** (`quality_gate_failed`, proof-BUG-1, 2 repairs spent). See below. |

### Codex finding (not a product defect, a factory gap)
The Codex final reviewer reported a PORT=80 bug and wrote repro `qa/port-80.test.mjs`. The test sets a `Host` header via Node `fetch`, which ignores it (forbidden header), so the app returned 403 for a request that never carried that Host. The repairer proved the app is correct with raw HTTP (canonical and explicit Host/Origin pass, foreign ones are 403) and said the test itself is wrong; budget ran out and the run parked. A reviewer-authored repro is trusted as ground truth even when it is the defective part.

### Item 3 (Fable routing): no repair
Intentional: c4a7c0e made Opus the reasoning default after Fable hit the subscription limit (smoke 10). Fable only applies if `SOLOFACTORY_CLAUDE_REASONING_MODEL=fable` is set.

### Fix made in this branch (committed locally as 61bcc44, not pushed)
- Reviewer prompt (`src/prompts.mjs`): repro tests must sanity-check their own harness (e.g. `node:http`, not `fetch`, to set Host).
- Owner waiver: when the repair budget is spent, "Waive BUG-n (faulty test)" next to "Prepare repair plan" (`POST /api/jobs/:id/waive-proof`) deletes that qa test, records the waiver and your reason as an owner decision for the reviewer, and allows one more final pass, then Resume. Test: `test/waive-proof.test.mjs`; `npm test` 366/366. Not yet exercised on a real parked run.

### Waiver tightening (also in the commit)
Reason required; the last repair turn's own words are shown beside the button; a completed run shows "Live · owner waived BUG-n"; planner and reviewer prompts treat a spec's older Node major as satisfied by the controller's newer Node.

### Second Codex run (2026-10-16-df6500ce, fresh home `.solofactory/smoke-codex2`, with the prompt fix)
Parked differently: no reviewer test this time. A planned proof, `F1.F1-METRICS` case METRICS-PRIVATE (AC14: metrics must leak no sentinel/IDs/paths, bounded route vocabulary), failed after 3 attempts at feature-1 integration (`quality_gate_failed`, budget exhausted). METRICS-HTTP and METRICS-SCHEMA pass. **Diagnosed:** feature F1's own test (`scripts/metrics.test.mjs:29`) asserts 404 for the completion route; later feature F2 legitimately changed it to 303. F1's proof reruns during F2's checks, F2 may not edit F1's test (writes gate), and the repairer said so and stopped. The app is right; two features' tests disagree and nothing can reconcile them. Not the waiver's case. So Codex is 0 for 2 on this brief, with two different causes. The waiver does not apply (not a BUG proof).

### Third Codex run (2026-10-17-85f24773, port 4210, with all fixes)
Stopped at 2 of the features built, 0 repairs, by `usage_limit` ("Subscription usage is unavailable"): the Codex subscription limit, not a product defect. It verifies nothing about the planner/reviewer fixes yet. Parked run is resumable in `.solofactory/smoke-codex3` once the limit resets (start the server there with PORT=4210 and Resume).

## For Lou in the morning
1. **Review** the waiver + prompt fix (files: `src/factory.mjs`, `src/server.mjs`, `public/app.js`, `src/prompts.mjs`, `test/waive-proof.test.mjs`, this report). Committed locally, not pushed.
2. **Resume the third Codex run after the Codex limit resets**; it is the only check of the planner fix. **Codex is 0/2 so far** on the Habit Ledger brief (run 1: faulty reviewer test; run 2: an earlier feature's test contradicts a later feature's required behavior). Claude is 3/3. Run 2 needs a gate-semantics decision: let a repairing feature update an earlier feature's proof test when the plan requires the changed behavior.
3. **Node 24 vs host Node 26.5:** prompt-level fix made (older pinned major is satisfied); unverified on a real run.
4. `MAX_REPAIRS=0` also zeroes plan corrections, so it cannot force a build-stage failure.
5. Servers stopped; smoke homes under `.solofactory/` are gitignored.
