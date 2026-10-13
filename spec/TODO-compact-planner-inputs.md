# TODO: compact planner inputs (long-term fix for oversized plans)

Status: deferred. Lou chose this as the better long-term fix on 2026-10-13. He is first retrying the
photo-library repair plan as-is.

## Problem
Commit a478f3e moved the repair request out of the prompt into
`.factory/recovery-request-<id>.json`, so the prompt now fits. The data is still unreadable. The
photo-library prior plan is ~2.44M characters (~600K tokens), more than any planner can hold, so
the planner searches and skims it and can miss obligations it must preserve. The bloat comes from
hundreds of cases each repeating the same long test commands, source references and case
descriptions.

## Fix
SoloFactory writes the planner a compact, lossless view of the prior plan alongside the full one:
- each obligation listed once by id, with behavior, refs and expectation;
- proof commands and source references stated once in a table, then referred to by id;
- the full plan stays on disk and stays authoritative; the compact view says where it is.

The view must be lossless: a test expands it back and compares it to the original plan. Nothing is
truncated or summarized away.

## Also bound (same principle: data in files, not prompts)
These still inline unbounded content and could hit the 200K cap (`MAX_PROMPT_CHARS`, src/providers.mjs):
- plan correction blockers: `src/feature-recovery.mjs` repairCorrectionPrompt, `src/prompts.mjs` ~503
- whole feature JSON: `src/prompts.mjs` ~247, ~532, ~536, ~572
- interview transcript + run snapshot: `src/interview.mjs` ~180-181

## Trigger to start
When the as-is retry shows the planner losing or weakening obligations, or the prompt sizes recorded
by the new `promptChars` field trend toward the cap.
