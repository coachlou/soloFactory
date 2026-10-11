# Consolidated photo-library proofs: readiness report

Date: 2026-10-10. Answers spec/HANDOFF-consolidated-photo-library-proofs.md.
Nothing was submitted to live run 2026-10-07-4f2dd1cf. Nothing was installed. The ready plan
(phase 42d97519) is still unapproved. The candidate is not a reviewed plan.

## Bottom line

- **Submission path: ready.** On `wip/feature-slice-recovery`, an idle ready plan now accepts
  an owner-submitted corrected plan. Commit 31b6f80, plus one more test after it.
- **Candidate structure: preserved.** All 578 obligations are unchanged, and the commands drop
  from 578 to 37.
- **Strict runner: not enforceable by the factory as written.** The factory passes a proof only
  on its exit code. Every per-test guarantee depends on a runner script the builder writes
  itself. The capability this lacks, and the smallest factory change to fix it, are below.
  Decide on that before you submit.

## 1. Candidate and coverage map (read-only audit)

- 578/578 obligations have the same id, behavior, refs and sources.
- The features keep the same order, dependsOn, closes, title and demo. The top-level fields are
  unchanged.
- The only objective that changed is TARGET-COMPAT, which appends the runner requirement.
- Every grouped obligation maps to exactly one group, and that group belongs to the
  obligation's feature.
  - No test appears in two groups.
  - Each group's `originalCommands` equals the command in the ready plan.
  - Each test name equals its acceptance id.
  - The two npm proofs (PRESERVATION-029 and -030) are byte-identical.
- In the 576 grouped proofs, each `expect` is the original text plus one fixed sentence. None is
  weakened. That includes the 173 proofs covering real inference, compatibility, security,
  preservation or regression.
- The candidate is 1,217,395 bytes. That is under the amendment limit (`MAX_AMENDED_PLAN_BYTES`,
  4,000,000).

Risks the audit raised:
- The map sits at `spec/consolidated-repair-plan/proof-groups.json`, but the objective expects
  `test/recovery/proof-groups.json`.
- `test/recovery/slice-regression.test.mjs` is shared by 17 groups. If it imports later
  features at load time, it fails early. The original plan had the same exposure.
- Groups hold up to 64 tests (PEOPLE-UI-SUITE-01), so a single failure fails the whole group.

## 2. Amendment from an idle ready plan (implemented)

When a plan is ready, the policy still lists approve-plan as the primary action. It now adds
the alternative `amend-plan`: "Submit corrected plan for review" (`POST /recovery-review`).
This goes through the existing amendment path, nothing new:

- **Prior plan kept as evidence.** The ready phase, including `planDigest` and `planReview`,
  moves to `recoveryPhaseHistory`. Its plan file and `approved-candidate.json` stay
  byte-identical, and a `prior-plan.json` copy is written.
- **The replacement gets its own approval.** It has one independent review and no automatic
  corrections. The prior digest is refused by `startRecovery` and by the HTTP 409 preflight.
  Saved state does not change.
- **The reviewer is told the earlier approval does not carry over.** It used to see an empty
  "previously blocked for" list.
- **Rejected submissions leave state byte-identical and run zero turns.** The guarded cases
  are:
  - duplicate (including reordered keys);
  - stale phase;
  - invalid plan;
  - changed inputs;
  - busy writer.
- **A blocked replacement** leads to amend-plan. **An interrupted replacement** leads to
  retry-plan, which runs the review only. Neither case runs a planner turn or renews the
  budget, and spent corrections are kept.
- **Known consequence:** once a replacement is submitted, the old ready plan cannot be
  restored. Resubmitting it is refused as a duplicate because it was already reviewed. Submit
  only a plan you prefer to the ready one.
- **Not done:** the help-packet download still works only for blocked plans. A ready plan
  offers only the upload.

Tests are in test/plan-amendment.test.mjs:
- 4 new unit tests, and the existing HTTP journey extended with a ready-plan replacement.
- Full suite: 236/236 before the last test was added. The amendment file passes 26/26.
- The dashboard upload on ready plans is checked only at source level. I did not check it in a
  browser.

## 3. Strict runner: what the factory can and cannot enforce

What the factory does today:
- `verify()` passes a proof gate when its exit code is 0 (src/factory.mjs `verify`).
- `proof.expect` is text for the reviewer only. Nothing matches it against output.
- `verify()` deduplicates identical commands, as the handoff said, so 37 gates run.

What is missing:
1. **No per-test evidence.** The factory cannot confirm that a mapped test ran and passed. The
   guarantee "fail on missing, skipped, duplicate or zero-match tests" exists only inside the
   app's `verify-proof-group.mjs`, which the builder writes during TARGET-COMPAT.
2. **The schema cannot carry test ids.** `validateRecoveryPlan` rebuilds each obligation from a
   fixed field set (src/wbs.mjs ~287), so an extra `proof.tests` field would be dropped. The
   group → file mapping lives only in the map file, not in the plan.
3. **Nothing freezes the runner or the map.** No digest of either is recorded, and later
   features may edit them. The coverage map is not a run input. Adding it as one would change
   `sourcesDigest` and make the amendment stale.
4. **5-minute limit per proof gate.** `timeoutMs` is fixed. A 64-test group that includes
   real-inference tests now shares one 5-minute window, where before each test had its own.
   *(verify: the real runtime of the largest groups)*

Smallest factory change that would let the factory check the runner instead of trusting it
(proposed, not built):
- Allow an optional `proof.tests: [ids]` field on an obligation, and keep it in
  `validateRecoveryPlan`. Its value is the exact test ids from the map.
- In `verify()`, for a gate whose obligations declare `tests`:
  1. Delete `.factory/proof-results/<gate>.json` and pass a fresh nonce in an environment
     variable.
  2. After exit 0, read that file.
  3. Fail the gate unless the nonce matches and every declared id appears exactly once with
     status `pass`, with no skips or todos.

  Failure output would name the missing or failed ids.

This change still trusts the runner to report honestly. It does remove trust in the runner's
completeness logic, and it pins the test ids inside the reviewed plan, so the map cannot drift.
It is roughly 30 lines plus tests in factory.mjs and wbs.mjs.

If you want to submit with no factory change, the fallback is:
- Keep the runner requirement in TARGET-COMPAT.
- Rely on the feature reviewer to inspect `verify-proof-group.mjs` and the map.

Under that fallback, per-test strictness is reviewed once and not enforced afterward.

## Owner decisions before submission

1. Submit as-is with the fallback, or build the `proof.tests` check first. Building it first
   means regenerating the candidate with `tests` arrays.
2. Accept that a submitted replacement retires the current ready plan for good.
3. Install the factory build that contains 31b6f80. Do this only after you authorize it.
