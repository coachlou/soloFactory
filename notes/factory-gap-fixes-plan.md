# Factory gap fixes: plan (scoping only)

Date: 2026-11-12. I read the code and the two Voice Notes runs. There were no model calls and no code edits.

Both fixes change `src/factory.mjs` and `src/prompts.mjs`, which are in SMOKE_PATHS (`scripts/smoke-gate.mjs:10`). So the alpha needs another real smoke once they land. `git diff main release/0.11.0-alpha.1 -- src/factory.mjs src/prompts.mjs` is empty, so both fixes apply cleanly to main and to `release/0.11.0-alpha.1`.

**Branch:** `fix/factory-gaps` off main. It goes into stable 0.10.18 and also merges into `release/0.11.0-alpha.1`.

---

## Gap 1: writes ownership (run 2026-11-12-d07bfd16)

### Where it is

- **The gate:** `writesFailure` in `src/factory.mjs` (~1441-1468).
  - Widening happens only when `!others.some((item) => writesCover(item.writes, file))`.
  - `others` are the features that aren't built yet.
  - That condition is what refused QUEUE's one-line `server.js` change and its `store.update()` method: RESTART owns `server.js`, and LIBRARY and RESTART own `store.js`.
- **The prompt promise:** "If the fix needs an existing source file outside them, edit it: the controller adds it to this feature's writes."
  - The repair prompt has it at `src/prompts.mjs` ~287.
  - The builder prompt has it at ~680.
  - Neither prompt mentions the owner exception, so repairs 2 and 3 trusted the promise and changed nothing.
- **Why the owner rule exists:** the comment on `parkSetAside` (~868-872) says the set-aside commit took the whole tree, "including files the writes gate rejected, which a later feature may own".
  - So the rule protects one case: a feature that edits another feature's file, is then set aside, and is later restored on top of the owner's newer version of that file.
  - The rule came in with the squash merge 66c7c7e. Nothing else records why.

### Options

| Option | What it does | Verdict |
|---|---|---|
| (a) Gate widens into an unbuilt owner's existing file | The owner keeps its claim. The change is recorded and shown to the owner's build and review. | **Recommended** |
| (b) Prompts tell the truth, plus a plan-amendment request from repair | Honest, but the run still fails. Amendment adds a new path through planning and owner approval. | Prompt half only, as part of (a) |
| (c) Plan-review rule for wiring and shared files | The earliest place to catch it, but it depends on the model. Round 2 already approved this plan with "writes miss files its obligations plainly need" in the prompt. | Add the sentence; don't rely on it |

### Why (a)

- It fixes the actual failure without a model judgment call. QUEUE needed a one-line wiring change and a store method, and both are legitimate.
- The safety nets already cover widened files:
  - Widened writes feed impact selection through `reachedProofs` and `sliceStats[id].widened`. When the owner later edits the file, QUEUE's proofs rerun, so a later break is still caught.
  - Features build one at a time, so two features never write the same file at once.
  - Only *modified existing* source files widen. New files, deletions and other features' tests still fail, as they do today.
- The prompt promise becomes true, so (b) mostly turns into a wording fix.
- I'd also add one line to the plan-review prompt (option c) as cheap prevention: "an entry point or shared store a feature must change to wire its behaviour belongs in its writes".

### Change

1. **`writesFailure`.** Split today's `widen` filter:
   - files with no unbuilt owner keep today's behaviour;
   - files an unbuilt feature owns also widen, and go into `cursor.shared = [{ file, owner }]`;
   - the event message names the owner ("…src/store.js (owned by RESTART, not built yet)").
   - About 8 lines.
2. **Set-aside guards (the cases the owner rule protected). Both directions:**
   - **(i)** In `setAside`, return false when `cursor.shared?.length`. A feature that changed an unbuilt feature's file isn't set aside; the run parks on it, exactly as a non-set-aside failure does today.
   - **(ii)** In `writesFailure`, keep refusing when the owner is in `job.setAside`.
     - A set-aside feature isn't in `sliceDone`, so it looks unbuilt.
     - If a later feature widened into its file, `parkSetAside` would check the set-aside version out over that later edit.
     - That's the "declared writes keep that work disjoint" invariant from the `setAside` comment.
   - Together these rule out the clobber in `parkSetAside` without a three-way merge, since the case is rare.
   - About 4 lines.
3. **Tell the owner.** Copy `cursor.shared` into `sliceStats` (next to `widened`, ~824). When the owner's feature builds, its builder prompt and its scoped review get one line: "Feature X changed <file> (yours) before you were built; keep its change working."
   - About 10 lines across the factory and the prompts. This is an estimate: I haven't read the feature build prompt or the scoped-review request yet.
4. **Prompts.** In the builder and repair wording (~287, ~680), keep the promise, which is now true, and add: "if another feature owns the file, keep the edit minimal; that feature is told."
   - Add the wiring sentence to the plan-review rules (~488).
   - About 4 lines.
5. **Error text.** Remove "or a file an unbuilt feature owns" from the gate's output (~1467).

**Total:** about 25-30 lines.

### Tests (`test/writes.test.mjs`, reusing `declaredRun`)

- A feature that edits an existing source file an unbuilt feature owns:
  - the run completes;
  - `slice.writes_widened` names the owner;
  - `sliceStats[X].shared` is set;
  - the owner's build prompt contains the line about X's change.
- The same edit on a *test* file the unbuilt owner has still fails the writes gate (no regression).
- A new file inside an unbuilt owner's writes still fails.
- A feature with `shared` that runs out of repairs is not set aside (`slice.set_aside` absent; the run parks).
- A later feature that edits a file in a *set-aside* feature's writes still fails the writes gate.
- The existing tests at writes.test.mjs:160-193 stay green.

### Risk

- **Could a real failure slip through?** Low.
  - The widened file still goes through every gate.
  - Impact selection reruns X's proofs on the owner's later edits.
  - The owner's review sees the change.
- **What's left:** the owner's builder could rewrite X's change in a way that breaks X only outside X's proofs. Today's widening already has that risk with built owners, and the final review covers it.
- **The set-aside guards trade one thing for safety:**
  - a feature with shared edits parks the run instead of being set aside, which is the same as today's behaviour for any non-set-aside failure;
  - a set-aside feature's files stay off-limits to later features, exactly as today.

---

## Gap 2: flaky final test (run 2026-11-12-b1da8f4b)

### Where it is

- **The final gate:** `finishFromBuild` → `verifyWithRepairs(job, manifest, signal, { includeInstall:false })` (~1374) with no slice → `verify()` (~1605).
  - `verify()` runs `npm test` through `this.commandRunner`.
  - Any non-zero exit returns `quality_gate_failed` (~1716).
- **Repair counting:**
  - `repair()` (~1563) checks `job.attempt >= job.repairBudgetLimit` and then throws the failure as-is.
  - The final phase gets `maxRepairs` once (`finalBudgetSet`, ~833). That's 4 in this run, and it's shared across the integration gates, the QA bug proofs and the final review repairs.
- **The run:**
  1. `npm test` passed at 03:57:15 (candidate 8b9b…).
  2. Repair 4 then changed `src/metrics.js` (normalizeRoute) for the QA bug.
  3. `npm test` failed at 03:59:06 on `[TR-RETRY]` (test/transcribe.test.js:158): it expected `failed` and got `transcribing`.
  4. The budget was spent, so the run failed with no repair turn.
- **Why it was flaky:** repair 4 hadn't touched transcribe code, and its own rerun of that file passed. TR-RETRY looks timing-dependent.

### Proposal

- **Free rerun, once, at final integration only** (`verifyWithRepairs` with `slice === null`, whatever budget is left).
  - In `verify()`, when a `test` or `proof-*` gate exits non-zero (not timed out, not a runner crash), retry the whole per-gate body once, immediately.
  - The `test` gate can be cased: a proof whose command is `npm test` merges its cases into it. So the retry must also redo `rm(events)` and the `caseResults` write. Retrying the whole body does that, so cased gates are covered and aren't left for a follow-up.
  - During feature builds a flake still goes to repair, which now gets the "fix the intermittent" line.
  - If the rerun passes, the gate passes.
  - If it fails again, today's path runs unchanged and repair gets the rerun's output.
  - The rerun costs one gate run (about 5 seconds here) and no repair attempt.
- **Record it.**
  - Emit `gate.flaky` (gate, command, the first run's failing case names or a 2,000-character output tail).
  - Push to `job.flakyGates`.
  - The final review request gets a `flaky` list, with a line in `reviewPrompt` that it judges as a likely race.
    - This is safe across reviews: `contractDigest` (review.mjs:7) hashes only the `.factory` contract files, not request fields. So the new field can't trigger "Frozen contract changed".
  - The run summary and owner view show it from the event, the same way they show `writes_widened`.
- **Why not "passed earlier on unchanged code" as the trigger.**
  - In this run the code *had* changed (metrics.js), just not the test's code.
  - Proving "unrelated change" means file-impact analysis that the final gate doesn't have.
  - The immediate rerun is the simpler test that would have saved this run.
- **Scope.** Install, lint and build are deterministic and never rerun.

**Size:** about 20-25 lines in `verify()`, plus about 5 in `prepareReview` and `reviewPrompt`.

### The repair prompt

Yes, it can be told. In `repairPrompt` (~283), add one general line for every repair: "A test that fails, then passes when rerun, is a bug in the app or the test (a race, an unawaited promise, a timer, shared state). Find the cause and fix it; never leave it as 'intermittent'." Repair 4 already found TR-RETRY flaky and walked away; this line points it at the fix. It's 1-2 lines, and the run doesn't depend on the model following it, because the free rerun handles that.

### Tests (`test/factory.test.mjs` or a small new `test/flaky.test.mjs`)

- A fake `commandRunner` whose `npm test` fails once and then passes:
  - the run completes;
  - `job.attempt` is unchanged by the gate;
  - one `gate.flaky` event;
  - `job.flakyGates` has one entry;
  - the review request carries it.
- `npm test` fails twice: one repair turn runs with the second run's output, as today.
- A timed-out gate is not rerun (still `gate_timeout`).
- Lint and build failures are not rerun.
- A cased `npm test` that fails once and then passes: `job.caseResults` shows the cases passed, with no stale failed entries.
- A feature-build gate that fails once is not rerun; it goes to repair as today.

### Risk

- **Could a real failure slip through?** Yes: a genuine race that passes one run out of two.
- **Mitigations:**
  - only one rerun;
  - the failure is recorded, not hidden;
  - the final reviewer sees it and can block;
  - the repair prompt tells future repairs to fix intermittents.
- **The trade:** today one coin-flip test burns the whole run.
- **Cost:** every real final-gate failure now runs twice before repair. That includes QA bug proofs, which fail by design until they're repaired. Each rerun can take up to the gate timeout (5 minutes by default), but in practice it's seconds: `npm test` took about 5 seconds here.

---

## Order and smoke

1. Branch `fix/factory-gaps` off main.
2. Do Gap 2 first (smaller), then Gap 1. For each, its own tests until green.
3. Before merging: full `npm test`, then the real smoke. Both fixes touch SMOKE_PATHS.
   - Voice Notes is the right brief, since it hit both gaps.
   - That's about 1-2% of weekly usage, judging by the last re-run.
4. Merge into main (stable 0.10.18 gets it) and into `release/0.11.0-alpha.1`. Re-record the alpha smoke row on the release branch.
5. No push, tag or zip until Lou says.
