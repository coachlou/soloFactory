#!/usr/bin/env node
// Usage: node scripts/measure-run.mjs <run dir | events.jsonl> [--json]
// Prints a run's per-feature agent and verification cost from its event log. Read-only.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { formatMeasurement, measureRun } from "../src/measure.mjs";

const [target, flag] = process.argv.slice(2);
if (!target || target === "--help") {
  console.error("Usage: node scripts/measure-run.mjs <run dir | events.jsonl> [--json]");
  process.exit(target ? 0 : 2);
}
const file = (await stat(target)).isDirectory() ? path.join(target, "events.jsonl") : target;
const events = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const measurement = measureRun(events);
console.log(flag === "--json" ? JSON.stringify(measurement, null, 2) : formatMeasurement(measurement));
