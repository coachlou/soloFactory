# SoloFactory v0.1 specification

Status: implementation baseline  
Audience: one developer or a very small team building micro, mini, and personal SaaS apps

## 1. Product contract

SoloFactory is a local web app that turns an owner's answers into a working application.
It is a governed execution loop, not a general agent platform:

`Factory Guide interview -> frozen brief -> PRD + plan + acceptance -> build -> deterministic gates -> review -> verified deployment + live telemetry`

The factory succeeds only when it returns a reachable health-checked application URL and
preserves enough evidence to explain what happened. Generating attractive documents or
receiving a confident agent response is not success.

### Core user story

As a solo builder, I talk to a focused requirements agent that asks one useful question at
a time and shows what it has and has not yet learned. After reviewing the compiled brief, I
start the factory and leave. When I return I can see the current stage, the artifacts, the
exact verification result, live app activity, and either a working URL or a specific
failure I can recover from without discarding completed work.

### Design principles

1. One machine, one owner, one active build. Concurrency does not earn its place in v0.1.
2. A subscription-authenticated coding CLI does the semantic work. SoloFactory does not
   request, persist, or pass API keys.
3. The controller owns state, commands, gates, retries, and deployment. Agent prose cannot
   mark a gate green.
4. Files are the durable evidence boundary. Every run is inspectable without this UI.
5. A narrow Node/npm output contract trades stack freedom for repeatable verification.
6. Failure is loud and resumable. Interrupted work never remains labelled "running."

## 2. Scope

### v0.1 capabilities

- A subscription-backed Factory Guide skill that conducts a conversational interview,
  asks targeted follow-ups, and maintains a controller-validated coverage ledger for
  problem, user, workflow, scope, data, integrations, business model, visual direction,
  deployment, acceptance, and constraints.
- A review screen before execution; submitted answers become immutable run input.
- Automatic generation of `.factory/PRD.md`, `.factory/PLAN.md`, and
  `.factory/ACCEPTANCE.md`.
- Build and review stages executed by Codex CLI using the user's existing ChatGPT/Codex
  subscription session. A second CLI can be added behind the same adapter contract.
- Deterministic `install`, `test`, `build`, `start`, and `/health` checks supplied through a
  validated `factory.json` manifest.
- At most two repair attempts with the exact failed command and output fed back to the
  coding agent.
- Local deployment on an unused loopback port, followed by a real HTTP health check.
- Live build telemetry and privacy-preserving generated-app metrics for uptime, requests,
  errors, and latency. Metrics remain local and contain no request bodies or personal data.
- Atomic state snapshots, append-only event history, bounded logs, cancellation, same-run
  resume, and an explicit start-over option.

### Explicitly deferred

- Hosted multi-tenancy, role-based access, organization policy, SSO, or audit compliance.
- Parallel agents, work packets, distributed leases, child PRs, and scheduling.
- Remote production deployment presets. A local verified deployment is the v0.1 deploy
  contract; remote adapters should be added only after one real target is selected.
- Billing automation, secret brokerage, production data migrations, and domain/DNS changes.
- Support for non-Node output stacks.

## 3. Factory Guide interview contract

The main UI is a chat with the Factory Guide. Each turn is run through the selected
subscription CLI using the versioned prompt in `skills/factory-guide.md` and a strict JSON
response schema. The Guide asks exactly one question at a time, explains ambiguity when it
matters, and avoids implementation jargon unless the owner introduces it. The controller,
not the model, validates the returned shape and completion threshold.

The interview must collect:

1. Product promise and working name.
2. Primary user and triggering problem.
3. Current workaround and why it is inadequate.
4. The user's start-to-finish core workflow.
5. Must-have v1 behavior.
6. Explicit non-goals.
7. Data, login, payments, integrations, and sensitive-data constraints.
8. Visual tone and reference products.
9. Business model and expected usage.
10. Deployment expectation.
11. Observable acceptance scenarios.
12. Technical, time, legal, and accessibility constraints.

The structured response contains `message`, `status`, `coverage`, and `brief`. Coverage is
reported for each required category as `missing`, `partial`, or `complete`. The controller
will accept `ready` only when every required category is complete and at least one
observable acceptance scenario exists.

The full chat transcript and compiled brief are written verbatim to
`.factory/requirements.json`. The model may organize and clarify them, but must not silently
discard constraints or invent external credentials. If the provider is unavailable, the UI
reports the subscription/login problem; it never falls back to an API key.

## 4. Lifecycle and authority

| Stage | Semantic worker | Controller-owned exit gate |
|---|---|---|
| Intake | Factory Guide skill | response schema and every required coverage item validate |
| Spec + plan | subscription CLI | all three documents exist, are non-trivial, and no app code was created early |
| Build | subscription CLI | `factory.json` is valid and commands are within the executable allowlist |
| Verify | local controller | install, test, and build each exit 0 within timeout |
| Repair | subscription CLI | bounded attempt completes; controller reruns all gates |
| Review | subscription CLI | review completes; controller reruns tests and build |
| Deploy | local controller | process stays alive and `/health` returns HTTP 2xx |
| Complete | controller only | deployment URL and evidence are persisted |

The worker may edit only the generated app workspace. It cannot change job state directly.
Commands are spawned as argument arrays, never interpolated into a shell. The environment
passed to workers removes common API-key variables so subscription authentication remains
the intended path.

Agent timeouts are activity-aware. Output resets a six-minute idle deadline; it does not
extend the separate 45-minute total safety cap. An otherwise clean idle timeout may trigger
one same-session Codex resume after a 15-second backoff. No model is called during backoff,
and there is no retry loop. Recognized usage-limit, authentication, network, permission, or
toolchain errors suppress automatic retry so tokens are not spent repeating a known failure.

## 5. Output application contract

Every generated app must be a self-contained Node project with:

- `package.json` and a lockfile after installation;
- automated tests that exercise core acceptance behavior;
- a production build command;
- a start command that honors the injected `PORT` environment variable;
- `GET /health` returning a 2xx response without authentication;
- `GET /_factory/metrics` returning the local aggregate telemetry schema below;
- a concise operator README;
- `factory.json` in this form:

```json
{
  "version": 1,
  "commands": {
    "install": ["npm", "install", "--no-audit", "--no-fund"],
    "test": ["npm", "test"],
    "build": ["npm", "run", "build"],
    "start": ["npm", "start"]
  },
  "healthPath": "/health",
  "metricsPath": "/_factory/metrics"
}
```

Allowed command executables in v0.1 are `npm`, `node`, and `npx`. This is not a security
sandbox—package scripts are code—but it removes accidental shell interpolation and keeps
the contract reviewable.

The metrics endpoint returns:

```json
{
  "startedAt": "2026-09-02T12:00:00.000Z",
  "uptimeSeconds": 42,
  "requests": { "total": 12, "errors": 1, "active": 0 },
  "latencyMs": { "count": 12, "average": 18, "p95": 41 },
  "routes": [{ "method": "GET", "path": "/", "count": 7, "errors": 0 }]
}
```

Route values must be templates or normalized paths, not user-supplied URLs. No request or
response bodies, headers, IP addresses, account identifiers, or query strings may be
recorded. In-memory aggregates reset on app restart in v0.1.

## 6. State and evidence

A project is a workspace the factory builds into: any directory under `<root>/projects/`, or a
git repo directly under `<root>/` (`root` = `SOLOFACTORY_ROOT`, default the factory home). One
project is active at a time; every run and every agent session (Factory Guide included) runs
inside it. Opening a project initialises it: `git init` if needed, `.gitignore` rules, a
project-owned `.aai/` scaffolded once from `templates/project/` and never overwritten, and
`CLAUDE.md`/`AGENTS.md` anchors pointing at it. The factory commits after the specification
and after each passed gate set (`factory: <stage> passed gates`), so `git log` is the build
history; `.aai/*.md` and the anchors are committed with it.

```text
<project>/                 git repo; generated application at the root
  CLAUDE.md, AGENTS.md     discovery anchors → .aai/ (appended, never replaced)
  .aai/                    project context, written once: identity.md, context.md, instructions.md
    memory/interviews/     gitignored; guide.log = this project's Factory Guide transcript
  .factory/
    requirements.json
    PRD.md
    PLAN.md
    ACCEPTANCE.md
    recovery.json           failure evidence supplied to a resumed worker
    logs/                   gitignored
  .solofactory/runs/<id>/   gitignored run evidence
    state.json              atomic current snapshot
    events.jsonl            append-only lifecycle evidence
```

Canonical states are `queued`, `specifying`, `building`, `verifying`, `repairing`,
`reviewing`, `deploying`, `completed`, `failed`, `cancelled`, and `interrupted`. On startup,
any persisted nonterminal job is changed to `interrupted`; it may be resumed explicitly.
Only one job may be active because the target user does not benefit from resource races.

## 7. Failure behavior

- Command timeout, non-zero exit, invalid manifest, missing artifact, agent exit, and failed
  health check each produce a named error code and durable evidence.
- Logs are stored in full per stage but only bounded tails are returned to the browser.
- Repair receives the exact failed gate and log path. It never receives authority to skip or
  rewrite a gate.
- A failed run records its prior state, structured diagnostics, preserved workspace and log
  paths, retry disposition, and owner actions.
- **Resume current run** keeps the same run ID and workspace. Specification, build, repair,
  and review interruptions continue with a narrowly scoped worker; verification resumes at
  controller gates; deployment interruptions restart deployment. Completed work is not
  regenerated by default.
- **Copy recovery packet** produces a plain-language handoff for HITL chat with Codex. It
  names the failed stage, workspace, error, actions, and evidence path.
- **Start over** is a separate explicit action and creates a new run. It is not the default
  response to a recoverable interruption.
- Cancellation sends termination to the active child and records `cancelled`.
- Process restart converts ambiguous in-flight state to `interrupted`.

## 8. Security boundary

- The server binds to `127.0.0.1` by default.
- Paths are generated or resolved under the factory home; traversal is rejected.
- Common API credential variables are removed from agent and command environments.
- The UI warns owners never to paste secrets into requirements.
- Subscription CLI credentials stay in their native credential store and are never read by
  SoloFactory.
- Generated code executes with the owner's local OS permissions. v0.1 does not claim hostile
  code isolation; users should run it only in a trusted local account/workspace.

## 9. HTTP surface

- `GET /api/health` — factory health, active project, busy run.
- `GET /api/projects` — discovered projects with run count and last run; the active one.
- `POST /api/projects` — create `projects/<slug>` (`git init`) and select it.
- `POST /api/projects/select` — switch the active project (initialising it: `git init`, `.aai/`
  scaffold, anchors); `409 { busyJobId }` while a run is active unless `cancel: true`, which
  cancels it and waits before switching.
- `GET /api/config` — intake questions and available subscription providers.
- `POST /api/interview/turn` — run one Factory Guide turn inside the active project and return
  structured coverage; the transcript is appended to that project's `.aai/memory/interviews/guide.log`.
- `POST /api/jobs` — validate intake, freeze input, queue a run.
- `GET /api/jobs/:id` — current state and bounded event history.
- `POST /api/jobs/:id/cancel` — cancel active work.
- `POST /api/jobs/:id/resume` — continue a failed/interrupted run in its existing workspace.
- `GET /api/jobs/:id/recovery-packet` — return the HITL recovery handoff as plain text.
- `POST /api/jobs/:id/retry` — explicitly start over as a new run.
- `GET /api/jobs/:id/artifacts/:name` — fetch an allowlisted factory artifact.
- `GET /api/jobs/:id/telemetry` — combine lifecycle timing with the deployed app's local
  metrics response.

## 10. Acceptance ledger

The factory is ready when all of the following are demonstrated:

1. Thin answers are rejected and a complete interview can be reviewed and submitted.
2. An authenticated subscription provider is detected without reading an API key.
3. A deterministic fixture run creates all specification artifacts and a real Node app.
4. The controller catches a failed gate, requests repair, and reruns the gates.
5. A successful run reaches `completed` only after a real HTTP health check.
6. Restart recovery changes ambiguous active state to `interrupted`.
7. Path traversal and unsupported command executables are rejected.
8. The UI clearly distinguishes interview, review, active stages, failure, and working URL.
9. Build telemetry updates while a run is active, and app request/error/latency metrics
   update after deployment without transmitting personal data.
10. The factory's own automated tests and browser walkthrough pass.
11. The operator can start it with one documented command and no API key.
12. Agent output prevents an idle timeout, continuous output cannot bypass the total safety
    cap, and one clean silent timeout resumes the same Codex session.
13. A recognized blocker suppresses automatic retry, while manual resume retains the same
    run ID, workspace, and partial files.

## 11. Decisions deliberately left for observed demand

- Remote deployment: choose one real hosting target before adding an adapter.
- Git/PR automation: add only if generated apps are routinely promoted through GitHub.
- Database-backed queue: add only if concurrent or remote execution becomes necessary.
- More stacks/providers: add when a real app cannot fit the Node/npm contract.

These are extension points in the lifecycle, not components shipped pre-emptively.

## 12. Build strategies — single build vs vertical slices

A run chooses its build strategy at creation and keeps it for the run's life.

- `single` (default, v0 behavior): one implementation worker turn builds the complete
  application, then the controller runs the whole-project gates and review.
- `slices` (wbs-driven): the specification worker additionally authors
  `.factory/slices.json`, a machine-readable plan of 2–6 vertical slices. Slice 1 must be a
  thin walking skeleton that also creates the runtime manifest (`factory.json` v1 with
  install/test/build/start), `GET /health`, and privacy-preserving `GET /_factory/metrics`.
  Every later slice ends demoable with its suite green; dependencies reference earlier
  slices only.

### Slices contract

- Each slice object has `id` (SCREAMING-SNAKE, unique), `title`, `objective`, at least one
  concrete `acceptance` criterion, an optional `demo` sentence an observer can act on, and
  optional `dependsOn` naming earlier slices.
- The controller validates the plan (`src/wbs.mjs`) before any build turn: non-empty plan,
  unique ids, every dependency present and strictly earlier, no dependencies on the walking
  skeleton, and no acceptance criterion duplicated across slices (a duplicate means one
  slice re-implements another). An invalid plan parks the run as `invalid_slice_plan`.

### Slice-plan quality gates

Decomposition quality is enforced, not just requested:

- The spec worker numbers the frozen `brief.acceptanceScenarios` as SC-1..SC-n and tags each
  scenario-delivering criterion with `[SC-n]`. The controller requires every scenario to be
  referenced by at least one slice criterion; a missing tag parks the run naming the
  uncovered scenarios, so a plan cannot silently omit part of the contract.
- The spec worker plans against the brief's scenarios and workflow, never the file
  structure; each slice is the smallest end-to-end increment that leaves the app runnable
  and its whole suite green, and slice 1 is the walking skeleton carrying the manifest,
  `/health`, and `/_factory/metrics` contract.
- A `demo` sentence is normalized (rejected when too thin) so every slice has an observable
  completion an owner or reviewer can act on.

### Slices and recovery

- The build loop executes one slice per bounded agent turn (tests-first per slice), then
  controller-run gates: `install` once on the walking skeleton, `test`+`build` after every
  slice. A failed gate enters the bounded repair loop scoped to that slice (≤2 repairs,
  earlier slices preserved), then re-verifies. After the final slice the controller still
  runs the whole-project gate (test + build, no reinstall), the contract review, and the
  health-checked deployment — unchanged from the single-build path.
- Failure inside a slice parks the run with the same recovery record; `job.sliceIndex`
  persists which slice was interrupted. `Resume current run` continues at that slice with a
  same-session continuation prompt; finished slices are never replayed.
- `Start over` re-runs with the strategy the original job chose.

### Comparison data

Every run records `job.sdlc` and, for slices, per-slice timing and repair counts
(`job.sliceStats`). Telemetry (`/api/jobs/<id>/telemetry`) returns a `summary` block with
strategy, slices planned/completed, agent turns, repairs, and gate runs so a single-build
run and a slices run of the same brief can be compared field by field.

### Front-loaded quality: interview scenarios and the plan second opinion

Two upstream investments keep bad decompositions from ever reaching a build turn:

- The Factory Guide contract sharpens acceptance scenarios at the source: each scenario is
  one observable behavior an automated test could prove (the skill says to split bundled
  behaviors and add failure cases), and the ready validator rejects duplicate or oversized
  scenarios (>400 chars) so the brief cannot carry a scenario that is really three.
- Slice-mode runs take a second-opinion plan review: after the specification worker writes
  .factory/slices.json and before any build turn, a fresh-context agent audits and may
  rewrite the plan (scenario coverage, walking skeleton, verticality, dedupe, dependency
  order). The controller validates the plan before AND after that turn; a reviewer that
  leaves the plan invalid parks the run as invalid_slice_plan, and resume re-enters the
  specification stage where the plan can be corrected.

A per-slice demo audit during the final review is deliberately deferred until real slice-mode
runs show the gated slices are not being delivered end-to-end.
