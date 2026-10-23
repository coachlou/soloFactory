// The controller's own feature-plan validation, runnable by planning agents as `node .factory/check-plan.mjs`
// (a stub the controller writes into each run), so schema errors are fixed in the planning turn instead of
// costing a separate schema-fix turn. Exit 0 = valid; exit 1 = invalid, with the error on stderr.
// Repair planning passes its plan and request files: `node .factory/check-plan.mjs <plan.json> <request.json>`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateFeaturePlan } from "./wbs.mjs";
import { validateRecoveryPlan } from "./feature-recovery.mjs";

const readJson = async (file) => JSON.parse(await readFile(path.resolve(file), "utf8"));
try {
  if (process.argv[3]) {
    // ponytail: skips assertConsolidation (a replacement plan's base review); the controller still runs it after the turn.
    validateRecoveryPlan(await readJson(process.argv[2]), await readJson(process.argv[3]), { fresh: true });
    console.log(`OK: ${process.argv[2]} passes the controller's repair-plan validation.`);
  } else {
    const dir = path.resolve(process.argv[2] ?? ".factory");
    const request = await readJson(path.join(dir, "plan-request.json"));
    const plan = await readJson(path.join(dir, "slices.json"));
    validateFeaturePlan(plan, { jobId: request.jobId, contractDigest: request.contractDigest, checks: request.checks, sources: request.sources.map((item) => item.path) });
    console.log("OK: slices.json passes the controller's plan validation.");
  }
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exitCode = 1;
}
