# SoloFactory progress

## Outcome

A local-first web application whose subscription-backed Factory Guide interviews one
owner, produces a durable PRD,
implementation plan, and acceptance contract, uses an authenticated subscription-backed
coding-agent CLI to build the app, runs deterministic install/test/build gates, repairs
bounded failures, launches a health-checked deployment, and shows live build and app
telemetry without a third-party analytics service.

## Non-goals

- Multi-user accounts, teams, permissions, billing, or enterprise deployment.
- Distributed queues, parallel workers, agent marketplaces, or arbitrary workflows.
- Storing API keys or metering per-token API usage.
- Claiming OS-level isolation for code executed on the owner's machine.

## Proof required

- Unit tests for intake and lifecycle invariants.
- End-to-end run using a deterministic fixture agent and a real generated Node app.
- Browser walkthrough of intake, review, running, evidence, and completion states.
- Factory server and generated app both answer health checks.

## Status

- [x] Product boundary selected.
- [x] Subscription-backed Codex CLI confirmed installed and signed in with ChatGPT.
- [x] Specification complete.
- [x] Factory implementation complete.
- [x] Factory Guide interview skill and coverage ledger complete.
- [x] Build and generated-app telemetry dashboard complete.
- [x] Automated verification green: 12/12 tests, including real HTTP deployment.
- [x] Real Codex subscription interview turn passed the strict response contract.
- [x] Browser verification green at desktop and 390px mobile width; no console errors.
- [x] Factory launched at `http://127.0.0.1:4173` with Codex detected as signed in via ChatGPT.
- [x] Replaced the fixed wall-clock timeout with output-aware idle timing plus a separate
      total safety cap.
- [x] Added one bounded same-session Codex continuation for clean idle timeouts, with no
      model call during backoff and no retry on known blockers.
- [x] Added structured recovery, same-run stage-aware resume, and a copyable HITL recovery
      packet; **Start over** is now a secondary action.
- [x] Full regression suite and live browser recovery walkthrough after server restart.
- [x] Pinned subscription-backed Codex factory work to `gpt-5.6-sol` for new and
      resumed sessions; interactive model changes can no longer switch a run to Astra.
- [x] Defaulted factory Codex work to low reasoning effort to conserve subscription
      capacity; both model and effort remain explicit environment configuration.
- [x] Added a specific incompatible-model recovery diagnosis instead of generic
      `provider_failed`, preserving the same-run recovery path.
- [x] Made the deployment telemetry gate accept both privacy-safe route lists and
      aggregate route-count maps; generated apps may use either documented aggregate form.
- [x] Cleared stale recovery cursors when resuming/completing, so a later deployment-only
      failure resumes at deployment and cannot replay build or review agent turns.

## Final regression and recovery pass (2026-09-03)

The complete suite runs green on the shipped tree: 19/19 tests pass (`node --test
test/*.test.mjs`), including the deterministic fixture HTTP journey, the legacy-blocker
HTTP recovery test, same-run resume, the output-aware idle/hard-cap timer tests, and the
classifier test proving a "permission denied" phrase inside a successful agent message is
not treated as a live blocker.

The factory server was restarted from the current tree (`node src/server.mjs`) and now
serves the owner-facing recovery surface for the preserved Snap & Go Nutrition run
(`2026-09-03-22af0b00`) at `http://127.0.0.1:4173`:

- `GET /api/jobs/2026-09-03-22af0b00` reports `state: failed` with
  `recovery.canResume: true`, `filesPreserved: true`, and a clean two-blocker diagnosis:
  package/registry network access (`network_unavailable`) and Xcode not selected for
  command-line builds (`xcode_not_selected`). The earlier "permission denied" misfire no
  longer appears — that phrase exists only inside the acceptance specification text in the
  build log and is correctly ignored.
- `GET /api/jobs/2026-09-03-22af0b00/recovery-packet` returns the copyable HITL handoff
  naming the failed stage, preserved workspace, the exact build log path, and both
  recommended actions, ending with "Do not start over or redo completed work…".
- All preserved artifacts serve 200: PRD, PLAN, ACCEPTANCE, requirements, and the
  validated `factory.json` manifest.
- Restarting the server was idempotent: the run stayed `failed` (no `interrupted` flip), no
  spurious events were appended, and the persisted version-2 recovery was not re-derived.
- The UI contract renders the recovery card (`aria-live`) with **Resume current run** as the
  primary action and **Copy recovery packet** / **Start over** as secondary ghost actions,
  populated from the API recovery block.

No model call was spent during this pass; the pending local action remains the owner's
`sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer` before a real
resume turn.

## Current native toolchain finding

`/Applications/Xcode.app` and TestFlight are installed. The active command-line developer
directory is still `/Library/Developer/CommandLineTools`, so `xcodebuild` cannot use the full
Xcode toolchain until the owner switches it to `/Applications/Xcode.app/Contents/Developer`.
This is now reported as a concrete recoverable blocker rather than a generic timeout.

## Browser-discovered repair

The first live walkthrough found that the factory server's `PORT` could leak into generated
app test commands. The generated fixture then tried to bind the factory's own port and the
controller correctly failed the run after its repair budget. The controller now removes
inherited `PORT` and `HOST` values from build gates unless explicitly supplied for deployment,
and generated servers start only when executed directly. The regression suite was rerun with
`PORT=4173` and passed 12/12.

## Vertical-slice SDLC strategy lands (2026-09-03)

A run can now choose between two build strategies at creation (`job.sdlc`):

- **single** (default, v0 behavior untouched) — one implementation turn for the whole app.
- **slices** — the specification worker also writes `.factory/slices.json` (2-6 vertical
  slices); the controller validates it (`src/wbs.mjs`: unique ids, concrete acceptance
  criteria, dependencies only on earlier slices, no dependencies on the walking skeleton),
  then executes one bounded agent turn per slice with controller-run gates after each:
  `install` once on slice 1, `test`+`build` per slice. Repairs stay scoped to the failing
  slice; the whole-project gate, review, and health-checked deploy still run after the last
  slice. `Resume current run` continues at the interrupted `sliceIndex`; finished slices are
  never replayed.

Comparison data: `job.sdlc`, per-slice `job.sliceStats` (duration, repairs, verify runs),
and a telemetry `summary` block (strategy, slices planned/completed, agent turns, repairs,
gate runs) are available per run via `/api/jobs/<id>/telemetry` and the slice plan is a
served artifact.

Observed (commands actually run, results actually observed):

- `node --test test/wbs.test.mjs` → 6/6 pass (plan validation, ordering, next-executable,
  mutation safety, dependency rules).
- `node --test test/factory.test.mjs` → 8/8 pass, including three new slice tests:
  full two-slice lifecycle with exactly one install, in-slice gate repair with per-slice
  stats, and a slice-mode resume that preserves partial workspace and completes all slices.
- `node --test test/e2e.test.mjs` → 3/3 pass, including a real HTTP slice-mode journey:
  reaches `completed`, serves the final slice's UI (`/Record your daily score/`), and
  exposes the slices artifact.
- `node --test test/*.test.mjs` → **30/30 pass** (was 20 before this work). Single-mode
  behavior and prompts are unchanged for existing runs.

Files: `src/wbs.mjs` (new engine), `src/factory.mjs` (`buildSlices`, slice-aware resume,
telemetry summary), `src/prompts.mjs` (slice spec/build/repair/continuation prompts),
`src/fixture-provider.mjs` (deterministic two-slice plan + per-slice writes),
`src/store.mjs` / `src/server.mjs` (sdlc persistence + validation), `public/` (build-strategy
selector + strategy stat), `SPEC.md` §12.

## Slice-plan quality gates land (2026-09-03)

Follow-up to the vertical-slice pass: tightened the spec worker's decomposition contract and
made the plan validator enforce quality instead of only structure.

What changed:

- `src/prompts.mjs` — the slice-mode specification brief is now a decomposition methodology:
  decompose against the frozen scenarios/workflow, never the file structure; each slice is
  the smallest increment that delivers whole scenarios end-to-end, keeps the app runnable
  with its whole suite green, adds no speculative or duplicated criteria, and depends only
  on earlier slices whose outputs it uses; cross-cutting constraints (health/metrics
  contract, mobile, keyboard, build) belong to the walking skeleton; a numbered self-check
  runs before the file is final.
- `src/wbs.mjs` — new enforced gates: scenario-coverage (every frozen acceptance scenario
  SC-1..SC-n must be tagged `[SC-n]` on at least one slice criterion; a missing tag parks
  the run naming the uncovered scenarios), duplicate-criterion rejection across slices
  (re-implementation is the top slice waste), and `demo` normalization (rejected when too
  thin) so every slice has an observable completion.
- `src/factory.mjs` — the plan validator now receives the frozen brief's acceptance-scenario
  count, so coverage is checked against the actual contract.
- `src/fixture-provider.mjs` — fixture plan conforms (SC-1 tag, demos).

Observed (commands run, results observed):

- `node --test test/wbs.test.mjs` → 10/10 (added coverage-required, missing-scenario
  reporting, thin-demo rejection, duplicate-criterion rejection).
- `node --test test/*.test.mjs` → **34/34 pass** (30 before this pass); single-mode runs
  and prompts unchanged.

## Front-loaded quality: interview scenarios and plan second opinion (2026-09-03)

Two of the three proposed front-loading improvements landed; the third (per-slice demo audit
during final review) is deliberately deferred until real slice-mode runs show gated slices
are not being delivered end-to-end.

What changed:

- `skills/factory-guide.md` + `src/interview.mjs` — acceptance scenarios are sharpened at the
  source: the Guide must write each scenario as one observable behavior an automated test
  could prove (split bundled behaviors, name observable outcomes, prefer 2-6 scenarios, add
  failure cases, never repeat a behavior), and the ready validator rejects duplicate
  scenarios and oversized (>400 chars) ones.
- `src/prompts.mjs` — `planReviewPrompt`: a fresh-context second-opinion decomposition
  review (scenario coverage SC-1..SC-n, walking skeleton contract, verticality/demoability,
  dedupe, dependency order) that may rewrite `.factory/slices.json` in place and nothing
  else.
- `src/factory.mjs` — slice-mode runs take the plan review after specification and before
  any build turn (`reviewSlicePlan`), validating the plan before AND after the turn; a
  reviewer leaving the plan invalid parks the run fail-closed as `invalid_slice_plan`.
  `job.planReviewed` records completion so resume never double-runs it. Resume from a
  failed plan review re-enters the specification stage where the plan can be corrected.

Observed (commands actually run, results actually observed):

- `node --test test/interview.test.mjs` → 7/7 (new: duplicate-scenario rejection,
  oversized-scenario rejection).
- `node --test test/factory.test.mjs` → 10/10 (new: plan review runs once before the first
  build turn; a plan review leaving the plan invalid parks `invalid_slice_plan` naming the
  missing scenario, and resume recovers to completed).
- `node --test test/*.test.mjs` → **38/38 pass** (34 before this pass). Single-mode runs,
  prompts, and gates unchanged.

Files: `src/interview.mjs`, `skills/factory-guide.md`, `src/prompts.mjs`, `src/factory.mjs`,
tests above, `SPEC.md` §12.

## Preserved Snap & Go recovery completed (2026-09-05)

Run `2026-09-03-22af0b00` resumed from its preserved workspace and completed. The
factory is explicitly pinned to `gpt-5.6-sol` with low reasoning effort, the missing
lockfile was repaired, test/build gates passed, contract review completed, and the local
health/telemetry deployment is live. Final factory regression: **40/40 pass**. Live checks
returned `status: ok`, finite aggregate telemetry, and zero server errors.

## Feedback reporting shipped (2026-09-06)

Spec: `docs/feedback-reporting-spec.md`. WP1 added `src/feedback.mjs` and
`POST /api/feedback/preview` (allowlisted diagnostics, fingerprint, scrubber, 400/413
validation, store-only reads so previewing never mutates run evidence). WP2 added the
`<dialog>` in `public/`, `.github/ISSUE_TEMPLATE/{problem,improvement}.yml`, and the
`SOLOFACTORY_ISSUES_URL` README section.

Observed:

- `node --test test/*.test.mjs` → **54/54 pass** (40 before). New: 11 unit tests including
  the leaky-fixture privacy test, 3 HTTP cases including byte-identical `state.json` /
  `events.jsonl` before and after preview.
- Browser walkthrough (embedded Chromium, 800px and 390px): Feedback and Report this run
  open the dialog with focus on Title; Problem mode preselected with diagnostics ticked for a
  failed fixture run; preview showed `quality_gate_failed`, `verifying`, the fingerprint and
  lifecycle table with zero forbidden strings; `<script>` and `#` in user text rendered inert;
  Copy report set the clipboard; Escape closed the dialog and focus returned to the trigger;
  with `SOLOFACTORY_ISSUES_URL` set, search and new-issue URLs carried title and template
  only.

## Projects as git repos (2026-09-07, in progress)

Definition (owner): a project is a workspace the factory builds into — a git repo living
at `<root>/<project>/` or `<root>/projects/<project>/`. Decisions: the factory commits at
stage boundaries (spec, each passed gate set, completion); run evidence lives inside the
project at `.solofactory/runs/<id>/` (gitignored).

- [x] Step 1 — `src/store.mjs` project-rooted (`appDir` = repo root, runs under
      `.solofactory/runs/`, `init()` = `git init` + `.gitignore`), `src/factory.mjs` commits
      at boundaries, spec-created-code check compares against a pre-turn snapshot.
      Interim: server points at `<home>/projects/default` until step 2.
- [x] Step 2 — server project registry: `GET/POST /api/projects`, `POST /api/projects/select`
      (409 while busy unless `cancel:true`), `SOLOFACTORY_ROOT` replaces `SOLOFACTORY_JOBS_ROOT`.
- [x] Step 3 — UI selector lists projects (name · last run · run count) + "+ New project";
      switching while busy → confirm → cancel → switch; active project's run history.
- [x] Docs/distro: `distro/run.sh`, `distro/instructions.md`, README, SPEC.

Observed: `npm test` → **56/56** (new: project-repo lifecycle with exact commit sequence;
HTTP registry with 409-while-busy, cancel-and-switch, per-project run lists, traversal id →
404). Demo browser walkthrough: header shows project + run selectors; "+ New project…"
created `projects/second-app` and switched; a build started there; switching back to
`default` mid-build raised the confirm, cancelled the run (`second-app` last run =
cancelled), and showed `default`'s completed run. On disk each project has the app at the
root, three `factory:` commits, a clean tree, and gitignored `.solofactory/runs/`.

## Project workspaces (2026-09-12)

Spec: `docs/project-workspaces-spec.md`. Selecting `projects/<name>` makes it the current
workspace: any directory under `projects/` is a project (`git init` on first open), it gets a
project-owned `.aai/` scaffolded once from `templates/project/` plus `CLAUDE.md`/`AGENTS.md`
anchors, the Factory Guide runs inside it with its transcript in
`.aai/memory/interviews/guide.log` (ignored), and context is committed at stage boundaries.
Installed folders on 0.1.0 predate the selector; the 0.3.0 sync delivers both.

Observed: `npm test` → **61/61** (new: scaffold-once/never-overwrite store test; e2e asserts
the guide's cwd/logPath are the active project and a hand-seeded `projects/seeded/` is
listed and initialised on select).

## Distro verification + install/update runbook (2026-09-13, 0.4.0)

`scripts/build-distro.sh` (was `build-distro-docs.sh`) now verifies the package, not just
copies INSTALL.md: required distro files exist, every `APP_FILES` path exists, and every
directory `src/` reads from the app root is shipped (dot-paths are runtime state and skipped).
`npm test` runs it as `pretest`; `npm run distro` rebuilds. `docs/INSTALL.md` gained a Step 0
fork (new install vs update, with a detection one-liner reading `.ailib/manifest.yaml`) and a
self-contained update path U1–U4 with its own done-list.
