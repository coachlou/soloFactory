# Member run-log analysis: job-match-prototype (Claude run)

Sources: the member's `claude-original-run/` (`events.jsonl`, 1022 events; `state.json`; `requirements.json`; `slices.json`; recovery plan; PRD/PLAN/ACCEPTANCE), the `sandbox-antigravity-run/` set and `SOLOFACTORY-ANTIGRAVITY-INTEGRATION.md`. No `.factory/logs/` or `last-failure-*.txt` were supplied. All times UTC.

## Bottom line

The budget went to **recovery from a factory bug, not to reviewer blockers**. No feature review ever ran (zero `review.*` events); the only reviewer blocker in the whole run was one plan-review item (MH-1/SC-21), fixed in one correction round. The run died on a proof gate that failed three times with every test case passed: Node 22.22.1 on the member's WSL box crashes with `EINVAL fsync` when soloFactory 0.10.1 points the case reporter at `/dev/null`. Two repairs could not fix it (the launcher is outside the worker's writes), the owner approved a recovery, and that recovery re-planned all 25 features and rebuilt 10 of them before the third weekly-usage hit ended the run with zero features ever committed.

| phase | workers | min | input tok | output tok | $ (logged) |
|---|---|---|---|---|---|
| specification | 1 | 3.8 | 0.26M | 17K | 1.04 |
| feature plan + review + correction | 4 | 24.1 | 5.76M | 125K | 10.09 |
| CORE build (after resume) | 1 | 3.4 | 1.40M | 18K | 1.93 |
| CORE repairs ×2 | 2 | 9.3 | 2.64M | 35K | 3.18 |
| **recovery plan + review + correction** | 4 | 31.8 | 14.9M | 149K | **16.06** |
| **recovery rebuild (CORE … JOBROOM, 10 features)** | 10 | 53.7 | 17.1M | 269K | **21.63** |
| total logged | 22 | 126 | 42.0M | 614K | 53.93 |

Plus 3 workers killed by usage limits (≈25 min, usage not recorded): build-slice-CORE 11-02 17:32, recovery SCORE 11-03 07:41, recovery MAILBOX 11-03 12:47.

Recovery = 70% of logged spend and 68% of worker time. Largest single workers: recovery-plan $6.22 (5.7M input, 15 min), feature-plan $5.94 (18.7 min), JOBROOM rebuild $5.67 (12.8 min), recovery-correction $5.51 (10 min).

The fix for the crash (commit 17cba54, "Stop cased gates crashing on Linux after every test passed") landed 2026-11-03 03:25Z and shipped in v0.10.2 at 03:37Z. The gate failed 11-02 21:46 to 21:56Z; recovery planning started 11-03 06:50Z. The logs do not record the factory version or when the AIMM install channel published 0.10.2, so whether she could have updated in that window is not determinable from these files. Everything after 21:56Z on 11-02 ($38 of $54) was spent recovering from a defect that v0.10.2 both fixes and, had it recurred, would have classified as `gate_infrastructure` with no repair turn.

## Ranked causes, with evidence

1. **Factory environment bug turned a passing proof into a hard failure.** `gate.failed proof-CORE-METRICS` ×3 (21:46:52, 21:51:17, 21:56:11), each with `cases: {passed: 4}`. Gate output tail: `pass 4 fail 0` followed by `Error: EINVAL: invalid argument, fsync … Node.js v22.22.1`. v0.10.1 `src/factory.mjs:1485` passes `--test-reporter-destination=/dev/null`; Node 22 fsyncs the destination on close and Linux refuses fsync on `/dev/null`. The repair worker diagnosed it correctly on attempt 2 ("controller-side fix … I'm not permitted to install a patched Node", "no code changes this round"). v0.10.1 treats `exit ≠ 0` as a failed check even when every declared case passed. 17cba54 (v0.10.2) adds `runnerCrash()`: all cases passed + runner stack entirely in `node:` frames → `gate_infrastructure`, "Update SoloFactory or Node.js, then Resume", no repair, no recovery.

2. **Recovery re-planned the whole run for one gate.** `recoveryPhase.request.scope` is `null`. In `src/feature-recovery.mjs` the one-feature scope is only set when `executed` is true, i.e. when a *prior recovery phase* ran; a gate failure in the ordinary build gets the unscoped "plan everything" prompt. Result: a 253KB recovery plan, 25 slices, 19 entries differing from the prior plan, `totalRepairLimit` 54, and a review round with 6 blockers (CORE-FSYNC "does not address the finding", C-FSYNC-GATE "spawns a command the controller never runs", C-FSYNC-PIPE unobservable, route ownership of `src/web/server.js`, PIPELINE loader path, DECISIONS→ARCHIVE dependency). Cost: $16 and 32 min before any code was written.

3. **Recovery rebuild in batch mode never re-tested anything.** 25 slices ≥ `batchRepairsFrom` 10, so the rebuild skipped gates between features (`buildOnly: batch`). Ten features ($21.63, 54 min) were built with no `gate.*` event between them; the fsync bug would have resurfaced only at the end. Nothing was verified before the third usage hit.

4. **Weekly usage limit as the stop condition.** Three `usage_limit` kills; each resume re-ran the interrupted stage (build-slice-CORE resumed 4h11m later, SCORE 4h10m later as a `-resume` stage). The factory records no usage for killed workers, so the true spend is above $54.

5. **Planner scope inflation (secondary).** `slices.json` compatibility declares zero npm dependencies because "the sandbox permits no network, install or probe command", so the plan reimplements HTTP routing, IMAP over `node:tls`, MIME, HTML-to-text, PDF writing and language detection on Node core. 25 features for 22 MH + 26 SC. Six features (CORE, FILTER, DEDUP, ADPAGE, PLATFORM, DURABILITY) close no check. This made each build and plan turn larger but did not cause the failure.

6. **Planning itself was cheap and clean.** One plan blocker only (plan-review-1: MH-1/SC-21 "12:30 CET half never proved; zone CET/CEST never pinned"), fixed in one correction, approved on review 2. $10, 24 min.

## Corrections to `notes/prd-audit-job-match-prototype.md`

| audit claim | verdict | evidence |
|---|---|---|
| Scope line: "Factory v0.10.3" | **refuted for the Claude run** | run created 11-02 17:00Z, before v0.10.2 (tagged 11-03 03:37Z) or v0.10.3 (05:31Z) existed; the `/dev/null` reporter destination is v0.10.1 and earlier. Her later sandbox install may be 0.10.3. |
| Bottom line: "looped on requirements that cannot be true on the machine" | **refuted** | no feature review ever ran; one plan-review blocker (MH-1/SC-21) in total; the loop was gate→repair→recovery on an environment crash. |
| F1: `agy.exe`/Antigravity as hard dependency drove the cost | **refuted** | the interview replaced it: constraint "All generation … must run on the owner's Google/Gemini account via a Gemini API key from Google AI Studio, not on Claude or Codex." No `agy`/`antigravity` in PRD.md, PLAN.md, ACCEPTANCE.md, slices.json or the brief. The Antigravity sandbox run used a *different* PRD (12 MH, 6 SC, names "Antigravity CLI") and a member-patched factory with a third provider. |
| F2: Windows artefacts asserted as outcomes → blocked every review | **unresolved** | MH-17 (notification), MH-22 (uninstall), `D:\Job-search-assistenz\…` paths are in the frozen brief; the planner routed them through a PLATFORM adapter feature. Never reached a review, so no blocker evidence either way. |
| F3: 52 checks × repair budget, `totalRepairLimit` refill | **partly confirmed** | 25 features, 48 checks, `totalRepairLimit` 54 after one approval. But the spend came from the unscoped re-plan and batch rebuild, not from per-feature repairs (only 2 ran). |
| F3: recovery prompts "grow toward the 200K cap" | **refuted** | max `promptChars` 19,252 (prompts are file pointers). The cost is real but the mechanism is token reading: the recovery-plan worker consumed 5.7M input tokens reading the 253KB request plus repo. |
| F4: live Job-Room/Gmail/ad-page checks blocked | **unresolved** | planner used fixtures and adapters; never reviewed. |
| F5: 12:30 CET wall-clock proofs cost turns | **confirmed, minor** | the single plan blocker; one correction round (~$2.5). |
| F6: hard-coded `D:\…` paths | **unresolved** | present in MHs; planner mapped to `data/`; never reviewed. |
| F7 digest formats, F8 fuzzy scoring | **unresolved** | never reached build or review. |
| F9: oversized prompt park | **refuted** | see F3 above. |
| "Not determinable": interview rewrote §9? | **resolved** | yes: 22 MH + 26 SC (from 23 + 29), Antigravity removed, Gemini API key added. |
| "Not determinable": OS, features, approvals, overrides | **resolved** | WSL Ubuntu (`/home/eliza`, `/mnt/d`), Node 22.22.1; 25 features; 1 recovery approval; no sign of `SOLOFACTORY_MAX_REPAIRS` override (maxRepairs 2 observed); 3 usage-limit parks. |
| Permission denials, hook/plugin/MCP noise | **none** | zero matches for permission/denied/hook/plugin/mcp in 1022 events. |
| "Why Antigravity succeeded: same PRD" | **refuted** | different PRD, different factory build, Gemini provider; 33 workers, 5h28m, 2 repairs, 3 review bugs, completed. |

## Single highest-leverage fix

**Get the member onto v0.10.2 or later before she resumes anything.** v0.10.2 fixes the `/dev/null` destination (runs in the job folder) and adds `runnerCrash()`, which turns "all cases passed, Node crashed afterwards" into `gate_infrastructure` with no repair turn and no recovery. On that version this run would have stopped at 21:46Z on 11-02 with a one-line owner message instead of spending $38 and three usage windows.

Fixed (replanForGate now scopes a first-time gate failure to the feature in `featureCursor`; the sentence below describes the old behaviour): **a gate failure in the ordinary build gets an unscoped recovery.** `request.scope` (plan one feature, keep the rest) is only set when `executed` is true, i.e. after a prior recovery phase ran (`src/feature-recovery.mjs`, `replanForGate`). A first-time gate failure re-plans every feature and, at ≥10 slices, rebuilds them in batch mode with no gates between features. Scoping the first recovery to the failed feature would have made it one worker, not four plus a 10-feature rebuild.

A PRD rewrite would not have changed this run's outcome. The scope cuts in the PRD audit (Finding 3) remain good advice for cost per turn, not for the failure.

## Antigravity run, for comparison

Member-modified soloFactory (third provider `agy.exe` via WSL UNC paths, gemini-3.8-flash-high, stream-json), 12-MH PRD. 33 workers over 5h28m; 10.5M input / 143.4M cached / 1.62M output tokens; 1 plan blocker, 1 declared-writes gate failure, 1 review block with 3 bugs, 2 repairs; `job.completed Working app: http://127.0.0.1:46821`. Its proof gates ran under the member's patched factory, so whether it hit the same fsync path is not visible in its events.
