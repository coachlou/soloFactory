# {{NAME}} — Behavior

## When this applies

Any request to build, resume, inspect, or report on a software project in this
folder: "build me an app that…", "start the factory", "what happened to
project X", "resume the last run", "show me the PRD", "where's the deployed
app". SoloFactory is this folder's agentic function; projects are its output.

## Inputs

| File | Kind | Load when |
|------|------|-----------|
| `~/.aai/identity.md`, `purpose.md`, `context.md`, `memory.md` | reference — the owner's global ambient home | always, **if `~/.aai/` exists**; then `~/.aai/rules/core.md`. Skip silently if absent. |
| `.aai/references/*.md` | reference — folder-level rules | always, if present |
| `.ailib/solofactory/` | vendored — resolve `.aai/skills/solofactory/` first (shadowing) | any factory operation |
| `.ailib/solofactory/app/README.md` | reference — how the app runs and its boundaries | before starting or troubleshooting the factory |
| `projects/<name>/.aai/*.md`, `.factory/*.md`, `.solofactory/runs/<id>/{state.json,events.jsonl}` | working — one project's context, contract, state, log | when the request names or implies that project |

## Process

1. **Start the factory** (deterministic): `bash start.sh` at the folder root
   (resolves to the `.aai/skills/solofactory/run.sh` fork if one exists, else
   `.ailib/solofactory/run.sh`). It serves
   <http://127.0.0.1:4173> and builds projects in `projects/<name>/`. Selecting a project in the
   header makes it the current workspace: the guide and the builders run inside it, and it
   carries its own `.aai/` (scaffolded once; edit freely) and `.aai/memory/interviews/guide.log`.
   A folder created by hand under `projects/` is picked up and initialised on first select.
   `SOLOFACTORY_DEMO=1` gives a
   deterministic demo that spends no quota.
2. **New project**: the owner answers the Factory Guide in the browser, reviews
   the compiled brief, and chooses *Start the factory*. Do not drive the
   interview for them; do help them phrase acceptance scenarios as observable
   behavior if asked.
3. **Inspect / report** (inference over working files): read only the named
   project's `state.json`, recent `events.jsonl`, and `.factory/` artifacts.
   Summarize state, stage, failures, and the deployment URL.
4. **Resume / recover**: interrupted runs are recoverable from the UI; point the
   owner there rather than editing `state.json` by hand.
5. **Update the factory**: re-run the installer from the library
   (`install.sh <this folder>`); it re-syncs `.ailib/` and leaves `.aai/` and
   `projects/` alone.

## Outputs

- `projects/<name>/.solofactory/runs/<id>/{state.json,events.jsonl}` → run state and lifecycle log
- `projects/<name>/` → the generated application (git repo, `git log` = build history), deployed on a loopback port
- `projects/<name>/.factory/{PRD,PLAN,ACCEPTANCE}.md` → the frozen contract
- `projects/<name>/.aai/` → the project's own context (committed) and `memory/interviews/guide.log` (ignored)
- `.aai/memory/solofactory/` → which project is active

## Rules

- The factory handles one active build at a time and binds to 127.0.0.1.
  Keep it running while a generated app is in use.
- Node 22+ and a signed-in `codex` or `claude` CLI are prerequisites; check
  them before diagnosing a "provider not found" error.
- Project ids look like `YYYY-MM-DD-xxxxxxxx`; refer to projects by id.
- Generated code runs with the owner's OS permissions. Never put credentials
  or customer records in a brief.
