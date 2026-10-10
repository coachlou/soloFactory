# Fix false provider diagnostics and repair-planning continuation

Status: implementation handoff for Claude; no code changes made by this document.
Date: 2026-10-10 (America/Toronto)
Authoritative repo: /Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory
Branch at investigation: wip/feature-slice-recovery, commit e314860.

## Problem and expected outcome

A repair planner stopped after an idle timeout. SoloFactory mislabeled it as a coding-agent
sign-in failure and instructed the owner to Resume. Both providers reported authenticated,
but Resume returned “That run cannot be resumed from its current state.” The owner signed
in repeatedly with no way to understand the correct action.

Fix both defects: diagnose failures from correctly framed execution evidence, and present a
continuation action that the controller actually accepts for the current recovery phase.
Preserve the existing bounded retry/repair policy, frozen inputs, approvals and evidence.
Do not weaken gates, replenish budgets, start over, introduce provider switching, or change
the generated photo-library app as part of this factory fix.

## Observed evidence

Installed factory: committed source e314860, updated via generated distribution and normal
installer. Dashboard: http://127.0.0.1:4173; project projects/medialibrary.
Preserved run: 2026-10-07-4f2dd1cf.

Failed planning phase: c70c7a41-5f0a-4b3b-92ff-400b7c25fd13.
State: failed; failedState: specifying; recoveryPhase.status: plan_failed.
Error: authentication; details.timedOut: true; timeoutReason: idle;
idleForMs: 360019; durationMs: 504610; autoResumes: 0.
Recovery banner said “Sign in through the provider CLI, then resume this run from its
preserved files”; recovery.canResume was true. The server nevertheless refused Resume.

Named log:
/Users/loudalo/Documents/photo-library-prototype/projects/medialibrary/.factory/logs/recovery-plan-c70c7a41-5f0a-4b3b-92ff-400b7c25fd13.log

Read-only reproduction with current exported detectProviderDiagnostics:

```js
const log = await readFile(namedLog, 'utf8');
detectProviderDiagnostics(log).map(d => d.code);                 // []
detectProviderDiagnostics(log.slice(-200000)).map(d => d.code);  // ['authentication']
log.slice(-200000).startsWith('{');                             // false
```

The log has 922291 JavaScript string characters. Authentication-like matches occurred in
successful command_execution events (status completed, exit_code 0), including printed
source constants UNAUTHORIZED and INVALID_CREDENTIAL. No non-command provider authentication
match was found in this inspection. This confirms the classification false positive; it
DOES NOT establish why the underlying worker stopped producing output.

Live /api/config reported both Codex and Claude installed and authenticated after the owner
signed in again. A single POST to the existing /recovery-plan endpoint was accepted and
started phase 4aa20708-ec4d-4754-9583-dedf01f47855, state specifying/planning, error null,
with fresh worker activity. Prior phases were preserved. That retry is evidence of the
correct continuation route, not evidence that planning or repair execution has completed.

## Root causes and code locations

1. src/process.mjs, runCommand output accumulation (~86):
   `output = (output + text).slice(-200_000)` truncates arbitrarily inside a JSON event.
2. src/providers.mjs, executionFailureText and detectProviderDiagnostics (~322–386):
   successful command events are already excluded when JSON parses. A truncated first
   record does not parse, enters the plain-text fallback, and includes source/spec content.
   The broad authentication regex then misclassifies it. providerFailure prefers that
   diagnostic over the genuine idle-timeout classification; the false diagnostic also
   suppresses the existing bounded automatic timeout continuation.
3. src/factory.mjs, buildRecovery (~1120–1180): recovery.canResume and diagnostic actions
   do not account for a failed planning phase. runResume (~180) rejects planning/plan_failed
   and requires planning retry, or approval when ready.
4. src/server.mjs, /resume (~432–445): independently rejects ready/planning/plan_failed with
   a generic error. ensureRecovery (~547) retains existing version-2 guidance unchanged.
5. public/app.js, resume visibility (~538) and renderRecovery (~557 onward): uses persisted
   canResume and displays the contradictory Resume action instead of a phase-specific retry.

## Implementation requirements

### A. Preserve diagnostic provenance across bounded output

Use a bounded, correctly framed diagnostic input. Do not parse an arbitrary partial JSON
record as trusted plain-text provider failure evidence. Prefer extracting structured failure
signals from complete events as they arrive, or retaining complete records separately from
the raw display tail. Preserve legitimate plain-text provider startup/transport errors.
Do not merely increase the tail size: a larger single event reproduces the same defect.

Keep actual authentication, quota, compatibility, network and permission failures detectable.
Distinguish provider authentication errors from successful source/spec/test output. A timeout
without a genuine diagnostic must retain its timeout code and existing bounded retry policy.
Keep the named full log available without copying credentials into dashboard diagnostics.

### B. Make continuation coherent across controller, API and dashboard

Derive the allowed action from the parked run AND recovery phase, with one authoritative
policy reused by the controller/API/UI rather than another set of conflicting predicates.

- plan_failed (including timeout/auth interruption): offer “Retry repair-plan preparation”
  through recovery-plan, preserving prior request/phase evidence and correction budgets.
- parked planning: use the supported planning retry path; never execute an unapproved plan.
- ready: offer review/approval, not ordinary Resume.
- running recovery: continue its preserved cursor when permitted.
- exhausted final review: Prepare repair plan; never renew the budget through Resume.
- active writer: no duplicate worker or continuation launch.

If actual sign-in is required, tell the owner to sign in THEN use the correct phase-specific
action. Return an actionable API refusal identifying the allowed next action/endpoint instead
of only “cannot be resumed.” Do not silently approve or execute repairs when retrying planning.

Existing saved version-2 recovery banners can be stale. Derive current presentation without
rewriting historical failures/events. Leave frozen contracts, source, owner data, completed
features, monotonic attempts and approval bindings intact. Make this preserved legacy run a
fixture for migration/presentation behavior; its original recovery plan is version 1.

## Acceptance and regression tests

1. A successful command prints >200000 characters containing UNAUTHORIZED, INVALID_CREDENTIAL
   and sign-in-like spec prose; truncate across its JSON record. No authentication diagnostic.
   Cover chunk boundaries, partial first records and oversized individual records.
2. Genuine provider structured auth errors and genuine plain-text startup auth errors still
   produce authentication diagnostics. Successful source output cannot masquerade as either.
3. An idle-timeout fake provider with source-only matches retains agent_idle_timeout and
   follows the existing bounded timeout continuation policy, without unlimited retries.
4. A saved failed planning job with recovery.version=2 and stale canResume=true presents
   planning retry. UI, controller and API agree; refusal directs to the correct action.
5. After restored authentication, one planning retry starts one planner, archives/preserves
   the prior phase, retains unfinished checks, and does not run implementation/deployment.
6. Ready plans still require exact approval; active writers remain exclusive; exhausted
   repair budgets and plan corrections are not replenished by retry or ordinary Resume.

Start with test/process.test.mjs diagnostic/provider fixtures and the existing recovery/HTTP
suites; include a dashboard presentation assertion. Run the full suite and distro precheck.
Any real-provider smoke test must use an isolated fixture workspace. Do not interrupt the
active photo-library planner to test this change.

## Delivery

Implement in the canonical dev repo/worktree only. Update relevant README/SPEC wording.
Report changed files, tests and remaining limitations. Installation into the photo-library
host is a separate step through generated distribution and the normal installer, only at
an idle/safe boundary. No edits to its vendored .ailib copy, manual job/event changes, public
push, release, or paid API fallback are part of this handoff.
