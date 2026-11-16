# Developing SoloFactory

Repo-only: none of this ships in the distro (`distro/APP_FILES`).

## Gate tiers

Each check belongs to one tier (`docs/four-tier-gates-spec.md`):

| Tier | Check | When it runs |
|---|---|---|
| 1 Rules | `node --check` on staged `.mjs` files (`scripts/hooks/pre-commit`) | every commit |
| 2 This change works | `npm test` (distro check first) | locally, and in `pre-push` on any push to main |
| 3 Main works | GitHub Actions `test` on Linux | every push and pull request |
| 4 Ready to release | smoke gate and smoke set; Linux CI green on the release commit (`scripts/ci-green.mjs`) | at the version bump, and in `pre-push` on a release push to main |

Turn the hooks on once per clone or worktree:

```bash
npm run hooks   # git config core.hooksPath scripts/hooks
```

Once it is set, git ignores an old `.git/hooks/pre-push`; the versioned one does the same and more.
`git push --no-verify` skips the hooks when you mean to.

**Release only from a commit that passed Linux CI.** Members run Linux (WSL), and the local suite runs on macOS.
Push the release commit to a branch first (`git push origin HEAD:release-<version>`), wait for CI to pass, then
push the same commit to main. The `pre-push` hook refuses a push to main that changes `package.json`'s version
until `node scripts/ci-green.mjs <sha>` finds a successful `test` run on that exact commit (it uses `gh`, signed in).
Tag and sync to ambient-library only from that commit.

## Verify the factory

```bash
npm test
```

The suite exercises intake validation, API-key scrubbing, command restrictions,
activity-aware agent timeouts, bounded same-session continuation, same-run recovery,
failure repair, the complete HTTP workflow, a real generated Node app, health checks, and
live metrics. It runs the distro check first, and GitHub Actions runs it on Linux for every
push and pull request.

A release that changes prompts, adapters (models included), the Guide skill or the controller
(`src/prompts.mjs`, `src/providers.mjs`, `skills/factory-guide.md`, `src/factory.mjs`) must run the
real-provider smoke set first. Once `package.json` carries a version that has no tag yet, `npm test`
fails until `smoke/results.jsonl` has a passing real-provider row for every brief at or after the last
commit that touched one of those files, or the version's own PROGRESS heading has
`- Smoke: waived, <reason>`. Fixture rows never count, and CI (a checkout with no tags) skips the gate
(`scripts/smoke-gate.mjs`). Run it on the Node major the briefs name (Node 24 today): a real run on an older
Node is refused before it starts, because the plan reviewer would reject every plan for the missing runtime. Run the smoke set by hand (about $10 and 35 minutes for the two small briefs; `household-inventory.json` is a mid-size brief of about 12-15 features that shows per-feature overhead and costs more):

```bash
node scripts/smoke.mjs
```

It builds each brief in `smoke/briefs/` in a fresh home and appends one row per run to
`smoke/results.jsonl`; `node scripts/smoke.mjs table` prints the ledger. Each row also records minutes
per stage (`stageMin`: planning, implement, review, repair, gates). A stage over its budget is printed after
the run and shown in the table's *Over budget* column. Budgets: planning 8 min, implement 3 min and review 1.5 min
per feature, repair 5 min, gates 3 min (`STAGE_BUDGETS` in `src/measure.mjs`). `SMOKE_BUDGETS="review=2,planning=10"`
overrides them for one session. A budget is a tripwire to investigate, never a failure. A free dry run of
the loop: `SOLOFACTORY_DEMO=1 SMOKE_PROVIDER=fixture SMOKE_LEDGER=/tmp/smoke.jsonl node scripts/smoke.mjs`.

To A/B the per-feature review, pair runs of the same brief:

```bash
SMOKE_ARM="review risky" SOLOFACTORY_FEATURE_REVIEW=risky node scripts/smoke.mjs
```

The baseline arm uses the default `all`. Each row records:
- **Reviews**: scoped reviews run.
- **Skipped**: features that skipped their review.
- **Skipped findings**: final-review bugs in skipped features' files.
- **Unattributed findings**: bugs in files no feature declares.

Make `risky` the default only when both hold over at least two pairs per brief:
- Skipped findings stay near zero.
- Cost per feature drops by at least 15%.

Smoke briefs rarely make the scoped review block, so also check a brief that does.
