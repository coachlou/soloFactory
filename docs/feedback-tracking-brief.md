# SoloFactory Feedback Reporting — Build Brief

## Working name

SoloFactory Feedback Reporting

## Product promise

Let a SoloFactory user turn a run failure or a manually reported idea into a concise,
privacy-safe GitHub issue without adding accounts, background telemetry, hosted storage, or
a GitHub token to SoloFactory.

## Primary user

The owner of a personal SoloFactory installation who wants to report a problem or suggest an
improvement while preserving control over what leaves their machine.

## Problem

SoloFactory already preserves useful run evidence locally, but there is no simple way to turn
that evidence into an actionable product report. A user must manually reconstruct the version,
provider, failed stage, error code, recovery attempts, and other context. This makes useful
reports less likely and inconsistent.

The solution must not turn every failed generated-app build into a SoloFactory bug. A failed run
is diagnostic evidence; the user decides whether it represents a SoloFactory problem, a feature
request, or nothing worth submitting.

## Current alternative

The user manually opens GitHub Issues, writes a report from memory, and copies selected details
from the SoloFactory dashboard or recovery packet. There is no consistent privacy boundary or
stable failure fingerprint.

## Core workflow

### Failure-initiated report

1. A run becomes `failed`, `interrupted`, or `cancelled` and retains its existing recovery
   actions.
2. The recovery area also offers **Report this run**.
3. SoloFactory opens a feedback dialog with **Problem** selected and a safe diagnostic preview
   generated from the current run.
4. The user describes what happened and what they expected, or changes the type to
   **Improvement**.
5. The user reviews the complete Markdown report and a clear notice that nothing is sent
   automatically.
6. The user may select **Search existing issues**, **Copy report**, or **Open GitHub**.
7. The user pastes the copied report into GitHub, edits it if desired, and chooses whether to
   submit it.

### User-initiated report

1. The user selects a persistent **Feedback** action from the SoloFactory interface.
2. They choose **Report a problem** or **Suggest an improvement**.
3. If a run is currently displayed, the user may include its safe diagnostic summary; otherwise
   the report contains no run diagnostics.
4. The user completes the short form, reviews the Markdown preview, and explicitly chooses
   whether to copy it or open GitHub.

## Must-have behavior

- Reuse SoloFactory's existing per-job `state.json`, `events.jsonl`, structured errors, recovery
  data, and telemetry summaries. Do not create a second activity journal.
- Add **Report this run** beside the existing recovery actions for terminal non-success states.
- Add a persistent **Feedback** action that works with or without a selected run.
- Use one feedback dialog with two modes: `problem` and `improvement`.
- Generate a complete Markdown preview before any external navigation.
- State plainly in the dialog: **Nothing is sent automatically. Review the report before sharing
  it.**
- Provide three independent actions:
  - **Search existing issues** opens a GitHub issue search for the stable fingerprint when one is
    available, or a search based on the user-entered title otherwise.
  - **Copy report** copies the displayed Markdown report to the clipboard.
  - **Open GitHub** opens the configured bug or feature issue form in a new browser tab.
- Keep recovery actions unchanged. Reporting must not replace or block **Resume current run**,
  **Copy recovery packet**, or **Start over**.
- Support a configurable GitHub Issues base URL using `SOLOFACTORY_ISSUES_URL`. If unset, keep
  **Copy report** available and hide or disable GitHub-specific actions with a clear explanation.
- Read the SoloFactory version from the application's package metadata rather than duplicating a
  version string.
- Add two GitHub issue forms: one for problems and one for improvements. The forms may set the
  existing `bug` and `feature-request` labels respectively, but must not require SoloFactory to
  authenticate to GitHub.
- Use a responsive, keyboard-accessible dialog. Focus moves into it when opened, Escape closes it,
  focus returns to its trigger, and every field has a visible label.

## Feedback fields

Problem fields: required short title, what happened, and expected result; optional additional
context; and an include-diagnostics choice shown only when a run is available. Diagnostics default
on when opened from **Report this run**.

Improvement fields: required short title, problem or friction, and desired outcome; optional
current workaround; frequency (`once`, `sometimes`, `often`); affected area (`interview`,
`specification`, `build`, `verification`, `recovery`, `dashboard`, `deployment`, `generated app`,
or `other`); and optional run diagnostics when available.

The first release does not capture or upload screenshots. A user may attach one directly in
GitHub after the issue form opens.

## Safe diagnostic report

Build the diagnostic section from an explicit allowlist. Do not serialize a job object, recovery
object, telemetry response, event object, or log and then attempt to remove sensitive fields.

Allowed values: SoloFactory version; `process.platform` and `process.arch`; Node.js version;
provider ID; build strategy; run and failed state; most specific normalized error code; failed gate;
repair, agent-turn, gate-run, and slice counts; elapsed whole seconds; stable fingerprint; and a
bounded curated lifecycle list containing only type, state, gate or slice ID, duration, and
timestamp.

Allowed event types: `job.created`, `job.failed`, `job.interrupted`, `job.cancelled`, `job.resumed`,
`stage.started`, `gate.started`, `gate.passed`, `gate.failed`, `slice.started`, `slice.completed`,
`agent.started`, `agent.completed`, `agent.backoff`, `deployment.started`, `deployment.stopped`, and
`job.completed`.

Do not include the event `message` property. Include at most the 20 most recent allowed events.

Never include interview messages, compiled brief, prompts, source or artifact contents, acceptance
criteria, agent output, provider responses, command or log output, command arguments beyond gate
name, environment variables, session IDs, paths, usernames, hostnames, URLs, ports, process IDs,
request data, customer records, credentials, or secrets.

After allowlisted construction, apply a small final scrubber for obvious credential patterns and
absolute paths as defense in depth. If the scrubber changes anything, show `[redacted]`. The
allowlist—not the scrubber—is the primary privacy boundary.

## Error selection and fingerprint

Choose the most specific normalized error code in this order:

1. The first recognized provider diagnostic code, when present.
2. The stored `job.error.code`.
3. `unexpected_error`.

Build the fingerprint from stable structured values:

```text
<provider>:<error-code>:<failed-state>[:<gate>]
```

Do not hash or normalize free-form error messages. Do not include the SoloFactory version, run ID,
timestamp, path, or exit code in the fingerprint.

The fingerprint groups similar evidence; it does not decide that a bug exists, automatically
create an issue, or prioritize implementation.

## Report format

Problem Markdown sections: title, What happened, Expected result, optional Additional context,
optional SoloFactory diagnostics, and optional Recent lifecycle. Improvement sections: title,
Problem or friction, Desired outcome, optional Current workaround, Context with frequency and area,
and optional diagnostics. Omit empty optional sections. Render user input as inert text, never
executable HTML.

## Data and access

Evidence and report construction stay local. Make no background feedback request, store no GitHub
token, call no GitHub API, and persist no report draft. Clipboard access and GitHub navigation occur
only after their respective user actions. Nothing is tracked until the user submits it on GitHub.

## Integration

GitHub Issues is the only external integration. The base URL must match
`https://github.com/<owner>/<repository>/issues` with no credentials, query, or fragment. Derive
existing-issue search and the two new-issue template URLs from it.

Use template selection and a short prefixed title in the URL. Do not put the complete report body
in a query string. The user copies and pastes the reviewed report into the issue form, avoiding
URL-length limits and accidental disclosure in browser history.

## Visual direction

Use one compact dialog with Problem/Improvement choice, short labeled fields, readable preview, and
privacy notice above the actions. **Copy report** is primary; search and GitHub are secondary. Add
no settings screen, report history, charts, or notification center.

## Deployment

The feature runs inside the existing local SoloFactory Node server and browser interface. It adds
no service, database, dependency, authentication system, migration, daemon, or deployment target.

## Acceptance scenarios

1. The user can open **Report this run** from a failed run and see a problem preview with safe error
   code, failed state, and fingerprint.
2. The user can open persistent **Feedback** without a selected run and create an improvement
   preview with problem, outcome, frequency, and affected area.
3. The user can disable run diagnostics and see no diagnostic section in the preview.
4. The user can copy Markdown identical to the visible preview.
5. The user can search GitHub for the URL-encoded fingerprint.
6. The user can open the matching issue form without an authenticated API call.
7. The user can omit `SOLOFACTORY_ISSUES_URL`, still copy, and see why GitHub is unavailable.
8. The user can preview a job containing transcripts, agent output, paths, session IDs, command
   output, URLs, and secret-like strings and see none in diagnostics.
9. The user can enter HTML-like text and see inert preview text with no script execution.
10. The keyboard user can close the dialog and have focus return to its trigger.
11. The user can report, resume, or start over without reporting changing run state or evidence.

## Constraints

- Keep this a compact vertical slice using pure, testable report and fingerprint functions.
- Validate all feedback lengths server-side if report Markdown is built by the server; use bounded
  fields and reject oversized requests with a clear error.
- Never infer that a failed generated application is a SoloFactory defect.
- Never submit, upload, or persist feedback automatically.
- Never send telemetry merely because a GitHub Issues URL is configured.
- Never expose raw job, event, recovery, telemetry, or log structures to the report builder.
- Do not add a dependency solely for dialogs, Markdown formatting, redaction, clipboard use, or URL
  construction; platform APIs are sufficient.
- Preserve both build strategies and existing recovery behavior.
- Add focused tests for report construction, fingerprint stability, URL validation, privacy
  exclusion, missing configuration, and the end-to-end preview flow.

## Non-goals

No automatic submission, classification, priority, assignment, or implementation; remote
telemetry; duplicate event store; Sentry or OpenTelemetry; hosted intake; GitHub authentication;
issue synchronization or backlog UI; AI report processing; attachments or log upload; saved drafts;
retention changes; or granular provider, stage, and error labels.

## Product authority rule

SoloFactory may preserve evidence and prepare a report. The user remains the authority over whether
that evidence leaves the machine, whether it represents a product problem, and whether it becomes
backlog work.
