# SDLC hardening: evals, contract protection, independent review, lessons, incidents — spec

**Status: proposal (2026-10-06). Nothing here is implemented.** SPEC.md stays the source of
truth for current behavior; items move there as they ship.

**Goal.** Close the gaps between SoloFactory's loop and a mature AI-native SDLC: changes to
the harness are measured before they ship, gates cannot be satisfied by weakening them, the
reviewer is not the author, repeated mistakes become durable instructions, and a live app's
failures feed back into the queue. Prompted by a comparison against a published AI-native
SDLC playbook (artifact chain intent → spec → plan → diff → review → incident → intent).

## Harness neutrality (applies to every item)

SoloFactory drives any coding-agent CLI through the provider adapter in `src/providers.mjs`
(Codex and Claude Code today). Nothing in this spec may depend on a feature of one harness.

- **Enforcement lives in the controller, never in the agent's harness.** No harness hooks,
  permission files, plan modes, or managed settings. The controller observes the result of a
  turn (git diff, file contents, gate exit codes) and accepts or parks the run. Any CLI that
  can edit files and exit is compatible.
- **Instructions live in `.aai/`.** Lessons and review policy are plain markdown under the
  project's `.aai/` (and the factory home), reached by the existing `CLAUDE.md`/`AGENTS.md`
  anchors and named explicitly in stage prompts. No harness-specific skill or rule format.
- **The adapter contract does not grow** beyond what any provider can supply: run a prompt in
  a directory, stream output, return exit status and (when available) usage. Optional
  capabilities, such as read-only execution, are declared by the adapter and degrade to a
  controller check when absent.
- **"Different reviewer" means different context first, different provider when available.**
  Never assume a second provider is installed.
- **Records are tool-neutral files**: JSON lines, markdown, git commits.

## Where we are

| Today | After |
|---|---|
| A prompt, skill, or model-pin change is judged by the next real build | A replay corpus runs against the change and is compared with the baseline before it ships |
| Repair is *asked* not to weaken tests, the contract, or the manifest | The controller diffs every repair/review turn and parks the run if protected files or test coverage regress |
| The final reviewer audits and fixes in one turn, usually on the building provider | Review is a separate, fresh-context turn (other provider when available) in three named passes, against an owner-editable policy |
| Lessons (PORT leak, npm allowlist, crash on launch) are hand-edited into the harness | Repairs record the trap they fixed; repeats are surfaced as lesson candidates and eval cases |
| A live app's errors and crashes are shown, then forgotten | Threshold breaches draft a *proposed* fix card the owner can queue |
| Gates prove `/health` answers | An optional browser smoke check renders the app and saves a screenshot as evidence |

## 1. Replay corpus that gates harness changes

**Why.** Every behavior SoloFactory adds is a prompt or controller change, and today the only
test of a prompt change is a live build. The 2026-09-27 repair replay (pre-repair tree,
$2.19 vs $3.14) showed replays are cheap and decisive; make them routine.

- **Corpus** in the factory repo (`evals/cases/<id>/`): a frozen `requirements.json`, the
  stage to start from, an optional starting tree (a git bundle or commit of the project at
  that point), the expected outcome (`completed`, or a named park code), and the provider/model
  it was captured on. Seed cases: e2e-yoga, Snap & Go, Assay follow-on, the PORT/HOST leak, the
  launch crash on a missing env var, one invalid slice plan.
- **Runner** (`scripts/eval.mjs`): for each case, create a scratch project, check out the
  starting tree, queue the case through the normal `POST /api/jobs` path (or call the factory
  directly) with `SOLOFACTORY_VARIANT=<label>`, and collect the resulting `runs.jsonl` line.
  Uses whatever provider is selected; cases may pin one.
- **Comparison**: outcome match, slices green without repair, repairs, agent turns, wall
  time, tokens. Report a table of baseline vs. candidate; flag any case whose outcome
  changed. Cost is a reported number, not a pass criterion.
- **When it runs**: by hand before merging a change to `src/prompts.mjs`,
  `skills/factory-guide.md`, the model/effort pins, or the gate/repair logic. A CI job may
  run the deterministic subset (fixture provider, `SOLOFACTORY_DEMO=1`) on every push; real
  provider cases stay manual because they spend the owner's subscription.
- **Incident → case**: when a failed run is fixed in the harness, its brief and pre-failure
  tree become a case in the same change. A "Report this run" issue is closed with the case id.
- **Guard**: cases never contain secrets or customer data (same rule as briefs).

## 2. Controller-enforced contract protection

**Why.** Repair and review prompts say "do not weaken, skip, rename, or delete tests, health
checks, metrics, build commands, or acceptance criteria." That is advisory. A turn that
deletes a failing test turns the gates green, and nothing notices. The design principle
"agent prose cannot mark a gate green" should cover agent *edits* too.

After every repair, review, and continuation turn, and after each slice after the first,
the controller compares the tree against the commit before the turn:

- **Protected paths** must be byte-identical: `.factory/requirements.json`,
  `.factory/ACCEPTANCE.md`, `.factory/slices.json` (outside the spec and plan-review stages),
  and the `commands`, `healthPath`, and `metricsPath` fields of `factory.json`.
- **Test files** (paths matched by a small, documented pattern set, e.g. `test/`, `tests/`,
  `*.test.*`, `*.spec.*`) may be added or edited but not deleted or renamed away.
- **Test count** must not drop. The controller reads it from the test gate's own output
  (node:test / TAP summary first; a missing count is recorded, not guessed) and compares it
  with the last green gate run. Skips count as drops.
- **Scenario coverage** (slice runs): every `[SC-n]` that a test referenced at the last green
  gate is still referenced by some test.

A violation parks the run as `contract_weakened`, naming the file or count and keeping the
diff in evidence. It is not repairable inside the run, because the repair loop is what
produced it; the owner resumes (the controller restores the protected files from the prior
commit before the turn) or starts over. All checks are git and file reads, so they work with
any provider.

## 3. Independent review in passes

**Why.** The agent that wrote the code should not be the one that approves it. Today the
final reviewer is a single turn that may also fix, usually on the same provider and model as
the build.

- **Separate context, always.** Review starts a fresh session with no build transcript. It
  reads the frozen artifacts, the diff since the specification commit, and gate output.
- **Other provider when available.** If a second signed-in provider exists, review uses it by
  default (`SOLOFACTORY_REVIEW_PROVIDER` overrides). Otherwise same provider, fresh session.
- **Three passes, one record.** `.factory/REVIEW.md` gets three sections, each with findings
  (`blocking` or `note`, file:line, reason):
  1. *Correctness*: bugs, wiring, error handling.
  2. *Security and privacy*: input handling, secrets in the tree, the telemetry privacy
     contract, dependency red flags.
  3. *Contract compliance*: each SC-n traced to the test that proves it; each PRD must-have
     traced to code; each slice's changes stayed within its objective (diff vs. plan).
- **Find, then fix, as separate turns.** The reviewer writes findings only (read-only when
  the adapter declares that capability; otherwise the controller rejects a review turn that
  changed anything except `.factory/REVIEW.md`). Blocking findings go to the existing bounded
  repair worker, which is subject to item 2. Notes are recorded, not acted on.
- **Owner policy.** `.aai/review.md`, scaffolded once like the other `.aai/` files, holds
  project-specific review rules ("all money values are integer cents", "no external fonts").
  The review prompt names it.
- **Measure it.** `runs.jsonl` gains findings per pass and how many blocking findings the
  repair fixed. Owners can mark a finding wrong from the run card; the rate of wrong findings
  is how the prompt is tuned, not the volume.

## 4. Lessons: the second time a mistake happens, write it down

**Why.** Each harness fix so far (PORT/HOST leak, npm allowlist, crash on launch) was found by
a human reading logs. The same pattern inside generated projects is never recorded at all.

- **Per project: `GOTCHAS.md` by directory.** (Harness-ideas backlog item 4.) A repair that
  fixes a trap appends one line to `GOTCHAS.md` in the nearest directory it touched: the
  symptom, the cause, the rule. Build and repair prompts list the `GOTCHAS.md` files on the
  paths a slice touches, plus ancestors. Plain markdown, read by any agent.
- **Repair records its cause.** The repair prompt asks for a final line
  `ROOT-CAUSE: <category>: <one sentence>`; the controller stores it in the `repair.completed`
  event and `runs.jsonl` (free text, capped, scrubbed). Missing is allowed and counted.
- **Factory-wide candidates.** `scripts/lessons.mjs` groups `errors.jsonl` codes and repair
  root causes across all projects. Anything seen in two or more runs is printed as a lesson
  candidate with its runs. The maintainer decides whether it becomes a prompt line, a
  controller check, or nothing, and adds an eval case (item 1) for whichever it becomes. No
  automatic prompt edits.

## 5. Live-app incidents become proposed fix cards

**Why.** The factory already collects `/_factory/metrics` and notices when a deployed app
stops, then does nothing with it. Closing the loop turns monitoring into the next brief.

- **Detection** (controller, deterministic, unit-tested): every N minutes while an app is
  live, read its metrics. Rules, configurable per project in `.aai/monitor.json` with
  defaults: the app stopped unexpectedly; error ratio above X% across at least M requests
  since the last check; p95 latency above Y ms across at least M requests. Low local traffic
  makes statistical bands noisy, so these are plain thresholds with a minimum sample size.
- **Response tiers**: *log* (record an event, show on the run card); *diagnose* (one
  read-only agent turn with deployment.log tail and metrics, writing a diagnosis); *propose*
  (the diagnosis becomes a fix card in the patch-lane format: what happened, what should
  have happened, evidence). Proposed cards wait in a "proposed" list; only the owner queues
  them. The controller never auto-runs a fix.
- **Depends on** the patch lane (backlog) for the card format and lane. Until then, a
  proposal pre-fills a follow-on interview instead.
- When the fix ships, its reproduction test stays in the app's suite. That is this project's
  equivalent of an eval.

## 6. Optional visual smoke check

**Why.** Gates prove the server answers `/health`, not that the UI renders. The interview
already accepts mockups that nothing checks against.

- After deploy, if a headless browser is available (`SOLOFACTORY_BROWSER=<path>` or a
  discoverable Chromium/Playwright install), load `/`, wait for network idle, and record:
  console errors, non-empty body text, a full-page screenshot saved to run evidence.
- Console errors or an empty page are a repairable gate failure, sharing the deploy repair
  budget. No browser: the check is skipped and the run says so, never silently passed.
- The review turn (item 3) receives the screenshot and any attached mockup and comments on
  visible divergence as `note` findings. Pixel comparison is out of scope.

## 7. Smaller additions

- **Plan fields.** Slices gain optional `risks` (what could break) and `notChosen` (rejected
  approach and why). The plan reviewer must challenge each risk. Validation stays as today;
  the fields are free text with length caps.
- **Recorded deviations.** If a slice turn departs from its slice's objective, it appends a
  dated line to `.factory/DEVIATIONS.md` in the same turn; review pass 3 reads it.
- **Derived metrics** from `runs.jsonl` in `scripts/stats.mjs`: share of slices green without
  repair, repairs per run, spec rework (commits to `.factory/PRD.md` after the first build
  commit), contract violations (item 2), wrong-finding rate (item 3), recurring root causes
  (item 4).

## Build order

1. Contract protection (2): small, controller-only, and protects every later change.
2. Replay corpus (1): needed to measure 3, 4, and 6.
3. Root-cause line and lessons script (4), then per-directory `GOTCHAS.md`.
4. Independent review (3), judged on the corpus.
5. Visual smoke check (6).
6. Incident proposals (5), after the patch lane.

## Deliberately not adopted

Organization governance (managed settings, human approval gates on deploy, change-management
sign-off), chat-channel incident responders, organization-wide skill distribution, scheduled
security scanning across repositories, and parallel agent sessions on worktrees. They serve
multi-team enterprises; SPEC.md §2 and §11 defer them for a one-owner, local factory, and that
reasoning still holds.
