# wip vs scrappy: which should succeed main

*2026-10-15. Analysis only. Nothing is merged, pushed or changed.*

## Bottom line

- **Build the successor from scrappy's skeleton and carry wip's bug fixes onto it.** Scrappy drops the parts of the workflow that used most of the agent hours. Over the last 3 days, wip found real bugs that scrappy still has.
- **This verdict is a design inference, not a measurement.** Scrappy has only run on a tip calculator: 17 minutes and 8 turns. Its claim of "saves about 10 of 19 hours" applies scrappy's design to wip's own run 4f2dd1cf. Scrappy has never built a large app.
- **Order of work:**
  1. Finish the media-library run on wip, as you already decided.
  2. Build the merged branch in its own worktree.
  3. Have Codex build the media-library brief from scratch on it. That run is the release gate.

## Where wip's time actually goes

The pain in the live run falls into three buckets. Scrappy only fixes the first.

| Bucket | Evidence | Does scrappy fix it? |
|---|---|---|
| **1. Workflow design** | Run 4f2dd1cf used 19.06 agent hours. Only 8.26 h went to building. The rest went to:<br>• 2.74 h of per-feature reviews<br>• 3.57 h of recovery planning<br>• 3.29 h of repairs<br>• 1.06 h of whole-run reviews<br>Separately, 76% of proof minutes were regression reruns. The plan grew 10 → 30 features. Every re-plan went back through planner review. | **Yes.** Scrappy has no per-feature review, no recovery re-planning and no regression reruns between levels. Each level runs only its own tests. |
| **2. Factory bugs, now fixed on wip** | • Case events truncated (f1381f3)<br>• Writes too narrow (3bc24b4)<br>• closedChecks dropped (11a84b4, 744cdea)<br>• 39 MB job poll (cfd6873)<br>Each of these used up repair budget and forced you to raise the budget limit. | **No.** Scrappy still has the first two bugs (see below). |
| **3. Provider limits** | • Codex usage-limit parks every 4–5 h<br>• 6-minute idle timeouts<br>This is the biggest wall-clock cost: about 5.5 h of agent time vs about 36 min of proofs today. | **Neither workflow fixes this.** It costs the same on both. |

So wip at its current commit is cheaper than run 4f2dd1cf's numbers suggest, because bucket 2 is gone. Scrappy's advantage is bucket 1. That bucket is still about half of a run's agent hours.

**Wall clock:** both are bound by provider limits. Scrappy runs fewer turns, so it hits the limit later and less often. But a big app will still park on Codex resets.

**Feature count:** scrappy's cap is 8 phases × 6 features = 48, compared with wip's 30. Scrappy saves overhead per feature. It does not reduce the number of features.

## The tradeoff scrappy makes

Dropping per-feature review is a bet, not a free saving. On wip, per-feature review caught real defects. For example, VIEWER-012 had a test missing the recovered-preview assertion. Scrappy bets that one owner-triggered release review catches the same defects later, at lower total cost. Each blocker it finds becomes one P0-RF fix feature, with at most 2 rounds.

That bet is proven on a tip calculator, where it found a real rounding bug and closed it. It is not proven on a 30-feature app. The release gate below is what tests it.

## Port list

### wip → scrappy (needed)

| Commit | Why scrappy needs it | Verified at scrappy 516c843 |
|---|---|---|
| **f1381f3**: case reporter appends via `SOLOFACTORY_CASE_EVENTS` | Scrappy's gate still uses `--test-reporter-destination` through NODE_OPTIONS (`src/gate.mjs:193`). Any proof test that starts its own node:test process will wipe the case events and fail a green run with "no test events". | Bug present |
| **3bc24b4**: writes widen to existing source files | Scrappy's writes gate says "the plan's file lists are fixed during a build" (`src/gate.mjs:99`). That is exactly what caused the VIEWER-DATES loop. The planner instruction to list every needed file should come too. | Bug present |
| **872b761** (diagnostics half only): name the never-run cases | Cheap, and it saved real debugging time. Leave out the review-repair allowance, because scrappy has no per-feature review. | Port the diagnostics only |
| **b3ee8e8, 9436cf7**: dashboard scope labels | Only if scrappy's dashboard shows the same counters. Check during the port. | Check |

### wip → scrappy (not needed)

- **c79dec6, 2dd45e4, 11a84b4, 744cdea:** these fix the planning and re-planning path that scrappy deleted.
- **cfd6873:** scrappy has no `recoveryPhaseHistory`. Keep the rule behind it, though: a polled GET must never return unbounded history. Add a size check to the job response test.

### scrappy → wip

None worth doing. Scrappy's value is in what it removes. Porting those removals into wip one at a time would just rebuild scrappy, with more conflicts.

### New work for the merged branch

These come from the approved post-run list and from known gaps:

1. **Show builders the reviewer's checklist up front.** In scrappy, this means the release reviewer's must-haves. The aim is that per-feature defects get caught at build time without paying for a review turn. This is the main hedge on the tradeoff above.
2. **Retry a malformed release review once before parking.** Today scrappy parks immediately.
3. **Classify Codex 503 errors as transient,** not as failures.
4. **Concurrent proof gates in sandboxes per proof** (already approved).
5. **In-flight jobs:** no migration. Jobs in the old format finish on the old build. State this in the release notes.

## Merged version, in one paragraph

Take scrappy-pipeline at 516c843 as it stands:

- **Documents:** three of them (spec, architecture, phased PRD).
- **Feature level:** 1 build turn plus up to 2 continuations. It runs only its own tests.
- **Phase level:** one integration turn, then an automatic push.
- **Release:** owner-triggered. Blockers become fix features, with 2 rounds before the run parks.
- **Quick-fix lane and park card** as built.
- **Port from wip:** f1381f3, 3bc24b4 and the never-run-case diagnostics.
- **Add:** the 5 items above.

factory.mjs stays under about 1,000 lines. The suite is 249 tests plus the ports.

## Proposed QA and release plan

All of this waits until the media-library run finishes QA on wip. Nothing touches main, wip or :4173 before then.

1. **Branch.** Cut `successor` from scrappy-pipeline in a new worktree, `../soloFactory-successor`.
2. **Cherry-pick the ports.** Expect conflicts in gate.mjs and prompts.mjs, because scrappy restructured them. Write each port as a test that fails first.
3. **Add the 5 new items,** one commit each.
4. **Run the full suite,** then the existing tip-calculator smoke with Codex.
5. **Release gate:** Codex builds the media-library brief from scratch on `successor`. It passes when:
   - the run reaches the release tag
   - it parks no more than once for a reason other than provider limits
   - total agent hours are well under 19, which is the 4f2dd1cf baseline
   - the release review finds and closes at least the classes of defects that per-feature review caught on wip

   If the review misses defects that per-feature review caught, the bet failed. Bring back a lightweight check per feature before release.
6. **Then** merge into main, after your approval, and release through the normal sync-distro → audit → production flow.

## Risks

- **Large-app behavior is unproven.** The gate in step 5 exists to test it.
- **Cherry-picking onto restructured files is fiddly.** Re-implementing by hand may be cleaner than `git cherry-pick`.
- **The 8 × 6 caps are first guesses.** The media-library brief will show whether they hold.
