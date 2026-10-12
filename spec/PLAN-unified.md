# Unified plan: faster, feature-owned pipeline (2026-10-12)

This plan merges three sources:

- the **Feature Pipeline PRD** (Claude Doc "SoloFactory Feature Pipeline PRD", stages 1–5);
- `spec/DESIGN-build-time.md` (A–D);
- the open INBOX audit "nested regression replay and final candidate composition".

Steps are ordered by leverage: the biggest time or risk cut per unit of work comes first. Each step is a separate
commit (or small series), has its own acceptance criteria, and is measured with `scripts/measure-run.mjs` against
smoke 11 before the next step begins.

| # | Step | Source | Size | Why here |
|---|---|---|---|---|
| 1 | **Hermetic, verifiable agent turns** | Design A+B | S | 46 permission denials and a Fable advisor in every build; the F1 repair (354 s) came from a blocked proof run. Biggest cut for the least code. |
| 2 | Smoke rerun and measurement | Design plan | – | Success: 0 denials, no Fable in `modelUsage`, builds plus repairs under 900 s (from 1478 s). |
| 3 | Inline the builder's own slice | Design D | S | Stops the full 31 KB `slices.json` dump in every build and repair. Decide from step 2's logs. |
| 4 | Per-release fixed-cost measurement | PRD (pre-stage 1) | – | No code: run one brief as one job vs three follow-on briefs. Sizes the payoff of stages 2–4. |
| 5 | Feature records and declared `writes` | PRD stage 1 | L | Fixes the Restart-from-slice budget refill defect. Prerequisite for impact selection and for continuing past a blocked feature. |
| 6 | Merge checks with impact selection and nonrecursive proof composition | PRD stage 2 + INBOX audit | M | Gates are seconds on small apps but dominate at scale: photo-library regression proofs ran 808 s ×3, and their aggregates nest. Rerun only affected proofs; flatten aggregates. |
| 7 | Release QA and bug items | PRD stage 3 | M | Agent QA once per release; findings come back as failing tests owned by a feature. |
| 8 | Continue past a blocked feature | PRD stage 4 | M | A failed feature parks only its dependents. |
| 9 | Builder-run `check-feature.mjs` | Design C | S | Only if case-shape repairs still happen after steps 1 and 3. |
| 10 | Parallel builds (worktree per feature) | PRD stage 5 | L | Only after steps 5–8 are proven. |

## Step 1: hermetic, verifiable agent turns

**Change:** `src/providers.mjs` plus the build and repair call sites.

- Every Claude turn runs with `--setting-sources project,local --strict-mcp-config`, so it doesn't pick up the
  user's hooks (rtk rewrites), `advisorModel`, plugins or claude.ai connectors (Gmail, Docs and so on).
  - Verified 2026-10-12: with these flags the tool list drops both `advisor` and every `mcp__claude_ai_*` server.
- Write turns also get `--disallowedTools Agent`, so they don't fan out sub-agents on unknown models.
- Write turns are allowed:
  - read-only orientation commands: `ls`, `git ls-files`, `git status`, `git diff`, `git log`;
  - `node --test`;
  - the controller's own gate commands, i.e. the current feature's proof commands. For a repair, that is every
    proof command in the verification it repairs.

**Acceptance:**

- [ ] A unit test asserts the args contain the isolation flags.
- [ ] A unit test asserts a build turn's allow-list contains its feature's proof commands.
- [ ] `npm test` passes.
- [ ] Smoke 12 shows 0 permission denials and no `claude-fable` in any build's `modelUsage`.

## Open questions (from the PRD, decide by step 7)

- What triggers release QA: every N merged features, a milestone, or on request?
- Is "blocks this release" the default for findings in a feature's own declared checks?
- Does a bug item get the owning feature's remaining budget or a fresh one?
