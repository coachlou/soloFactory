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
smoke set by hand (about $10 and 35 minutes for both briefs):

```bash
node scripts/smoke.mjs
```

It builds each brief in `smoke/briefs/` in a fresh home and appends one row per run to
`smoke/results.jsonl`; `node scripts/smoke.mjs table` prints the ledger. A free dry run of
the loop: `SOLOFACTORY_DEMO=1 SMOKE_PROVIDER=fixture SMOKE_LEDGER=/tmp/smoke.jsonl node scripts/smoke.mjs`.
