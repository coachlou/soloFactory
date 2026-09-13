# Project workspaces — spec

**Goal.** Work on several projects from one installed SoloFactory folder, one at a time.
Selecting `projects/<name>` in the app makes that folder the current workspace: its
context, its memory, its git repo, and the folder every agent session runs in.

## Where we are (2026-09-12)

| Capability | Source (0.2.3) | Installed folders (0.1.0, synced 2026-09-07) |
|---|---|---|
| `projects/<name>/` git repos, header selector, "+ New project", remembered active project | ✅ | ❌ predates the selector |
| Build agents run with `cwd = projects/<name>` | ✅ | ❌ |
| Interview agent + log run in the project | ❌ `<home>/interviews/` | ❌ |
| Per-project `.aai/` context | ❌ | ❌ |
| Per-project memory | ❌ `<folder>/.aai/memory/solofactory/` | ❌ |
| Hand-made `projects/<name>/` (no `.git`) appears in the selector | ❌ requires `.git/` | ❌ |

The first two rows need no code: re-sync the distro and re-run the installer. The rest is
this spec.

## Layout of one project after this change

```
projects/<name>/               git repo; generated app at the root
├── CLAUDE.md, AGENTS.md       discovery anchors → .aai/ (appended if present, never replaced)
├── .aai/                      OWNED by the project — scaffolded once, never overwritten
│   ├── identity.md            what this project is (name, one-line purpose)
│   ├── context.md             routing map: .factory/, .aai/memory/, the app
│   ├── instructions.md        how agents behave here; defers to the folder-level .aai/ above it
│   └── memory/                gitignored
│       └── interviews/        guide.log — the Factory Guide transcript for this project
├── .factory/                  PRD.md, PLAN.md, ACCEPTANCE.md (committed), logs/ (ignored)
└── .solofactory/runs/<id>/    run evidence (ignored)
```

`.gitignore` gains `.aai/memory/`. Context is committed; memory is not.

## Behaviour

1. **Discovery.** Any directory under `<root>/projects/` is a project, `.git/` or not.
   Directly under `<root>/`, a directory still needs `.git/` (so `.aai/`, `.ailib/`,
   `node_modules/` never appear).
2. **Open = initialise.** Opening a project (startup, select, create) runs `store.init()`,
   which already `git init`s when missing. It additionally scaffolds `.aai/` from
   `templates/project/` for any file that does not exist, and appends the `CLAUDE.md` /
   `AGENTS.md` anchor line when absent. Existing files are never touched, so the owner and
   Claude edit freely.
3. **Agents run in the workspace.** The interview session's `cwd` and `guide.log` move from
   `<home>/interviews/` to `projects/<name>/.aai/memory/interviews/`. Builds already run in
   the project. `SOLOFACTORY_HOME` keeps only `active-project`.
4. **Switching** is unchanged: selector → `POST /api/projects/select`, 409 while a build runs
   unless the user confirms cancelling.

## Templates (`templates/project/`)

Three short markdown files with `{{NAME}}` substituted. `instructions.md` says: load the
parent folder's `.aai/` first if present, then this one; the contract is `.factory/`; the
transcript is `.aai/memory/interviews/guide.log`; never edit `.ailib/`.

## Out of scope

- Multiple projects active at once, or per-project ports.
- Migrating the old `<home>/interviews/guide.log` into a project (it is a folder-level log
  from before projects existed; leave it).
- A UI editor for `.aai/` files. The owner edits them in their editor or via Claude.

## Implementation steps (each ≤ 3 files)

1. `src/store.mjs` — `init()` scaffolds `.aai/` + anchors + `.aai/memory/` ignore rule;
   `templates/project/{identity,context,instructions}.md`. Test: init on an empty dir yields
   the files; init again leaves a hand-edited file byte-identical.
2. `src/server.mjs` — discovery relaxes `.git` under `projects/`; interview `cwd` / `logPath`
   use the active project. Test: a bare `projects/seed/` dir lists, selecting it `git init`s;
   the guide log lands in the project.
3. Docs — `README.md`, `SPEC.md` project section, `distro/templates/aai/*.md` and
   `distro/instructions.md` layout blocks; bump `package.json` + `plugin.json`.
4. Release — commit, `sync-distro.sh`, audit, rebuild; re-run the installer on the existing
   folder (this is also what delivers the selector to 0.1.0 installs).

## Acceptance

- Start the app in an installed folder with a hand-made `projects/alpha/` (no `.git`): it
  appears in the selector; selecting it creates `.git/`, `.aai/`, anchors, `.gitignore`.
- Run the guide in `alpha`, switch to `beta`, run the guide: two separate `guide.log`s.
- Edit `projects/alpha/.aai/identity.md`, restart the app: the edit survives.
- `git status` in `alpha` shows `.aai/*.md` tracked, `.aai/memory/` ignored.
- `npm test` passes with the two new tests.
