# Flag to skip the per-feature review: analysis

Repo-only note (notes/ does not ship). Written 2026-11-09 against main at 4f50e95. Analysis only: no code changed.

## Bottom line

**Superseded: build the risk-gated review instead (see "Revised design" below).** Built on main in 0076a5a and 80eab87 (`SOLOFACTORY_FEATURE_REVIEW=risky`, default `all`). Two departures from the sketch below: a feature that closes a check no case cites also counts as risky, and the ledger adds an "Unattributed findings" column. The original call
for the plain flag follows.

**Build it. Keep it off by default. Do not decide on smoke savings alone.**

- The flag is small: about 10 lines of code, one new dev-only setting, and two tests.
- The saving is real. On the two smoke runs we can measure, per-feature review cost **23% and 29% of the
  run's dollars** and 17% and 20% of agent time. On the 19-hour medialibrary run it was 14% of agent time.
- But on every smoke run we have, the per-feature review **blocked nothing**. So today's smoke set can
  show what the flag saves, but it cannot show what it costs in missed defects. Measuring that needs a
  third signal (see "Decision criteria").
- One coupling must ship with the flag, or the flag quietly removes *both* reviews. Today the final
  review is told "every feature already passed its scoped review, do not re-audit obligations". With the
  flag on that is false, so the final review must switch back to a full audit.

## Revised design: risk-gated review (supersedes the plain flag)

Added 2026-11-09 after a Fable audit of a middle-ground proposal. It keeps the scoped review where it
earns its cost and skips it elsewhere. It avoids both extremes: piling every check into the final
review, and reviewing every feature.

**Rules**

1. **Review risky features always.** A feature is risky if any of these hold. All are read from data
   already present at the checking → reviewing step (`factory.mjs` ~956):
   - a requirement with no test cases: `runnable.some(i => !i.cases?.length)`. The scoped review is
     the only check on these.
   - a browser case: `cases[].surface === "browser"` (schema `prompts.mjs` 405).
   - it edited an earlier feature's tests: `cursor.brokenProofs?.length`. The writes check rejects that
     edit unless the test is in `brokenProofs` (`factory.mjs` ~1417, ~1428), so the signal is reliable.
2. **Skip the scoped review for everything else.** The builder still works against `REVIEW_BAR`.
3. **The final review fully audits only unreviewed features.** Reviewed features keep the narrow
   `FEATURE_REVIEWED_SCOPE`. The unreviewed list is derived, with no new state: `reviews === 0` in
   `job.sliceStats`, plus batched-recovery stats (`feature-recovery.mjs` 603). This also closes the
   batched-recovery gap below.

**Dropped after the audit**

- *"Review until 2 clean in a row, then skip."* Once reviews were off, only a failed check could turn
  them back on. But the defects the scoped review exists for (tests that assert too little, stand-in
  results) pass the checks by definition, so the skip could never be proven wrong. On clean smoke
  briefs it turns into "skip after feature 2". It also needs a saved counter that a restart rewind
  (`factory.mjs` 176–189) would have to reset.
- *Free-text risk signals* (exact messages, "recovered/preserved/rejected"). These need a regex over
  planner wording, which misses rephrasings ("still there", "returns 409"). Add later as a
  `ponytail:` heuristic only if the ledger shows misses there.

**Hazards checked and cleared:**
- Features build one at a time, so there is no ordering issue.
- A resume after a skip is safe, because the committing step rechecks the candidate.
- Recovery (`scope.cursor`) is untouched.
- `review_unstable` and `reviewRepairsGranted` only apply to reviewed features.

**Remaining risk:** a skipped low-risk feature can still have weak tests. The final review catches them
later, with a repair budget of 2, after later features have been built on top.

**Sketch (~25 lines plus tests)**

- Setting `SOLOFACTORY_FEATURE_REVIEW=all|risky` (default `all`), persisted on the job at creation.
  Add it to `scripts/internal-env.txt`.
- `factory.mjs` ~956: `const review = scope.cursor || job.featureReview !== "risky" || uncased ||
  browser || cursor.brokenProofs?.length; await save(review ? "reviewing" : "committing");` and emit
  `review.skipped`.
- `factory.mjs` 487/495: compute `unreviewed`, pass it to `prepareReview` and to
  `reviewPrompt({ unreviewed })`.
- `prompts.mjs` 317–339: `FEATURE_REVIEWED_SCOPE` takes an exception list ("audit these features'
  obligations from scratch").
- `measure.mjs` ~141: `reviewsRun`, `reviewsSkipped`, and `skippedFindings` (the `review.bug` events
  on features with `reviews === 0`).
- Fixture tests:
  - a low-risk feature commits with no `feature-review-*` turn;
  - a browser-case feature still reviews;
  - the final prompt names the skipped ids;
  - the batched-recovery final prompt names its features.

**Decision signal from the ledger:** run `risky` against `all` on the same briefs. If
`skippedFindings` stays near zero and cost per feature drops by ≥15%, make `risky` the default.

## 1. What the change implies

### Code paths

| Where | Today | With the flag on |
|---|---|---|
| `server.mjs` (beside `SOLOFACTORY_MAX_REPAIRS`, ~line 87) | — | Read `SOLOFACTORY_FEATURE_REVIEW=off`; pass `featureReview: false` to the factory. |
| Job creation | — | Persist `job.featureReview = "off"` on the job, so resume and the ledger row see the value the run started with. A server restart with a different env must not flip a run half-way. |
| `proveFeature`, `checking` substage (`factory.mjs` ~957) | `save("reviewing")` | `save(skip ? "committing" : "reviewing")`, where `skip = job.featureReview === "off" && !scope.cursor`. The `committing` substage already rechecks that the candidate is unchanged before it commits, so nothing else in the loop moves. |
| `reviewAndVerify` (`factory.mjs` 495) | `reviewPrompt({ featureReviewed: job.planVersion === 2 })` | `featureReviewed: job.planVersion === 2 && job.featureReview !== "off"`, so the final review does the full audit. **This is the line that makes or breaks the flag.** |
| `prompts.mjs` | Unchanged. `REVIEW_BAR` stays in the builder and repair prompts, which is the whole hedge. | Unchanged. |
| `measure.mjs` `summarizeRun` | Row has no review data. | Add `featureReview`, `reviewBlocks` (scoped and final, split), `qaBugs` and `reviewMin`. Without these the ledger cannot answer the question. |

Scope: main build loop only (`!scope.cursor`). Repair features in feature recovery keep their scoped
review. That keeps the A/B clean and leaves the recovery path, which is the riskiest code, untouched.

### Existing gap found along the way (not caused by the flag)

Batched recovery (10+ repair features, `buildOnly`) already skips the scoped review, by Lou's choice on
2026-10-16. But its final review still gets the narrowed "features were already reviewed" scope, because
the test is only `planVersion === 2`. So today a batched repair plan gets **no obligation-level review at
all**. The same one-line condition fixes both: narrow the final scope only when every feature was really
reviewed (for example, no `phase.stats[id].batched` and no `featureReview: "off"`). Worth fixing on its own,
whatever we decide about the flag.

### State

- One new job field, `featureReview`. No cursor changes: with the flag on, a feature's cursor goes
  `implementing → checking → committing → verified` and simply never enters `reviewing` or `repairing`.
- `sliceStats[id].reviews` reads 0, which is accurate.
- Pause/resume: unchanged. The cursor substage is persisted as before, and the job field is fixed at creation.

### Gates

What still runs per feature with the flag on:
- build;
- the feature's own proof commands;
- the proofs of earlier features its changes can reach;
- every case must have its own `[CASE-ID]` test that passed (`caseResults`);
- the writes check and the broken-earlier-proof check.

What moves to the end: the judgment of whether each test actually asserts what its case says. Release QA
already turns findings into failing `qa/` tests and routes each one to the feature that owns the files
(`repairFindings`), much as scrappy turns blockers into fix features.

### Recovery and bounded repairs

- **Feature-level repair budget is used less.** Each feature gets `maxRepairs` (2), and review blocks
  could also claim the extra `reviewRepairsGranted` allowance. With the flag on, only gate failures use it.
- **Final repair budget gets more pressure.** It is `maxRepairs` (2) after the final review, sized for
  integration findings. With the flag on, every defect the scoped reviews would have caught lands there
  at once. On medialibrary that would have been up to 46 blocks. Expect more parks at the final review on
  big apps. Those parks then go to the repair plan (feature recovery), which is the expensive path the
  harvest is trying to avoid.
- **Set-aside changes.** `setAside` fires on `review_rejected` and `review_unstable`. With no scoped
  review, a weak feature is never set aside. It is committed, and later features build on it.
- **Final review time cap.** A full audit of 15+ features is longer than today's scoped final review.
  On medialibrary a final review used 44 of its 45 minutes before `463b3c2`. One continuation is
  allowed (`allowContinuation`), but this is a real timeout risk on big apps.

### Docs

- `build-distro.sh --check` fails on any `SOLOFACTORY_*` setting that is not in the manual or in
  `scripts/internal-env.txt`. Add `SOLOFACTORY_FEATURE_REVIEW` to `internal-env.txt` (dev and smoke only,
  not for owners). The manual (`docs/`, which ships) is untouched.
- `DEVELOPING.md` (does not ship): one line in the smoke section showing the arm, e.g.
  `SMOKE_ARM="no feature review" SOLOFACTORY_FEATURE_REVIEW=off node scripts/smoke.mjs`.
- The release that carries it needs its `- Docs:` PROGRESS bullet: "none for owners; dev-only flag".
- If it ever becomes the default, that is an owner-visible change (the activity feed loses the
  "Reviewing feature N" step), and the manual and member letter change then, not now.

## 2. How a feature-mode run flows

**Today (flag off), per feature:**

1. Precheck: recovery features only.
2. Build turn: the builder sees `REVIEW_BAR`, owner decisions and the "uncased checks are judged against
   real behavior" rule.
3. Checking: build, then this feature's proofs, then reached earlier proofs. A failure means a repair and
   another check, within the feature's budget of 2.
4. Scoped review turn: opens each case's test and checks it against the case text, clause by clause, and
   judges uncased checks directly. A block means a repair, then checking, then another review. The
   review limit is `maxRepairs + 2`; past it the run gets `review_unstable` and the feature is set aside
   or the run parks.
5. Commit `factory: feature X verified`.

**After all features:**

6. Integration verify (whole suite).
7. Final review, *narrowed*: integration, deploy readiness and edited proofs. It is told not to re-audit
   obligations.
8. Bugs become `qa/` tests routed to their owners and repaired (budget 2). Re-verify, re-review.
9. Deploy.

**With the flag on, per feature:**

1. Precheck: unchanged.
2. Build turn: unchanged.
3. Checking: unchanged.
4. *(no review turn)*
5. Commit.

**After all features:**

6. Integration verify: unchanged.
7. Final review, *full audit*: every obligation against its case text, plus integration and deploy.
8. Bugs become `qa/` tests and repairs: unchanged, but expect more of them.
9. Deploy.

In short, the flag swaps N small reviews, each run while the feature's context is fresh, for one bigger
review at the end.

## 3. Benefits, quantified

Per-feature review share, from the event logs:

| Run | Features | Scoped review | Final review | Whole run | Scoped review share | Scoped blocks |
|---|---|---|---|---|---|---|
| Habit Ledger `abf84219` | 3 | 3 turns, 2.3 min, $1.00 | 0.8 min, $0.33 | 13.2 min, $4.41 | 23% $, 17% time | 0 |
| Voice Notes `e063f3f8` | 6 | 6 turns, 4.2 min, $1.61 | 1.1 min, $0.44 | 20.9 min, $5.59 | 29% $, 20% time | 0 |
| Household Inventory `b064615a` | 15 | run dir not found locally | — | 30 min, $11.38 | n/a | n/a (1 repair, cause unknown) |
| Medialibrary `4f2dd1cf` (wip) | 10 → 30 | 2.74 h | 1.06 h | 19.06 h | 14% time | most of 46 blocked reviews |

**Net saving estimate.** The gross saving is about 25% of dollars on small apps. The full-audit final
review gives some of that back. Today's final review costs $0.33–0.44; guess 2–3× that for a full audit,
so +$0.40–0.90 per run. Net is roughly **15–20% of dollars and 3–4 minutes of wall time** on small and
mid-size briefs. That is a guess until the ledger has rows.

**Is it worth it?**
- On small, clean apps, yes: the scoped review blocked nothing on any smoke run, so it was pure cost there.
- On big, messy apps, unknown and probably not. On medialibrary most of the 46 blocks were real
  under-asserting proofs, caught while the builder's context was fresh and before later features built
  on them. Moving them to the end costs more repair turns, more parks and maybe re-planning, which is
  where 3.57 h of that run went. A 14% saving there is easily eaten by one extra recovery cycle.

## 4. Effect on the SDLC workflow, and why do it (or not)

**What changes:** the SDLC goes from "prove and review each feature, then a narrow release check" to
"prove each feature, then one full release review". That is scrappy's shape, reached with one flag instead
of scrappy's rewrite.

**What does not change:** proof gates, the writes check, case tests, release QA bug routing, the repair
plan path. The builder already gets the reviewer's bar (`REVIEW_BAR`), which was hedge #1 in the
wip-vs-scrappy report. So most of the hedge is in place.

**Why do it:**
- Cheap to build and cheap to remove.
- It turns a design argument into ledger rows.
- If `REVIEW_BAR` in the builder prompt has really moved the catches up-stream (build time), this is the
  cleanest proof of it. That is the upstream-over-downstream rule at work: the review exists to catch
  what the builder should never produce.

**Why not to switch it on by default yet:**
- The evidence for the review's value (medialibrary) is from the biggest, hardest brief.
- The evidence against it (smoke) is from small ones.
- Defaulting to "off" on small-app data would remove the gate exactly where it earned its keep.

## Defect classes only the scoped review catches today

Proof gates check that tests **pass**. Only a reviewer checks that they **prove the case**. These are
covered by the scoped review alone, until a full-audit final review sees them late:

1. **A test that passes but under-asserts its case.** It drops a clause, fixture or step, or checks loose
   message wording. Example: VIEWER-012, whose test was missing its recovered-preview assertion. Most of
   medialibrary's 46 blocks were this class.
2. **A stand-in result.** The test checks a job status, a counter or a version bump instead of the
   observable outcome the case names (the preview actually loads).
3. **Inputs that cannot expose the defect.** For example, an orientation fixture with no visible
   orientation, or a rejection proof that never checks the prior state.
4. **Uncased checks.** Requirements with no `[CASE-ID]` tests are judged against real behavior only by a
   reviewer; no gate touches them.
5. **Browser steps that do not act like a user.** No waits, invisible controls, or synthetic events
   instead of real input.
6. **Source-string assertions and faked or skipped checks** that still exit 0.

Not lost with the flag: weakened edits to earlier features' proofs. The final review's
`EDITED_PROOFS_RULE` applies in both scopes.

The cost of catching late is not just the review turn. A defect caught late may have later features built
on top of it, and its repair lands on the final budget of 2 instead of the feature's own.

## Recommendation and decision criteria

**Build it, default off.** Switch to default on only when all of these hold across paired runs (same
commit, flag off vs on, at least 2 runs per brief per arm, because one run is a tripwire, not a
measurement):

1. **Savings:** median `costPerFeature` drops at least 15% on household-inventory, and wall time does not rise.
2. **Same outcome:** every ON run passes wherever its OFF pair passed, with no new parks at the final
   review and no final review needing more than its one continuation.
3. **Catch rate, the hard one.** Today's briefs give the OFF arm nothing to catch, so add one of these:
   - **(a) A brief that reliably produces scoped-review blocks** (preferred). A mid-size brief with
     exact-wording messages, recovered or prior-state cases and a browser flow: the classes medialibrary
     tripped on. The OFF arm must show at least 2 scoped blocks for the comparison to count.
   - **(b) An experiment-only post-hoc audit of each ON run.** After the run completes, run one scoped
     review per feature against the final tree. Charge it to the experiment, not to the arm. Every
     blocker it finds is a defect the ON arm shipped.
   - **(c) Lou's manual check.** Lou checks the ON-arm app against the OFF arm's `REVIEW.md` blocker list.

   The ON arm passes only if its final review (as `qaBugs` or blocks) caught at least as many defects as
   the OFF arm's scoped review did, in the same classes. Rule (b) or (c) must find zero shipped defects of
   classes 1–4 above.
4. **No set-aside or recovery regressions:** no ON run enters feature recovery where its OFF pair did not.

If 1 holds but 3 fails, keep the scoped review and try the cheaper middle ground instead: a light scoped
review only for features with uncased checks or browser cases (hedge #2 in the wip-vs-scrappy report).

## Smallest implementation sketch

- **Setting:** env `SOLOFACTORY_FEATURE_REVIEW=off`, read in `server.mjs` like `SOLOFACTORY_MAX_REPAIRS`,
  passed as a factory constructor option and persisted on the job at creation (`job.featureReview`).
  Listed in `scripts/internal-env.txt`. Not a brief or job option, so members cannot reach it.
- **Call sites:**
  1. `proveFeature` checking substage: skip to `committing`.
  2. `reviewAndVerify`: `featureReviewed` false when the flag is off (and, separately, when batched
     recovery skipped reviews).
  3. `summarizeRun` and `formatSmokeTable`: new review columns.
- **Tests (fixture provider, free):**
  1. Flag on: no `feature-review-*` turn starts, each feature commits, and the final review prompt does
     *not* contain the "already passed its own proofs and scoped review" text.
  2. Flag on, pause during `checking` and resume: still no review turn (the persisted flag wins over the env).
  3. `summarizeRun` counts scoped vs final review blocks and `review.bug` events.

  Flag off is covered by the existing suite.
- **Then:** smoke, flag off vs on, per the criteria above. Paid runs, so they need Lou's OK.

## Open data gap

The household-inventory run directory (`2026-11-09-b064615a`) was not found under `.solofactory/smoke-runs/`
or nearby checkouts. Its one repair could have been a scoped-review block, the only mid-size data point we
have. If the run home still exists somewhere, `node scripts/smoke.mjs summarize <run dir>` plus a look at
its `gate.failed` events with `gate: "review"` would settle it.
