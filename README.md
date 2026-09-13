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

Open <http://127.0.0.1:4173>. Answer the Factory Guide one turn at a time, review the
compiled brief, and choose **Start the factory**.

A **project** is the workspace the factory builds into. Projects are discovered under
`SOLOFACTORY_ROOT` (default: the home, `.solofactory/`): any directory in `<root>/projects/`,
or a `<root>/<name>/` that contains `.git/`. The header selector switches projects or creates
one; a folder you make by hand under `projects/` shows up too. Selecting a project makes it
the current workspace: it is `git init`ed if needed, gets a project-owned `.aai/` (identity,
context, instructions — scaffolded once, yours to edit) plus `CLAUDE.md`/`AGENTS.md` anchors,
and both the Factory Guide and the build agents run inside it. Switching while a build is
running asks before cancelling it. The app lives at the repo root; the factory commits after
the specification and after every passed gate set; the guide transcript
(`.aai/memory/interviews/guide.log`) and run evidence (`.solofactory/runs/<id>/`) are
gitignored along with `.factory/logs/`.

The generated app is deployed locally on an unused loopback port. Keep SoloFactory running
while using that app. This is the deliberately small v0.1 deployment contract; no cloud
account or secrets are needed.

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
nothing is sent anywhere until you copy the report or open GitHub yourself.

To enable the **Search existing issues** and **Open GitHub** buttons, point SoloFactory at
your issue tracker:

```bash
SOLOFACTORY_ISSUES_URL=https://github.com/coachlou/soloFactory/issues npm start
```

The value must be exactly that shape, with no query string or fragment; anything else is
treated as unset and the buttons stay hidden. GitHub links carry only the issue template and
title. The report body always travels through your clipboard.

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
  **Start over** remains an explicit secondary action that creates a new run.
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
