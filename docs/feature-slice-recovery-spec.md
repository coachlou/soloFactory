# Feature and slice recovery within a preserved run

Status: first implementation verified (124 tests pass), 2026-10-07. Requested by Lou. Updated 2026-10-13 to match
HEAD of `wip/feature-slice-recovery`; SPEC.md (Feature recovery within a preserved run) is the source of truth.
The branch is not merged or released until Lou accepts a real-provider recovery smoke.

The first version supports parked runs with matching failed review checks. Pause an
active run with the existing Pause control before planning. It does not automatically
chain a pause into planning. The original strategy remains recorded; recovery is a
separate execution phase. A plan that passes independent review starts execution on
its own (owner decision, 2026-10-12); a Pause during planning leaves it for approval. Recovery
resumes retain consumed repair budgets; they do not replenish them. Plans can be
regenerated before execution or after the full final review fails, retaining earlier
phase history. Preview deployment and new requirements during recovery remain deferred.

## Observed problem

The household photo-library run `2026-10-07-4f2dd1cf` reached final review with
many unfinished requirements. It used the single-build strategy and exhausted
its automatic repair budget. An owner-requested resume now grants another
bounded repair cycle, but the repair worker still receives the whole backlog.
The existing restart control rewinds a previously completed slice; it cannot
decompose remaining work or convert a single-build run into staged recovery.

## Requested outcome

Let the owner recover unfinished features in small, individually verified steps
inside the same run and workspace. Retain implemented behavior, user data,
the original requirements, and all prior evidence. Show which recovery feature
is running, verified, queued, or blocked.

This is an execution-plan change. It must not silently rewrite the product
contract or declare the original run complete with requirements deferred.

## First supported flow

1. On a parked run, offer **Plan feature recovery** alongside Resume. For an
   active run, offer **Pause after current step, then plan recovery**. Wait for
   the controller to release the project writer before inspecting mutable
   artifacts or starting a planning worker. Do not start a second writer.
2. Read the current, matching review report, full requirement text, execution
   history, and preserved working tree. Plan from current files, including
   partial work; do not reset to the last shipped commit.
3. Prepare a recovery plan that maps all unfinished MH/SC checks to dependency-
   ordered feature slices. Distinguish missing behavior from missing evidence.
   Identify already verified behavior to preserve and any real external blocker.
4. Show the owner the slices, acceptance checks, preserved baseline, and bounded
   repair budget. Planning and execution use subscription quota; starting a
   plan does not authorize execution of an unreviewed plan. As implemented, the
   independent review is the approval: a plan that passes it starts executing on its
   own, bound to the exact plan digest, and the owner is asked only when corrections
   stall (they continue past the base budget while each review finds fewer blockers,
   up to 3x) or run out. A Pause during planning parks the plan `ready` for explicit
   approval (`recovery-start` with the plan digest).
5. Once approved, execute one recovery slice at a time through the existing
   provider, gate, queue, and project-lock mechanisms. Scope each repair to the
   current slice. Record a checkpoint only after its acceptance checks pass.
   Before a slice's first build turn, run its checks: a slice that already
   passes goes straight to its scoped review; a failure is handed to the
   builder. This check spends no repair budget. A reviewer's blockers on a
   pre-verified slice start its build turn, not a repair.
   Each slice is held to the same safeguards as a new-run feature: the `writes` gate
   (every freshly drafted or submitted repair plan must declare `writes` per feature;
   changes outside them fail the slice, measured against the slice's start commit so a
   file the agent committed itself is still caught), gate logs named per feature,
   a build session resumed only by its exact label, and large slices read from
   `.factory/logs/feature.json` rather than inlined (past 60,000 characters).
   A slice that exhausts its review limit (`review_unstable`) goes to Prepare repair plan,
   not Resume.
   The owner may set a batch (`features: N` on `recovery-plan`, `recovery-start` or
   `resume`): the run parks as paused after N more slices, with its cursor,
   budgets and evidence kept. A plain resume keeps an unfinished batch's end.
6. Resume after interruption at the unfinished recovery slice. Do not replay
   verified slices. Reuse prior evidence only when it still applies to the
   current code and contract.
7. After the last recovery slice, run whole-project regression gates and fresh
   structured review against every original requirement. The gates also rerun the
   original plan's built-feature proofs (a repair slice with the same id replaces its
   original), every release-QA bug proof and `qa/` test, and all non-superseded
   integration proofs. The final reviewer reports defects as failing `qa/` tests, which
   are routed to the slice owning the faulty files; it does not fix feature code. Deploy or mark the
   run completed only after those gates pass.

## Plan and evidence boundaries

- Keep the original run ID, original strategy history, frozen contract digest,
  requirement IDs, plan, acceptance contract, and review history. Record recovery
  as a new execution phase rather than rewriting the run's original strategy.
- Store the recovery execution plan separately from `.factory/PLAN.md` and the
  original slice plan. Changing a recovery plan must not invalidate or replace
  the frozen product contract. Bind the approved recovery plan to the source
  review, contract digest, and preserved code baseline; reject stale approval.
- Validate complete coverage of unfinished checks, dependency order, and explicit
  ownership when a broad requirement spans several slices. Prevent duplicate
  implementation assignments. Recovery slices need not recreate a walking
  skeleton that already exists.
- Preserve prior failure files, transcripts, evidence, and checkpoint commits.
  Use distinct recovery-phase/slice attempt identities so new attempts cannot
  overwrite old artifacts. Do not mark an original failed check as passed just
  because a recovery slice's narrower test passed.
- A replacement plan may not change what a kept obligation asserts: under the same id,
  its behavior, expected result and proof command stay and its cases may not be dropped
  or altered. A change of meaning is a new case that supersedes the original, which the
  reviewer compares against it.
- Prerequisite-only recovery slices may use an empty `checks` array, but still
  require executable acceptance criteria. Every unfinished original check must
  still have exactly one owning slice; its full evidence gate runs after its
  prerequisites, and final review covers the unchanged full contract.
- Apply bounded repairs per recovery slice and a visible bound for the approved
  recovery phase. Exhaustion parks the run; automatic retries cannot replenish
  the budget or silently replan.
- Keep user data out of Git resets and evidence. Do not use dismissal to unblock
  recovery: dismissal can roll back the partial implementation being preserved.
- New product requirements belong in a separately approved follow-on brief.
  They can be drafted while recovery runs, but must not enter its frozen contract
  or run concurrently against the same tree.

## Operator safeguards

Neither the factory nor anyone operating it may take these shortcuts, even when a plan is
stuck and the owner is impatient. A stuck plan moves only through its endpoints: an
owner-submitted corrected plan, or a genuine spec change.

- Never mark a live plan failed manually.
- Never fake an input change (touching specs, uploads or guidance) to unlock planning.
- Never reset spent corrections or repair budgets.
- Preserve completed work, evidence and approval history: prior phases, plan files, reviews,
  approved candidates and checkpoint commits.

## UI

The existing run card gains a recovery section: approved plan, current feature,
verified/remaining counts, blockers, acceptance evidence, and remaining attempts.
The Guide receives this controller state and can explain it. Chat text alone
must not claim to have changed the execution plan or started a worker.

Run view (see `run-board-and-controls-spec.md`, Part C): the run's plan is drawn as a metro
map with per-step time and tokens; it shows the repair plan's features when a recovery phase exists.

Treat per-feature live previews as a separate extension. Verified feature
checkpoints do not by themselves make the whole app production-ready. This first
version keeps final deployment behind the whole-project completion gate.

## Implementation starting points

- `src/factory.mjs`: `runResume`, `reviewAndVerify`, `buildSlices`, `repair`.
  Reuse the execution and gate helpers; do not force a recovery plan through the
  original skeleton-first specification path.
- `src/server.mjs`: recovery planning/approval controls, scheduler ownership,
  stale approval rejection, and safe active-to-paused transition.
- `src/store.mjs` and the existing slice-plan validator: persist recovery phase,
  coverage mapping, checkpoints, budget, and durable resume cursor.
- `src/prompts.mjs`, `skills/factory-guide.md`, and run-card UI: recovery scope,
  owner-visible plan, honest progress, and evidence links.

Choose exact endpoint and storage shapes during implementation. Keep older jobs
without recovery-phase fields readable and resumable through existing controls.

## Acceptance tests

1. A single-build run with several failed MH/SC checks produces a recovery plan
   covering every unfinished check, without changing its frozen contract.
2. An existing slice run can recover incomplete features without replaying
   previously verified work or rewriting historical slice completion records.
3. Plan generation/approval during an active writer is rejected or waits for an
   acknowledged pause; no concurrent writer or reset occurs.
4. Code, contract, or source-review changes after preview invalidate approval.
5. Recovery preserves partial files, records, previous failure logs, and existing
   application behavior; a regression parks the current recovery slice.
6. A process restart resumes at the unfinished recovery slice and retains its
   consumed budget. Automatic failures cannot create fresh budgets.
7. Missing coverage, dependency cycles, duplicate assignments, and scope waivers
   reject the recovery plan before implementation begins.
8. A green recovery slice cannot bypass the full original completion review.
9. A blocked external dependency remains visible; the UI does not report it as
   implementation progress or silently drop its requirements.
10. The browser displays the current recovery feature, verified/remaining work,
    remaining attempts, and evidence. The Guide's account matches this state.
11. Older jobs still load and use ordinary Resume without a recovery migration.

## Not yet implemented

- Setting aside a blocked recovery slice so independent slices keep building. The main
  feature plan does this (SPEC.md section 12); recovery phases park on the first blocked slice.
- Rerunning earlier features' proofs when a recovery slice changes files they own. Recovery
  reruns them only at final integration.
- Per-feature live previews and new requirements during recovery (as before).

## Delivery boundary

Changes are made and tested in the SoloFactory dev repo, then released through the installed
distribution. Install a new build only when no run has an active worker. The release gate is the
real-provider recovery smoke noted under Status.
