# Adopt an existing app — spec

**Status: draft, 2026-11-12.** Not implemented. Owner answers so far (Lou, 2026-11-12):
copy the app into SoloFactory; repair failing tests on import; adoption may add files to the
app; non-Node apps and skills are in scope.

**Goal.** Bring an app that was built outside SoloFactory into a project, record what it
already does, prove that record with tests, and continue it with normal follow-on releases.

## Where we are

- A run is a follow-on release when the project already has `factory.json`
  (`src/factory.mjs:318`). A follow-on has no walking-skeleton slice, extends the existing
  code, and keeps the previous release live until the new one passes deploy.
- Without `factory.json`, the run is a first build. Its skeleton slice can overwrite an
  existing app.
- An imported app has no `PRD.md`, `ACCEPTANCE.md` or verified run. The Guide counts only
  verified behavior as baseline (`skills/factory-guide.md`), so it has nothing to protect.
- The output contract is Node-only. The coupling points are:
  1. `assertAllowedCommand` allows only `npm`, `node`, `npx` (`src/process.mjs:158`).
  2. Cased proofs, QA proofs and bug proofs run `node --test` with the case reporter
     (`src/factory.mjs:1432`, `:1523`, `:1655`).
  3. Prompts hard-code `npm test`, `node --test` and `package.json` (`TEST_SCRIPT_RULE`,
     `LINT_RULE` in `src/prompts.mjs`).
  4. `readManifest` requires `healthPath` `/health` and `metricsPath` `/_factory/metrics`.
     Deploy needs an HTTP server. A skill has neither.

**Manual path today (Node web apps only).** Copy the app into `projects/<name>/`. Write
`factory.json`. Add `/health` and `/_factory/metrics`. Make `npm test` and `npm run build`
pass. The next run is then a follow-on, with no baseline record.

## Phases

| Phase | Delivers | Size |
|---|---|---|
| 1 | Adopt Node web apps: import, survey, harness, repair, baseline review | Medium, 7 steps |
| 2 | Stack profiles and a runner-neutral proof format; Python web as the first non-Node stack | Large |
| 3 | Skill profile: adopt and build Claude skills | Large; needs an eval decision first |

Phase 1 delivers value alone and builds the adoption flow that phases 2 and 3 reuse.

## Phase 1 — adopt a Node web app

### Import

- New project dialog gains **From existing folder**. The owner gives a project name and a
  folder path on this machine (a git URL is open question 6).
- `POST /api/projects/import {name, source}` copies `source` into `projects/<slug>/`. The
  copy keeps `.git/`. It skips `node_modules/`, build output named in `.gitignore`, and
  `.solofactory/`. The original folder is never written to.
- The import refuses a source inside the SoloFactory root and a slug that already exists
  (409, as `POST /api/projects` does).
- `store.init()` runs as for any project. Note: it adds `data/` to `.gitignore`. Files
  already tracked under `data/` stay tracked.
- The import writes `.factory/adoption.json`:
  `{ source, importedAt, profile: "node-web", sourceHead, state: "imported" }`.
- While `adoption.json` has `state` other than `adopted`, the project shows an **Adopt**
  card in place of the interview. The Guide can answer questions but cannot queue a brief.

### The adopt run

A new job kind, `adopt`, that uses the normal queue, budgets, pause, cancel and resume.

1. **Survey** (agent, writes only under `.factory/`). The agent reads the code, docs and
   tests, then writes:
   - `.factory/PRD.md` — baseline: what the app does now, its users, data and
     integrations, as observed. Unknowns are listed as assumptions, not invented.
   - `.factory/FEATURES.md` — feature map: one entry for each user-visible capability, with
     its entry points (routes, screens, commands) and the files that implement it.
   - `.factory/ACCEPTANCE.md` — one observable scenario for each feature, in the Guide's
     "the actor can action and then result" form.
   - `.factory/requirements.json` — a synthesized brief with `origin: "adopted"`, every
     coverage key filled from the survey, and no transcript.
   - The existing gate (`spec_created_code`) holds: the survey creates no app code.
2. **Harness** (agent, writes app files). The agent adds `factory.json`, `/health`,
   `/_factory/metrics` (the SPEC §5 schema, as middleware), and one characterization test
   file for each feature that pins its current behavior. Rule: a test records what the app
   does now, not what it should do. A suspected bug goes in `.factory/ADOPTION.md`, not in
   a fix.
3. **Verify with repairs.** The normal gates: install, lint (if declared), test, build.
   Existing tests that fail get the normal repair budget (owner answer 2). A repair may
   change app code or the test. Each repaired failure is recorded in `ADOPTION.md` with
   the test name, the cause and the change, for the owner to review.
4. **Deploy.** The normal deploy gate: process alive, `/health` 2xx, metrics schema,
   `GET /` without a 5xx.
5. **Owner review of the baseline.** The run parks as `review_baseline`. The owner reads
   `PRD.md`, `FEATURES.md`, `ACCEPTANCE.md` and `ADOPTION.md`, then corrects them with the
   Revise-brief flow or accepts them. Accept marks the run `completed` as **Release 0
   (adopted)** and sets `adoption.json` `state: "adopted"`.

After Release 0, the project is an ordinary project. Every later run is a follow-on, and
the Guide treats the Release 0 scenarios as verified baseline.

### What adoption never does

- Write to the source folder.
- Add features, refactor, or change dependencies, except what a gate repair needs.
- Read or copy secrets into prompts. `.env*` files are handled per open question 3.

### Implementation steps (each ≤ 3 files)

1. `src/server.mjs`, `src/store.mjs` — import endpoint, copy with skip list,
   `adoption.json`. Test: import of a fixture folder copies it, keeps `.git`, skips
   `node_modules`, and leaves the source byte-identical.
2. `public/app.js`, `public/index.html` — **From existing folder** in the new project
   dialog; **Adopt** card. Test: card shows for an imported project and hides after adopt.
3. `src/prompts.mjs` — `surveyPrompt`, `harnessPrompt`, repair-prompt wording for
   adoption. Test: prompt snapshots.
4. `src/factory.mjs` — `adopt` job kind, stages 1–5, `review_baseline` park state,
   Release 0 on accept. Test: fixture provider adopts a fixture app end-to-end.
5. `src/interview.mjs`, `skills/factory-guide.md` — Guide refuses to queue a brief before
   adoption; reads adopted baseline as verified after it; baseline review reuses Revise
   brief. Test: interview with an unadopted project returns the adopt notice.
6. Docs — `SPEC.md` (new section and lifecycle row), `README.md`, manual, changelog,
   `distro/` sync.
7. Smoke — adopt one real outside Node app on Lou's machine; then run one follow-on.

**Dependency.** Step 5 reuses Revise brief. That work is not yet committed on the release
line (it sits uncommitted on `main`'s working tree and in commit 6df5048 on `test/new-ui`).
Land Revise brief first.

### Acceptance

- Importing a folder leaves the source folder byte-identical (hash before and after).
- An imported app with one failing test reaches Release 0, and `ADOPTION.md` names the
  repair.
- `FEATURES.md` lists every route of the fixture app; each has a scenario and a passing
  characterization test.
- A follow-on run after Release 0 has no walking-skeleton slice and keeps every Release 0
  test green.
- The Guide will not queue a feature brief for an unadopted project.

## Phase 2 — stack profiles (non-Node)

- `factory.json` version 2 adds `profile`. Version 1 means `node-web`, so existing
  projects do not change.
- A profile defines: the allowed executables, the default commands, the prompt rules that
  replace `TEST_SCRIPT_RULE` and `LINT_RULE`, the proof runner, and the deploy contract.
- **Proofs become runner-neutral.** A proof writes JUnit XML (pytest `--junitxml`,
  `go test` through gotestsum, and most other runners can). The controller reads cases from
  the XML. `node-web` keeps the current case reporter.
- **Web profiles** keep the deploy contract: `PORT`, `/health`, `/_factory/metrics`,
  `GET /`.
- First non-Node profile: `python-web` (allowed: `python`, `uv`, `pip`; tests: pytest).
- Every prompt that names npm or `node --test` takes its text from the profile.

## Phase 3 — skill profile

A skill has no server, port or URL, so it needs its own gates and its own meaning of
"released".

- **Gates.** Lint: frontmatter `name` and `description` exist and meet the length limits;
  every file the skill references exists; no secrets. Test: scenario evals under
  `evals/` (see open question 1).
- **Release.** The validated skill is packaged to `dist/<skill>/` (and `.skill`/zip). An
  optional install target copies it into a skills folder the owner names.
- **Interview.** The Guide's coverage keys need a skill variant: trigger phrases, inputs,
  outputs, tools used, and failure behavior replace `visual` and `deployment`.

## Open questions

1. **Skill evals (blocks phase 3).** SPEC principle 3 says agent prose cannot mark a gate
   green. A skill eval runs an agent. Options: (a) only deterministic checks on the files
   the skill produces; (b) allow an AI grader as a gate; (c) AI grading as advisory, shown
   at review but never gating. Recommendation: (a) as the gate, (c) as evidence.
2. **First non-Node stack.** Python is the recommendation. Which stacks do your real apps
   use, and which runtimes are on members' machines?
3. **Secrets in the copied app.** Copy `.env*` files (they stay gitignored and the app can
   run), or skip them and ask the owner to add them? Recommendation: skip and list them in
   the Adopt card; SoloFactory does not broker secrets (SPEC §2).
4. **Apps that need outside services** (a database, a third-party API). Adoption cannot
   deploy them locally without credentials. Park with a named blocker, or allow
   "adopted without deploy"?
5. **Large repos.** Prompts are capped at 200,000 characters. The survey reads files from
   disk, but a very large app may need a size limit or a chosen subfolder.
6. **Import from a git URL** as well as a folder? Recommendation: folder only in phase 1.
7. **Changes in the original after import.** Recommendation: one-way copy, no sync. A
   later re-import is a new project.
