# Recover from exhausted plan corrections without changing valid requirements

Status: implementation handoff for Claude. No implementation delivered by this document.
Date: 2026-10-10 (America/Toronto)
Canonical repo: /Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory
Branch: wip/feature-slice-recovery; inspected HEAD 1d5d37b.
Owner instruction: Claude owns the current implementation. Codex supplies this document only.

## Problem

An independent reviewer can reject a repair plan because the planner omitted requirements
already present in the authoritative inputs. After two automated corrections, SoloFactory
stops and tells the owner to revise the inputs. That misdiagnoses a planning failure as a
requirements problem. The owner must not edit correct specs simply to unlock another budget.

Keep automatic corrections bounded. Add an explicit, supervised path to submit an amended
plan for independent review. This is not another automatic planner retry. A reviewed plan
still needs exact owner approval before any application repair executes.

## Evidence from the preserved photo-library run

Run: 2026-10-07-4f2dd1cf
Host: /Users/loudalo/Documents/photo-library-prototype
App: projects/medialibrary
Installed source: 77159ff (the newer watchdog source is not installed there).
Failed phase: 34d6aa37-b322-4624-ace0-6698c0e041cb
State: failed; failedState specifying; phase plan_failed; corrections 2; blocked true.
Failure: plan_blocked at 2026-10-10T16:40:52Z.
Plan: .factory/recovery-plan-34d6aa37-b322-4624-ace0-6698c0e041cb.json
Original 15 verified recovery features remain in phase history. No new repairs started.

The final reviewer found three defects in the plan:

1. PEOPLE-UI-009 cites the wrong source location for the 60-character person-name limit.
   The limit already exists as maxlength="60" in requirements.json, transcript[1].content,
   embedded SOLOFACTORY-HANDOFF.md reference dialog markup, decoded content line 349.
2. METADATA-FACTS omits unreadable individual-field tests for a successfully decoded file.
   Embedded SPEC section 6, decoded line 107, and section 15, line 199, already require
   unreadable values to remain unknown, retained raw values and provenance/status, and
   missing/unreadable fixtures. Missing fields and a failed whole extractor are different.
3. EXACT-SEARCH/SMART-RULES omit supported search-schema version validation and rejection
   cases. Embedded SPEC section 11, decoded line 161, already requires this boundary check.
   Test supported versions, malformed/unsupported versions, and mutation-free rejection.

These are review findings, not independently reproduced application behavior tests.
All three point to existing requirements. No evidence here establishes a defective input.

## Required behavior

### 1. Explain the actual stop

Replace the sole instruction “Revise inputs and prepare a new plan” after exhausted plan
corrections with neutral, accurate guidance:

“Automatic plan corrections are exhausted. The plan still has review blockers. Correct the
plan and submit it for review. Change the requirements only if the inputs themselves are wrong.”

Show all blockers, the preserved plan, logs, automatic corrections already spent, and the
fact that no repairs have started. Do not claim every blocker is a planner error: conflicting
or incomplete requirements can still require a genuine input revision.

Keep the controller/API/dashboard on one allowed-action policy. An ordinary retry against
an exhausted fingerprint remains refused. Existing revised-input handling remains available.

### 2. Supervised amendment, not budget renewal

Accept an explicitly submitted corrected plan as an artifact. Do not invoke the planner or
an automatic correction agent for this action. Run one independent plan review. Do not give
it a renewed correction allowance. If blocked, preserve the new findings and park again.

Every new submission needs an explicit owner action. Do not chain submissions, manufacture
spec edits, auto-submit title-only changes, or use this path to evade the watchdog's loop
policy. Automatic correction counts, application repair counts, and plan history persist.

A genuine new input fingerprint retains the existing policy for a fresh correction budget.
Approval alone still does not reset budgets. Preserve the existing distinction between
unexecuted plans and new findings after a plan has actually executed.

### 3. Validate before spending a reviewer turn

Preflight must reject an active writer, dismissed/completed run, wrong recovery phase,
malformed submitted plan, missing/unknown checks, stale phase identity, changed source
baseline, changed inputs, changed frozen contract, or modified underlying review evidence.
Perform checks again after acquiring ownership; do not rely only on HTTP preflight.

Use the existing recovery-plan validator and the exact existing request. Bind the submission
to its phase ID and input fingerprint. Normalize plan content for duplicate detection:
formatting and a new request ID do not constitute a corrected plan. Reject a plan already
reviewed for this same unresolved request/input set before any agent turn. Preserve a durable
submission identity so restarts and switching between previously submitted candidates do
not create an unlimited unchanged-review loop. Use the watchdog where appropriate.

Do not require the prior blocked plan to be structurally valid. A malformed old plan must
not make a valid replacement impossible. Preserve its raw artifact as evidence, then validate
the replacement against the request. Keep comparisons scoped to the unresolved recovery
lineage; do not block a genuinely new repair assessment after executed work.

Validate negative conditions before writing job state or archiving a phase. Rejected
submissions must leave saved state byte-for-byte unchanged and start zero provider turns.

### 4. Reuse review and approval gates

Archive the failed phase and leave its plan artifact unchanged. Write the replacement to a
new phase-specific file, preserving the authoritative contract, checks, findings, sources,
source baseline and completed-feature list. Include the prior plan-review blockers in the
new review request so the reviewer must assess them explicitly.

Reuse the independent plan-review request/token/digest validation, source guards and
approval checks. If the reviewer changes the plan or source, reject its verdict. Bind approval
to the exact reviewed plan, inputs, source baseline and review evidence as today.

If approved by the reviewer, park in ready state. Do not execute or deploy on submission.
The owner must use “Approve and continue repairs” with the exact plan digest.
An interrupted amendment review must resume/retry the review stage only, preserve its
accounting, and never fall back to starting the automated planner with a fresh budget.

### 5. Provide a usable owner journey

The primary presentation should explain the problem and offer help correcting the plan.
Provide a downloadable packet containing the plan, request, blockers, source references and
instructions for an owner or their chosen coding agent. Do not require a nontechnical owner
to infer which files to edit or type a large JSON blob into chat.

Provide an advanced “Submit corrected plan for review” file-input flow. Display the selected
candidate and targeted phase before submission. Validate size/type/JSON and retain selection
through polling and server errors. An optional text editor is secondary; avoid making it
mandatory for this real 500KB plan. Preserve existing server request-size limits, or implement
bounded upload handling deliberately; never silently truncate.

Keep “Revise inputs and prepare a new plan” as an alternative for genuinely wrong or ambiguous
inputs. Neither the download nor submit action may reset, dismiss or start over the app.

## Implementation map (suggested, inspect current code first)

- src/feature-recovery.mjs: amendment validation, lineage/duplicate checks, and review-only
  entry that reuses draftRepairPlan's review/approval machinery. Avoid a second weaker loop.
- src/factory.mjs: controller operation and shared continuation policy. Validate under writer
  ownership as well as preflight. Honor the newly committed watchdog and its accounting.
- src/server.mjs: bounded candidate download/submission and exclusive scheduler dispatch.
  Example intent: POST recovery-review with phase identity and corrected plan; exact API
  design belongs to the implementation. GET candidate must stay within owned artifact paths.
- public/app.js: blockers, explanation, downloadable assistance packet, amendment submission,
  and correct approval action. Avoid UI/controller predicate drift.
- Existing feature-recovery, HTTP and watchdog tests: regressions below.
- README, SPEC and PROGRESS: update the owner instructions in the same change.

The watchdog and provider diagnostics work already committed in this branch must remain
intact. No code from Codex's brief implementation attempt remains; it was removed before
this document was written. That attempt was untested and is not an implementation to ship.

## Acceptance tests

1. Reproduce this class: existing requirements, valid but incomplete plan, exhausted automatic
   corrections. Show amendment/help guidance, not an assertion that specs must change.
2. A valid changed candidate starts exactly one independent reviewer, zero planner/correction
   turns, zero implementation turns, zero deployments. Corrections used stays unchanged.
3. A passing review produces ready state; stale/wrong approval is refused; exact approval
   executes through the normal bounded feature pipeline, preserving prior completed work.
4. A blocked amendment adds findings/history but starts no automatic correction. A further
   review requires a new explicit submitted candidate; duplicates start zero turns.
5. Formatting-only and request-ID-only changes, resubmission after restart, switching back to
   an earlier rejected candidate, and concurrent duplicate clicks cannot evade accounting.
6. Changed source/contract/inputs/review, stale phase ID, malformed replacement, active writer,
   dismissed/completed run, and omissions are refused before writing state or invoking agents.
7. A malformed original plan can be replaced by a structurally valid candidate without losing
   the original raw evidence. An old blocked run lacking newer flags has supported guidance.
8. Reviewer modification invalidates its verdict. Amendment interruption continues only review.
   Existing owner pause, watchdog, writer exclusivity and exhausted fingerprint guards hold.
9. Download/submission handles a plan of at least the observed 540KB size within bounded limits.
   UI polling does not erase input; failures are actionable; API and controller actions agree.
10. Ordinary feedback and unchanged automatic retry still do not reset corrections. Actual
    input changes and post-execution repair planning retain the agreed fresh-budget semantics.

Write failing regression tests first. Run the narrow suites, full npm test and distro precheck
under Node 24. Use isolated fixtures; do not mutate the live run to manufacture a passing test.
Report the behavior demonstrated, remaining limits, and whether installation is safe.

## Delivery and immediate next step

Implement in the canonical dev repo/worktree only. Do not edit the installed .ailib, manually
rewrite run state/events, reset budgets, weaken gates, push publicly or use paid API fallback.
Keep the photo-library run parked. Installation is a later step through generated distribution
and the normal installer, at a safe idle boundary.

After installation, correct only the three plan defects above in a separately preserved
candidate and submit it through the supported review path. Review must pass, then the exact
plan must be approved before repairs start. Do not revise valid specs just to alter fingerprints.
