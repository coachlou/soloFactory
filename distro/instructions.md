# solofactory

Turns a folder into a SoloFactory workspace and operates it. SoloFactory is a
local-first software factory: it interviews the owner, freezes a PRD/plan/
acceptance contract, builds the app with the owner's own Codex or Claude Code
subscription, runs deterministic gates, and deploys the result on localhost.
No API keys are requested or stored.

The capability ships the app itself in `app/` (a vendored snapshot — see
`app/VERSION`), so a folder that installs it works with no network and no
library reachable.

## Important

- **Node 22+ is required** and a signed-in `codex` or `claude` CLI. The
  installer warns if node is missing but still writes the scaffold.
- **Building spends subscription quota.** Never start a real build on the
  owner's behalf without an explicit go-ahead. `SOLOFACTORY_DEMO=1` is free.
- Never edit `.ailib/solofactory/` in a target folder — the next install
  re-syncs it. Personalize by copying to `.aai/skills/solofactory/`.

## Install — make a folder a SoloFactory workspace

**Installing for a non-technical owner?** Read `INSTALL.md` next to this file and follow it
instead of this section. It is a step-by-step runbook covering both macOS and Windows (WSL2),
with dependency detection, copy/paste blocks written for a beginner, and remediation for
every known failure. This section assumes the prerequisites are already in place; `INSTALL.md`
does not.

Without the library plugin (member one-liner, same result):

```bash
curl -fsSL https://raw.githubusercontent.com/coachlou/ambient-library/main/library/ambient-folder/bootstrap.sh | bash -s -- solofactory <target>
```

With the plugin installed:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/library/ambient-folder/install.sh" solofactory --check <target>   # plan only
bash "${CLAUDE_PLUGIN_ROOT}/library/ambient-folder/install.sh" solofactory <target>           # default: cwd
```

1. Confirm the target path with the user; show the `--check` plan.
2. Run the installer. It writes:

```
<target>/
├── .aai/                      # OWNED — written once, never overwritten
│   ├── identity.md            #   the workspace's identity
│   ├── instructions.md        #   behavior: build/resume/inspect/report; layers ~/.aai if present
│   ├── context.md             #   routing map
│   └── memory/solofactory/    #   which project is active (created on first run)
├── .ailib/                    # VENDORED — re-synced on every install
│   ├── manifest.yaml
│   ├── ambient-folder/        #   generic install/update script (dependency)
│   ├── ambient-folder/        #   generic install/update script (dependency)
│   └── solofactory/           #   this capability: run.sh, app/, templates/
├── start.sh                   #   root-level launcher → .ailib/solofactory/run.sh
├── projects/                  # one workspace per project (from the app, or a folder you make)
│   └── <name>/.aai/           #   the project's own context + memory/interviews/guide.log
├── CLAUDE.md, AGENTS.md       # discovery anchors (appended, never replaced)
```

3. Verify: `ls <target>/.aai <target>/.ailib/solofactory <target>/projects`.
4. Tell the user: start with `bash <target>/start.sh`, open
   <http://127.0.0.1:4173>, answer the guide, review the brief, start the
   factory. Each project is a workspace in `projects/<name>/` — selected in the header, with
   its own `.aai/` and the generated app at its root.

Re-running the installer (or `bash <target>/.ailib/ambient-folder/install.sh solofactory <target>`) is the **update** path: `.ailib/` is refreshed,
`.aai/` and `projects/` are untouched.

## Operate — inside an installed folder

The folder's own `.aai/instructions.md` governs; it was written from
`templates/aai/instructions.md` here. In short: `start.sh` (at the folder root)
runs `run.sh`, which starts the factory
with `SOLOFACTORY_HOME=<folder>/.aai/memory/solofactory` and
`SOLOFACTORY_ROOT=<folder>` (projects are any `<folder>/projects/*` directory, or a
`<folder>/*` child with `.git/`). Selecting one in the header makes it the current
workspace — the guide and builders run in it and it gets its own `.aai/` on first open.
Inspect a project by reading its `.aai/*.md`, `.factory/*.md`, `git log`, and
`.solofactory/runs/<id>/{state.json,events.jsonl}`.

## Maintain — refresh the library copy (library maintainers)

This capability is owned by the soloFactory repo (`distro/` + `APP_FILES`).
`library/solofactory/` is a build output — never hand-edit it. In soloFactory,
`npm run distro` rebuilds `distro/INSTALL.md` from `docs/` and verifies that every
directory the app reads at runtime is listed in `APP_FILES` (`npm test` runs the
same check, so a missing runtime asset fails the suite). After an app change is
committed there:

```bash
scripts/sync-distro.sh solofactory /path/to/soloFactory   # in the ambient-library dev workspace
```

Then audit, commit, and rebuild production. Bump `distro/.claude-plugin/plugin.json`
when the install contract changes so installed folders can see they are behind.

## Rules

- One operation per request: install, update, start, inspect, or sync.
- Never install into the library repo itself.
- Report in plain language: which folder, which files, what to run next.
