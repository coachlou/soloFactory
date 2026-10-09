# SoloFactory

SoloFactory is a local-first software factory for one developer or a very small team. Its
Factory Guide interviews the owner, freezes a PRD/plan/acceptance contract, uses an existing
Codex or Claude Code subscription session to build the app, runs deterministic gates, repairs
bounded failures, reviews the result, and launches a health-checked local deployment with a
live telemetry dashboard.

It does not request or store an OpenAI or Anthropic API key.

## Requirements

- Node.js 22 or newer.
- Codex CLI signed in with ChatGPT (`codex login status` should say `Logged in using ChatGPT`),
  or Claude Code signed in with a subscription account.
- npm, available on `PATH`.

## Start

```bash
npm start
```

Open <http://127.0.0.1:4173>. The **Manual** button in the header opens the illustrated user
manual (`docs/manual/index.html`, also served at `/manual`). Answer the Factory Guide one turn at a time, review the
compiled brief, and choose **Queue for the factory**. **Attach files** drops an existing spec
(markdown, text, JSON, YAML, CSV) straight into the conversation and lets the Guide open a
mockup or screenshot (png, jpg, gif, webp); images are saved under the project's
`.factory/uploads/`. The brief joins that project's run
queue and you land back in a fresh interview, so the next release can be shaped while this
one builds. Runs in one project go one after another, each building on the last; runs in
different projects can overlap when `SOLOFACTORY_MAX_ACTIVE_RUNS` is above 1 (default 1).
A brief for a project that already shipped is specified as a follow-on release, and deploying
it stops the previous release's app. **Factory** in the top bar opens the board: every run
of every project by column, with slice progress; click a card to open that run.

A **project** is the workspace the factory builds into. Projects are discovered under
`SOLOFACTORY_ROOT` (default: the home, `.solofactory/`): any directory in `<root>/projects/`,
or a `<root>/<name>/` that contains `.git/`. The header selector switches projects or creates
one; a folder you make by hand under `projects/` shows up too. Selecting a project makes it
the current workspace: it is `git init`ed if needed, gets a project-owned `.aai/` (identity,
context, instructions — scaffolded once, yours to edit) plus `CLAUDE.md`/`AGENTS.md` anchors,
and both the Factory Guide and the build agents run inside it. Switching projects never
cancels a run. The app lives at the repo root; the factory commits after
the specification and after every passed gate set; the guide transcript
(`.aai/memory/interviews/guide.log`) and run evidence (`.solofactory/runs/<id>/`) are
gitignored along with `.factory/logs/`.

The generated app is deployed locally on an unused loopback port. Keep SoloFactory running
while using that app. This is the deliberately small v0.1 deployment contract; no cloud
account or secrets are needed.

## Codex model settings

Codex uses `gpt-6.1-sol` with `medium` reasoning effort by default. These settings
apply to the Guide, planning, coding, repair, and AI review. Deterministic tests run
as commands and do not use a model. Codex stage-specific model or effort settings are
not currently supported.

Override the defaults when starting the factory:

```bash
SOLOFACTORY_CODEX_MODEL=gpt-6.1-sol SOLOFACTORY_CODEX_REASONING_EFFORT=medium npm start
```

Pause active runs at a safe boundary before changing settings or restarting the
factory. Resume the preserved run after restarting; its completed features remain.

## Claude model settings

Claude uses `opus` with `medium` effort for the Guide, coding, and repairs.
Plan correction also uses `opus`. Specification, feature planning, plan review, recovery planning,
feature review, and final AI review use `fable` with `low` effort. Model aliases
resolve through the installed Claude Code CLI. Deterministic tests run as commands and do not use a model.

Override either profile when starting the factory:

```bash
SOLOFACTORY_CLAUDE_MODEL=opus SOLOFACTORY_CLAUDE_EFFORT=medium \
SOLOFACTORY_CLAUDE_REASONING_MODEL=fable SOLOFACTORY_CLAUDE_REASONING_EFFORT=low npm start
```

These profiles apply to Claude runs; the provider of an existing run remains
unchanged. Update the installation and restart at a safe pause boundary to load
new adapter settings.

## Verify the factory

```bash
npm test
```

The suite exercises intake validation, API-key scrubbing, command restrictions,
activity-aware agent timeouts, bounded same-session continuation, same-run recovery,
failure repair, the complete HTTP workflow, a real generated Node app, health checks, and
live metrics.

For a deterministic browser demo that does not consume subscription quota:

```bash
SOLOFACTORY_DEMO=1 SOLOFACTORY_HOME=./solofactory-demo npm start
```

## Report a problem or an idea

**Feedback** in the top bar, or **Report this run** on a failed, interrupted, or cancelled
run, opens a short form and previews a markdown report. Copy it and paste it into an issue.
The report contains what you typed plus, only when you tick the box, an allowlisted run
summary: version, platform, error code, failed stage, gate, counts, and recent lifecycle
event types. Your brief, transcript, agent output, and file paths are never included, and
nothing is sent anywhere until you send it yourself. **Copy & open email** copies the report and
opens a message to support@coachlou.com with the subject "SoloFactory Feedback"; paste the
report into the body.

To enable the **Search existing issues** and **Open GitHub** buttons, point SoloFactory at
your issue tracker:

```bash
SOLOFACTORY_ISSUES_URL=https://github.com/coachlou/soloFactory/issues npm start
```

The value must be exactly that shape, with no query string or fragment; anything else is
treated as unset and the buttons stay hidden. GitHub links carry only the issue template and
title. The report body always travels through your clipboard.

From Claude Code or Codex, *Report a problem with the factory* is always the last numbered
option: the agent drafts the same report and gives you the email route (or the issue link when
`SOLOFACTORY_ISSUES_URL` is set). It never sends anything itself.

### Error log

Every operational error is appended to `errors.jsonl` in the factory home
(`SOLOFACTORY_HOME`; `.aai/memory/solofactory/` in an installed folder), one JSON line each
with `at`, `version`, and `source`: `server` (a failed request), `run` (a run that failed),
`scheduler`, `browser` (every error notice the UI shows, plus uncaught errors), or `chat` (a
failed call the chat agent made). Messages are capped and scrubbed of paths and secrets. The
file never leaves your machine; `GET /api/errors?limit=50` returns the latest entries.

## Operational boundaries

- SoloFactory binds to `127.0.0.1` by default and handles one active build at a time.
- Generated code runs with your local OS permissions. The command allowlist prevents shell
  interpolation but is not a hostile-code sandbox.
- Never place credentials or production customer records in the interview.
- Common API-key environment variables are removed before coding agents and generated-app
  commands are launched. Subscription credentials stay in each CLI's own credential store.
- Agent work has a six-minute **idle** deadline that resets whenever output arrives and a
  separate 45-minute total safety cap. A quiet Codex session is resumed once after a
  15-second backoff; the wait itself makes no model call. Set
  `SOLOFACTORY_AGENT_IDLE_MINUTES`, `SOLOFACTORY_AGENT_HARD_MINUTES`, and
  `SOLOFACTORY_AGENT_BACKOFF_SECONDS` to change those bounds.
- Usage limits, authentication errors, network failures, toolchain failures, and permissions
  are never blindly retried. The dashboard explains the blocker and preserves a recovery
  packet that can be pasted into Codex for human-guided recovery.
- **Resume current run** continues the existing run ID and files from the failed stage.
  **Start over** remains an explicit secondary action that creates a new run. Both go to the
  front of the queue.
- **Pause** lets the run finish the stage it is in, commit the green tree, and park before
  the next one; **Resume** picks up there with nothing replayed. **Cancel run** stops now.
- A parked slice run offers **Restart from slice** for every completed slice after the
  first: the tree is rewound to the commit before that slice and it is rebuilt from there.
- A failed, interrupted, cancelled, or paused run holds its project's queue so nothing
  builds on a half-repaired tree. Resume it, start it over, or **Dismiss** it to let queued
  briefs run. **Remove from queue** drops a brief that has not started.
- A restart changes ambiguous in-flight runs to `interrupted`; they can be resumed from the
  preserved workspace.
- App telemetry is local aggregate data only: uptime, request/error counts, latency, and
  normalized routes. Bodies, headers, IP addresses, identifiers, and query strings are
forbidden by the output contract.

For iPhone outputs, installing Xcode is not enough if `xcodebuild` still points to the
standalone Command Line Tools. Select the full installation with
`sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`, then confirm
`xcodebuild -version`. TestFlight affects distribution, not this local build-tool selection.

See [SPEC.md](./SPEC.md) for the complete product, state, security, and acceptance contract.

## Planned features

Every new run plans before it builds. After the specification, a planner writes a
dependency-ordered feature plan (`.factory/slices.json` version 2) in which each must-have and
acceptance scenario has exactly one closing feature with executable proofs. A fresh reviewer
must approve that exact plan, bound to its digest, the frozen contract and a token, before any
code is written. Each feature then passes install/test/build, its own proof commands, a scoped
review bound to the reviewed source, and a checkpoint commit before the next one starts.
Plans, features and final integration each get two repairs; Resume never refills them. There is
no single-build option for new runs; older single and slice runs still resume. Details:
[SPEC.md §12](SPEC.md).

## Completion review gate

A completed worker turn is not review approval. After build/tests, the controller writes a fresh `.factory/review-request.json` covering every intake must-have (MH-n) and acceptance scenario (SC-n), bound to the run and frozen contract digest. The reviewer writes `.factory/review-result.json` and a human-readable REVIEW.md. Every check must pass with existing project-relative evidence files, verdict must be pass, and blockers must be empty. Missing, stale, malformed, partial, blocked or unevidenced reports fail the gate even if npm test passes. Reviewers must report missing capabilities and required browser/visual evidence instead of waiving scope.

Review failures use the existing bounded repair budget, then park the run. An explicit owner resume after a rejected review obtains a fresh review and authorizes another bounded repair cycle (two attempts by default). Attempt numbers remain monotonic so earlier failure files are retained. Automatic retries never renew this budget. Repairs after review (including deployment repairs) require re-review. The frozen contract cannot be narrowed during repair. Existing completed runs are historical and are not retroactively reclassified. A structured review still depends on honest behavioral assessment; the controller validates coverage, evidence presence and verdict consistency rather than proving arbitrary application semantics.

Review recovery diagnostics include every unfinished MH/SC with its full requirement, all reviewer blockers, artifact paths and repair-budget guidance. Dashboard Guide receives the selected project’s latest run snapshot and matching recovery evidence; it must not treat an existing PRD as proof of delivery or claim chat resumes execution. Matching older terse failures are enriched read-only without rewriting run history.

## Feature recovery within a preserved run

For an unresolved parked run with a matching failed review, choose **Plan feature
recovery**. An active run must first reach a safe stop through Pause. Planning
preserves the source, original contract and completed work, and produces a separate
execution plan mapping every unfinished MH/SC check to an owning feature slice.
Review the plan, then choose **Approve and start feature recovery**. Approval is
bound to the plan digest, source baseline, source review, and frozen contract.
A changed baseline rejects stale approval; regenerate the plan before starting.

Each feature runs deterministic gates and a scoped evidence review of both its
acceptance checks and the full original checks it owns. Completed features are
recorded durably; Resume continues at the unfinished feature. There are up to two
repairs per feature and two for final integration, bounded by the approved phase.
Recovery resumes do not replenish consumed budgets. The original full-contract
review still gates deployment. The run ID and original strategy are unchanged;
source reviews, feature reviews and prior phase histories remain available.

`POST /api/jobs/:id/recovery-plan` starts planning through the project scheduler.
Read the resulting plan at `GET /api/jobs/:id` under `job.recoveryPhase`.
`POST /api/jobs/:id/recovery-start` with `{"planDigest":"…"}` approves that exact
plan and queues execution. These controls reject active/queued project writers.
The run card shows planned/current/verified features, acceptance checks and budgets.
The Guide can explain this state; chat text alone does not execute recovery.

To revise a ready plan, enter feedback and choose Plan feature recovery again.
The planning endpoint accepts optional `guidance` text (up to 6000 characters);
prior candidate/history are preserved and old approval becomes invalid.

Prerequisite-only recovery slices may use an empty `checks` array, but still
require executable acceptance criteria. Every unfinished original check must
still have exactly one owning slice; its full evidence gate runs after its
prerequisites, and final review covers the unchanged full contract.
