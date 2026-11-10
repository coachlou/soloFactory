#!/usr/bin/env node
// Fixed smoke set: run the stored briefs with a real provider and keep one comparable row per run.
//
//   node scripts/smoke.mjs [brief.json ...]       run briefs (default: every smoke/briefs/*.json), one after another
//   node scripts/smoke.mjs summarize <run dir>... print rows for runs that already happened (no spend)
//   node scripts/smoke.mjs table                  print the ledger, smoke/results.jsonl, as Markdown
//
// Real runs cost about $4-15 and 15-50 min each: required before a release that changes prompts, adapters,
// the Guide skill or the controller (scripts/smoke-gate.mjs checks it at the version bump); never on a schedule. One run per brief is noisy; read it as a tripwire.
// Each run gets a fresh home under .solofactory/smoke-runs/ and an in-process server on an ephemeral
// port (never :4173). Model and effort come from the usual SOLOFACTORY_* env, e.g.
//   SMOKE_ARM="opus medium" SOLOFACTORY_CLAUDE_REASONING_EFFORT=medium node scripts/smoke.mjs
// SMOKE_ARM labels the rows; SOLOFACTORY_MAX_RUN_COST_USD defaults to 15 here. A run that hits the cap
// parks and is recorded as it stands; it is never resumed.
// Free dry run of the whole loop: SOLOFACTORY_DEMO=1 SMOKE_PROVIDER=fixture SMOKE_LEDGER=/tmp/x.jsonl
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSmokeTable, summarizeRun } from "../src/measure.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledger = process.env.SMOKE_LEDGER ?? path.join(repo, "smoke", "results.jsonl");
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const arm = process.env.SMOKE_ARM ?? "";
const SETTLED = new Set(["completed", "failed", "cancelled", "interrupted", "paused"]);

async function rowFor(runDir, extra) {
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return summarizeRun(state, events, extra);
}

async function run(briefFile) {
  const body = JSON.parse(await readFile(briefFile, "utf8"));
  if (process.env.SMOKE_PROVIDER) body.provider = process.env.SMOKE_PROVIDER;
  const name = path.basename(briefFile, ".json");
  const home = path.join(repo, ".solofactory", "smoke-runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
  await mkdir(home, { recursive: true });
  process.env.SOLOFACTORY_MAX_RUN_COST_USD ??= "15";
  const { createSoloFactoryServer } = await import("../src/server.mjs");
  const app = await createSoloFactoryServer({ home, root: home });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const created = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!created.ok) throw new Error(`${name}: POST /api/jobs ${created.status} ${await created.text()}`);
    const { job } = await created.json();
    console.error(`${name}: run ${job.id} in ${home}`);
    let state = job.state;
    while (!SETTLED.has(state)) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      const { jobs } = await (await fetch(`${base}/api/jobs`)).json();
      const next = jobs.find((j) => j.id === job.id)?.state;
      if (next !== state) console.error(`${name}: ${next}`);
      state = next;
    }
    const row = await rowFor(path.join(home, "projects", "default", ".solofactory", "runs", job.id), { arm, commit });
    await appendFile(ledger, `${JSON.stringify(row)}\n`);
    return row;
  } finally {
    await app.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "--help") {
  console.error("Usage: node scripts/smoke.mjs [brief.json ...] | summarize <run dir>... | table");
} else if (command === "summarize") {
  // Commit is unknown for an old run; the row says so rather than guessing.
  console.log(formatSmokeTable(await Promise.all(rest.map((dir) => rowFor(dir, { arm, commit: "?" })))));
} else if (command === "table") {
  const rows = (await readFile(ledger, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  console.log(formatSmokeTable(rows));
} else {
  const briefs = command ? [command, ...rest] : (await readdir(path.join(repo, "smoke", "briefs"))).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(repo, "smoke", "briefs", f));
  const rows = [];
  for (const brief of briefs) rows.push(await run(brief));
  console.log(formatSmokeTable(rows));
}
