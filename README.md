# SoloFactory

SoloFactory is a local-first software factory for one developer or a very small team. Its
Factory Guide interviews the owner, freezes a PRD/plan/acceptance contract, uses an existing
Codex or Claude Code subscription session to build the app, runs deterministic gates, repairs
bounded failures, reviews the result, and launches a health-checked local deployment with a
live telemetry dashboard.

It does not request or store an OpenAI or Anthropic API key.

## Requirements

- Node.js 22 or newer; Node 24 LTS is the recommended version. The installer warns on Node 25 and up, because some packages the factory builds with ship no prebuilt files for it yet.
- Codex CLI signed in with ChatGPT (`codex login status` should say `Logged in using ChatGPT`),
  or Claude Code signed in with a subscription account.
- npm, available on `PATH`.

## Start

```bash
npm start
```

Open <http://127.0.0.1:4173>. If that port is taken, the server says whether it is another SoloFactory (open that one) or another app (start with `PORT=5000 npm start`). The **Manual** button in the header opens the illustrated user
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
Specification, feature planning, plan review, plan correction, recovery planning, feature review,
and final AI review also use `opus`, with `low` effort. Model aliases
resolve through the installed Claude Code CLI. Deterministic tests run as commands and do not use a model.

Override either profile when starting the factory:

```bash
SOLOFACTORY_CLAUDE_MODEL=opus SOLOFACTORY_CLAUDE_EFFORT=medium \
SOLOFACTORY_CLAUDE_REASONING_MODEL=opus SOLOFACTORY_CLAUDE_REASONING_EFFORT=low npm start
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

- SoloFactory binds to `127.0.0.1` by default (`HOST` overrides) and runs one active build at a time unless `SOLOFACTORY_MAX_ACTIVE_RUNS` is raised (runs in one project always go one after another).
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
- While the factory server runs, it supervises its own active run (nothing is watched while
  the server is stopped, and preview servers are never watched). Each run card shows a
  supervision status beside the lifecycle state: **Working**, **Waiting for command** (a
  gate inside its own deadline, with its age and limit), **Progress unknown** (a worker that
  produces no output), **Progress needs checking** (output keeps arriving but no gate, commit
  or approved plan has landed within `SOLOFACTORY_PROGRESS_MINUTES`, default 20, 0–240, 0
  turns it off), **Recovering**, or **Action needed**. The warning never stops a worker; the
  idle and hard caps stay the deadlines.
- The one automatic continuation per stage is recorded in the run before it is dispatched, so
  Resume or a restart never grants another. When the same check fails the same way
  `SOLOFACTORY_LOOP_THRESHOLD` times (default 3, 2–10) on unchanged code, the factory stops
  repairing and says so instead of spending the rest of the repair budget. Repairs that do
  change the code are still bounded by the normal budget.
- A test or proof gate that runs past `SOLOFACTORY_GATE_MINUTES` (default 5, 1–60; install
  always gets at least 10) is stopped and the run parks with `gate_timeout`. No repair turn
  runs and no attempt is spent, because a killed command proved nothing about the app. Raise
  the limit and Resume if the checks are only slow.
- If the server restarts while a worker it launched is still running, the run parks with
  **Stop worker** and its pid; Resume appears once that process has exited. A worker that
  started before this version recorded no pid, so its liveness cannot be checked.
- No agent prompt exceeds 200K characters; larger inputs (plans, reviews, transcripts) go in files the agent reads. A prompt that still would not fit fails with `prompt_too_large` before any agent starts, and the dashboard offers no Retry for it: it is a factory defect to report.
- Usage limits, authentication errors, network failures, toolchain failures, and permissions
  are never blindly retried. The dashboard explains the blocker and preserves a recovery
  packet that can be pasted into Codex for human-guided recovery. Diagnostics read
  only complete output records, so source code in a successful command's output (for example
  an `UNAUTHORIZED` constant) cut at the 200K output cap is never mistaken for a sign-in
  failure and never suppresses the bounded idle resume.
- **Resume current run** continues the existing run ID and files from the failed stage.
  **Start over** remains an explicit secondary action that creates a new run. Both go to the
  front of the queue.
- **Pause** lets the run finish the agent turn it is in, commit the tree, and park before
  the next one, including a repair or plan correction; **Resume** picks up there with
  nothing replayed. The job API reports `pendingPause` until it parks. **Cancel run** stops now.
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
- Run cost: `GET /api/jobs/<id>/telemetry` includes `measurement`, derived from the run's event
  log. It breaks down planning, each feature and integration into agent time (implement, review,
  repair, planning), tokens, and controller gate runs. Gate runs show failures, timeouts, same-argv
  repeats, and repeats on an unchanged source candidate. For any saved run, use
  `node scripts/measure-run.mjs <run dir> [--json]`. Commands a worker runs inside its own turn are
  not observed, and older events without candidates give lower bounds; the report says so.

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
review bound to the reviewed source, and a checkpoint commit before the next one starts. The
feature reviewer reads the controller's gate logs and case results instead of rerunning those
commands. After a repair, the gate that failed runs first (behind install), then the full set.
Final integration reruns every verified feature's build-time proofs once, so a later feature that
breaks an earlier one is caught before the final review. A repair run reruns its own features'
proofs and the original plan's built features' proofs; a repair feature with the same id replaces the original.
Plans get two corrections (more while each review finds fewer blockers, at most three times
that); features and final integration each get two repairs. Resume never refills them. There is
no single-build option for new runs; older single and slice runs still resume. Details:
[SPEC.md §12](SPEC.md).

## Completion review, continuation and feature recovery

A completed worker turn is not review approval: every must-have and acceptance scenario needs
passing, evidenced checks before deployment. When a parked run can continue, one policy names
the allowed action (Resume, Prepare repair plan, Submit corrected plan for review), and a repair
plan that passes independent review starts its repairs on its own. If the stuck gate is a reviewer-written test that is itself wrong, the owner can waive it with a written reason; the waiver is recorded on the run. The full contract for the
review gate, continuation and feature recovery lives in
[SPEC.md, Completion review gate](SPEC.md#completion-review-gate) and the sections after it.
