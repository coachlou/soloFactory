# SDLC hardening: safe deploys, harness parity, release evals, proof backstops, lessons — spec

**Status: proposal, rewritten 2026-11-09 against `main` at cd22719 (0.10.17 + Unreleased).
Nothing here is implemented.** SPEC.md stays the source of truth; items move there as they ship.
The 2026-10-06 version of this file predates planned features and is superseded. Audited the same
day by an independent review against the code; its corrections are folded in and its ranking is the
**Priority** table at the end. Implementation specs for the L-effort items: `docs/sdlc-hardening-impl.md`; the problems it found are folded in below.

**Goal.** Close the gaps that remain between SoloFactory and a mature AI-native SDLC (artifact
chain intent → spec → plan → diff → review → incident → intent, with deterministic gates and human
approval above the loop). Most of that chain has shipped since the first comparison; this spec
covers only what is still open, plus two gaps the first comparison missed.

## Harness neutrality (applies to every item)

SoloFactory drives any coding-agent CLI through `src/providers.mjs` (Claude Code and Codex
today). The SDLC must hold the same way whichever one the owner signed in with.

- **Enforcement lives in the controller.** A guarantee is real only if the controller checks it
  from files, git, gate exit codes or factory-owned reporters (`src/case-reporter.mjs`). An
  adapter flag may add defense in depth, never the only defense.
- **Every adapter states the same guarantees.** Where one CLI has a flag and another does not,
  the adapter says so in a parity table (item 2) and the controller covers the gap.
- **Budgets and evidence use what every provider reports.** Tokens are reported by both; cost is
  not.
- **"Independent reviewer" means fresh context always, a different model when the provider has
  one, a different provider when one is signed in.** Never assume a second provider.
- **Instructions are plain markdown under `.aai/` or the frozen `.factory/` inputs**, named in
  prompts. No harness-specific skill, rule or hook format.

## Where we are

Shipped since 2026-10-06, and therefore not in this spec: declared `writes` with a writes gate,
`plan_mutation` / `stale_plan` / `inputs_changed`, plan approval bound to a plan digest, per-feature
proofs and reviews bound to a candidate hash, reviewer edits voiding a verdict, release-QA bug tests
under `qa/`, final-integration rerun of every proof, `editedProofs` review, the watchdog's loop
detection, run worker and cost ceilings, the smoke set and ledger, and CI on Linux.

| Gap today | After |
|---|---|
| A follow-on deploy stops the live app before the new one passes `/health`; a failed deploy leaves nothing live until the owner dismisses the failed run and relaunches the previous one | The new release is health-checked on its own port first; the old one stops only after that, so a failed deploy leaves the last good release running |
| Claude turns are isolated from personal config, allowlisted and split across models; Codex write turns inherit the owner's config, run with `--approve-for-me`, and use one model for every stage | One parity table per adapter; the controller covers what an adapter cannot; Codex gets per-stage models, and config isolation once the CLI is checked |
| The run cost ceiling sums cost Claude reports; Codex turns report none and are skipped | The ceiling also has a token limit, so it binds on every provider |
| The smoke set is two briefs, all rows on Claude, run by hand | Required for releases that change prompts, models, adapters or the controller (incident replay cases and a Codex arm later) |
| An edited earlier proof is checked only by reviewers (PROGRESS: "accepted risk") | For cased proofs, the case reporter proves an edited proof still passes every case it passed before |
| Lessons (test-script rule, own-files rule, accessible names) are found by reading member reports | Failure fingerprints are grouped across runs and projects and surfaced as lesson candidates |
| Review checks privacy but not security; no owner review policy | A security pass and an owner-editable `.aai/review.md` |
| Reviewers must cite browser evidence, but the controller supplies no browser | A controller page check at deploy now; an optional browser check later |

## 1. Deploy: health-check before replace, keep the last good release

**Effort L · Return H.** The swap itself is small; the card's fallback field and the relaunch
cleanup add a little (see `docs/sdlc-hardening-impl.md`).

**Why.** `deployLocal` (`src/factory.mjs`) takes the project's live app out of `liveByProject`,
marks it `replaced` and stops it before launching the new release. If the new release then fails
its health or metrics check (and its bounded repair), the owner has no running app. Rollback exists,
but takes two owner actions on a parked run: **Dismiss** rewinds the shared tree to the run's
`baseCommit`, and relaunch is then allowed for the previous completed run (`relaunch()` refuses only
while a newer run is undismissed or has no rollback point). Owners should not lose a working app
for a release that never passed its gates.

- Launch the new release on a fresh port (as today) while the old one keeps running. Apps already
  get distinct ports and `data/` is shared and gitignored, so two copies can run briefly. A brief
  that cannot tolerate two processes on one `data/` (an exclusive lock file, say) is the exception;
  the app's start failure is then treated like any deploy failure below.
- Only after `/health` and `/_factory/metrics` pass: stop the old app, mark it `replaced`, record
  the new deployment. This is the existing code with its two halves swapped.
- If the new release fails deploy after its repair budget: the old app stays `live` and the run
  parks with its usual recovery. The card says "previous release still running at <url>".
- If the old app was already stopped (factory restart, crash): keep today's relaunch rule. Every
  run in a project shares one tree, so relaunching an older run without the Dismiss rewind would
  start the failed run's code. Instead, the parked card says so and offers **Dismiss, then
  Relaunch <previous run>** as one visible path.
- The old app keeps running while the tree holds the new release's files. Node has its code in
  memory, but files it reads from disk at request time (static assets, templates) are the new
  ones until the swap. That is already true for the whole follow-on build, since the old app is only
  stopped at deploy; the swap adds the seconds the checks take. Note it in the code.
- A release that fails its checks is stopped inside `deployLocal`. Today `relaunch()` leaves such an
  app running (only the deploy loop stops it); this closes that orphan.
- Tests: a fixture follow-on whose start command exits immediately leaves the earlier fixture app
  answering `/health` and still `live`; a passing follow-on stops the earlier app only after its
  own health check.

## 2. Harness parity

Split by value: **2a token ceiling** (Effort L · Return H) ships right after item 1; **2b parity
table and Codex per-stage models** (M · M) later; **2c Codex config isolation** (M · M) after a CLI
check.

**Why.** The controller-side gates are provider-neutral, but the adapters are not equal. Claude
turns run with `--setting-sources project,local --strict-mcp-config`, `--disallowedTools Agent`,
a command allowlist and the single-command shell rule, and stages split across models
(Sonnet builders, Opus reasoning, Opus Guide). Codex `exec` runs with the owner's own Codex
configuration and `--approve-for-me` in write mode (read mode already runs
`--sandbox read-only --ephemeral`, so both adapters have a read-only mode), and one `SOLOFACTORY_CODEX_MODEL` /
`_REASONING_EFFORT` for every stage, so on Codex the reviewer is the builder's model. The run cost
ceiling skips turns without a reported cost, which is every Codex turn.

- **Parity table (2b).** First move the inline arg building in `codexRun` and `claudeRun` into
  pure functions; `test/providers.test.mjs` asserts no adapter args today. Then each adapter exports a small, tested object stating what it guarantees:
  `isolatedConfig`, `commandAllowlist`, `noSubagents`, `readOnlyMode`, `perStageModels`,
  `reportsUsage`, `reportsCost`, and a test asserts the table matches the args those functions build, and DEVELOPING.md prints it. A guarantee an adapter cannot give is a visible
  `false`, not an omission.
- **Controller covers the gaps.** Anything the parity table marks `false` that the factory relies
  on must already be checked by the controller (writes gate, plan/contract checks, verdict
  binding). Where it is not, add the check rather than relying on the flag. Example: agent changes
  to `data/` are already reported after each turn regardless of provider; keep extending that
  pattern rather than adding per-CLI rules.
- **Codex config isolation (2c).** No incident has been traced to it yet, so it waits. Find the Codex equivalent of Claude's project-only settings. If none
  exists, run Codex with a factory-owned config location that carries only the sign-in, so the
  owner's MCP servers, profiles and global instructions do not enter build turns. Needs checking
  against the installed Codex CLI first: its home directory also holds credentials.
- **Codex per-stage models (2b).** Use the stage classification Claude already uses (guide, reasoning,
  builder) with `SOLOFACTORY_CODEX_GUIDE_*`, `_REASONING_*` and the existing builder settings,
  defaulting to the picks in `notes/sdlc-model-value-table.md` once those model IDs are confirmed
  against the Codex CLI. New settings go in the manual's
  Settings table (the docs gate already enforces this).
- **Token ceiling (2a).** `SOLOFACTORY_MAX_RUN_TOKENS` alongside the cost ceiling, summed from usage
  every adapter reports, with the same park code (`run_budget_reached`), Resume allotment and card
  text, modelled on the existing worker ceiling check. Default 40,000,000 (shipped). It was first
  set at 25M from the 0.10.12 smoke (3.05M tokens for $4.08), but the 2026-11-10 real smoke ran up to
  1.14M tokens per dollar, where 25M is only about $22; 40M keeps the $30 cost ceiling firing first on
  Claude (counts are mostly cache reads). A run
  that parked before tokens were recorded takes its Resume allotment from `details.spend.tokens`.
  The cost ceiling stays for Claude, where it means something. SPEC.md does not yet document the
  worker or cost ceilings; 2a adds a §7 bullet covering all three.
- **Cross-provider review: cut for now.** Add it only when smoke rows show it changes outcomes
  (the Jev lesson: measure outcome change, not accuracy).

## 3. The smoke set becomes a release gate, with incident cases and a Codex arm

Split: **3a release gate** (Effort L · Return M) now; **3b incident cases** (H · M) and **3c Codex
arm** (L · M, needs a Codex sign-in) deferred.

**Why.** `scripts/smoke.mjs` and `smoke/results.jsonl` are the eval suite; they are run by hand,
cover two briefs and have only Claude rows. The member runs that drove 0.10.6–0.10.12 are not in
it, so a later change can bring them back unnoticed.

- **Release gate (3a).** `build-distro.sh --check` runs before every `npm test` and in CI, so the
  check must fire only for a release: when `package.json`'s version differs from the latest tag.
  CI checks out at depth 1 with no tags, so with no tag found the gate skips.
  Then, when the release's diff touches `src/prompts.mjs`, `src/providers.mjs`,
  `skills/factory-guide.md`, model defaults or `src/factory.mjs`, `smoke/results.jsonl` must hold a
  passing row for a commit in that release for each brief. Ledger rows hold a 7-character commit
  and the brief's `workingName`, so match by hash prefix and name. A written waiver line in the
  version's own PROGRESS entry (`## <version>`, as the docs gate reads it, not Unreleased) (`- Smoke: waived, <reason>`) satisfies it, so the gate never blocks a docs-only fix.
- **Incident cases (3b, deferred).** `smoke/cases/<id>/`: a frozen brief, a saved project tree (a git bundle) and
  the stage and cursor to resume from, plus the expected result (`passed`, or a named park code).
  `smoke.mjs case <id>` restores the tree into a fresh home and resumes there, so a replay costs one
  feature or one review, not a whole build. Seed: the 25-feature rebuild (0.10.6), the unprovable
  live-Gmail brief (0.10.7), the broken `node --test test/` script (0.10.12), the per-row checkbox
  without an accessible name (Unreleased), the habits-html proof broken by a later feature
  (Unreleased). Cases never carry owner data or secrets; member-derived cases are rewritten
  into synthetic briefs. Those runs' trees no longer exist, so each seed must be rebuilt to its
  failing stage first; that, plus resume-into-a-fresh-home, is why this is H effort.
- **Codex arm (3c, deferred).** `SMOKE_PROVIDER=codex` rows for both briefs at each release that changes the
  adapter. The ledger already has an `arm` column; the table groups by provider.
- **Incident → case rule.** Once 3b exists, a fix for a reported run lands with its case, as the
  docs gate lands with its bullet.

## 4. Backstop for edited earlier proofs

**Effort M · Return M–H.** Edited earlier proofs came up in three smoke runs.

**Why.** Since 0cb4bd5 a feature's repair may edit an earlier feature's proof test that its change
broke. PROGRESS records this as an accepted risk whose backstop is the feature and final reviewers
reading `editedProofs`. That backstop is a model's judgment. The factory already owns a reporter
that records exactly which named cases ran and how they ended (`src/case-reporter.mjs`).

- Scope: proofs that declare cases, the only ones the case reporter is injected into. Uncased
  pass counts would need the reporter on every proof or parsing spec output; deferred.
- When a cased proof first passes, store the set of its passing case names on the feature's
  `sliceStats`.
- When that proof reruns after one of its test files was edited (`brokenProofs` /
  `editedProofs`), every stored case name must still be reported as passing, not skipped or
  todo. A case may be removed only by a plan entry that `supersedes` it, the rule
  replacement plans already follow.
- A violation fails the gate as `proof_weakened`, naming the missing cases. It goes to repair like
  any gate failure, within the same budget, so the repair can restore the case. Reviewers still
  read the edited files; this makes the accepted risk a checked one.
- Provider-neutral: it reads the factory's own reporter output, not the agent's account.

## 5. Lessons from repeated failures across runs

Split: **5a lessons script and report fingerprints** (Effort L–M · Return M) now; **5b project
`gotchas.md`** (M · L) deferred until the script shows repeats worth recording.

**Why.** Every recent prompt rule (`TEST_SCRIPT_RULE`, `OWN_FILES_RULE`, accessible names for
repeated controls) was found by a person reading one member's run. The watchdog already
fingerprints each failed gate attempt (`job.watch.attempts`: scope, code, gate, checks, normalized
output digest), but only to catch loops inside one run.

- `scripts/lessons.mjs` reads `job.watch.attempts`, `errors.jsonl` codes and review blockers across
  every run in every project under a home (and, on the maintainer's machine, the smoke homes), and
  groups them by code, gate kind and checks. The output digest rarely matches across projects, so it
  is shown, not grouped on. Each run keeps its last 30 attempts, which is enough here. Any group seen in two or more runs is
  printed with its runs, first and last build ID, and whether it still occurs on the current build.
- The maintainer decides each candidate's fate: a prompt rule, a controller check, a planner rule,
  or nothing. Whatever it becomes lands with an incident case (item 3). No automatic prompt edits.
- For members: the feedback report's allowlisted run summary gains the fingerprints (code, gate,
  digest), which contain no brief text, so a pasted report feeds the same grouping.
- **Deferred (5b).** Per project: when a repair passes a gate that failed with a fingerprint seen before in that
  project, the controller appends one line to `.aai/gotchas.md` (gate, symptom, the repair's last
  note, capped), and build and repair prompts name that file. Plain markdown, read by any agent.

## 6. Review: a security pass and owner policy

**Effort L · Return M.** A prompt line, a template copy and a tree scan.

**Why.** The final review prompt names correctness, wiring, error handling, accessibility, privacy
and operator docs. Security is covered only where it overlaps privacy. Owners have no place to
state project-specific review rules other than the brief.

- Add a security line to the final and feature review prompts: input validation at trust
  boundaries, path handling under `data/`, secrets committed to the tree, unsafe defaults in auth or
  sessions the brief asked for. In the final review, findings are blockers with `qa/` bug tests like
  any other defect; feature reviews have no `qa/` mechanism and report blockers only.
- A controller check, not a review item: fail a gate when a file the run added or changed contains
  a credential. Scan contents, not names, and only the run's own changes (skipping `.factory/` and
  `.aai/`), or a follow-on whose shipped tree already matches would fail with nothing to repair. Of
  the `feedback.mjs` SCRUB patterns only the two credential ones apply, and they must be copied or
  moved, not imported: `feedback.mjs` imports from `factory.mjs`, so importing back is circular.
- `.aai/review.md`, scaffolded once from `templates/project/` like the other `.aai/` files and
  never overwritten, holds owner review rules ("money is integer cents", "no external fonts").
  The review request carries it in a separate `reviewPolicy` field, so reviewers must check it and
  cite it. It must not join the request's `sources`: `validateReview` rebuilds those from
  `.factory/uploads/` only, so every review would fail, and widening that set would mark every
  existing run `inputs_changed`.

## 7. Live-app incidents: dropped

Proposed earlier: threshold rules on `/_factory/metrics` drafting fix briefs. Dropped after audit
(Effort H · Return L). It depends on the unbuilt patch lane, and a local app has one user who sees
its failures directly; the app-stopped event and the telemetry probe already cover detection.

## 8. Controller-provided page and browser evidence

Split: **8a page check** (Effort L · Return M) can ride along with item 1; **8b browser evidence**
(H · M) deferred, since Chromium or Playwright is rarely on members' machines.

**Why.** Reviewers must report missing visual evidence and cite executed browser evidence, but
nothing gives them a browser, so the evidence is whatever a build agent improvised.

- **Page check (8a).** After deploy, the controller fetches `/` and fails the deploy gate on a 5xx,
  no answer, or an empty body on a 2xx, sharing the deploy repair budget. A 404 with a body passes,
  so API-only apps still deploy. Relaunch runs the same check. No browser needed.
- **Browser evidence (8b, deferred).** If a headless Chromium is available (`SOLOFACTORY_BROWSER`, or a discoverable Playwright
  install), after deploy and before final review the controller loads `/` and each route the
  metrics report, waits for network idle, and saves a screenshot, console errors and visible text
  length under `.factory/evidence/` for the final review request to list.
- Console errors or an empty page are a deploy gate failure sharing the deploy repair budget.
- No browser: the run records `browser: unavailable` and the review request says so, so reviewers
  block on missing visual evidence only where the brief requires it. Never silently passed.
- Provider-neutral by construction: the controller runs the browser, not the agent.

## Priority

From the audit. Effort: L under a day, M a few days or several files with tests, H a week or more,
or depends on unbuilt work. Return: what it saves owners or the maintainer (lost work, money,
silent wrong results, regressions), weighted by how often it bites.

| Rank | Item | Effort | Return | Why |
|---|---|---|---|---|
| 1 | 1 Health-check before replace | L | H | The only case where owners lose a running app today. |
| 2 | 2a Token run ceiling | L | H | The cost ceiling never binds on Codex, which reports no cost. |
| 3 | 4 Edited-proof backstop (cased proofs) | M | M–H | Turns a documented accepted risk into a controller check. |
| 4 | 6 Security line, credential-file gate, `.aai/review.md` | L | M | Cheap and provider-neutral. |
| 5 | 8a Page check at deploy | L | M | Most of the browser check's value for a fetch call. |
| 6 | 2b Parity table, Codex per-stage models | M | M | Needs the adapter args made testable first. |
| 7 | 3a Smoke run required at release | L | M | Catches prompt and model regressions; fires on version bumps only. |
| 8 | 5a Lessons script, report fingerprints | L–M | M | Reads data that already exists; maintainer-only. |
| 9 | 2c Codex config isolation | M | M | No incident yet; check the Codex CLI first. |
| 10 | 3b Incident cases, 3c Codex arm | H / L | M | Replay is a new subsystem; the arm needs a Codex sign-in. |
| 11 | 8b Browser evidence | H | M | Rarely available on members' machines. |
| 12 | 5b Project `gotchas.md` | M | L | Wait until 5a shows repeats. |
| — | 7 Live-app incidents | H | L | Dropped. |

## Deliberately not adopted

Organization governance (managed settings, change-management sign-off, release managers),
chat-channel incident responders, organization-wide skill distribution, scheduled security
scanning across repositories, and parallel agent sessions on worktrees. They serve multi-team
enterprises; SPEC.md §2 and §11 defer them for a one-owner local factory, and that still holds.
