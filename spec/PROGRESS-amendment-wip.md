# Plan amendment WIP (branch fix/exhausted-plan-amendment)

## Done
- src/feature-recovery.mjs: planKey, reviewedPlanKeys, amendRepairPlan, resumeAmendedReview, amendmentPacket, assertPlanningCurrent; draftRepairPlan takes an amendment (no planner, one review, blocked after it).
- src/factory.mjs: amendRecovery, activate(admit) hook, assertPlanAmendable, MAX_AMENDED_PLAN_BYTES (4,000,000), continuationAction amend-plan / "Resume plan review", buildRecovery text.
- src/server.mjs: POST recovery-review, GET recovery-plan-packet, drainOnce dispatch, readBytes drains oversize bodies then throws body_too_large.
- public/app.js: renderAmendment (packet link, advanced file input, selection kept in state.amendment, revise-inputs alternative).
- Tests: test/plan-amendment.test.mjs (21 controller tests pass); feature-recovery and e2e tests updated and pass.
- README.md, SPEC.md, PROGRESS.md updated.

## Failing / next
- The HTTP test in test/plan-amendment.test.mjs fails at `assert.equal(ready.nextAction.action, 'approve-plan')`: actual 'none'. Probably the job was read while the scheduler still held the run (busy -> none). Fix the test by polling until nextAction settles (or re-read after the run clears), not the code, unless it proves otherwise.
- Then rerun full `npm test` (only that one failure was seen in the tail; confirm total), `bash scripts/build-distro.sh --check`.
- Node 24 is not installed; ran on v26.5.0.
- Commit the final state; never push; leave distro.zip, solofactory-*.zip and .aai/ alone.
