# Developing SoloFactory

Repo-only: none of this ships in the distro (`distro/APP_FILES`).

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
`smoke/results.jsonl`; `node scripts/smoke.mjs table` prints the ledger. A free dry run of
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
