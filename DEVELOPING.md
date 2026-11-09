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

Before a release that changes prompts, models or the controller, run the real-provider
smoke set by hand (about $10 and 35 minutes for the two small briefs; `household-inventory.json` is a mid-size brief of about 12-15 features that shows per-feature overhead and costs more):

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
