# Drive SoloFactory from the chat

Read this when the owner wants to use the factory from Claude Code (or Codex) instead of the
browser: "build this with the factory from here", "run the factory in chat", "check on my
build". The browser UI and this guide use the same local JSON API, so a run started here
shows up on the board, and a run started in the browser can be watched from here.

## Important

- **A real build spends the owner's subscription quota.** Show the finished brief and get an
  explicit "go" before `POST /api/jobs`. Demo mode (`SOLOFACTORY_DEMO=1`) is free.
- **Jobs land in the *active* project.** Create or select the project first. The body of
  `POST /api/jobs` has no project field.
- **You are the Factory Guide.** Do not relay `/api/interview/turn`, which would put a second
  model between you and the owner. Read `app/skills/factory-guide.md` (next to this file) and
  follow its conversation rules: one question per turn, plain product language, and push vague
  words into observable behavior.
- The server binds to `127.0.0.1` and dies with its terminal. Start it in the background and
  keep it running while the build or the built app is in use.
- Never edit `state.json` or `events.jsonl` by hand. Every recovery action has an endpoint.

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
  "sdlc": "single",
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
- `sdlc`: `single` means one build turn. `slices` builds a walking skeleton first, then one
  gated turn per slice. Use `slices` for anything with more than a handful of must-haves.

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
| `/api/jobs/<id>/dismiss` | accepts the run as-is and unblocks the project's queue |
| `/api/jobs/<id>/pause`, `/cancel` | pauses or stops an active run, or dequeues a queued one |
| `/api/jobs/<id>/relaunch` | restarts a completed app whose server stopped |
| GET `/api/jobs/<id>/recovery-packet` | the diagnosis to read before suggesting a fix |
