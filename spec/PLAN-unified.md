# Unified plan: faster, feature-owned pipeline (2026-10-12)

This plan merges three sources:

- the **Feature Pipeline PRD** (Claude Doc "SoloFactory Feature Pipeline PRD", stages 1–5);
- `spec/DESIGN-build-time.md` (A–D);
- the open INBOX audit "nested regression replay and final candidate composition".

Steps are ordered by leverage: the biggest time or risk cut per unit of work comes first. Each step is a separate
commit (or small series), with acceptance criteria proved by `npm test` and cheap targeted checks. The factory is
developed the way the PRD wants it to develop apps: the real-provider smoke run (~35 min, ~$20) is **release QA**,
run once before a release (push or install), never per step. Its findings come back as owned fixes.

| # | Step | Source | Size | Why here |
|---|---|---|---|---|
| 1 | **Hermetic, verifiable agent turns** | Design A+B | S | 46 permission denials and a Fable advisor in every build; the F1 repair (354 s) came from a blocked proof run. Biggest cut for the least code. |
| 2 | *(moved to release QA)* | Design plan | – | Pre-release smoke checks: 0 denials, no Fable in `modelUsage`, builds plus repairs under 900 s (from 1478 s). |
| 3 | Inline the builder's own slice | Design D | S | Stops the full 31 KB `slices.json` dump in every build and repair. Decide from step 2's logs. |
| 4 | Per-release fixed-cost measurement | PRD (pre-stage 1) | – | No code: run one brief as one job vs three follow-on briefs. Sizes the payoff of stages 2–4. |
| 5 | Feature records and declared `writes` | PRD stage 1 | L | Fixes the Restart-from-slice budget refill defect. Prerequisite for impact selection and for continuing past a blocked feature. |
| 6 | Merge checks with impact selection and nonrecursive proof composition | PRD stage 2 + INBOX audit | M | Gates are seconds on small apps but dominate at scale: photo-library regression proofs ran 808 s ×3, and their aggregates nest. Rerun only affected proofs; flatten aggregates. |
| 7 | Release QA and bug items | PRD stage 3 | M | Agent QA once per release; findings come back as failing tests owned by a feature. |
| 8 | Continue past a blocked feature | PRD stage 4 | M | A failed feature parks only its dependents. |
| 9 | Builder-run `check-feature.mjs` | Design C | S | Only if case-shape repairs still happen after steps 1 and 3. |
| 10 | Parallel builds (worktree per feature) | PRD stage 5 | L | Only after steps 5–8 are proven. |

## Step 1: hermetic, verifiable agent turns

**Change:** `src/providers.mjs` plus the build and repair call sites.

- Every Claude turn runs with `--setting-sources project,local --strict-mcp-config`, so it doesn't pick up the
  user's hooks (rtk rewrites), `advisorModel`, plugins or claude.ai connectors (Gmail, Docs and so on).
  - Verified 2026-10-12: with these flags the tool list drops both `advisor` and every `mcp__claude_ai_*` server.
- Write turns also get `--disallowedTools Agent`, so they don't fan out sub-agents on unknown models.
- Write turns are allowed:
  - read-only orientation commands: `ls`, `git ls-files`, `git status`, `git diff`, `git log`;
  - `node --test`;
  - the controller's own gate commands, i.e. the current feature's proof commands. For a repair, that is every
    proof command in the verification it repairs.

**Acceptance:**

- [ ] A unit test asserts the args contain the isolation flags.
- [ ] A unit test asserts a build turn's allow-list contains its feature's proof commands.
- [ ] `npm test` passes.
- [ ] Release-QA smoke shows 0 permission denials and no `claude-fable` in any build's `modelUsage`.

## Step 4: deferred to release QA

It needs real-provider runs, so it rides along with the next release-QA smoke instead of costing its own runs.

## Step 5 (approved 2026-10-12; 5a done)

**What the code actually shows about the PRD's restart defect.** `restartFromSlice` (factory.mjs:114) sets
`attempt = 0` and clears `repairBudgetLimit`. Features before the restart point are already done, and each rebuilt
feature gets exactly `0 + maxRepairs`, so the budgets come out right. Three real defects sit nearby:

- **Stale agent session (likely the worst).** `agentSessions` is never cleared, and `resumeSessionFor` matches any
  session key containing the slice id. A rebuilt feature can resume the parked run's session, including a
  reviewer's, about work the rewind threw away. This is a suspicion: 5b starts by writing the test that reproduces it.
- **Label collisions.** `attempt` restarts at 1, so `repair-1.log`, `<gate>-1.log` and `last-failure-1.txt`
  overwrite the parked run's records (`.factory/logs/` is gitignored, so the reset doesn't remove them).
- **Stale `recoveryPhase`.** Restart leaves it in place, and its `totalRepairLimit` was computed from the old `attempt`.

So stage 1's value is mostly **testability plus the restart fixes**, not a budget refill. The work splits in two:

**5a. Declared `writes`, done first because step 6 needs it.** It touches 4 files: `src/wbs.mjs`,
`src/prompts.mjs`, `src/factory.mjs` and `test/wbs` (or `test/features`, as new tests only).
- Schema: each slice gets `writes: [glob]`, required for new v2 plans. Older plans without it skip enforcement.
- Validator: two slices with no `dependsOn` path between them must not overlap. Overlap is checked by globbing
  each side's patterns against the other's literal prefix, using `path.matchesGlob` from Node 22, so no new
  dependency.
- **Foundation features.** The default proposal: a slice with no `dependsOn` is foundation. Only foundation slices
  may write the shared files (`package.json`, the entry point, README, migrations).
- Plan-review prompt: flag implausible or too-broad `writes`, and `dependsOn` entries with no real need.
- Enforcement: after the build or repair turn, `git status --porcelain` paths must all match the feature's
  `writes`. Always exempt: `.factory/**`, `package-lock.json`, and README for the last feature. A violation fails
  the gate and names the file. Final-integration repairs (no slice) are checked against the union of all `writes`.

*5a as built:* final-integration and final-review repairs are not checked yet. Step 7 turns release findings
into owned bug items, which carries the check to them. A non-foundation feature that needs a new npm
dependency fails its gate by design: the plan must put the dependency in a foundation feature.

**5b. Feature record, restart and migration.** It touches about 7 files: a new `src/feature-record.mjs`,
`factory.mjs`, `feature-recovery.mjs`, `store.mjs` (migration on read), `server.mjs`, `watchdog.mjs` and tests.
- `job.attempt` stays the run-wide, ever-increasing counter, because labels, logs, `repairAttempts` and the
  watchdog depend on it.
- The record holds `{ id, substage, limit, spent, reviews, candidate, commit, stats }`. A pure module manages it, so
  budgets and reviews can be tested without a Factory.
- Restart stops zeroing `attempt`. It drops the rewound features' records and their `agentSessions`, and clears a
  stale `recoveryPhase`.
  *Done first (test/restart.test.mjs):* the stale session reproduced (the rebuild resumed the parked build's session).
  Restart now keeps `attempt`, clears all `agentSessions`, and archives the repair plan as `discarded`, which also
  starts a fresh correction budget. v1 runs get `repairBudgetLimit = attempt + maxRepairs`, the same budget as before.
- Migration on read turns `featureCursor` / `phase.cursor` plus `repairBudgetLimit` into a record with the same
  remaining budget.
- `test/features.test.mjs` asserts on `featureCursor` and `attempt` in 21 places. To keep it unchanged, the record
  stays at `job.featureCursor`, with the new fields added, rather than being renamed.

Deferred (decided 2026-10-12): the feature-record module and migration move to step 8. The data already exists in
`featureCursor` + `repairBudgetLimit`; step 8 is the first consumer that needs per-feature state in a new shape.

## Step 6 (in progress)

*Merge check, done:* a feature's checks rerun the proofs of built features whose writes, or whose dependencies'
writes, cover a file changed since the last verified feature (`impactedFeatures`, `reachedProofs`). Plans without
writes keep the old scope. Planner and plan review are told not to write aggregate regression proofs, since the
controller now does that job. Ceilings:
- impact is computed once per check, so a repair that reaches further is caught at final integration;
- reads are assumed to be own plus dependencies' files.

*Not done:* final integration still reruns every feature proof once. Selecting there needs a per-feature "last
verified at" commit; add it with step 8's record if final integration time shows up in release QA.

## Step 7 (in progress)

*Bug items, done:* in feature mode the final review is release QA. It reports each defect as a failing
`qa/*.test.mjs` plus the source files at fault (`bugs` in review-result.json). The controller commits the
findings, gives each to the latest feature whose `writes` cover those files, runs the test (it must fail, or
the finding falls back to the unscoped repair), and repairs under that feature's writes gate, so the repair
cannot edit the finding's test. Findings no feature owns keep the unscoped repair. Ceilings:
- a fixed bug's test reruns at every later final integration in the run, but not in later releases unless the
  app's test command discovers `qa/`;
- an unowned finding's unscoped repair has no writes gate, so only the prompt keeps it off the finding's test;
- non-feature (v1) runs are unchanged.

The repair prompt carries the feature inline (no `slices.json` read), its writes, and each finding's description.

## Step 8 (in progress)

*Set aside, done:* a feature that runs out of repairs (gate, review or unstable-review failure) is set aside
when features that don't depend on it remain. Its work is committed to `refs/factory/set-aside/<id>` and the
tree resets to the commit it started from. Dependents wait. After the loop, the run parks once on the first
set-aside feature with its files restored over everything built since, plus its cursor and spent budget. That
is the same parked state as today, so Resume, the repair plan and restart are unchanged (restart drops the
set-aside list). Ceilings:
- always-writable files (README, package-lock.json) take the set-aside feature's version on restore;
- a repair plan made while a second feature is still set aside replans that feature from scratch;
- plans without `writes` keep the old stop-at-first-failure behavior.

The feature-record module stays deferred: set-aside reuses the cursor as its record.

## Open questions (decided 2026-10-12, Lou delegated)

- Trigger: release QA stays once per run, before deploy. Every-N-features waits for step 8's record.
- Blocking: yes, findings block this release (current behavior).
- Budget: bug items share the final-stage budget; a per-feature budget needs step 8's record.

## Open questions (from the PRD, as asked)

- What triggers release QA: every N merged features, a milestone, or on request?
- Is "blocks this release" the default for findings in a feature's own declared checks?
- Does a bug item get the owning feature's remaining budget or a fresh one?
