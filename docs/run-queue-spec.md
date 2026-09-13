# Run queue and per-project scheduling — spec

**Status: implemented in 0.5.0.** This doc is kept as design record; SPEC.md is the source
of truth for current behavior.

**Goal.** Keep the owner and the factory both busy. Submitting a brief never waits for the
factory to be free, and the factory never sits idle while a brief is queued. Parallelism is
taken only where it is free: across projects. Within one project, runs stay strictly serial.

## First principles (2026-09-13)

Three resources: the owner's attention (interview, recovery decisions), agent turns (spec,
build, repair, review), and a project's git tree (one writer at a time, or merges). Every
stage of a run reads and writes the same tree, so stages cannot overlap inside a run without
merges. Two projects are two repos, so two runs can overlap with no merge risk. Therefore:

- **Unit of work is one brief = one release.** The interview produces it; the run delivers it.
- **Serial within a project.** A project has at most one active run; queued runs wait in FIFO.
- **Parallel across projects.** Up to `maxActiveRuns` runs at once (default 1, an env/config
  knob for subscription rate limits). Raising it is the only way to get concurrency.
- **The interview never blocks.** It runs in the viewed project, reads that project's files,
  and submitting enqueues. The chat is available again immediately.

Dropped, deliberately: stage-level pipelining (shared tree, nothing to overlap); worktrees
for independent slices (same utilisation is available across projects with no merges;
revisit only if `sliceStats` show one project waiting on idle capacity); carrying a frozen
brief through the chat (the project's `.factory/PRD.md` already holds that state).

## Where we are

| Today | After |
|---|---|
| `POST /api/jobs` → 409 while `busyJobId` is set | → 202 with `state: "queued"` |
| One `busyJobId` for the whole server | `active: Map<projectId, {jobId, factory, run}>` + a FIFO of queued `{projectId, jobId}` |
| Selecting another project 409s and offers to cancel the run | Selecting just changes the view; runs keep going |
| Startup marks non-terminal jobs of the *active* project `interrupted` | Same, for *every* project, and `queued` is left alone |
| Spec worker always writes a greenfield v1 | Follow-on mode when `.factory/PRD.md` exists |
| Guide interviews for "the app" | Guide reads `.factory/PRD.md` when present and scopes the next release |
| Each run's deployment lives forever | A completing run stops the project's previous deployment |

## Behaviour

1. **Submit = enqueue.** `POST /api/jobs` creates the job in the viewed project with
   `state: "queued"`, appends `{projectId, jobId}` to the FIFO, and returns 202. The client
   returns to the interview view with a fresh transcript.
2. **Scheduler.** One function, `drain()`, called after every enqueue and every run
   settlement: while `active.size < maxActiveRuns`, take the oldest queued entry whose
   project is not in `active`, open that project's `JobStore`, construct a `SoloFactory`,
   and start it. `job.state` moves `queued → specifying` as today. If no eligible entry
   exists, do nothing.
3. **Parked runs hold their queue.** A run that ends `failed | interrupted | cancelled`
   leaves `active` but its project's queued jobs do not start until the owner resolves it
   (resume, start over, or dismiss). `GET /api/jobs` reports `blockedBy: <jobId>` on such
   queued jobs so the UI can say "waiting on recovery of run X". A dismissed run frees the
   project. (Rationale: the tree may be mid-repair; a queued brief must not build on it.)
4. **Dequeue.** `POST /api/jobs/<id>/cancel` while `queued` removes it from the FIFO and
   marks it `cancelled`. No other state is deletable this way (an active run's `cancel`
   goes through `factory.cancel` instead).
5. **Follow-on releases.** The Factory Guide skill gains one rule: if `.factory/PRD.md`
   exists in the working folder, read it and `.factory/ACCEPTANCE.md`; treat them as already
   delivered; interview only for the next increment; the brief's `promise` names the
   release. The specification prompt gains a follow-on variant, selected by the controller
   when `.factory/PRD.md` exists: update `PRD.md` so it describes the product *including*
   this release, replace `PLAN.md` with the delta plan, replace `ACCEPTANCE.md` with this
   release's scenarios plus one standing scenario "every previously passing test still
   passes". Slice plans (when `sdlc: "slices"`) drop the walking-skeleton requirement
   because the skeleton exists; `src/wbs.mjs` skips that check when a manifest is present.
6. **Deployment replacement.** On `deploying`, the controller stops the project's previous
   live deployment (if any, tracked per project, not per factory) before launching the new
   one. The old job's `deployment.status` becomes `"replaced"`.
7. **Startup.** `recoverInterrupted()` runs for every discovered project. `queued` joins
   the terminal-like skip set so queued jobs survive a restart and are re-added to the
   FIFO in `createdAt` order.
8. **Project switching.** `selectProject` no longer cancels or 409s. The `cancel: true`
   option and the client's confirm dialog are deleted. `GET /api/projects` returns each
   project's `activeJobId` and `queued` count so the header can show ● and a badge.

## Out of scope

- Priorities, reordering, or scheduling across projects by anything but FIFO.
- More than one active run per project.
- Migrating existing `<home>/interviews/guide.log` or old jobs.

## Implementation steps (each ≤ 3 files)

1. **Scheduler** — `src/server.mjs`: replace `busyJobId/busyRun/launch` with `active`,
   `queue`, `drain()`; 202 on submit; `DELETE` for queued; startup recovery over all
   projects; `blockedBy`. `src/store.mjs`: accept `queued` in `recoverInterrupted`.
   Test (`test/e2e.test.mjs`, fixture provider): submit two briefs to project A → second
   is `queued`, starts after the first completes; with `maxActiveRuns=2`, a brief in
   project B starts while A runs; a failed run in A leaves A's queue `blockedBy` it.
2. **Follow-on mode** — `skills/factory-guide.md` rule; `src/prompts.mjs`
   `specificationPrompt({ followOn })`; `src/wbs.mjs` skeleton check conditional.
   Test (`test/factory.test.mjs`): a project with an existing PRD gets the follow-on
   prompt; a slice plan without a skeleton validates when a manifest exists.
3. **Deployment replacement** — `src/factory.mjs` `deployLocal`: per-project registry,
   stop previous child, mark replaced. Test: two sequential fixture runs in one project
   leave exactly one live child.
4. **UI** — `public/app.js` / `index.html`: queue badge and list, "Remove from queue",
   "waiting on recovery" banner, delete the switch-cancel confirm, return to the interview
   after submit. Then docs (`SPEC.md` §4/§9, README, INSTALL) and version bump.

## Acceptance

- In one project: interview, submit, immediately interview again, submit. Two jobs listed,
  first `specifying`, second `queued`; second starts automatically when the first completes;
  the second run's PRD describes both releases and its tests include the first release's.
- With `SOLOFACTORY_MAX_ACTIVE_RUNS=2` and two projects: a submit in each → both active;
  the header shows ● on both; switching between them never prompts to cancel.
- Fail the first run (fixture): the queued job shows "waiting on recovery"; dismiss it →
  the queued job starts.
- Restart the server with a queued job: it is still `queued` and starts when eligible.
- `npm test` passes with the new tests.
