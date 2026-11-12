# Declared-writes ownership gap (Voice Notes smoke, 0.11.0-alpha.1)

Run `2026-11-12-d07bfd16`. The Voice Notes smoke failed (`quality_gate_failed`) after 2 of 6 features were built. I only read the run's files to find out why; there were no model calls.

## What happened

- **What QUEUE declared it would write:** `src/queue.js`, `src/app.js`, `scripts/fake-transcribe.js`, `test/helpers.js` and `test/queue.test.js`.
- **What the builder also changed:**
  - `src/server.js`: one line that passes `TRANSCRIBE_CMD` into `createApp`. PLAN.md says server.js reads `TRANSCRIBE_CMD`, but QUEUE didn't list that file.
  - `src/store.js`: a new `update(id, patch)` method. Without it the queue can't save its status changes (pending, transcribing, transcribed or failed) or the retry reset.
- **Why the gate refused:** `src/factory.mjs` widens a feature's writes to cover a modified file only when no unbuilt feature owns that file. Here RESTART, which wasn't built yet, owns server.js, and LIBRARY and RESTART own store.js. The gate's message says: "Move the change into an allowed file or revert it."

## Why no step caught or fixed it

- **Plan review:**
  - The plan-review prompt includes the check "a feature's writes miss files its obligations plainly need".
  - Round 1 blocked 6 issues, including the missing `test/helpers.js` writes. Round 2 approved.
  - Neither round flagged server.js or store.js for QUEUE.
- **Repair:**
  - The builder and repair prompts both say: "If the fix needs an existing source file outside [the writes], edit it: the controller adds it to this feature's writes" (`src/prompts.mjs` ~287 and ~680).
  - That contradicts the gate whenever a feature that isn't built yet owns the file.
  - The repair prompt offers no way to ask for a plan amendment or for wider writes.
  - Repairs 2 and 3 trusted the prompt. Both made no change, wrote that the files "should be added to QUEUE's writes", and the run stopped after 3 identical failures.

## Did this release cause it?

No. `git diff 80feac5 8c14e87 --stat` shows no change to `src/factory.mjs`, `src/prompts.mjs`, `src/providers.mjs`, `src/wbs.mjs`, or any planner or prompt file. The release only changed the Guide and interview, the server, the UI, the update check, the smoke scripts and the docs. The gate text is the same at 80feac5.

**Verdict:** a gap that existed before this release. Whether a run hits it depends on how the planner happens to split file ownership.

## Fix options, earliest point first

1. **Plan review:** check more sharply for wiring files. A feature whose behaviour needs an entry point (`server.js`) or a store method should list those files in its writes.
2. **Gate:** let it widen into a file whose owner isn't built yet, while the owner keeps the file in its own writes.
3. **Repair:** give the repair a way to request a plan amendment, and drop the "controller adds it" promise when the file's owner isn't built yet.
