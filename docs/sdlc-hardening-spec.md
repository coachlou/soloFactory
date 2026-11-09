# SDLC hardening: rollback, harness parity, release evals, proof backstops, lessons, incidents — spec

**Status: proposal, rewritten 2026-11-09 against `main` at cd22719 (0.10.17 + Unreleased).
Nothing here is implemented.** SPEC.md stays the source of truth; items move there as they ship.
The 2026-10-06 version of this file predates planned features and is superseded.

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
| A follow-on deploy stops the live app before the new one passes `/health`; a failed deploy leaves nothing live, and relaunch is refused for any run but the newest | The new release is health-checked on its own port first; the old one stops only after that, and a failed deploy keeps or restores the last good release |
| Claude turns are isolated from personal config, allowlisted and split across models; Codex turns inherit the owner's config, run with `--approve-for-me`, and use one model for every stage | One parity table per adapter; the controller covers what an adapter cannot; Codex gets per-stage models and config isolation |
| The run cost ceiling sums cost Claude reports; Codex turns report none and are skipped | The ceiling also has a token limit, so it binds on every provider |
| The smoke set is two briefs, all rows on Claude, run by hand | Required for releases that change prompts, models, adapters or the controller; incident cases replay from a saved stage; a Codex arm |
| An edited earlier proof is checked only by reviewers (PROGRESS: "accepted risk") | The case reporter proves an edited proof still passes every case it passed before |
| Lessons (test-script rule, own-files rule, accessible names) are found by reading member reports | Failure fingerprints are grouped across runs and projects and surfaced as lesson candidates |
| Review checks privacy but not security; no owner review policy | A security pass and an owner-editable `.aai/review.md` |
| `/_factory/metrics` is collected from live apps and never acted on | Threshold breaches draft a proposed fix brief the owner can queue |
| Reviewers must cite browser evidence, but the controller supplies no browser | An optional controller-run browser check produces the evidence |

## 1. Deploy: health-check before replace, keep the last good release

**Why.** `deployLocal` (`src/factory.mjs`) takes the project's live app out of `liveByProject`,
marks it `replaced` and stops it before launching the new release. If the new release then fails
its health or metrics check (and its bounded repair), the owner has no running app, and
`POST /api/jobs/:id/relaunch` refuses the previous run because it is not the newest in its project.
Rollback should be the most ordinary path, not one that does not exist.

- Launch the new release on a fresh port (as today) while the old one keeps running. Apps already
  get distinct ports and `data/` is shared and gitignored, so two copies can run briefly. A brief
  that cannot tolerate two processes on one `data/` (an exclusive lock file, say) is the exception;
  the app's start failure is then treated like any deploy failure below.
- Only after `/health` and `/_factory/metrics` pass: stop the old app, mark it `replaced`, record
  the new deployment. This is the existing code with its two halves swapped.
- If the new release fails deploy after its repair budget: the old app stays `live` and the run
  parks with its usual recovery. The card says "previous release still running at <url>".
- If the old app was already stopped (factory restart, crash): allow relaunch of the newest
  *completed* run in the project, not only the newest run, so the owner can always get back to
  the last release that passed every gate.
- Tests: a fixture follow-on whose start command exits immediately leaves the earlier fixture app
  answering `/health`; relaunch of the last completed run succeeds while a newer failed run exists.

## 2. Harness parity

**Why.** The controller-side gates are provider-neutral, but the adapters are not equal. Claude
turns run with `--setting-sources project,local --strict-mcp-config`, `--disallowedTools Agent`,
a command allowlist and the single-command shell rule, and stages split across models
(Sonnet builders, Opus reasoning, Opus Guide). Codex `exec` runs with the owner's own Codex
configuration, `--approve-for-me` in write mode, and one `SOLOFACTORY_CODEX_MODEL` /
`_REASONING_EFFORT` for every stage, so on Codex the reviewer is the builder's model. The run cost
ceiling skips turns without a reported cost, which is every Codex turn.

- **Parity table.** Each adapter exports a small, tested object stating what it guarantees:
  `isolatedConfig`, `commandAllowlist`, `noSubagents`, `readOnlyMode`, `perStageModels`,
  `reportsUsage`, `reportsCost`. `test/providers.test.mjs` asserts the table matches the args the
  adapter builds, and DEVELOPING.md prints it. A guarantee an adapter cannot give is a visible
  `false`, not an omission.
- **Controller covers the gaps.** Anything the parity table marks `false` that the factory relies
  on must already be checked by the controller (writes gate, plan/contract checks, verdict
  binding). Where it is not, add the check rather than relying on the flag. Example: agent changes
  to `data/` are already reported after each turn regardless of provider; keep extending that
  pattern rather than adding per-CLI rules.
- **Codex config isolation.** Find the Codex equivalent of Claude's project-only settings. If none
  exists, run Codex with a factory-owned config location that carries only the sign-in, so the
  owner's MCP servers, profiles and global instructions do not enter build turns. Needs checking
  against the installed Codex CLI first: its home directory also holds credentials.
- **Codex per-stage models.** Use the stage classification Claude already uses (guide, reasoning,
  builder) with `SOLOFACTORY_CODEX_GUIDE_*`, `_REASONING_*` and the existing builder settings,
  defaulting to the picks in `notes/sdlc-model-value-table.md`. New settings go in the manual's
  Settings table (the docs gate already enforces this).
- **Token ceiling.** `SOLOFACTORY_MAX_RUN_TOKENS` alongside the cost ceiling, summed from usage
  every adapter reports, with the same park code (`run_budget_reached`), Resume allotment and card
  text. The cost ceiling stays for Claude, where it means something.
- **Cross-provider review when available.** If a second signed-in provider exists, plan review and
  final review may run on it (`SOLOFACTORY_REVIEW_PROVIDER`). Off by default until smoke rows show
  it changes outcomes (the Jev lesson: measure outcome change, not accuracy).

## 3. The smoke set becomes a release gate, with incident cases and a Codex arm

**Why.** `scripts/smoke.mjs` and `smoke/results.jsonl` are the eval suite; they are run by hand,
cover two briefs and have only Claude rows. The member runs that drove 0.10.6–0.10.12 are not in
it, so a later change can bring them back unnoticed.

- **Release gate.** `build-distro.sh --check` already fails a release whose PROGRESS entry has no
  `- Docs:` bullet. Add: when the release's diff touches `src/prompts.mjs`, `src/providers.mjs`,
  `skills/factory-guide.md`, model defaults or `src/factory.mjs`, `smoke/results.jsonl` must hold a
  passing row for a commit in that release for each brief. A written waiver line in the PROGRESS
  entry (`- Smoke: waived, <reason>`) satisfies it, so the gate never blocks a docs-only fix.
- **Incident cases.** `smoke/cases/<id>/`: a frozen brief, a saved project tree (a git bundle) and
  the stage and cursor to resume from, plus the expected result (`passed`, or a named park code).
  `smoke.mjs case <id>` restores the tree into a fresh home and resumes there, so a replay costs one
  feature or one review, not a whole build. Seed: the 25-feature rebuild (0.10.6), the unprovable
  live-Gmail brief (0.10.7), the broken `node --test test/` script (0.10.12), the per-row checkbox
  without an accessible name (Unreleased), the habits-html proof broken by a later feature
  (Unreleased). Cases never carry owner data or secrets; member-derived cases are rewritten
  into synthetic briefs.
- **Codex arm.** `SMOKE_PROVIDER=codex` rows for both briefs at each release that changes the
  adapter. The ledger already has an `arm` column; the table groups by provider.
- **Incident → case rule.** A fix for a reported run lands with its case, as the docs gate lands
  with its bullet.

## 4. Backstop for edited earlier proofs

**Why.** Since 0cb4bd5 a feature's repair may edit an earlier feature's proof test that its change
broke. PROGRESS records this as an accepted risk whose backstop is the feature and final reviewers
reading `editedProofs`. That backstop is a model's judgment. The factory already owns a reporter
that records exactly which named cases ran and how they ended (`src/case-reporter.mjs`).

- When a proof first passes, store the set of its passing case names (and, for uncased proofs, the
  node:test summary's pass count) on the feature's `sliceStats`.
- When that proof reruns after one of its test files was edited (`brokenProofs` /
  `editedProofs`), every stored case name must still be reported as passing, and the pass count
  must not fall. A case may be removed only by a plan entry that `supersedes` it, the rule
  replacement plans already follow.
- A violation fails the gate as `proof_weakened`, naming the missing cases. It goes to repair like
  any gate failure, within the same budget, so the repair can restore the case. Reviewers still
  read the edited files; this makes the accepted risk a checked one.
- Provider-neutral: it reads the factory's own reporter output, not the agent's account.

## 5. Lessons from repeated failures across runs

**Why.** Every recent prompt rule (`TEST_SCRIPT_RULE`, `OWN_FILES_RULE`, accessible names for
repeated controls) was found by a person reading one member's run. The watchdog already
fingerprints each failed gate attempt (`job.watch.attempts`: scope, code, gate, checks, normalized
output digest), but only to catch loops inside one run.

- `scripts/lessons.mjs` reads `job.watch.attempts`, `errors.jsonl` codes and review blockers across
  every run in every project under a home (and, on the maintainer's machine, the smoke homes), and
  groups them by code, gate kind and normalized message. Any group seen in two or more runs is
  printed with its runs, first and last build ID, and whether it still occurs on the current build.
- The maintainer decides each candidate's fate: a prompt rule, a controller check, a planner rule,
  or nothing. Whatever it becomes lands with an incident case (item 3). No automatic prompt edits.
- For members: the feedback report's allowlisted run summary gains the fingerprints (code, gate,
  digest), which contain no brief text, so a pasted report feeds the same grouping.
- Per project: when a repair passes a gate that failed with a fingerprint seen before in that
  project, the controller appends one line to `.aai/gotchas.md` (gate, symptom, the repair's last
  note, capped), and build and repair prompts name that file. Plain markdown, read by any agent.

## 6. Review: a security pass and owner policy

**Why.** The final review prompt names correctness, wiring, error handling, accessibility, privacy
and operator docs. Security is covered only where it overlaps privacy. Owners have no place to
state project-specific review rules other than the brief.

- Add a security line to the final and feature review prompts: input validation at trust
  boundaries, path handling under `data/`, secrets committed to the tree, unsafe defaults in auth or
  sessions the brief asked for. Findings are blockers with `qa/` bug tests like any other defect.
- A controller check, not a review item: fail a gate when the tree contains a file matching the
  credential patterns `feedback.mjs` already scrubs. Provider-neutral and cheap.
- `.aai/review.md`, scaffolded once from `templates/project/` like the other `.aai/` files and
  never overwritten, holds owner review rules ("money is integer cents", "no external fonts").
  It is listed among the review request's source files, so reviewers must check it and cite it.

## 7. Live-app incidents become proposed briefs

**Why.** Generated apps report requests, errors and latency through `/_factory/metrics`, and the
factory notices when a live app stops, then does nothing further.

- **Detection** (controller, deterministic, unit-tested, off by default): while an app is live,
  read its metrics every few minutes. Default rules: the app stopped unexpectedly; error ratio above
  a threshold over a minimum number of requests since the last read. Local apps see little traffic
  and metrics reset on restart, so these are plain thresholds with a minimum sample, not statistical
  bands. Per-project overrides in `.aai/monitor.json`.
- **Response**: record an event and show it on the run card; with the owner's opt-in, one read-only
  diagnosis turn (deployment log tail, metrics, recent diff) writes a short incident note.
- **Hand-off**: the note pre-fills a follow-on interview ("what happened, what should have
  happened"), or a patch-lane card once the patch lane exists. Only the owner queues it. The
  controller never starts a fix on its own.
- The incident note and fingerprint feed items 3 and 5.

## 8. Controller-provided browser evidence

**Why.** Reviewers must report missing visual evidence and cite executed browser evidence, but
nothing gives them a browser, so the evidence is whatever a build agent improvised.

- If a headless Chromium is available (`SOLOFACTORY_BROWSER`, or a discoverable Playwright
  install), after deploy and before final review the controller loads `/` and each route the
  metrics report, waits for network idle, and saves a screenshot, console errors and visible text
  length under `.factory/evidence/` for the final review request to list.
- Console errors or an empty page are a deploy gate failure sharing the deploy repair budget.
- No browser: the run records `browser: unavailable` and the review request says so, so reviewers
  block on missing visual evidence only where the brief requires it. Never silently passed.
- Provider-neutral by construction: the controller runs the browser, not the agent.

## Build order

1. Deploy health-check-before-replace (1): small, and the only item that changes what owners lose
   today.
2. Token ceiling and the parity table (2), then Codex per-stage models and isolation.
3. Smoke release gate and the first incident cases (3); Codex arm once (2) lands.
4. Edited-proof backstop (4).
5. Lessons script (5), then project `gotchas.md`.
6. Security pass, credential-file check, `.aai/review.md` (6).
7. Browser evidence (8).
8. Live-app incident proposals (7), after the patch lane.

## Deliberately not adopted

Organization governance (managed settings, change-management sign-off, release managers),
chat-channel incident responders, organization-wide skill distribution, scheduled security
scanning across repositories, and parallel agent sessions on worktrees. They serve multi-team
enterprises; SPEC.md §2 and §11 defer them for a one-owner local factory, and that still holds.
