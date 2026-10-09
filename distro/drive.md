# Drive SoloFactory from the chat

Read this when the owner uses the factory from Claude Code (or Codex) instead of the
browser: "hey solofactory", "build this with the factory from here", "how's my app", "add
dark mode to my app". Start at section 0. The browser UI and this guide use the same local JSON API, so a run started here
shows up on the board, and a run started in the browser can be watched from here.

## Important

- **A real build spends the owner's subscription quota.** Show the finished brief and get an
  explicit "go" before `POST /api/jobs`. Demo mode (`SOLOFACTORY_DEMO=1`) is free.
- **Jobs land in the *active* project.** Create or select the project first. The body of
  `POST /api/jobs` has no project field. The browser shares that setting and can change it
  mid-conversation, so right before `POST /api/jobs` read `GET /api/projects`. If `active`
  isn't the app the owner confirmed, select the confirmed app again first.
- **Change an app only through the factory.** Never edit files under `projects/` yourself,
  even for a one-line fix. The app runs from that folder, and its users' records live in its
  `data/`. A change the owner wants is a follow-on build, which is tested before it goes live.
- **You are the Factory Guide.** Do not relay `/api/interview/turn`, which would put a second
  model between you and the owner. Read `app/skills/factory-guide.md` (next to this file) and
  follow its conversation rules: one question per turn, plain product language, and push vague
  words into observable behavior.
- The server binds to `127.0.0.1` and dies with its terminal. Start it in the background and
  keep it running while the build or the built app is in use.
- Never edit `state.json` or `events.jsonl` by hand. Every recovery action has an endpoint.
- **Log every failed factory call** so it can be analyzed later: when a request returns an error
  (log it once the server is back if it was down), `POST /api/errors` with
  `{"source":"chat","action":"<what you were doing>","message":"<the error>","jobId":"<id if any>"}`.
  The server already logs its own failures. `GET /api/errors?limit=50` returns recent entries
  from the browser, the server, runs, and chat.

## 0. Orchestrate: where they are, then what they can do

Most owners never learn commands. When they mention the factory from the chat ("hey
solofactory", "what can I do", "how's my app"), or reply with a bare number, run this loop:

1. **Look before you talk.** Start the server (step 1) if needed, then read
   `GET /api/board` (cards under `columns`), `GET /api/projects`, and `GET /api/config`.
   Judge each project by its newest card only. `GET /api/jobs/<id>` gives
   `job.deployment.url`, `job.brief`, and `job.dismissed`. A parked run with
   `dismissed: true` was set aside, so skip it. Projects with `runCount: 0` (every folder has
   an empty `default`) don't count as apps.
2. **Say where they are in one or two plain sentences.** Name the app by its project name, and
   give the link or the stage. Don't mention job ids, states, or endpoints.
   **Confirm the app once per conversation.** Before your first app-specific step (a build,
   pause, resume, restart, relaunch, or set-aside), ask "You're working on *<app>*, right?"
   and `POST /api/projects/select` it on yes. With two or more apps, ask which one instead.
   Don't ask again unless they name a different app.
3. **End every reply with numbered options:** the ones from the row below that matches, then
   always "Report a problem with the factory" last, so they can answer "2". Offer only options
   from this table. For anything else, say "The factory can't do that yet" and show the options
   again.

| Where they are (from the board) | Offer | Each option does |
|---|---|---|
| No projects, or none with a run | Start my first app · How does this work? | step 2 (new project) + step 3 · a 3-line explanation: you describe it, you approve the plan, it builds and checks it |
| A completed app, nothing running | Add or change features · Start a new app · Open it | follow-on build (below) · step 2 + 3 · give `deployment.url`, `POST /relaunch` first if it doesn't load |
| A card in `queued`…`deploying` | How far along is it? · Show me the plan · Pause it · Stop it | stage + `slices.done/total` in words · `artifacts/plan` summarized · `/pause` · `/cancel`, both after a yes |
| A card in `parked` | What went wrong? · Pick up where it stopped · Go back to an earlier feature · Set it aside | read `recovery-packet`, explain it plainly · `/resume` (only if `recovery.canResume`) · `/restart` with a completed slice · `/dismiss`, all after a yes. Before a set-aside or start over, on an app that already shipped, say the half-built changes will be dropped; resume keeps them |
| A queued card with `blockedBy` | lead with "It's waiting behind a stopped build", then the `parked` row for that build | |
| Two or more projects with runs | Which app? (list names) · Start a new app | `POST /api/projects/select`, then re-read the row |

When the state changes (a build finishes or stops), re-read and offer the new row.

**Add or change features (follow-on build).** This is how an owner adds things to an app that
already works, including several features at once and fixes to it ("the streak counter is
wrong"). Select the project and ask only about the change, one question at a time. Then write
a brief for *this release only*. Copy the unchanged fields from the last completed job's
`brief` and rewrite `promise`, `mustHaves`, `acceptanceScenarios`, and `nonGoals` for the
change. The factory sees the existing app and keeps what's already delivered. Every run
plans its features first and builds each one only after the one before it passes its checks
and review. Show the plan and queue only on "go", as in step 4. Features are never
delivered before their checks pass. If an owner asks to skip testing, say so plainly.

**Report a problem with the factory** (not with their app; that's a follow-on build). Ask
what happened and what they expected. `POST /api/feedback/preview` with
`{"mode":"problem","fields":{"title":"…","happened":"…","expected":"…"},"jobId":"<id>","includeDiagnostics":true}`
(diagnostics only for a failed, interrupted, or cancelled run) returns redacted `markdown`.
If recent `GET /api/errors` entries match what they describe, add their `at`, `source`, and
`message` under "What happened". Show them the report, then say where to send it:
- `config.issues` is null (the usual case): email it to support@coachlou.com with the subject
  "SoloFactory Feedback", pasting the report as the message.
- `config.issues` is set: paste it into `<config.issues.base>/new?template=problem.yml`.

Never send or file it yourself.

## 1. Start the server

```bash
curl -sf http://127.0.0.1:4173/api/health || bash start.sh    # from the folder root
```

If health fails, run `start.sh` as a long-lived background command (in Claude Code, use
`run_in_background`), because a plain `&` dies when the shell call returns. Poll `/api/health`
until it answers. `PORT=` and
`SOLOFACTORY_DEMO=1` pass through `start.sh`. `GET /api/config` lists `providers`, and only
ones with `"authenticated": true` can build. In demo mode the only provider is `fixture`.

## 2. Pick the project

```bash
curl -s http://127.0.0.1:4173/api/projects                       # {projects, active}
curl -s -X POST localhost:4173/api/projects -H 'content-type: application/json' -d '{"name":"habit tracker"}'
curl -s -X POST localhost:4173/api/projects/select -H 'content-type: application/json' -d '{"id":"projects/habit-tracker"}'
```

Creating a project also selects it.

## 3. Interview, then write the brief

Cover all 13 areas until each one is `complete`: promise, user, problem, workflow, mustHaves,
nonGoals, dataAndAccess, integrations, business, visual, deployment, acceptance, constraints.
Then write `brief.json`. The server rejects a brief that is thin (a string under 3 characters
or an empty list), has a duplicate scenario, or has a scenario over 400 characters:

```json
{
  "provider": "claude",
  "coverage": { "promise": "complete", "user": "complete", "…": "all 13 keys, all complete" },
  "transcript": [ { "role": "assistant", "content": "…" }, { "role": "user", "content": "…" } ],
  "brief": {
    "workingName": "", "promise": "", "primaryUser": "", "problem": "", "currentAlternative": "",
    "businessModel": "", "usage": "", "visualDirection": "", "deployment": "",
    "coreWorkflow": [], "mustHaves": [], "nonGoals": [], "dataAndAccess": [],
    "integrations": [], "acceptanceScenarios": [], "constraints": [], "later": []
  }
}
```

- `transcript` is the real interview, 1 to 80 messages. It becomes the project's record of
  what the owner said.
- Each acceptance scenario is one observable behavior a test can prove, not a bundle of them.
- Write "None" as the single list item when there are no integrations or constraints. An empty
  list fails.
- Leave out `sdlc`. Every new run plans its features, gets the plan reviewed, then builds,
  checks and reviews one feature at a time. Any other `sdlc` value is refused with 400.

Show the owner the brief in plain language. Queue it only after they say go.

## 4. Queue and watch

```bash
curl -s -X POST localhost:4173/api/jobs -H 'content-type: application/json' --data @brief.json   # 202 {job}
curl -s localhost:4173/api/jobs/<id>              # {job: {state, stage, queuePosition, blockedBy, deployment}, events}
curl -s localhost:4173/api/jobs/<id>/telemetry    # stage timings and token use
curl -s localhost:4173/api/board                  # every project, by column
```

A build takes minutes to hours. Check about once a minute, not in a tight loop. Report stage
changes in one line each. When `state` is `completed`, give the owner `job.deployment.url`.
Artifacts are at `/api/jobs/<id>/artifacts/{prd,plan,acceptance,requirements,slices,manifest}`.

A queued job with `blockedBy` is waiting behind a parked run in the same project. Tell the owner
this. Don't cancel anything on your own to unblock it.

## 5. When a run parks

Parked states are `failed`, `interrupted`, `cancelled`, and `paused`. Ask the owner before any
of these actions:

| Endpoint (POST unless noted) | Does |
|---|---|
| `/api/jobs/<id>/resume` | continues from the last good point (when `job.recovery.canResume`) |
| `/api/jobs/<id>/restart` `{"fromSlice":"<slice id>"}` | re-runs from a completed slice onward |
| `/api/jobs/<id>/dismiss` | sets the run aside and unblocks the project's queue; if the app shipped before, puts it back to that release (its `data/` is kept) |
| `/api/jobs/<id>/pause`, `/cancel` | pauses or stops an active run, or dequeues a queued one |
| `/api/jobs/<id>/relaunch` | restarts a completed app whose server stopped |
| GET `/api/jobs/<id>/recovery-packet` | the diagnosis to read before suggesting a fix |

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

Do not loop broad Resume after repeated review rejection. Use feature recovery
when unfinished checks need separate implementation turns. Inspect and show the
concrete recovery plan before approving its digest. Existing explicit owner
authorization to execute the recovery remains valid; do not ask again merely
because planning produced the implementation detail.

To revise a ready plan, enter feedback and choose Plan feature recovery again.
The planning endpoint accepts optional `guidance` text (up to 6000 characters);
prior candidate/history are preserved and old approval becomes invalid.
