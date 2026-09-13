# Run board and run controls — spec

Companion to `run-queue-spec.md`. Part A (the board) depends on nothing and can ship
first. Part B (controls) depends on the scheduler from the queue spec.

**Goal.** Show at a glance where every run is and how far along its slices are, and give
the owner four controls that are safe on a shared tree: pause at a boundary, resume, cancel,
and restart from an earlier slice.

## Facts the design rests on (verified 2026-09-13)

- `job.state` moves `queued → specifying → building → repairing → reviewing → deploying →
  completed`, or parks as `failed | interrupted | cancelled`. `stageHistory` holds every
  transition with timestamps.
- The slice loop emits `slice.started` / `slice.completed` and records `sliceStats[id]`
  (`startedAt`, `durationMs`, `repairs`, `verifyRuns`) plus `sliceDone` and `sliceIndex`.
- `verifyWithRepairs` commits after every passed gate (`factory: <gate> passed gates`), so
  each completed slice ends on its own commit. The hash is not recorded.
- Controls today: `POST /api/jobs/<id>/cancel`, `/resume` (parked → continue), `/retry`
  (new job, same brief, from scratch). The UI polls; there is no event stream.

## Part A — the board

**Model.** Nothing new is stored. `GET /api/board` aggregates every project's jobs into
columns keyed by state, collapsing `repairing` into `building` and `failed | interrupted |
cancelled | paused` into `parked`:

```json
{ "columns": { "queued": [...], "specifying": [...], "building": [...], "reviewing": [...],
               "deploying": [...], "parked": [...], "completed": [...] },
  "maxActiveRuns": 1, "active": 1 }
```

Each card: `{ jobId, project, promise, state, stage, startedAt, elapsedMs, slices?:
{ done, total, current, repairs }, blockedBy? }`. `slices` is present only for
`sdlc: "slices"` jobs and is derived from `slicePlanIds`, `sliceDone`, `sliceIndex`, and
`sliceStats`. `completed` shows the last 5 per project.

**UI.** A "Factory" view alongside interview and run: one column per state, cards as above,
a segmented bar per card (green done, pulsing current, grey remaining, red tick per
repair). Clicking a card opens that run. The header project marker (●) and queued badge
come from the same payload. Polling stays at the existing interval; the board is one extra
request per tick.

**Deliberately not shown.** Per-phase queue depth. Runs are serial within a project, so
"queued at build" would always read 0 or 1 and imply a pipeline that does not exist.

## Part B — controls

All four act on the project's tree, so every one of them is only legal when the target
job is that project's active run or is parked. The scheduler rule "one active run per
project" is what makes them safe.

1. **Pause** — `POST /api/jobs/<id>/pause`. Sets `job.pauseRequested = true` and returns
   202. `stage()` checks the flag before entering the next stage: if set, it commits the
   tree (`factory: paused`), parks the run as `state: "paused"` with a recovery record
   whose `failedState` is the stage that was about to start, clears the flag, and releases
   the project so the scheduler treats it like any parked run (queue behind it waits). A
   pause requested mid-turn takes effect at the end of that turn; the UI shows "pausing
   after <stage>". Pause inside the slice loop lands between slices. Rationale: a mid-turn
   stop wastes the turn and leaves the tree half-edited; a boundary stop leaves a green,
   committed tree.
2. **Resume** — existing `/resume`, extended to accept `paused`. No new code path: the
   recovery record already carries the stage and, for slices, `sliceIndex`.
3. **Cancel** — existing. Unchanged, except a `queued` job cancels by dequeue (queue spec).
4. **Restart from slice** — `POST /api/jobs/<id>/restart` with `{ fromSlice: "<id>" }`.
   Legal when the job is parked (any parked state) and `fromSlice` is in `sliceDone`.
   The controller resets the tree to the commit recorded *before* that slice
   (`git reset --hard <hash>`; the tree is a factory-owned repo, and everything after that
   commit is by definition machine output the owner asked to redo), truncates `sliceDone`
   and `sliceStats` to the slices before it, sets `sliceIndex`, and re-enters
   `buildSlices({ resumeFrom })` with the normal build prompt (not the continuation
   prompt). Requires one new field: `sliceStats[id].commit`, the hash after that slice's
   gate passed, recorded by `store.commit()` returning the hash. Restarting from the
   first slice is the existing `/retry`.

**Not in this spec.** Restart from an earlier *release* (an earlier job). It is a reset
across run boundaries that invalidates every later run's evidence. Wait for the demand;
if it comes, it is the same reset with a confirm that names the superseded runs.

## Implementation steps (each ≤ 3 files)

1. **Board endpoint** — `src/server.mjs` `GET /api/board` (reuses `discoverProjects` and
   each project's `JobStore.list()`); `src/store.mjs` nothing. Test (`test/e2e.test.mjs`):
   two projects, one running, one queued → columns populate; slices card carries
   `done/total`.
2. **Board UI** — `public/index.html`, `public/app.js`, `public/styles.css`: Factory view,
   cards, segmented bar, header badge.
3. **Pause/resume** — `src/factory.mjs` `stage()` flag check and `paused` park;
   `src/server.mjs` `/pause` route, `/resume` accepts `paused`. Test
   (`test/factory.test.mjs`, fixture provider): pause during slice 1 parks before slice 2
   with a `factory: paused` commit; resume finishes without replaying slice 1.
4. **Restart from slice** — `src/store.mjs` `commit()` returns the hash and
   `reset(hash)`; `src/factory.mjs` records `sliceStats[id].commit`, adds
   `restartFromSlice(job, sliceId)`; `src/server.mjs` `/restart` route. Test: a
   three-slice fixture run parked after slice 3, restarted from slice 2, leaves the tree
   at slice 1's commit and replays 2 and 3 exactly once each.
5. **Controls UI** — `public/app.js` / `index.html`: pause button while active, resume on
   `paused`, per-slice "restart from here" on parked slice runs. Then `SPEC.md` §4/§6/§9,
   README, version bump.

## Acceptance

- Board shows a run moving column to column and its slice bar filling; a queued job in
  another project sits in `queued` with the project name; `parked` shows the failed run and
  the queued job behind it says "waiting on recovery".
- Pause during slice 2 of 4: the run parks after slice 2 with the tree committed and tests
  green; resume completes slices 3 and 4 only.
- Restart from slice 3 of 4 on a parked run: `git log` shows slice 1 and 2 commits, then
  fresh slice 3 and 4 commits; `sliceStats` has exactly four entries.
- Pause, restart, and resume are refused (409) for a job that is neither the project's
  active run nor parked.
- `npm test` passes with the new tests.
