# Design pass: cutting feature-build time (2026-10-12, proposal, not implemented)

Baseline is smoke 11 (run 2026-10-12-20e1e4ce). Feature work took 1478 s of the 2110 s wall time.

| Turn | Time | Turns | Cost | Denied Bash calls |
|---|---|---|---|---|
| build F1 | 516 s | 44 | $5.12 (Fable $3.15) | 9 |
| repair-1 (F1) | 354 s | 32 | $3.42 | 21 |
| build F2 | 269 s | 34 | $2.82 | 5 |
| build F3 | 333 s | 39 | $4.38 | 11 |

## What the logs show

1. **Builders cannot run their own proofs.** The allow-list is `npm install`, `npm test`, `npm run build` and `check-plan`.
   Every proof command was denied: `node --test test/mark-done.test.js`, `node scripts/process-check.mjs` and
   `node scripts/e2e-cleanup-check.mjs`. So were orientation commands (`ls`, `git ls-files`, `find`) and any
   command starting `cd "<project>" && ...` (30 of the 46 denials).
   - F1's builder tried `node scripts/process-check.mjs`, was denied, and shipped a proof that recorded no cases.
     That cost the 354 s repair. The repair was then denied 21 more times.
   - A denied call costs a turn, and the agent then works around it.
2. **Builders inherit Lou's personal Claude Code config.** `claude -p` loads `~/.claude/settings.json`:
   - **`advisorModel: fable`.** Every build ran Fable as an advisor. That was 62% of F1's cost, and the advisor
     calls are uncached and serial. It also exposes the factory to the Fable usage limit that killed smoke 10.
   - **The `rtk hook claude` PreToolUse rewrite.** It turns `npm test` into `rtk npm test`, which the allow-list
     may then reject.
   - Lou's other hooks (guard-secrets, guard-large-read), plugins and global CLAUDE.md, which in turn routes to
     the `~/.aai` loads.

   A customer's machine would leak its own config the same way. Builds are not hermetic.
3. **Context re-reading is a symptom, not the cause.** Builders re-list and re-dump files mostly because
   their listing commands were denied. `slices.json` is 31 KB; the builder only needs its own slice.

## Proposals, in order of expected value

**A. Hermetic agent config** (src/providers.mjs, ~3 lines)
- Pass `--setting-sources project,local` so that user hooks, the advisor model and user plugins stay out.
- Also pass `--disallowedTools Agent` for write turns, so builders don't fan out sub-agents on unknown models.
- `--bare` is not an option: it refuses OAuth, and subscription users need OAuth.
- Verify before relying on it: does `--setting-sources` without `user` also drop the advisor and
  `~/.claude/CLAUDE.md`? Test with one cheap `claude -p` call on `/context` and compare `modelUsage`.
- Expected gain: Fable's share of cost goes to zero, fewer serial advisor round trips, and no rtk rewrites.

**B. Allow the feature's own proof commands** (providers.mjs plus the build/repair call sites in factory.mjs)
- The existing comment already sets the policy: "allow only the commands the controller's own gates already run."
  Proof commands are gates.
- The controller passes the current feature's proof commands, and for repairs every failing proof's command, as
  extra `Bash(<command>:*)` entries.
- Also allow read-only orientation commands: `Bash(ls:*)`, `Bash(git ls-files:*)`, `Bash(git status:*)`,
  `Bash(git diff:*)`.
- Expected gain: the F1 repair (354 s) would not have happened, and denial turns drop to about zero.

**C. `node .factory/check-feature.mjs`** (new script written beside check-plan.mjs, plus the prompt and allow-list)
- The script runs the feature's cased proofs with the controller's case reporter and prints missing or failed cases.
  It catches "printed its own ok lines" before the gate does.
- It depends on B for the commands it spawns. It is worth doing only if B alone still leaves case-shape repairs.

**D. Inline the builder's own slice in the prompt** (prompts.mjs)
- Put the builder's own slice (proofs, cases, files) in the prompt and tell it not to read the other slices.
- This is a small win once A and B remove the denial-driven re-reads. Measure first.

**Not proposed:**
- Smaller feature scopes. That adds plan, review and gate overhead per feature, and F2 (smallest) still took 34 turns.
- Integration gate repeats. They take seconds (10.6 s total gates).

## Plan

1. Do A and B together: one commit touching providers.mjs, factory.mjs, prompts.mjs and a provider test (4 files).
2. Rerun the smoke 9 brief.
3. Success criteria:
   - zero permission denials;
   - no `claude-fable` in `modelUsage`;
   - feature builds plus repairs under 900 s (from 1478 s).
4. Decide C and D from that run's logs.
