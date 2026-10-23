# Run watchdog and bounded recovery

Status: requirements handoff for Claude; implementation not started by this document.
Date: 2026-10-10
Canonical repository: /Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory
Target branch: wip/feature-slice-recovery (verify the current checkout before edits).

## Outcome

SoloFactory supervises its own active runs without an open chat or a separate AI agent.
It detects stalled workers and repeated work that does not advance the run. It attempts
only safe, bounded recovery. When it cannot continue, it explains the cause and offers a
next action that the controller can execute. It preserves verified work and all gates.

This is a factory feature. It does not add monitoring to the generated application.
Deliver ordinary code first. A continuously running AI supervisor is not required.

## Observed problem and existing controls

The photo-library repair planner stopped after six minutes without output. Its failure
was misclassified as authentication, and the dashboard offered Resume even though the
controller required retrying plan preparation. Successful worker launch did not prove
that a reviewed plan was produced.

Related work: [Provider diagnostics and planning continuation](PRD-provider-diagnostics-and-planning-continuation.md).
That PRD owns diagnostic framing and the shared continuation policy. Reuse its result;
do not implement a competing action selector or diagnostic classifier.

Current source has process idle and hard timeouts in src/process.mjs. src/providers.mjs
has Codex idle continuation, a backoff, and a shared elapsed-time cap. In the inspected
checkout, write mode allows one automatic continuation and read mode allows none.
Some providers may stream no output; silence alone is not proof they have stalled.
The current checkout also contains uncommitted diagnostic and continuation fixes.
Inspect those changes before implementing; preserve the concurrent author's work.

These existing controls are a baseline, not evidence of semantic progress detection.
The exact cause of the observed planner's inactivity remains unconfirmed.

## Scope and invariants

Monitor planning, plan review/correction, implementation, verification, final review,
and repair planning/execution. Exclude intentionally long-lived preview servers.
Monitor only while the factory server is running and owns active work. Show this limit.
Do not add a daemon, cloud service, dependency, or paid API fallback for the first version.

Never:

- Create a second writer while the first worker or its child commands can still write.
- Reset a run, erase evidence, discard owner data, or repeat verified features by default.
- Renew repair, correction, or watchdog allowances through Resume, retry, or restart.
- Approve a plan, accept a failed proof, weaken review, or deploy unverified work.
- Switch providers automatically. That feature remains deferred.
- Treat agent prose such as “still working” as proof of progress.

## Requirements

### R1. Distinguish activity, progress, and waiting

Record process activity separately from durable stage progress. A byte arriving, a tool
starting, or a heartbeat is activity. A validated plan artifact, a new verification
result, a committed checkpoint, or closing an acceptance obligation is progress.
Source changes are supporting evidence, not sufficient proof that a feature is done.

Keep stage-aware observations: run/stage/feature and recovery-phase identity, worker
session, worker ownership, activity time, progress time/type, running command, candidate
or artifact fingerprint, and the last failure signature. Use existing durable events
and job storage where possible. Do not duplicate full logs or source into job snapshots.

Classify a known long-running command as waiting, with command age and its hard limit.
Do not reset progress time for repeated log chatter or unchanged artifacts.

### R2. Detect inactivity and lack of progress without false certainty

Reuse process idle and hard caps. Add a configurable stage-aware progress window.
When activity continues but no accepted progress appears within that window, mark the
run “Progress needs checking” and record the evidence. This is suspicion, not proof
of a dead worker. Do not kill a worker solely because it has not closed a requirement.

A hard deadline remains the final bound. A command within its allowed deadline must not
be terminated by a shorter generic progress window. For silent providers, use process
state, command deadlines, and supported structured events; show “Progress unknown” when
there is insufficient evidence. Never invent a heartbeat or a sign-in diagnosis.

### R3. Detect repeated work with unchanged results

Use completed attempts, not individual output lines, as the comparison unit. Compare
within the same stage/feature using normalized failure identity, affected checks, and
candidate/artifact fingerprints. Prefer stable error/check IDs; retain command and output
references for inspection. Ignore volatile timestamps and temp paths where appropriate.

Three completed attempts with the same failure and unchanged candidate constitute a
no-progress loop by default. Respect any lower existing stage budget. Different code
changes with the same failing check are not automatically a loop; existing repair limits
still cap them. Include provider continuations that repeat the same completed work.
Do not equate legitimately repeated final proofs with a loop.

### R4. One bounded recovery owner

The watchdog observes and requests recovery through the existing controller. It must not
edit state files directly or start providers itself. Reuse the shared allowed-action policy
from the companion PRD. Controller, API, and dashboard must agree on the next action.

For a confirmed idle timeout or transient failure, continue the preserved session/cursor
only when that stage already permits safe automatic continuation. Retain structured output
contracts and approval bindings. For repeated failures, stop the repeated operation and
prepare or offer a repair plan according to existing approval rules. Genuine sign-in,
quota, input changes, and required owner decisions must park with their specific action.

Use one accounted allowance across provider retries and watchdog recovery. Existing
provider retries consume it; the watchdog must not multiply them. For the first version,
allow at most one automatic transient continuation per interrupted stage invocation,
subject to stricter existing policies and the overall hard cap. Read-only stage policies
must not be silently expanded. A new invocation cannot evade a detected unchanged loop.
Record attempts durably before dispatch. Manual retry does not erase the loop history.

An active suspected loop receives a warning; cancellation/recovery must wait for a supported
safe checkpoint or a process deadline. Do not force a second writer to resolve uncertainty.

### R5. Survive server interruption safely

Persist observations, consumed allowances, incident identity, and the preserved cursor.
Use monotonic elapsed time within a process and explicit timestamps across restarts.
Do not interpret downtime or a clock adjustment as evidence of worker inactivity.
On startup, reconcile actual worker ownership before offering recovery. If prior worker
liveness cannot be established, park with a specific operator action; never launch another
writer on that assumption. Reuse existing ownership controls rather than claiming that an
in-memory timer guarantees exclusivity after a crash.

### R6. Explain the state and the next action

The dashboard shows the current stage/feature, last activity, last confirmed progress,
waiting command and deadline when known, recovery attempts used, and the monitoring state.
States include Working, Waiting for command, Progress unknown, Progress needs checking,
Recovering, and Action needed. Do not replace the authoritative run lifecycle with these
labels; expose them as supervision status.

An incident states: what was observed, what is uncertain, what recovery was tried, what
work is preserved, and the one valid next action. Link the named log and evidence.
For example: “Repair planning stopped after six minutes without output. One continuation
was used. Your verified features are preserved. Retry repair-plan preparation.”
Only show that action when policy actually permits it. If limits are exhausted, explain
why and offer the supported repair/diagnostic path instead of an inert Resume button.

Emit events on status transitions and recovery decisions, not on every timer tick.
Show failures in the dashboard even when no notification channel is configured.
Do not introduce email or other external messaging. Bound and redact diagnostic snippets.

### R7. Configuration and diagnostics

Reuse existing idle/hard/backoff settings. Add only the settings needed for progress
windows and completed-attempt loop thresholds. Document defaults and valid ranges, and
validate values. Keep elapsed-time caps enforceable when progress detection is disabled.
Use one monitoring timer for active work, stop it on terminal/parked states, and clean up
listeners on completion. Avoid polling provider sign-in commands every tick.

Provide a bounded incident record suitable for a recovery packet: trigger, stage/cursor,
observed activity/progress, fingerprints, attempts consumed, selected action, outcome,
and named logs. A health snapshot must distinguish server alive from worker progressing.

## Acceptance tests

Use fake providers/processes and controlled clocks for deterministic tests. Cover both
providers where their event/silence behavior differs. No paid calls are needed.

1. Silent worker reaches idle cap; only the existing allowed continuation runs; a second
   failure parks with a valid action and preserved cursor.
2. Continuous chatter without progress creates a warning but does not become verified work
   or bypass the hard cap. A healthy long command within its deadline is not killed.
3. Three unchanged completed failures stop repeated work. A changed candidate is distinguished,
   while the original repair budget remains bounded.
4. Legitimate repeated integration proofs and a slow successful planner do not trigger a
   confirmed loop solely because the same command or output appears again.
5. Provider retry and watchdog retry share accounting. Concurrent timer/API requests and
   repeated clicks start at most one worker. Restart does not replenish allowances.
6. Owner pause, sign-in, quota, stale inputs, ready-for-approval, and exhausted repairs show
   correct actions. The watchdog never auto-approves or resumes an owner pause.
7. Crash/restart with uncertain writer ownership parks safely. Wall-clock changes and server
   downtime do not create false timeout incidents.
8. API and dashboard derive the same action for a failed repair-planning phase. The action
   starts planning only, then reaches reviewed-plan ready state; implementation requires
   approval. Include a fixture resembling the preserved photo-library failure.
9. Successful completion stops monitoring, keeps evidence, and deploys only after all gates.
   Named logs survive; repeated observations do not flood the event history.
10. Removing progress observation, loop comparison, or shared attempt accounting makes the
    relevant regression fail. A test must exercise the controller, not just a status helper.

## Implementation sequence and delivery

First map the existing process/provider timeouts, run ownership, durable events, continuation
policy, and dashboard status. Identify reusable owners before adding a new module.
Then deliver small slices: observations/status; unchanged-attempt loop detection; bounded
controller recovery; restart reconciliation and user actions. Each slice needs its own proof.
Avoid an independent supervisor execution loop beside the factory loop.

An AI diagnostic advisor is deferred. If deterministic evidence cannot explain a failure,
produce a usable incident packet now. A future advisor must remain bounded and cannot
change gates, budgets, approvals, or scope.

Update README/SPEC and configuration docs with the actual behavior. Run narrow regressions,
the full suite, and distro precheck. Report limits honestly. An isolated optional real-provider
smoke test must reach a reviewed repair plan, not just report worker launch. Do not interrupt
or mutate the live photo-library run to test this feature.

Implement in the canonical dev repo only. Installation is a later, safe idle-boundary step
through generated distribution and the normal installer. No public push or release is
included. Keep concurrent changes intact.

## Prompt for Claude

Implement this PRD in the SoloFactory dev checkout. Read the companion provider-diagnostics
PRD and current uncommitted changes first. Reuse the existing controller and monitoring
controls. Preserve the active photo-library run. Deliver and test the slices above; report
which requirements passed and which remain blocked before recommending installation.
