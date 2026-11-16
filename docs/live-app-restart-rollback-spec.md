# Two small briefs: restart live apps, roll back a shipped release

Status: briefs, agreed with Lou 2026-11-16. Not implemented. Grounded in `main` at 087218c.
Origin: thread "Compare solo CI/CD loop to SoloFactory".

---

## Brief A: start live apps again when SoloFactory starts

### Problem
A built app is a child of the SoloFactory server. When the server stops, the app stops.
On the next start, `recoverInterrupted` (`src/store.mjs:235`) sees the app does not answer and
records it as `stopped` ("App was not running after the restart"). Nothing starts it again.
The owner must press Relaunch on each project.

There is a second path. On a clean stop (Ctrl+C), `SoloFactory.shutdown()` (`src/factory.mjs:1996`)
kills each app, and the app's exit handler (`src/factory.mjs:1797`) records `stopped` before
the next start. So startup cannot tell "the server stopped it" from "the owner stopped it".

### Decision (Lou)
Restart only the apps that were running when SoloFactory stopped. Keep each app's old port
when that port is free; otherwise use a fresh port and say so.

### Behavior
1. Record why an app stopped: `deployment.stoppedBy` is `owner` (Stop button), `server`
   (shutdown, or an app recorded live that nothing answers for: SoloFactory crashed, was killed or the
   Mac lost power; found at startup or by the status probe), `replaced`, or `exited` (the app crashed
   by itself while SoloFactory ran).
2. Shutdown writes `stoppedBy: "server"` before it kills each app, so the exit handler keeps it.
3. At startup, after `recoverInterrupted`, relaunch each project's newest completed run whose
   app has `stoppedBy: "server"` and that `newerRunBlocks` does not block.
4. Relaunch tries the recorded port first. If the port is taken, use `availablePort()`.
5. A relaunch that fails its health, metrics or page check leaves the run `stopped`, emits
   `deployment.restart_failed` with the reason, and does not retry. No repair runs.
6. Startup does not wait for relaunches. The hub opens at once; apps come up in the background.
7. Emit `deployment.restarted` with the URL. When the port changed, the message names both ports.
8. `SOLOFACTORY_RESTART_APPS=0` turns this off. Default on.

### Not in scope
Apps the owner stopped. Apps that crashed by themselves (`exited`). Keeping apps running while
SoloFactory is stopped (no OS service, no daemon).

### Checks (offline, in `test/restart.test.mjs`)
- A fixture app running at shutdown is live again after a restart, on the same port.
- An app the owner stopped stays stopped after a restart.
- When the old port is taken, the app comes back on a new port and the event names both.
- An app that fails its health check on restart stays stopped with `deployment.restart_failed`.
- With `SOLOFACTORY_RESTART_APPS=0`, nothing is relaunched.
- An older completed run behind a newer undismissed run is never relaunched.

### Docs
README Operational boundaries ("Keep SoloFactory running while using that app" gains the restart
line), SPEC §5 and §6, manual Live app section, Settings table row for the new variable,
PROGRESS entry.

---

## Brief B: roll back a shipped release

### Problem
`src/server.mjs:515`: "A completed run is never rolled back or dismissed." Relaunching the
previous release is refused while the newer shipped run exists (`newerRunBlocks`,
`src/factory.mjs:88`). A release that passed every check but is bad in use can only be undone
by a new follow-on run or a manual `git reset`.

### Decision (Lou, revised 2026-11-16)
The backup warning comes before an update is deployed, not at rollback. At rollback, SoloFactory
tells the owner to restore the data they backed up, only if the shape of the data
changed materially since the update went live (Lou, 2026-11-16).

Rollback does not edit `data/`. `JobStore.reset` (`src/store.mjs:109`) runs `git reset --hard`
and `git clean -fd`, and `data/` is gitignored, so the files stay. The risk is that the older
code reads data the newer release wrote. That is why the backup is taken before the update.

### Behavior: before an update deploys
Only when the plan touches data (Lou, 2026-11-16). The plan does not exist yet at Send, so the
question is asked when the plan is approved, and only the deploy waits for the answer.
1. **Plan touches data.** The planner marks each feature `touchesData: true` when it adds, removes
   or renames stored fields, tables or files, or changes how stored data is read. The controller
   also sets it when a feature's declared `writes` include a file whose source names `data/`,
   `DATA_DIR`, or the app's store module. Either one is enough. A first release, or a project with
   an empty or missing `data/`, never asks.
2. **Ask early.** When such a plan is approved, the run card and the needs-you line show: "This
   update changes how your app stores its data. Back up `data/` now, so you can restore it if you
   roll back." A required checkbox: "I have backed up my app's data", and a Confirm button. It
   names the features that touch data.
3. **Build does not wait.** Features build, check and review as usual.
4. **Deploy waits.** If the run reaches deploy without the confirmation, it parks as
   `backup_unconfirmed` (*Waiting for your data backup*), with the same checkbox. Confirming
   resumes the deploy directly; it spends no repair budget and no model call.
5. The confirmation is recorded on the run (`dataBackupConfirmedAt`). A recovery plan that adds a
   data-touching feature after the confirmation asks again.
6. API: `POST /api/jobs/:id/backup-confirmed`. `GET /api/jobs/:id` returns `dataBackup:
   { needed, features, confirmedAt }`.

### Behavior: rollback
1. **Roll back to the previous release** shows on the newest completed run of a project when it
   is a follow-on, has a `baseCommit`, and the project has no running or queued writer.
2. Pressing it opens a confirm step: "This puts the app's code back to <previous release name>
   (<date>)." Buttons: Roll back, Cancel.
3. On confirm, the server: tags the current commit as `solofactory/rolled-back/<runId>` so the
   work can be recovered; stops the live app; runs `reset(job.baseCommit)`; marks the run
   `rolledBack: true` (state stays `completed`, so history and Done stay correct); then relaunches
   the previous completed run through the normal checks.
4. `newerRunBlocks` treats a `rolledBack` run like a dismissed one with a rollback point.
5. Shape-change test. When the update deploys, just before it starts, the controller records the
   shape of `data/` on the run (`dataShape`), not its content:
   - JSON and JSONL files: the set of key paths and value types (`habits[].name: string`), from
     every record, values ignored;
   - SQLite files: the table and column definitions from `sqlite_master`;
   - other files: the relative path pattern with ids and dates collapsed (`notes/<id>.md`).
   At rollback it computes the shape again. A material change is a key, column, table, type or
   file pattern that was added, removed or changed. New or edited records with the same shape are
   not a material change.
   No material change: the card says "Rolled back to <previous release name>. Your app's data
   kept the same shape, so the older version can read it." and gives no restore statement.
6. With a material change, the card names what changed (up to 5 items) and and the event message say: "Rolled back to <previous release
   name>. Press Stop, restore the copy of `data/` you backed up before this update, then press
   Relaunch so the app reads it." The previous release is already live; stopping it first keeps it
   from writing to `data/` while the owner restores it.
7. If the previous release fails its checks on relaunch, the run stays rolled back, the card says
   so, gives the restore statement when step 5 found a material change, and offers Relaunch again. No repair runs.
8. Events: `job.rolled_back` (with the tag name) and `deployment.relaunched`.
9. A rolled-back run keeps **Revise the spec**, so its brief can be fixed and queued again.
10. API: `POST /api/jobs/:id/rollback`.

### Not in scope
Rolling back more than one release at a time. Backing up or restoring `data/` for the owner. Undoing a rollback
in the UI (the git tag covers recovery by hand).

### Checks (offline)
- A follow-on whose plan has a `touchesData` feature shows the backup question once the plan is
  approved; a plan with none never asks.
- A feature that writes the store module counts as touching data even when the planner did not mark it.
- Unconfirmed at deploy: the run parks as `backup_unconfirmed`; confirming deploys it with no repair
  spent and no model call.
- Confirmed during the build: the deploy does not stop.
- A first release, and a follow-on with an empty `data/`, never ask.
- The deploy of a follow-on records `dataShape`.
- Rollback after the update added a JSON key, a SQLite column, or a new file pattern: the card and
  `job.rolled_back` carry the restore statement and name the change.
- Rollback after the update only added or edited records of the same shape: no restore
  statement, and the card says the data kept its shape.
- The shape ignores values, ids and dates: two records with different values give one shape.
- After rollback, the project tree matches the previous release's commit, the tag exists, and the
  previous release is live.
- A file in `data/` written by the newer release is still there after rollback.
- Rollback is refused while the project has a running or queued run.
- Rollback is refused on a run that is not the newest completed run, and on a first release.
- A new follow-on after a rollback builds on the previous release, not the rolled-back one.

### Docs
SPEC §4 Owner controls and §9 HTTP surface, manual (Live app and Done runs), README one line,
PROGRESS entry.

---

## Size and risk
Both are small: A touches `src/store.mjs`, `src/factory.mjs`, `src/server.mjs` startup;
B adds two endpoints, a `touchesData` plan flag, a deploy hold, two confirm steps in `public/app.js`,
and one flag in `newerRunBlocks`.
Neither changes how features build, check, review or repair; B adds one owner-gated hold before deploy. A can ship alone. They could go in one
release.
