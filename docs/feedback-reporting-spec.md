# SoloFactory Feedback Reporting — Intake Spec

Status: implemented (`src/feedback.mjs`). Kept as design record; audited from
`docs/feedback-tracking-brief.md`, 2026-09-06.
Source of truth for names below: `src/factory.mjs`, `src/store.mjs`, `src/providers.mjs`, `src/server.mjs`

---

## Part 1 — Audit of the brief

The brief is sound. Its privacy posture (allowlist first, scrubber second), its "user is the
authority" rule, and its no-token / no-API stance all hold up and are kept verbatim. The
findings below are places where the brief drifts from what the code actually has, or where a
requirement is under-specified enough that two engineers would build it differently.

### A. Mismatches with the codebase (must fix before build)

| # | Brief says | Code has | Resolution |
|---|---|---|---|
| A1 | Provider diagnostic code first, then `job.error.code`, then `unexpected_error` | Provider diagnostics live at `job.error.details.diagnostics[]` (each `{code,title,action}`); `job.error.code` is already the primary code from `providerFailure()` or a `FactoryError` code. Legacy runs get diagnostics re-derived by `ensureRecovery()` | Order stands, but name the actual path: `job.error.details.diagnostics[0]?.code ?? job.error.code ?? "unexpected_error"`. |
| A2 | Include "failed gate" in diagnostics and fingerprint | Gate name is at `job.error.details.gate` **only** for `quality_gate_failed`. Other codes have no gate. | Gate is optional exactly as brief's `[:<gate>]` implies. Spec the source field. |
| A3 | Allowed event type list omits `recovery.prepared` and `deployment.log` | Both exist. `deployment.log` carries app stdout (unsafe). `recovery.prepared` is harmless but noisy | Keep brief's list. Explicitly exclude both. |
| A4 | "Slice ID" in lifecycle entries | Field is `event.slice` (string id) | Name the field. |
| A5 | "Run and failed state" | `job.state` + `job.failedState` (set in `fail()`, also by `recoverInterrupted()`) | Name the fields. |
| A6 | Repair / agent-turn / gate-run / slice counts | Exact source: `factory.telemetry(id).summary` → `{agentTurns, repairs, gateRuns, slicesPlanned, slicesCompleted, strategy}` | Reuse `telemetry()`. Do not recount events in the report builder. |
| A7 | Elapsed whole seconds | `job.startedAt` may be null (failed while queued) | `elapsed = floor((completedAt ?? updatedAt) - (startedAt ?? createdAt)) / 1000`. |
| A8 | Read version from package metadata | `package.json` has `version: "0.1.0"`; nothing currently reads it | One `createRequire`/`readFile` of `package.json` at server start; expose via `/api/config`. |
| A9 | "Failed states" `failed`, `interrupted`, `cancelled` | UI already keys recovery card off exactly these three (`public/app.js:282`) | Consistent. Reuse that predicate. |
| A10 | Two GitHub issue forms | Repo has no `.github/` directory | Add `.github/ISSUE_TEMPLATE/problem.yml` + `improvement.yml`. Template slug in URL must match filename. |

### B. Under-specified (decide now, not during build)

| # | Gap | Decision |
|---|---|---|
| B1 | Where is the Markdown built: server or browser? Brief hedges ("if built by the server"). | **Server.** Reasons: the allowlist reads `state.json`/`events.jsonl` which the browser never sees raw; server-side length validation is then mandatory not optional; pure functions are unit-testable with `node --test` like the rest of the repo. Browser sends form fields only. |
| B2 | Cancelled runs: `recovery.canResume` is false and `status: "cancelled"`. Is a cancelled run reportable? | **Yes.** Brief lists `cancelled` in terminal states. Error code will be `cancelled`; fingerprint still forms. Diagnostics default **off** for cancelled (user chose to stop; unlikely a bug). |
| B3 | Fingerprint when no provider diag and `job.error.code` is generic (`provider_failed`, `agent_idle_timeout`)? | Fingerprint forms anyway: `codex:agent_idle_timeout:building`. It groups; it doesn't judge. No special case. |
| B4 | "Search existing issues" for improvements with no fingerprint uses the title | Title is user free-text and could contain a secret the user typed. Search URL is `…/issues?q=is:issue+<encoded>`. Accept: user typed it, user clicks it, it is visible in the dialog first. Cap search string at 100 chars. |
| B5 | `SOLOFACTORY_ISSUES_URL` validation | Regex `^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/?$`. Reject anything else at server start with a stderr warning; treat as unset. Trailing slash stripped. |
| B6 | Scrubber patterns | Exactly three: absolute paths (`/Users/…`, `/home/…`, `/Volumes/…`, `[A-Z]:\\…`), `sk-`/`ghp_`/`gho_`/`xox[abp]-`/`AKIA` prefixes, and `Bearer <token>`. Anything else the allowlist already excludes. Scrubber runs on the **diagnostics section only**, not on user text. |
| B7 | Field length bounds | title 120; body fields 4000 each; additional/workaround 4000; total request ≤ 32 KB. Reject 413 with `{error, code:"feedback_too_large"}`. |
| B8 | Lifecycle event `duration` | Only `gate.*` events carry `durationMs`. Others show `—`. |
| B9 | Focus-return target | Two triggers exist (Report this run, Feedback). Store the trigger element on open; restore on close. Use native `<dialog>` + `showModal()` — gives Escape, focus trap, and backdrop for free. |
| B10 | Markdown escaping vs "inert text" | Two different surfaces. **Preview**: render into `textContent`/`<pre>`, never `innerHTML`. **Markdown body**: user text inserted as-is inside the section (it's their words; GitHub renders it). Only guard: prefix any user line that starts with `#` with a backslash so it cannot forge a section header. |

### C. Scope cuts (brief asks for something a smaller thing covers)

| # | Brief | Cut to | Why |
|---|---|---|---|
| C1 | Three independent actions + hidden/disabled state + explanation | Same three, but GitHub actions **hidden** (not disabled) when URL unset; one sentence in the privacy notice explains. | One rendering path, no disabled-state styling. |
| C2 | "Frequency" and "affected area" as separate selects | Keep. Two native `<select>`s. | Already minimal. |
| C3 | Curated lifecycle list with 5 fields per row | Keep at 20 rows / 5 columns, rendered as a Markdown table. | Table reads better in GitHub than a list. |
| C4 | Both issue forms set labels | Set labels in the YAML. GitHub applies them without auth. | Free. |

### D. Risks the brief did not name

- **R1 — `ensureRecovery()` mutates on read.** `GET /api/jobs/:id` can write state and append an event for legacy runs. A report endpoint that reads via the same path is fine, but acceptance scenario 11 ("reporting does not change evidence") must be tested against a run that has *already* been through `ensureRecovery`, or the test will fail for an unrelated reason.
- **R2 — Provider id leaks tool identity, not data.** `codex`/`claude`/`fixture` are safe. Confirmed.
- **R3 — `job.error.message` is not allowlisted** and must not appear. It frequently ends with `See /abs/path.log`. The brief's rule already excludes it; call it out because `buildRecoveryPacket()` includes it and a copy-paste implementer will reach for that function.
- **R4 — Clipboard requires secure context.** `navigator.clipboard` works on `http://127.0.0.1`. If a user binds to a LAN IP, it will fail. Fall back to selecting the preview `<pre>` and telling the user to press Cmd/Ctrl-C. No library.

---

## Part 2 — Intake spec

### 1. Product promise and working name

**SoloFactory Feedback Reporting.** Turn a failed run or an idea into a reviewed,
privacy-safe Markdown report the user pastes into a GitHub issue. No account, no token, no
telemetry, no storage.

### 2. Primary user and triggering problem

Owner of a personal SoloFactory install. A run has just parked as `failed`/`interrupted`/
`cancelled`, or they have a friction point. Today they reconstruct version, provider, stage,
error, and counts by hand from the dashboard, so reports are rare and inconsistent.

### 3. Current workaround

Manual GitHub issue from memory, sometimes pasting from the recovery packet, which contains
absolute paths and the raw error message.

### 4. Core workflow

**Failure-initiated**
1. Recovery card shows on a terminal non-success run (existing).
2. New button **Report this run** appears beside **Copy recovery packet** / **Start over**.
   It does not touch **Resume current run** (stays primary).
3. Dialog opens in `problem` mode, diagnostics toggle **on** (off if `cancelled`), preview
   already rendered from `POST /api/feedback/preview`.
4. User fills title / what happened / expected. Preview re-renders on input (debounced 300 ms).
5. Privacy line sits above the actions: **Nothing is sent automatically. Review the report
   before sharing it.**
6. Actions: **Copy report** (primary) · **Search existing issues** · **Open GitHub**.
7. User pastes in GitHub.

**User-initiated**
1. Persistent **Feedback** button in the top bar (`header.topbar`).
2. Dialog opens with mode selector `Report a problem` / `Suggest an improvement`.
3. If `state.job` is a terminal non-success run, the diagnostics toggle is shown (default off).
   Otherwise no toggle and no diagnostics section.
4. Same preview / actions.

### 5. Must-have behavior

**Server (`src/feedback.mjs`, new, pure functions + one route in `server.mjs`)**

- `selectErrorCode(job)` → `job.error?.details?.diagnostics?.[0]?.code ?? job.error?.code ?? "unexpected_error"`.
- `buildFingerprint(job)` → `${job.provider}:${code}:${job.failedState ?? job.state}` +
  (`:${job.error.details.gate}` when present). No hashing. No version, id, time, path, exit code.
- `buildDiagnostics({ job, events, summary, version })` → plain object built **only** from:

  | Field | Source |
  |---|---|
  | `version` | `package.json` version, read once at boot |
  | `platform`, `arch` | `process.platform`, `process.arch` |
  | `node` | `process.version` |
  | `provider` | `job.provider` |
  | `strategy` | `job.sdlc ?? "single"` |
  | `state`, `failedState` | `job.state`, `job.failedState` |
  | `errorCode` | `selectErrorCode(job)` |
  | `gate` | `job.error?.details?.gate ?? null` |
  | `repairs`, `agentTurns`, `gateRuns`, `slicesPlanned`, `slicesCompleted` | `telemetry(id).summary` |
  | `elapsedSeconds` | see A7 |
  | `fingerprint` | `buildFingerprint(job)` |
  | `lifecycle[]` | last 20 events whose `type` ∈ ALLOWED_EVENTS, each mapped to `{type, state, ref: event.gate ?? event.slice ?? null, durationMs: event.durationMs ?? null, at}` |

  `ALLOWED_EVENTS` is the brief's 17-item list, frozen. `message` is never read.
- `scrub(text)` → replaces the three B6 pattern classes with `[redacted]`. Returns
  `{text, changed}`. Applied to the rendered diagnostics section only.
- `renderProblem(fields, diagnostics|null)` and `renderImprovement(fields, diagnostics|null)`
  → Markdown string. Empty optional sections omitted. User lines starting with `#` escaped.
- `validateFeedback(body)` → throws `FactoryError("feedback_invalid"|"feedback_too_large")`
  with 400/413. Bounds per B7. Enum checks for `mode`, `frequency`, `area`.
- `issuesConfig(env)` → `{ base, search(q), newProblem(title), newImprovement(title) } | null`.
  URL forms:
  - search: `${base}?q=${encodeURIComponent("is:issue " + q)}`
  - new: `${base}/new?template=problem.yml&title=${encodeURIComponent("[Problem] " + title)}`
    (and `improvement.yml` / `[Improvement]`). Body never in query.
- Route: `POST /api/feedback/preview` body `{mode, fields, jobId?, includeDiagnostics}` →
  `{markdown, fingerprint|null, redacted: boolean}`. Reads job via `store.read` (not
  `ensureRecovery` — see R1) and `factory.telemetry` only when `includeDiagnostics && jobId`.
  Never writes state or events.
- `GET /api/config` gains `{ version, issues: { base, available: boolean } | null }`.

**Browser (`public/index.html`, `public/app.js`, `public/styles.css`)**

- One `<dialog id="feedback-dialog">`. Native `showModal()`. Escape closes. Focus restored to
  the opening trigger. Every input has a `<label for>`.
- Buttons: `#report-run-button` in the recovery action row; `#feedback-button` in the top bar.
- Preview into a `<pre>` via `textContent`.
- **Copy report** copies the exact `markdown` string last received from the server.
- **Search existing issues** → `window.open(search(fingerprint ?? title.slice(0,100)), "_blank", "noopener")`.
- **Open GitHub** → `window.open(newX(title), "_blank", "noopener")`.
- GitHub buttons hidden when `config.issues` is null; privacy notice appends: *GitHub links are
  off because `SOLOFACTORY_ISSUES_URL` is not set.*

**Repo**

- `.github/ISSUE_TEMPLATE/problem.yml` (label `bug`) and `improvement.yml` (label
  `feature-request`), each with one required textarea "Paste your SoloFactory report".

### 6. Non-goals

Verbatim from brief. Plus: no `deployment.log` or `recovery.prepared` in lifecycle; no
recovery-packet reuse in the report; no persistence of the last preview.

### 7. Data, login, payments, integrations, sensitive data

- Zero new storage. Zero outbound requests from the server. Clipboard and `window.open` only
  on click.
- Only integration: GitHub Issues via URL. Base URL validated per B5.
- Sensitive-data boundary = allowlist above. Scrubber is defense in depth and its firing is
  surfaced (`redacted: true` → small note in dialog).

### 8. Visual direction

Compact modal, reuses existing `.button primary|ghost` classes and card styling. Mode
selector as two radio buttons styled as a segmented control. Preview `<pre>` max-height 40vh,
scrolls. Works at 390 px (existing mobile bar).

### 9. Business model and usage

Internal quality loop. Expected volume: single-digit reports per week.

### 10. Deployment

Runs inside the existing Node server. No new dependency (`package.json` unchanged except
nothing). No migration. Env var `SOLOFACTORY_ISSUES_URL` documented in README.

### 11. Acceptance scenarios (test-mapped)

| # | Scenario | Test file |
|---|---|---|
| 1 | Failed run → Report this run → preview shows `errorCode`, `failedState`, fingerprint | `test/feedback.test.mjs` (unit) + `test/e2e.test.mjs` (HTTP) |
| 2 | No run → Feedback → improvement preview shows problem, outcome, frequency, area | unit |
| 3 | Diagnostics off → no `## SoloFactory diagnostics` / `## Recent lifecycle` headings | unit |
| 4 | Copied text === displayed preview === server `markdown` | e2e (assert response body used verbatim) |
| 5 | Search URL contains `encodeURIComponent(fingerprint)` | unit |
| 6 | New-issue URL has `template=` and `title=` and no `body=` | unit |
| 7 | Env unset → `config.issues === null`, copy still works | e2e |
| 8 | Job fixture with transcript, agent output, `/abs/path`, session id, URL, `sk-…` → none appear in diagnostics | unit — **the key privacy test**; fixture built from a real `state.json` shape |
| 9 | User text `<script>alert(1)</script>` → preview `textContent` equals input, no execution | e2e with a DOM-less check that the server never returns HTML; browser walkthrough for the rest |
| 10 | Escape closes, `document.activeElement` returns to trigger | browser walkthrough (manual, recorded in PROGRESS.md) |
| 11 | `state.json` and `events.jsonl` byte-identical before/after preview; resume still works | e2e |
| 12 | Fingerprint identical across two runs differing only in id, timestamps, paths, exit code, version | unit |
| 13 | Oversized field → 413 `feedback_too_large`; bad `area` → 400 `feedback_invalid` | unit |
| 14 | Malformed `SOLOFACTORY_ISSUES_URL` (query, fragment, creds, non-github host) → treated as unset | unit |

### 12. Constraints

- Files touched: `src/feedback.mjs` (new), `src/server.mjs` (+1 route, +2 config fields),
  `public/index.html`, `public/app.js`, `public/styles.css`, `test/feedback.test.mjs` (new),
  `test/e2e.test.mjs` (+3 cases), `.github/ISSUE_TEMPLATE/*.yml` (new), `README.md` (env var).
  That is 5 existing files; split into two work packages: **WP1 server + tests**, **WP2 UI +
  templates + README**. WP1 is independently shippable and testable.
- Node ≥ 22, no new dependency.
- Existing 40 tests stay green.

### 13. Open questions for the owner

1. GitHub `owner/repo` for the default `SOLOFACTORY_ISSUES_URL` in README examples. Spec
   leaves it as `<owner>/<repository>`.
2. Should `cancelled` runs offer **Report this run** at all? Spec says yes with diagnostics
   default off. Say no and it becomes a one-line predicate change.
