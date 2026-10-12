// The controller's own feature-plan validation, runnable by planning agents as `node .factory/check-plan.mjs`
// (a stub the controller writes into each run), so schema errors are fixed in the planning turn instead of
// costing a separate schema-fix turn. Exit 0 = valid; exit 1 = invalid, with the error on stderr.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateFeaturePlan } from "./wbs.mjs";

const dir = path.resolve(process.argv[2] ?? ".factory");
try {
  const request = JSON.parse(await readFile(path.join(dir, "plan-request.json"), "utf8"));
  const plan = JSON.parse(await readFile(path.join(dir, "slices.json"), "utf8"));
  validateFeaturePlan(plan, { jobId: request.jobId, contractDigest: request.contractDigest, checks: request.checks, sources: request.sources.map((item) => item.path) });
  console.log("OK: slices.json passes the controller's plan validation.");
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exitCode = 1;
}
