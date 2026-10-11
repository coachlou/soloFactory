# Requirement consolidation with case tables

Date: 2026-10-10. Branch `wip/feature-slice-recovery`. Built and tested; **not installed**.
No live run was changed. This replaces `HANDOFF-consolidated-photo-library-proofs.md` and
supersedes §3 of `REPORT-consolidated-photo-library-proofs.md` (the proposed `proof.tests`).

## Problem

Planners repeat near-identical obligations: the same behavior once per field, per boundary,
per surface. Batching their proof commands (already done: `verify()` dedupes identical
commands) cuts launches but leaves the repetition, and a shared command that exits 0 tells
the factory nothing about which obligation actually passed.

## Capability

A requirement may carry a table of **cases**. One requirement states the shared behavior;
each case keeps what made the original obligations distinct.

```json
{ "id": "UPLOAD-LIMITS", "behavior": "...", "refs": ["MH-1", "SC-1"], "sources": [...],
  "proof": { "command": ["node", "--test", "test/upload.test.mjs"], "expect": "every case passes" },
  "cases": [
    { "id": "UP-API-BIG", "surface": "api", "action": "POST a 26 MB jpeg", "boundary": "25 MB",
      "expect": "413 and nothing is stored", "refs": ["SC-1"], "sources": [...],
      "supersedes": ["OLD-BIG-API"] } ] }
```

| Field | Rule |
|---|---|
| `id` | Unique across the plan, sharing the namespace of requirement ids |
| `surface` | `api`, `browser`, `cli`, `unit` or `integration`. API and browser coverage stay separate cases |
| `action`, `expect` | Required. `field`, `boundary` optional; the failure condition lives in `expect` |
| `refs`, `sources` | `refs` is a subset of the requirement's (may be empty for a constraint case). Each source names one of the requirement's source files with its own locator. **Together** the cases cite every ref the requirement cites. Locators match by file, not by text, and there is no case-side source coverage: both lists are planner-authored, and these bookkeeping rules failed three real-provider plans (2026-10-11). Source fidelity against a reviewed plan stays with the mapping check |
| `supersedes` | Ids of reviewed obligations this case replaces. Each id may be claimed once in the plan |

A plan without cases normalizes byte-for-byte as before, so existing plan digests are unchanged.

### Where it applies

- **New-run planning**: `featurePlanPrompt` and the plan audit carry the consolidation rules.
  The schema check rejects malformed tables. `featureBuildPrompt` tells the builder each case
  needs its own node:test named with `[CASE-ID]`.
- **Repair planning**: `repairPlanPrompt` and its audit carry the same rules, plus the mapping
  check below against the reviewed plan.
- **Owner-submitted amendments**: the same mapping check, refused before any state write.

### Complete mapping (`assertConsolidation`)

When a reviewed (ready) plan exists, a replacement must account for every obligation it held:

- each reviewed obligation is either **kept** under its id or **superseded** by exactly one case,
  never both, never neither;
- the keeping requirement or superseding case keeps all its check refs and source citations;
- when it is proved (at build vs `pending: integration`) does not change;
- a `supersedes` id the reviewed plan lacks is an error.

All problems are reported together (first 10 shown). The base is the last **ready** plan; it
carries through later blocked corrections (`amendment.base`), because a blocked plan was never
accepted and cannot become the yardstick. A fresh planner turn after an input change has no
base: its request may legitimately add or remove obligations, so only the schema, prompt rules
and plan review apply there. Today a base therefore exists only for owner-submitted amendments. Refusal code: `amendment_unmapped` (HTTP 400). In
repair planning a failure becomes a plan blocker for the planner's correction.

The plan reviewer receives the reviewed obligations as `base` in its request and must block a
merge that drops or blurs a distinct field, action, boundary, failure condition or surface.

### Per-case proof

For a gate whose requirements have cases, `verify()` injects a factory-owned node:test reporter
(`src/case-reporter.mjs`) through `NODE_OPTIONS`, writing to
`<jobDir>/cases-<gate>-<attempt>.jsonl`. The app's own spec output still reaches the log.

- A case passes only on a test whose name contains `[CASE-ID]` that passed. A failing test
  for that id fails it; skip or todo marks it skipped; no test leaves it missing.
- The gate fails with `quality_gate_failed` unless **every** case passed, even on exit 0,
  naming each case that did not: `proof-UPLOAD-LIMITS cases did not pass: UP-API-BIG missing.`
- Results land in `job.caseResults` and go to feature and final review as `caseResults`. A
  requirement with cases passes review only when each case is `passed`.
- Requirements without cases keep the exit-code gate.

Completed work, evidence, approval digests and correction budgets are untouched: consolidation
only changes what a new plan may contain and how its gates are judged.

### Ceilings

- **node:test only.** Another runner records no events, and the gate says so. Upgrade path:
  a reporter per runner, or a structured results file with a nonce.
- **A proof command with its own `--test-reporter` breaks injection.** Prompts forbid it; the
  gate fails loudly rather than passing.
- **Events are reported by the app's process**, so a hostile app could forge them. This
  removes trust in the app's completeness logic, not in its honesty.
- **Five-minute gate timeout is unchanged**; a large case table shares one window.

## Tests

`test/consolidation.test.mjs` (9):
- a case table normalizes with its own surface, field, boundary and expected result; a plan
  without cases normalizes exactly as before;
- rejected: a dropped check, a dropped source, a ref or source the requirement lacks, a bad
  surface, a reused id, a repeated `supersedes`, an empty table;
- mapping: complete mapping passes; unmapped, dropped ref, dropped source, changed `pending`,
  unknown `supersedes`, kept-and-superseded are each named;
- the 578-obligation regression shape (appendix) maps fully; one unmapped obligation is named;
- per-case results: a failure beats a pass, skip is not a pass, `[X-01]` is not `[X-010]`;
- `verify()` with one passing case of three fails and names the other two; all three pass;
  silence gives the node:test message; uncased gates get no reporter;
- the real reporter under real node:test: a skipped case fails the gate, all passing pass it;
- the builder prompt states the `[CASE-ID]` convention.

`test/plan-amendment.test.mjs` (+1, existing ready-replacement tests now submit mapped plans):
an unmapped or weakened replacement is refused with zero turns and byte-identical state; the
reviewer sees `base`; a blocked correction is still checked against the reviewed plan.

Full suite: 247/247. (An earlier run hit one load-sensitive timing flake, "agent activity extends the idle
deadline" in `test/process.test.mjs`, untouched here; it passes alone.)

## Appendix: photo-library regression

Live run `2026-10-07-4f2dd1cf`, ready phase `42d97519` (unapproved; keep it that way while this
is assessed). The private plan stays in the photo-library repo and is not copied here.

- The ready plan has 17 features and **578 obligations**, one command each. That count is the
  example the consolidation tests are shaped after, not a target: a good consolidation may land
  on any number of requirements, as long as every one of the 578 maps.
- The existing candidate (`spec/consolidated-repair-plan/plan.json` in that repo) **only
  batches execution**: same 578 obligations, 37 commands, no `cases`, no `supersedes`.
  Checked read-only on 2026-10-10 by running `assertConsolidation(candidate, readyPlan)` on the
  real files: it **passes** (578/578 kept under their ids, 0 cases), and removing one
  obligation is refused by name (`TARGET-COMPAT-REGRESSION ... is neither kept nor
  superseded`). So the mapping check accepts the candidate but it gains nothing: its gates are
  exit-code gates and its strictness rests on an app-written runner.
- What a useful candidate needs: requirements with case tables whose case ids appear in test
  names, `supersedes` naming every original obligation id it folds in, and proof commands that
  run node:test without their own reporter. The app-written `verify-proof-group.mjs` runner
  and `proof-groups.json` map then become unnecessary.
- Regression check before submitting any regenerated candidate: `assertConsolidation(candidate,
  readyPlan)` passes, and the number of cases plus kept obligations covers all 578 ids.

## Not done

- Installing this build, and regenerating or submitting the photo-library candidate. Both need
  owner authorization.
- A real-provider run of a planner producing case tables. Fixture and unit tests only.
