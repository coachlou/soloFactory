# SDLC hardening: implementation specs for items 1, 2a, 6, 8a, 3a

**Status: implementation guide, written 2026-11-09 against `main` at b3e7a1b (0.10.17 + Unreleased).**
Source: `docs/sdlc-hardening-spec.md` (its Priority table: every Effort L item with Return M or H).
Line numbers are for b3e7a1b. Every earlier PR in the order below shifts them, so **find each place by
the quoted code, not by the number**.

## Implementation order

| PR | Items | Why this order |
|---|---|---|
| A | **1** Health-check before replace + **8a** Page check | Both edit `deployLocal` and the deploy repair branch in `deployAndComplete`. Do 1 first, then 8a in the same PR. |
| B | **2a** Token run ceiling | Self-contained in the budget code. |
| C | **6** Security line, secrets gate, `.aai/review.md` | Touches prompts, review request, store scaffolding and `verifyWithRepairs`. |
| D | **3a** Smoke release gate | Repo tooling only. Land it before the next version bump, so the release that carries A–C is the first one it gates (A–C change `src/factory.mjs` and `src/prompts.mjs`). |

Each PR: run `npm test`, add its PROGRESS bullet under `## Unreleased`, and append its docs to the
existing Unreleased `- Docs:` bullet (PROGRESS.md:6). Do not bump `package.json`'s version, commit a
release, or tag.

## Problems found in `docs/sdlc-hardening-spec.md`

1. **Item 1 is more than "a 30-line swap"** (spec:52). Today no field tells a parked run which
   release it would fall back to, so the card text and the "Dismiss, then Relaunch" path need a server
   field plus dashboard code. Also, if the new release fails its checks, nothing stops its child inside
   `deployLocal`. The deploy loop does (`stopApp(this.deployments.get(job.id))`, factory.mjs:1073), but
   `relaunch()` (factory.mjs:1760) does not, so a relaunch that fails its metrics check leaves an
   orphaned app.
2. **Item 1's "for the seconds a deploy takes"** (spec:74-76) understates it. The old app is stopped only
   inside `deployLocal`, so today it already runs from a tree whose files change for the whole
   follow-on build, not only during the deploy. The swap adds the deploy seconds to that. The code
   comment should say so.
3. **Item 1 names the wrong home for Dismiss** in the task brief: Dismiss and its rollback live in
   `src/server.mjs` (`rollBack` :163-167, route :454-473), not in `src/factory.mjs`. The relaunch rule is
   at factory.mjs:1760-1775, as the spec says.
4. **Item 2a has no default for `SOLOFACTORY_MAX_RUN_TOKENS`** (spec:115-118). This guide uses
   **25,000,000**: the 0.10.12 smoke spent 3.05M tokens for $4.08 (PROGRESS.md:50), so $30 is about 22M.
   `inputTokens` includes cache reads for both CLIs (providers.mjs:339-352), so the counts are mostly
   cache. The spec also does not say how Resume grants tokens to a run that parked before tokens were
   recorded. Use `details.spend.tokens`; see item 2a.
5. **Item 3a does not say what happens with no tags.** CI uses `actions/checkout@v4` with its default
   depth 1 and no tags (.github/workflows/test.yml:13), so `git describe` finds no tag there. The gate
   must skip, or every CI run fails. Other gaps the gate has to handle:
   - "Model defaults" (spec:134) live in `src/providers.mjs:77,244-256`, which is already on the path list.
   - Ledger rows carry a 7-character `commit` (scripts/smoke.mjs:24) and `brief` = the brief's `workingName`
     (src/measure.mjs:146), so matching is by hash prefix and name.
   - "The PROGRESS entry" means `## <version>`, as in the docs gate (build-distro.sh:41-43), not `## Unreleased`.
6. **Item 6 "listed among the review request's source files"** (spec:211) would break reviews. `request.sources`
   is re-verified by `validateReview` (review.mjs:61), which rebuilds the set from `.factory/uploads/`
   paths only (`uploadsOf`, review.mjs:31). An `.aai/review.md` entry would make every review fail with
   "Specs or prototype inputs changed".
   - Widening `sourceSet` itself (review.mjs:23) would change `planBaseline.inputs` / `sourcesDigest` for every
     existing run, so every parked run would turn `inputs_changed`.
   - Use a separate `reviewPolicy` field instead (item 6, step C).
7. **Item 6's credential gate leaves three things open** (spec:207-208):
   - Content or names? `feedback.mjs` SCRUB (feedback.mjs:60-65) matches file *contents*, and only its
     entries 3-4 are credentials (entries 1-2 are paths).
   - Which files? With the whole tree, a follow-on whose shipped tree already holds a match fails every
     gate with nothing the repair may fix. This guide scans only files the run added or changed.
   - The circular import: `feedback.mjs` imports `FactoryError` from `factory.mjs`.
8. **Item 6 "blockers with `qa/` bug tests"** (spec:206) applies to the final review only. Only
   `FEATURE_REVIEWED_SCOPE` (prompts.mjs:315-333) has the `qa/` bugs mechanism. Feature reviews report
   blockers only.
9. **Item 8a "empty body"** (spec:227-228) does not say whether a 4xx counts. This guide fails on any 5xx,
   a dead socket, or an empty body on a **2xx**. A 404 with a body passes, so API-only apps still
   deploy. `relaunch()` also goes through the page check.
10. **SPEC.md never documents the worker and cost ceilings** (they appear only in README:180-184, the manual
    and INSTALL), so "items move to SPEC.md as they ship" means 2a adds a new §7 bullet.

---

## Item 1: health-check a follow-on before stopping the live release

**Goal.** A follow-on release starts on its own port while the previous release keeps running. The old
app is stopped only after the new one passes `/health`, `/_factory/metrics` (and, with 8a, `/`). A failed
deploy leaves the last good release live, and the parked card says where it runs. If it is not running,
the card offers **Dismiss, then Relaunch <previous run>**.

### Files and current code

- `src/factory.mjs:81-83`: module-level `liveByProject` (`const liveByProject = new Map();`).
- `src/factory.mjs:1677-1747` `deployLocal(job, manifest, signal)`. The block to move is :1682-1700:
  ```js
  const previous = liveByProject.get(appDir);
  if (previous) {
    liveByProject.delete(appDir);
    if (previous.jobId !== job.id) { try { const old = await this.store.read(previous.jobId); if (old.deployment?.status === "live") { old.deployment.status = "replaced"; ... await this.emit(old.id, { type: "deployment.replaced", ... }); } } catch {} }
    stopApp(previous.child);
  }
  ```
  - :1718 registers the new child too early: `liveByProject.set(appDir, { jobId: job.id, child });`
  - :1738-1746 runs the checks: `await waitForHttp(...)`, `fetchJson(metrics)`, `validateMetrics(metrics)`,
    then the exit check `"right after its health check"`.
- `src/factory.mjs:1055-1098` `deployAndComplete`. Its catch (:1069-1086) repairs only
  `invalid_metrics` / `deployment_exited`. `health_check_failed` (from `waitForHttp`, :2141-2156) parks.
- `src/factory.mjs:1759-1775` `relaunch(jobId)`. The newer-run rule is at :1765-1767:
  ```js
  const runs = await this.store.list();
  const newer = runs.slice(0, runs.findIndex((run) => run.id === job.id));
  if (newer.some((run) => !(run.dismissed && run.baseCommit))) throw new FactoryError("not_relaunchable", "A newer run exists in this project; relaunch that one.");
  ```
- `src/server.mjs:404-411`: the `GET /api/jobs/:id` route (`const jobMatch = ...`), the dashboard's poll source.
- `src/server.mjs:454-473`: Dismiss (calls `rollBack`, sets `dismissed`). `src/server.mjs:579-590`: Relaunch route.
- `public/app.js:690-709` `renderRecovery()`. The "Spent so far" line is built at :703-709
  (`features.append(line);`).
- `src/store.mjs:213-231`: `list()` returns runs **newest first** by `createdAt`.

### Steps

1. **Extract the relaunch rule** (factory.mjs, near `relaunch`). Add an exported pure function and use it in `relaunch()`:
   ```js
   // A newer run blocks a relaunch only if its work may still be in the folder: set aside with a rollback
   // point means the server rewound it. runs: JobStore.list(), newest first.
   export function newerRunBlocks(runs, jobId) {
     return runs.slice(0, runs.findIndex((run) => run.id === jobId)).some((run) => !(run.dismissed && run.baseCommit));
   }
   ```
   In `relaunch()`, replace the two `newer` lines with
   `if (newerRunBlocks(await this.store.list(), job.id)) throw new FactoryError("not_relaunchable", "A newer run exists in this project; relaunch that one.");`.
   Keep the message identical (tests match `/newer run/`).

2. **Move the retirement out of the pre-launch path.** Add a method next to `deployLocal`, with the
   existing block's body moved in unchanged:
   ```js
   // Retires the project's previous release once the new one passed its checks (docs/sdlc-hardening-spec.md item 1).
   async retirePrevious(job, appDir) {
     const previous = liveByProject.get(appDir);
     if (!previous) return;
     liveByProject.delete(appDir);
     if (previous.jobId !== job.id) { /* the existing try { ... "replaced" ... deployment.replaced ... } catch {} block, unchanged */ }
     stopApp(previous.child);
   }
   ```
   Delete :1682-1700 from `deployLocal`, and the `liveByProject.set(...)` at :1718.

3. **Wrap the checks and register the new child last.** Replace :1738-1746 with:
   ```js
   await this.emit(job.id, { type: "deployment.started", state: job.state, message: `Waiting for ${url}${manifest.healthPath}` });
   try {
     await waitForHttp(`${url}${manifest.healthPath}`, child, signal);
     // (unchanged) metrics fetch + validateMetrics(metrics)
     // (8a inserts checkPage here)
     if (child.exitCode !== null || child.signalCode !== null) throw new FactoryError("deployment_exited", `App exited with ${child.exitCode ?? child.signalCode} right after its health check.`);
   } catch (error) {
     stopApp(child); // a release that failed its checks never replaces the live one
     throw error;
   }
   // The previous release served until now. It reads the new release's files for anything it loads from disk per
   // request, as it already did during the whole follow-on build; this adds the seconds the checks take.
   await this.retirePrevious(job, appDir);
   if (child.exitCode === null && child.signalCode === null) liveByProject.set(appDir, { jobId: job.id, child });
   return { mode: "local", status: "live", url, port, pid: child.pid, startedAt: new Date().toISOString() };
   ```
   Keep everything else in `deployLocal`: the `signal.aborted` / `this.closed` checks before spawn,
   `this.deployments.set(job.id, child)` at spawn time (shutdown must still kill it), the abort listener,
   and the `exit` handler.

4. **Card data (server).** Add an exported pure function in factory.mjs (next to `newerRunBlocks`):
   ```js
   // The release a parked follow-on falls back to, for its card. runs: JobStore.list(), newest first.
   export function previousRelease(job, runs) {
     if (!job.followOn || !PARKED_STATES.has(job.state) || job.dismissed) return null;
     const at = runs.findIndex((run) => run.id === job.id);
     const prior = at < 0 ? null : runs.slice(at + 1).find((run) => run.state === "completed" && run.deployment?.url);
     if (!prior) return null;
     const live = prior.deployment.status === "live";
     // Dismiss rewinds to job.baseCommit and marks the job dismissed; relaunch is then allowed unless another newer run blocks it.
     const afterDismiss = runs.map((run) => (run.id === job.id ? { ...run, dismissed: true } : run));
     return { jobId: prior.id, name: prior.brief?.workingName || prior.id, url: prior.deployment.url, live,
       relaunchable: !live && Boolean(job.baseCommit) && !newerRunBlocks(afterDismiss, prior.id) };
   }
   ```
   Import it in server.mjs (add to the import at server.mjs:8). In the `GET /api/jobs/:id` route
   (:404-411), compute it only for parked follow-ons (the list reads every run's state file):
   ```js
   const previous = job.followOn && PARKED.has(job.state) && !job.dismissed ? previousRelease(job, await jobStore.list()) : null;
   return json(response, 200, { job: { ...annotated, idleGaps: await jobStore.idleGaps(job.id), previousRelease: previous }, events: ... });
   ```

5. **Card (dashboard).** In `public/app.js`, add a top-level pure helper. It must end with `\n}\n` at
   column 0 so the test can lift it:
   ```js
   // A parked follow-on's fallback (server: previousRelease in src/factory.mjs).
   function previousReleaseNote(job) {
     const prior = job.previousRelease;
     if (!prior) return null;
     if (prior.live) return { text: `Previous release still running at ${prior.url}.`, relaunch: null };
     if (prior.relaunchable) return { text: `The previous release (${prior.name}) is not running. Dismiss puts its files back; Relaunch then starts it.`, relaunch: prior.jobId, label: `Dismiss, then Relaunch ${prior.name}` };
     return { text: `The previous release (${prior.name}) is not running. It can be relaunched once every newer run is dismissed with a rollback point.`, relaunch: null };
   }
   ```
   In `renderRecovery()`, right after the "Spent so far" block (after `features.append(line);` at :708-709),
   add:
   ```js
   const fallback = PARKED.includes(state.job.state) ? previousReleaseNote(state.job) : null;
   if (fallback) {
     const note = document.createElement("p"); note.id = "previous-release"; note.textContent = fallback.text; features.append(note);
     if (fallback.relaunch) {
       const button = document.createElement("button"); button.type = "button"; button.textContent = fallback.label;
       button.addEventListener("click", async () => {
         button.disabled = true; clearError();
         try {
           await api(`/api/jobs/${state.job.id}/dismiss`, { method: "POST", body: {} });
           await api(`/api/jobs/${fallback.relaunch}/relaunch`, { method: "POST", body: {} });
           await poll(); refreshProjects();
         } catch (error) { showError(error); button.disabled = false; }
       });
       features.append(button);
     }
   }
   ```
   Do not use the local `action()` helper: it always posts to `state.job.id`.

### Tests

`test/factory.test.mjs`: import `previousRelease` from `../src/factory.mjs`.

- **Extend** `"a project's next release replaces its previous live deployment"` (:635). Before the second
  `release()`, wrap `store.writeState`. When it is called with `state.id === first.id &&
  state.deployment?.status === "replaced"` (first time only), read the second run's events
  (`(await store.list())[0].id`, then `store.events(id, 500)`) and take the URL from the
  `deployment.started` message (`/Waiting for (http:\/\/127\.0\.0\.1:\d+)/`). Record
  `{ newer: (await fetch(`${newUrl}/health`)).ok, older: (await fetch(`${first.deployment.url}/health`)).ok }`,
  then call through. Assert both are `true`: the new app passed health before the old one was retired, and
  the old one still served at that moment. Keep the existing assertions.
- **New** `"a follow-on whose app exits on launch leaves the previous release live and answering"`. Copy the
  replace test's setup. Release 1 uses `createFixtureProvider()`. Release 2 uses
  `new SoloFactory({ store, provider: broken, maxRepairs: 0 })`, where `broken` wraps the fixture and, after
  `fixture.run` on any stage matching `/^build-slice-/`, rewrites `package.json` with
  `scripts.start = 'node -e "process.exit(3)"'` (keep the quotes: `npm start` runs it through `sh`).
  Assert:
  - `second.state === "failed"` and `second.error.code === "deployment_exited"`
  - `(await fetch(`${first.deployment.url}/health`)).ok`
  - `(await store.read(first.id)).deployment.status === "live"` and its `replacedBy` is `undefined`
  - `previousRelease(await store.read(second.id), await store.list())` deep-equals
    `{ jobId: first.id, name: "Pocket Pulse", url: first.deployment.url, live: true, relaunchable: false }`
- **New** `"a parked follow-on names its fallback and whether Dismiss then Relaunch restores it"`. Pure: build
  `shipped = { id: "a", state: "completed", brief: { workingName: "Habit" }, deployment: { status: "stopped", url: "http://127.0.0.1:1" } }`
  and `parked = { id: "b", state: "failed", followOn: true, baseCommit: "c".repeat(40) }`. Assert:
  - `previousRelease(parked, [parked, shipped])` gives `relaunchable: true, live: false, jobId: "a", name: "Habit"`
  - with no `baseCommit`, `relaunchable` is false
  - with another undismissed newer run (`[{ id: "c", state: "failed" }, parked, shipped]`), `relaunchable` is false
  - with a live `shipped`, `live` is true and `relaunchable` is false
  - `followOn: false`, `dismissed: true` and `state: "completed"` each give `null`
- **New** `"a relaunch whose app fails its checks stops that app"`. Copy `"a metrics route that answers 500 ..."`
  (:768), but call `factory.relaunch(job.id)` on a completed job, with the `factory.json` written as in
  :791. After the rejection, poll up to 2 s until `factory.deployments.has(job.id)` is false, then assert it
  is false.
- Existing `relaunch` tests (:728, :785, :816) must pass unchanged.

`test/e2e.test.mjs`: **new** `"a parked follow-on's card names the running release or offers Dismiss, then Relaunch"`.
Lift `previousReleaseNote` the same way the test at :891 lifts `runningMs`
(`source.match(new RegExp("function previousReleaseNote\\([\\s\\S]*?\\n}\\n"))[0]`). Assert the three texts
and that `relaunch` is the prior's `jobId` only when `relaunchable`.

### Docs

- SPEC.md §4 *Owner controls*, :139-141. Replace "deploying it stops the previous release's app
  (`deployment.status: "replaced"`)" with: deploying it starts the new release beside the previous one and
  stops the previous app (`replaced`) only after the new one passes its deploy checks. A follow-on that fails
  deploy leaves the previous release live, and `GET /api/jobs/:id` returns `previousRelease`
  (`{jobId, name, url, live, relaunchable}`) for a parked follow-on. When the previous app is not running and
  `relaunchable` is true, the card offers **Dismiss, then Relaunch**.
- SPEC.md §9, the `GET /api/jobs/:id` bullet (:359-360): add `previousRelease`.
- Manual `docs/manual/index.html:88`: change "Deploying it stops the previous release's app." to say the
  previous app keeps running until the new one passes its checks, that a failed deploy leaves it running and
  the card names its URL, and that a stopped one offers **Dismiss, then Relaunch**.
- `distro/drive.md:187` (the dismiss row): add that a parked follow-on's `job.previousRelease` names the
  fallback release. When `relaunchable` is true, `POST /dismiss`, then `POST /api/jobs/<previousRelease.jobId>/relaunch`.
- PROGRESS Unreleased bullet, e.g. "A follow-on release now starts beside the live one and replaces it only
  after its own health, metrics and page checks pass; a failed deploy leaves the last good release
  running...". Docs note: SPEC §4/§9, manual Lifecycle, drive.md.

### Edge cases and do-nots

- **Do not** set `liveByProject` before the checks pass. The `exit` handler only deletes the entry when it holds
  this child (`liveByProject.get(appDir)?.child === child`), so a failed child that was never registered needs
  no cleanup.
- **Do not** stop the old app in any failure path, including `cancelled`, `health_check_failed` and
  `this.closed`. Shutdown still kills every app through `shutdown()` (factory.mjs:1858), which is correct.
- **Do not** move the "replaced" record write after `stopApp`: write the record first, then stop. Otherwise the
  old child's exit handler sees `live` and records `stopped` instead of `replaced`.
- Keep the `previous.jobId !== job.id` guard.
- The external `this.deployer` path (tests) is untouched. Only `deployLocal` changes.
- **Do not** change Dismiss or relaunch semantics, or the `not_relaunchable` messages.
- **Do not** try to retire an orphan that survived a factory restart (record `live`, not in `liveByProject`).
  That is out of scope; today's code ignores it too.
- A brief whose app cannot run twice on one `data/` fails its new start. That is `deployment_exited`, and it goes
  through the same bounded repair and park as any deploy failure (the spec accepts this).

### Done when

- [ ] `node --test test/factory.test.mjs` and `node --test test/e2e.test.mjs` pass.
- [ ] `npm test` passes (it runs `build-distro.sh --check` first).
- [ ] A failed follow-on's card shows "Previous release still running at …".

---

## Item 8a: page check at deploy

**Goal.** After `/health` and the metrics contract pass, the controller fetches `/`. A 5xx, a dead socket or an
empty 2xx body fails the deploy gate as `page_check_failed`, and that failure gets the same bounded repair
as `invalid_metrics`.

### Files and current code

- `src/factory.mjs:1740-1744` in `deployLocal`: `const metrics = await fetchJson(...)` … `validateMetrics(metrics);`
- `src/factory.mjs:1069-1086` catch in `deployAndComplete`:
  `if (error.code !== "invalid_metrics" && error.code !== "deployment_exited") throw error;`, then an
  `if (error.code === "invalid_metrics") { output = ... } else { const log = ...; output = ... }`.
- `src/factory.mjs:2168-2172` `fetchJson` (style to follow).
- `src/prompts.mjs:315-333` `FEATURE_REVIEWED_SCOPE`: "deploy readiness (the health endpoint, the metrics
  endpoint, and startup behavior: ...)".

### Steps

1. Add next to `fetchJson`:
   ```js
   // The home page the owner opens must answer (docs/sdlc-hardening-spec.md 8a). Fails on a 5xx, no answer, or an empty
   // 2xx body; a 4xx with a body passes, so an API-only app still deploys. No browser: this does not prove it renders.
   async function checkPage(url) {
     let response;
     let body;
     try {
       response = await fetch(`${url}/`, { signal: AbortSignal.timeout(5_000) });
       body = await response.text();
     } catch (error) {
       throw new FactoryError("page_check_failed", `GET / did not answer: ${error.message}.`, { status: null });
     }
     if (response.status >= 500) throw new FactoryError("page_check_failed", `GET / answered HTTP ${response.status}.`, { status: response.status, body: body.slice(0, 2_000) });
     if (response.ok && !body.trim()) throw new FactoryError("page_check_failed", `GET / answered HTTP ${response.status} with an empty body.`, { status: response.status });
   }
   ```
2. In `deployLocal`, inside the item-1 `try`, call `await checkPage(url);` **after** `validateMetrics(metrics)`
   and **before** the exit check. The order matters: the test "a metrics route that answers 500" (:768) also
   answers 500 at `/`, and it must still fail as `invalid_metrics`.
3. In `deployAndComplete`'s catch, allow the new code and give it its own output:
   ```js
   if (!["invalid_metrics", "deployment_exited", "page_check_failed"].includes(error.code)) throw error;
   ...
   } else if (error.code === "page_check_failed") {
     const log = await readFile(path.join(appDir, ".factory", "logs", "deployment.log"), "utf8").catch(() => "");
     output = `GET / failed the controller's page check: ${error.message}${error.details?.body ? `\nResponse body:\n${error.details.body}` : ""}\nThe home page must answer without a 5xx and with a non-empty page when the app runs with only PORT and NODE_ENV=production set.\n${log.slice(-8_000)}`;
   } else { /* existing deployment_exited branch */ }
   ```
   Keep the comment above it updated ("A broken metrics contract, a failing home page or a crash on launch …").
4. Prompt: in `FEATURE_REVIEWED_SCOPE` change "the health endpoint, the metrics endpoint, and startup behavior"
   to "the health endpoint, the metrics endpoint, the home page `/` (the controller fails deploy on a 5xx or an
   empty page), and startup behavior".

### Tests (`test/factory.test.mjs`, next to "a metrics route that answers 500 …" at :768)

- Use one helper:
  `const pageApp = (home) => \`import http from "node:http";\nhttp.createServer((q, r) => { if (q.url === "/health") return r.end("ok"); if (q.url === "/_factory/metrics") return r.end(${JSON.stringify(JSON.stringify({ uptimeSeconds: 1, requests: { total: 0, errors: 0 }, latencyMs: { average: 0 }, routes: [] }))}); ${home} }).listen(process.env.PORT);\``.
- `"a home page that answers 5xx or an empty 200 fails the page check and stops the new app"`. Run two cases,
  `r.statusCode = 503; r.end("down");` and `r.end();`. For each, assert
  `factory.deployLocal(job, manifest, new AbortController().signal)` rejects with `error.code === "page_check_failed"`
  (message `/HTTP 503/` and `/empty body/`). Then poll until `factory.deployments.has(job.id)` is false (≤ 2 s).
  Wrap in try/finally `factory.shutdown()`.
- `"a 404 home page with a body passes the page check"`. Use `r.statusCode = 404; r.end("Not found");` and assert
  the resolved value has `status === "live"`.
- `"a failing home page gets one deploy repair turn"`. Copy `"a crash on launch gets one repair turn with the
  deployment log"` (:165). The first deploy throws `new FactoryError("page_check_failed", "GET / answered HTTP 500.", { status: 500, body: "TypeError: x is undefined" })`.
  Assert `completed`, `deploys === 2`, and that `.factory/last-failure-1.txt` matches
  `/GET \/ failed the controller's page check/` and `/TypeError: x is undefined/`.

### Docs

- SPEC.md §4 table, Deploy row (:113): add "and `GET /` answers without a 5xx and, on a 2xx, with a non-empty body".
  SPEC.md §5 list (:179-180): add a bullet "`GET /` answering without a 5xx (the controller's page check)".
- Manual :104: "the deployed app must answer its health check" becomes "… its health check and serve a non-empty home page".
- No new setting, so no Settings row. PROGRESS Unreleased bullet plus a Docs note (SPEC §4/§5, manual).

### Edge cases and do-nots

- **Do not** read a non-2xx 4xx as failure, and **do not** follow up with a browser or check other routes (8b is deferred).
- **Do not** put the page check in `validateMetrics` or `fetchJson`. Other callers (`telemetry()`) use them.
- `fetch` follows redirects by default, so a `/` that redirects to `/app` is judged by the final page. That is
  intended.
- Telemetry route counts will include the page check's request, like the health and metrics probes. That is fine.

### Done when

- [ ] `node --test test/factory.test.mjs` passes, as does `node --test test/e2e.test.mjs` (its journey asserts
  `(await fetch(job.deployment.url)).ok`, which the fixture app satisfies).
- [ ] `npm test` passes.

---

## Item 2a: token run ceiling `SOLOFACTORY_MAX_RUN_TOKENS`

**Goal.** A run parks as `run_budget_reached` ("Run token ceiling reached") once the tokens its turns reported
reach `SOLOFACTORY_MAX_RUN_TOKENS` (default 25,000,000; `0` turns it off). This binds on Codex, which reports
tokens but no cost. Resume (any owner continuation) grants another allotment, like the worker and cost ceilings.

### Files and current code

- `src/factory.mjs:1189-1210` `assertWorkerBudget(job)`:
  ```js
  const ceiling = maxRunWorkers();
  const costCeiling = maxRunCostUsd();
  if (!ceiling && !costCeiling) return;
  ...
  const overWorkers = ceiling && workers >= (job.workerAllowance ?? ceiling);
  const overCost = costCeiling && costUsd >= (job.costAllowance ?? costCeiling);
  if (!overWorkers && !overCost) return;
  const spend = runSpend(job, events, this.maxRepairs);
  const [what, grant, title] = overWorkers ? [...] : [`spent about $${costUsd.toFixed(2)}, its limit of ...`, `another $${costCeiling}`, `Run cost ceiling reached ($${costUsd.toFixed(2)})`];
  throw new FactoryError("run_budget_reached", `This run has ${what}. So far: ${spendLine(spend)}. Resume allows ${grant}.`, { workers, ceiling, costUsd, costCeiling, spend, diagnostics: [...] });
  ```
- `src/factory.mjs:213-219` in `activate` (the grant):
  ```js
  const grant = job?.error?.code === "run_budget_reached";
  if (grant) {
    if (maxRunWorkers()) job.workerAllowance = job.error.details.workers + maxRunWorkers();
    if (maxRunCostUsd()) job.costAllowance = (job.error.details.costUsd ?? 0) + maxRunCostUsd();
  }
  ```
- `src/factory.mjs:2225-2239` `usageTotals(events)`; `:2241-2244` `maxRunCostUsd`; `:2246-2250` `knownCostUsd`;
  `:2253` `maxRunWorkers`; `:2257-2275` `runSpend` (`tokens: total ? total.inputTokens + total.outputTokens : 0`);
  `:2305-2309` `spendLine` (local `const count = ...`).
- Usage shape: `src/providers.mjs:339-376`. `inputTokens` counts every input token, cached included, for
  both CLIs. `outputTokens` is the output. `costUsd` is null for Codex.

### Steps

1. Below `maxRunWorkers` add:
   ```js
   // Tokens per run before it parks for the owner; 0 disables. Both CLIs report tokens, so unlike the cost ceiling this
   // binds on Codex. inputTokens includes cache reads; 25M is about the $30 cost ceiling at the 0.10.12 smoke's rate.
   export const maxRunTokens = () => /^\d+$/.test(process.env.SOLOFACTORY_MAX_RUN_TOKENS ?? "") ? Number(process.env.SOLOFACTORY_MAX_RUN_TOKENS) : 25_000_000;

   // Input plus output tokens every turn reported: the same figure as runSpend's tokens. A turn with no usage is skipped,
   // so like knownCostUsd this is a lower bound.
   export function knownTokens(events) {
     const { total } = usageTotals(events);
     return total ? total.inputTokens + total.outputTokens : 0;
   }
   ```
   Make `runSpend` use `tokens: knownTokens(events)`, so the two figures cannot drift.
2. Hoist `spendLine`'s `count` to module level as
   `const tokenCount = (n) => n >= 1e6 ? \`${(n / 1e6).toFixed(1)}M\` : n >= 1e3 ? \`${Math.round(n / 1e3)}K\` : String(n);`,
   and use it in `spendLine`. Output must stay byte-identical (run-budget.test.mjs:65 asserts `1.5M tokens`).
3. In `assertWorkerBudget`:
   - `const tokenCeiling = maxRunTokens();`
   - `if (!ceiling && !costCeiling && !tokenCeiling) return;`
   - `const tokens = knownTokens(events);`
   - `const overTokens = tokenCeiling && tokens >= (job.tokenAllowance ?? tokenCeiling);`
   - `if (!overWorkers && !overCost && !overTokens) return;`
   - Change the tuple to `overWorkers ? [workers…] : overCost ? [cost…] : [tokens…]`, where the token entry is:
     ```js
     [`used about ${tokenCount(tokens)} tokens, its limit of ${tokenCount(job.tokenAllowance ?? tokenCeiling)} (SOLOFACTORY_MAX_RUN_TOKENS=${tokenCeiling}, raised by each resume)`, `another ${tokenCount(tokenCeiling)} tokens`, `Run token ceiling reached (${tokenCount(tokens)} tokens)`]
     ```
   - Add `tokens, tokenCeiling` to the details object. Same code, same diagnostics shape.
   - Update the comment above the method: "Workers, reported cost and reported tokens; Resume after any stop
     raises all three allowances by one ceiling."
4. In `activate`'s grant add:
   ```js
   // A run parked before tokens were recorded still has them in its spend line.
   if (maxRunTokens()) job.tokenAllowance = (job.error.details.tokens ?? job.error.details.spend?.tokens ?? 0) + maxRunTokens();
   ```
5. Update the comment on `maxRunCostUsd` (:2241-2243): "Codex reports none, so a Codex run is held by the token
   and worker ceilings."

No server, dashboard, or `CLEAN_STOPS` change: the park code and the "Spent so far" line already cover it.

### Tests (`test/run-budget.test.mjs`; its `setup(t)` already returns 1,100 tokens per turn with `costUsd: null`, i.e. a Codex-like run)

- `"the token ceiling parks a run that reports no cost, and Resume grants another allotment"`. Set
  `process.env.SOLOFACTORY_MAX_RUN_TOKENS = "2000"` (delete it in `t.after`). Assert:
  - `parked.error.code === "run_budget_reached"`
  - `stages.length === 2`: 2,200 tokens after two workers, and the third never started
  - `parked.error.message` matches `/used about 2K tokens, its limit of 2K \(SOLOFACTORY_MAX_RUN_TOKENS=2000, raised by each resume\).*Resume allows another 2K tokens/`
  - `parked.error.details.diagnostics[0].title` matches `/Run token ceiling reached/`
  - after `await factory.resume(job.id)`: `(await store.read(job.id)).tokenAllowance === 4200` and `stages.length >= 3`
- `"a token ceiling of 0 disables the check"`: `"0"`, then the run completes.
- `"a run parked before tokens were recorded gets its allotment from the spend line"`. Copy `"any owner continuation
  after the ceiling grants another allotment"` (:57). Use
  `error.details = { workers: 5, spend: { tokens: 9000 } }` and assert `tokenAllowance === 9000 + maxRunTokens()`
  (import `maxRunTokens`).
- The existing cost tests must pass unchanged: the default 25M never trips on 1,100-token turns.

### Docs (the docs gate requires the first one: `npm test` fails without it)

- `docs/manual/index.html` Settings table: add a row after `SOLOFACTORY_MAX_RUN_COST_USD` (:168):
  `<tr><td><code>SOLOFACTORY_MAX_RUN_TOKENS</code></td><td>Tokens (input, cached included, plus output) one run may use before it parks for your go-ahead (Resume grants another allotment). Default 25,000,000; 0 turns the ceiling off. Both Claude and Codex report tokens, so this ceiling holds on Codex too.</td></tr>`.
- Manual *Spending ceilings* bullet (:149): add "about 25M tokens parks as *Run token ceiling reached*" and the variable name.
- README.md:180-184: add the token ceiling to the "A whole run is capped at …" bullet.
- `docs/INSTALL.md` troubleshooting table: after the cost row (:934), add the row
  `| Run parks as *Run token ceiling reached* (`run_budget_reached`) | The run's agents reported as many tokens as `SOLOFACTORY_MAX_RUN_TOKENS` allows (default 25M; cached input counts) | Same as the worker ceiling: read *Spent so far* with the owner; **Resume** grants another allotment |`.
  Then run `bash scripts/build-distro.sh` (no `--check`) to copy it to `distro/INSTALL.md`; the check fails
  if they differ.
- `distro/drive.md:174`: add `SOLOFACTORY_MAX_RUN_TOKENS` (default 25M tokens) to the `run_budget_reached` sentence.
- SPEC.md §7 *Failure behavior* (after the bullet at :259-261): new bullet, "A run parks as `run_budget_reached`
  before starting a worker once it has started `SOLOFACTORY_MAX_RUN_WORKERS` workers (150), its turns reported
  `SOLOFACTORY_MAX_RUN_COST_USD` of cost ($30, Claude only) or `SOLOFACTORY_MAX_RUN_TOKENS` tokens (25M); each is
  a lower bound over turns that reported usage. Any owner continuation raises all three allowances by one ceiling."
- PROGRESS Unreleased bullet plus a Docs note (manual row and bullet, README, INSTALL row, drive.md, SPEC §7).

### Edge cases and do-nots

- **Do not** count `cachedInputTokens` or `cacheWriteTokens` again. They are already inside `inputTokens`.
- **Do not** make a null usage turn turn the total unknown: `usageTotals` skips them, which is correct.
- **Do not** drop or rename `workers`, `costUsd` or `spend` in `details`. The grant reads them, and so do older parked runs.
- A run already over 25M tokens when the owner updates parks at its next worker. That is expected; add one
  sentence to the PROGRESS bullet.
- Validation is integer-only (`/^\d+$/`), like `MAX_RUN_WORKERS`. `25e6` or `25M` fall back to the default.

### Done when

- [ ] `node --test test/run-budget.test.mjs` passes.
- [ ] `npm test` passes (the docs gate finds the manual row).
- [ ] `cmp docs/INSTALL.md distro/INSTALL.md` is silent.

---

## Item 6: security review line, secrets gate, `.aai/review.md`

**Goal.** Three parts:
- (A) The final and feature reviewers also check security.
- (B) A controller gate fails when a file the run added or changed holds a credential-shaped token
  (the patterns `feedback.mjs` scrubs).
- (C) Every project gets an owner-editable `.aai/review.md`, scaffolded once, which the review request names
  and reviewers must check.

### Files and current code

- `src/prompts.mjs:334-366` `reviewPrompt({ featureReviewed })`, with the list "report each correctness,
  wiring, error-handling, accessibility, privacy or operator-documentation gap as a blocker" at :337-338.
  `src/prompts.mjs:315-333` `FEATURE_REVIEWED_SCOPE` (final review in feature mode; holds the `qa/` bugs
  rule). `src/prompts.mjs:659-684` `featureReviewPrompt(slice, featureFile)`.
- `src/feedback.mjs:60-65` `const SCRUB = [pathPosix, pathWindows, /\b(?:sk-…|gh[pousr]_…|xox[abp]-…|AKIA…)\b/g, /\bBearer\s+…/g];`.
  Note that `feedback.mjs:3` imports `FactoryError` from `./factory.mjs`.
- `src/factory.mjs:1352` in `verifyWithRepairs`:
  `const failure = (slice?.writes && await this.writesFailure(current, slice)) || await this.verify(...)`.
  `src/factory.mjs:1403-1429` `writesFailure`, the pattern to copy (emit `gate.failed`, return a
  `FactoryError("quality_gate_failed", message, { gate, output })`).
- `src/review.mjs:42-55` `prepareReview(appDir, job, {...})`, which builds `request` (`sources: await sourceSet(...)`, then optional fields).
- `src/store.mjs:50-58` `scaffoldContext()`: `for (const file of ["identity.md", "context.md", "instructions.md"]) { … if (await stat(target).catch(() => null)) continue; … replaceAll("{{NAME}}", name) … }`.
- `templates/project/` holds `context.md`, `identity.md`, `instructions.md` and `live-app.md`.

### Steps

**A. Prompts** (`src/prompts.mjs`, near `EDITED_PROOFS_RULE` at :310):
```js
// docs/sdlc-hardening-spec.md item 6. The controller separately fails a gate on committed credentials (secretsFailure).
const SECURITY_RULE = `Security: check input validation at trust boundaries (request bodies, query strings, uploaded
files), path handling under data/ (a user-supplied name must never reach outside it, e.g. through ../ or an absolute
path), secrets committed to the tree, and unsafe defaults in any auth or sessions the brief asked for (default
passwords, sessions that never expire, tokens in URLs). A security finding is a defect like any other: report it the
same way.`;
const REVIEW_POLICY_RULE = `If review-request.json names reviewPolicy, that file holds the owner's own review rules for
this project (lines inside <!-- --> are examples, not rules): check the app against every rule and quote the rule in
any blocker it causes. It is not evidence: never list it in a check's evidence.`;
```
- `reviewPrompt`: change "accessibility, privacy or operator-documentation gap" to "accessibility, privacy,
  security or operator-documentation gap". Append `\n${SECURITY_RULE}\n${REVIEW_POLICY_RULE}` after
  `${OWNER_DECISIONS}`. In feature mode the existing `qa/` rule in `FEATURE_REVIEWED_SCOPE` then applies to
  security defects too, with no extra text.
- `featureReviewPrompt`: after `${OWNER_DECISIONS}` add `${SECURITY_RULE} Judge it only in this feature's own code.\n${REVIEW_POLICY_RULE}`.

**B. Secrets gate.**
1. `src/feedback.mjs`: split the credential entries out and export them. `SCRUB` keeps the same four
   patterns in the same order:
   ```js
   // Token shapes for API keys and bearer credentials; the factory's secrets gate scans app files for the same ones.
   export const CREDENTIAL_PATTERNS = Object.freeze([
     /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{12,})\b/g,
     /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
   ]);
   const SCRUB = [/(?:\/(?:Users|home|Volumes|private|tmp)\/[^\s|`)]+)/g, /\b[A-Za-z]:\\[^\s|`)]+/g, ...CREDENTIAL_PATTERNS];
   ```
2. `src/factory.mjs`: `import { CREDENTIAL_PATTERNS } from "./feedback.mjs";`. This is a circular import
   (feedback.mjs imports factory.mjs). It is safe only if `CREDENTIAL_PATTERNS` is read **inside a method**,
   never at module top level. Then add the method after `writesFailure`:
   ```js
   // Committed credentials (docs/sdlc-hardening-spec.md item 6): the token shapes feedback.mjs scrubs, in any file this run
   // added or changed. A follow-on's shipped tree is not rescanned: a match there is no repair's to fix. .factory/ (frozen
   // inputs, owner uploads) and .aai/ (owner text) are skipped; the reviewers' security line covers them.
   async secretsFailure(job) {
     const appDir = this.store.appDir(job.id);
     const list = async (...args) => (await this.store.git(...args)).split("\0").filter(Boolean);
     const files = job.baseCommit
       ? [...new Set([...await list("diff", "--name-only", "-z", "--diff-filter=d", job.baseCommit), ...await list("ls-files", "-z", "-o", "--exclude-standard")])]
       : await list("ls-files", "-z", "-c", "-o", "--exclude-standard");
     const patterns = CREDENTIAL_PATTERNS.map((pattern) => new RegExp(pattern.source)); // no g flag: .test() must not keep lastIndex
     const hits = [];
     for (const file of files) {
       if (/^(\.factory|\.aai|node_modules|data)\//.test(file)) continue;
       const body = await readFile(path.join(appDir, file)).catch(() => null);
       if (!body || body.length > 1_000_000 || body.includes(0)) continue; // missing, large or binary
       body.toString("utf8").split("\n").forEach((line, index) => { if (patterns.some((pattern) => pattern.test(line))) hits.push(`${file}:${index + 1}`); });
     }
     if (!hits.length) return null;
     const message = `Credentials in the tree: ${hits.slice(0, 10).join(", ")}${hits.length > 10 ? ` and ${hits.length - 10} more` : ""} match an API key or token pattern.`;
     await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "secrets", message });
     return new FactoryError("quality_gate_failed", message, { gate: "secrets", output: `${message}\nRemove each value from the tree: read it from an environment variable or a gitignored file under data/. A fake value in a test must not look like a real key: build it at runtime (for example "sk-" + "x".repeat(20)) or use a placeholder such as "test-key".` });
   }
   ```
3. `verifyWithRepairs` (:1352): insert it after the writes gate:
   `const failure = (slice?.writes && await this.writesFailure(current, slice)) || await this.secretsFailure(current) || await this.verify(current, manifest, signal, { ... unchanged ... });`.

**C. `.aai/review.md`.**
1. New `templates/project/review.md`:
   ```md
   # Review rules — {{NAME}}

   Rules every SoloFactory reviewer checks this app against, on top of the brief. A reviewer blocks a change
   that breaks one and quotes the rule. Edit freely: SoloFactory writes this file once and never overwrites it.

   <!-- One rule per line, for example:
   - Money is stored and computed in integer cents.
   - No external fonts, scripts or trackers.
   -->
   ```
2. `src/store.mjs:52`: the loop list becomes `["identity.md", "context.md", "instructions.md", "review.md"]`.
   Nothing else changes: it is written once and never overwritten.
3. `templates/project/context.md`: add a table row
   `| \`.aai/review.md\` | the owner's review rules | reviewing, or deciding what "done" means |`.
   This only reaches new projects, because context.md is never overwritten.
4. `src/review.mjs` `prepareReview`: add `stat` to the `node:fs/promises` import, and before building `request`:
   ```js
   // The owner's review rules: a field of its own, not a source. request.sources is re-verified from .factory/uploads
   // only (uploadsOf), and widening sourceSet would flag every existing run inputs_changed.
   const policy = await stat(path.join(appDir, ".aai", "review.md")).then((info) => info.isFile(), () => false);
   ```
   and in the object `...(policy ? { reviewPolicy: ".aai/review.md" } : {}),`. This covers both final and
   feature reviews (factory.mjs:487 and :966 both call `prepareReview`).

### Tests

- `test/factory.test.mjs`, new `"both reviewers check security and the owner's review policy"`. For
  `reviewPrompt()`, `reviewPrompt({ featureReviewed: true })` and `featureReviewPrompt({ id: "F1", acceptance: [] })`,
  assert matches for `/input validation at trust boundaries/`, `/path handling under data\//`, `/reviewPolicy/` and
  `/never list it in a check's evidence/`. Assert `reviewPrompt()` matches `/privacy, security or operator-documentation/`.
- `test/factory.test.mjs`, extend `"init scaffolds project context once and never overwrites it"` (:535):
  `.aai/review.md` exists after `init()` and contains the project name; after `writeFile(review, "# mine\n")`
  and a second `init()` it is still `"# mine\n"`.
- `test/review.test.mjs`, new `"the review request names the owner's review policy, outside its sources"`. Use
  `setup(t)`, then `start`. Assert `result.reviewRequest.reviewPolicy === ".aai/review.md"`,
  `!result.reviewRequest.sources.some((s) => s.path.startsWith(".aai/"))`, and `result.state === "completed"`
  (validation still passes). A second case deletes `<root>/.aai/review.md` after `setup` (rm it) and asserts
  `reviewPolicy` is `undefined`.
- New `test/security.test.mjs`. Build the fake key at runtime:
  `const key = ["sk", "abcdefghijklmnop"].join("-")`. Never put a literal key in this repo.
  - `"a credential in a changed file fails the secrets gate without echoing it, and a repair that removes it completes"`.
    Harness as in `test/run-budget.test.mjs` `setup` (fixture provider wrapper, passing `commandRunner`, stub
    `deployer`), but create the job **without** `sdlc: "single"` (`store.create({ brief, transcript, provider: "fixture" })`),
    so it is a planned-feature run and features verify through `verifyWithRepairs` (factory.mjs:954). On the
    first stage matching `/^build-slice-/`, write `config.mjs` containing
    `export const key = "${key}";`. On a stage matching `/^repair-/`, rewrite it to
    `export const key = process.env.API_KEY;`. Assert:
    - `completed`
    - a `gate.failed` event with `gate === "secrets"` whose message matches `/config\.mjs:1/` and does not
      contain `key`
    - `.factory/last-failure-1.txt` does not contain `key`
  - `"the secrets gate skips factory inputs, owner text and a follow-on's shipped tree"`. Call
    `factory.secretsFailure(job)` directly, as run-budget.test.mjs:91 calls `assertWorkerBudget`:
    - with `.factory/uploads/spec.md` and `.aai/context.md` holding `key`: the result is `null`;
    - commit `old.mjs` holding `key` and set `job.baseCommit = await store.git("rev-parse", "HEAD")`: `null`;
    - write `new.mjs` holding `Bearer ${"t".repeat(20)}`: the result's `details.gate` is `"secrets"`, its message
      names `new.mjs:1` and not `old.mjs`.
- `test/feedback.test.mjs` must pass unchanged (scrub output is identical).

### Docs

- SPEC.md §8 *Security boundary*: add two bullets:
  - A controller `secrets` gate fails verification when a file the run added or changed (outside `.factory/`
    and `.aai/`) matches an API key or bearer-token pattern. It shares the repair budget.
  - The final and feature reviewers check input validation, path handling under `data/`, committed secrets,
    and unsafe auth or session defaults.
- SPEC.md §6 tree (:236): the `.aai/` line lists `review.md`. *Completion review gate* (:602): add "The request
  names `reviewPolicy: ".aai/review.md"` when that owner-edited file exists; reviewers check its rules and
  quote them in blockers."
- Manual :63: add "`.aai/review.md` holds your own review rules (for example 'money is integer cents'); every
  reviewer checks them". Release QA paragraph (:153): mention the security pass.
- README.md:47: add `review` to the list of `.aai/` files.
- PROGRESS Unreleased bullet plus a Docs note (SPEC §6/§8/review gate, manual, README). No setting, so no Settings row.

### Edge cases and do-nots

- **Do not** add `.aai/review.md` to `request.sources` or to `sourceSet()`/`runInputs()`. See problem 6.
- **Do not** call `.test()` on the exported `/g` regexes. Build non-global copies as shown.
- **Do not** read `CREDENTIAL_PATTERNS` at factory.mjs top level (circular import; a TDZ error when
  `feedback.mjs` is imported first, as in test/feedback.test.mjs).
- **Do not** put the matched secret in the message, the `output` or an event. Only `file:line`.
- **Do not** scan file names; scan contents only (the spec's patterns are content patterns).
- Expect false positives: a CSS class like `sk-spinner-wave` matches `sk-[A-Za-z0-9_-]{8,}`. The repair can rename
  it. Do not loosen the shared patterns for this; `scrub()` uses them too.
- Gitignored files (`.env` when ignored, `data/`) are not scanned, which is correct: they are not committed.
- When a secret sits in another feature's test file, the repair's edit to it fails the writes gate (tests are
  never widened). It parks like any unrepairable gate. Accept this.
- **Do not** edit `distro/templates/aai/`. Those are the factory's own installed-folder templates, not project
  templates.
- Upgrading scaffolds `review.md` into existing projects. It is committed at the next factory commit and
  enters `sourceBaseline` (feature-recovery.mjs:15-30), so a parked run's recorded candidates may differ once
  and re-verify. Note this in the PROGRESS bullet.

### Done when

- [ ] `node --test test/security.test.mjs test/review.test.mjs test/factory.test.mjs test/feedback.test.mjs` passes.
- [ ] `npm test` passes.

---

## Item 3a: smoke run required at release

**Goal.** `build-distro.sh --check` (run by `npm test` and CI) fails only while `package.json`'s version is
untagged. The failure fires when the release's diff since the latest tag touches `src/prompts.mjs`,
`src/providers.mjs`, `skills/factory-guide.md` or `src/factory.mjs`, and `smoke/results.jsonl` lacks a
`passed` row for each brief in `smoke/briefs/` at a commit after that tag. A
`- Smoke: waived, <reason>` line under the version's PROGRESS heading satisfies it.

### Files and current code

- `scripts/build-distro.sh:31-43`: the docs gate, ending with the `awk -v v="$ver" '$0 ~ "^## "v"[: ]" ...'`
  check of `- Docs:`, then `[ $fail = 0 ] && echo "distro: ok ..."` and `exit $fail`.
- `smoke/results.jsonl`: one JSON object per line, e.g.
  `{"at":…,"commit":"84f5da7","brief":"Habit Ledger","arm":"default (Opus low)","run":…,"result":"passed",…}`.
  `commit` is `git rev-parse --short HEAD` (scripts/smoke.mjs:24). `result` is `"passed"` or e.g.
  `"failed (run_budget_reached)"` (src/measure.mjs:147). `summarize` rows have `commit: "?"`.
- `smoke/briefs/*.json`: `{ provider, brief: { workingName, … }, transcript, coverage }`; names are
  "Habit Ledger" and "Voice Notes".
- `scripts/smoke.mjs:7-8` header: "run by hand before a release …, never on a schedule."
- `.github/workflows/test.yml:13`: `actions/checkout@v4` (shallow, no tags).
- Today: `git describe --tags --abbrev=0` gives `v0.10.17`, which equals the version, so the gate is quiet.

### Steps

1. New `scripts/smoke-gate.mjs`, with a pure, exported core and a guarded CLI:
   ```js
   #!/usr/bin/env node
   // Release smoke gate (docs/sdlc-hardening-spec.md 3a), run by build-distro.sh --check. Quiet unless package.json's
   // version is untagged and the release touches prompts, adapters, the Guide skill or the controller.
   import { execFileSync } from "node:child_process";
   import { readFileSync, readdirSync } from "node:fs";
   import path from "node:path";
   import { fileURLToPath } from "node:url";

   export const SMOKE_PATHS = ["src/prompts.mjs", "src/providers.mjs", "skills/factory-guide.md", "src/factory.mjs"];

   // null when the release may ship; otherwise the message to print.
   export function smokeGateProblem({ version, latestTag, changed, releaseCommits, rows, briefs, progress }) {
     if (!latestTag || latestTag === `v${version}`) return null;
     const touched = changed.filter((file) => SMOKE_PATHS.includes(file));
     if (!touched.length) return null;
     const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[: ]`);
     const lines = progress.split("\n");
     const start = lines.findIndex((line) => heading.test(line));
     const end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && line.startsWith("## "));
     const entry = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
     if (entry.some((line) => /^- Smoke: waived, \S/.test(line))) return null;
     const inRelease = (commit) => typeof commit === "string" && commit.length >= 7 && releaseCommits.some((full) => full.startsWith(commit));
     const missing = briefs.filter((name) => !rows.some((row) => row.brief === name && row.result === "passed" && inRelease(row.commit)));
     if (!missing.length) return null;
     return `smoke gate: ${version} changes ${touched.join(", ")} since ${latestTag}, but smoke/results.jsonl has no passing row after ${latestTag} for ${missing.join(", ")}. Run node scripts/smoke.mjs, or add "- Smoke: waived, <reason>" under "## ${version}" in PROGRESS.md.`;
   }

   function main(repo) {
     const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
     let latestTag = null;
     try { latestTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"); } catch { return 0; } // shallow CI checkout: no tags, nothing to compare
     const lines = (text) => text.split("\n").filter(Boolean);
     const read = (...parts) => { try { return readFileSync(path.join(repo, ...parts), "utf8"); } catch { return ""; } };
     const rows = lines(read("smoke", "results.jsonl")).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
     const briefs = readdirSync(path.join(repo, "smoke", "briefs")).filter((f) => f.endsWith(".json")).sort()
       .map((f) => JSON.parse(readFileSync(path.join(repo, "smoke", "briefs", f), "utf8")).brief.workingName);
     const problem = smokeGateProblem({
       version: JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version,
       latestTag,
       changed: lines(git("diff", "--name-only", latestTag)), // tag vs working tree: uncommitted edits count
       releaseCommits: lines(git("rev-list", `${latestTag}..HEAD`)),
       rows, briefs, progress: readFileSync(path.join(repo, "PROGRESS.md"), "utf8"),
     });
     if (problem) { console.error(`distro: ${problem}`); return 1; }
     return 0;
   }

   if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
   ```
   A missing `smoke/results.jsonl` reads as no rows (the `read` helper returns `""`).
2. `scripts/build-distro.sh`: after the docs-gate `awk … || miss …` line (:42-43) and before the final `[ $fail = 0 ]` line, add:
   ```bash
   # 3. Release smoke gate: while package.json's version is untagged, a release touching prompts, adapters, the Guide skill or
   #    the controller needs a passing smoke row per brief since the last tag, or "- Smoke: waived, <reason>" (scripts/smoke-gate.mjs).
   node scripts/smoke-gate.mjs || fail=1
   ```
   Also add a line `#    and (3) the release smoke gate.` to the header comment (:7-9).
3. `scripts/smoke.mjs:7-8` header: replace "run by hand before a release that changes prompts, models or the
   controller, never on a schedule" with "required before a release that changes prompts, adapters, the Guide skill
   or the controller (scripts/smoke-gate.mjs checks it at the version bump); never on a schedule".

### Tests: new `test/smoke-gate.test.mjs` (imports `smokeGateProblem` from `../scripts/smoke-gate.mjs`)

Use a base input:
`{ version: "0.10.18", latestTag: "v0.10.17", changed: ["src/prompts.mjs"], releaseCommits: ["abc1234def…(40 chars)"], rows: [], briefs: ["Habit Ledger", "Voice Notes"], progress: "## Unreleased\n\n## 0.10.18: x (2026-11-10)\n\n- Docs: none.\n\n## 0.10.17: y\n" }`.
Tests:
- `"quiet without a tag, on a tagged version, or when no gated file changed"`: `latestTag: null`; `latestTag: "v0.10.18"`; `changed: ["README.md"]` all return `null`.
- `"a gated release needs a passing row for every brief at a commit after the tag"`:
  - no rows: the message names both briefs and `src/prompts.mjs`;
  - two `passed` rows with `commit: "abc1234"`: `null`;
  - one `passed` row: names only the other brief.
- `"failed rows, rows before the tag and summarize rows do not count"`: `result: "failed (run_budget_reached)"`;
  `commit: "0000000"` (not in `releaseCommits`); `commit: "?"` all still give a problem.
- `"a waiver under the version's own heading satisfies the gate"`: `- Smoke: waived, docs-only prompt typo` under
  `## 0.10.18` gives `null`. The same line under `## Unreleased` or `## 0.10.17` still gives a problem, and so does
  `- Smoke: waived,` with no reason.

### Docs

- DEVELOPING.md:17-19: "Before a release that changes prompts, models or the controller, run …" becomes a
  requirement. Say that `npm test` fails on an untagged version until each brief has a passing row since the last
  tag, or the version's PROGRESS entry has `- Smoke: waived, <reason>`. Mention that CI (no tags) skips the gate.
- No SPEC.md change (repo process, not product behavior) and no manual row (no `SOLOFACTORY_*` setting).
- PROGRESS Unreleased bullet plus a Docs note ("DEVELOPING.md release smoke rule").

### Edge cases and do-nots

- **Do not** put the gate's logic in bash. JSONL and prefix matching belong in the node script, which is testable.
- **Do not** make the gate fire on `## Unreleased` or on every `npm test`. It fires only when
  `latestTag !== "v" + version`.
- **Do not** fail when git has no tags or `git describe` errors (CI's shallow checkout). Return 0 silently.
- **Do not** compare full hashes to ledger commits. The ledger stores 7-character short hashes, so use a prefix match
  on `rev-list` output.
- **Do not** add `fetch-depth: 0` to CI as part of this item. Skipping there is the intended behavior.
- Brief names come from `brief.workingName` inside each brief file, not from the file name.
- The script must not run `main` when imported (the `process.argv[1]` guard), or the test would exit the runner.

### Done when

- [ ] `node --test test/smoke-gate.test.mjs` passes.
- [ ] `bash scripts/build-distro.sh --check` prints `distro: ok` on `main` (version 0.10.17 = tag).
- [ ] Temporarily set `"version": "0.10.18"` in package.json and add a comment line to `src/prompts.mjs`: the
  check fails with the smoke message. The docs gate also complains about the missing `## 0.10.18` entry, which is
  expected. **Revert both** before committing.
- [ ] `npm test` passes.
