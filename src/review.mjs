import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const contractFiles = ["requirements.json", "PRD.md", "PLAN.md", "ACCEPTANCE.md"];

export async function contractDigest(appDir) {
  const hash = createHash("sha256");
  for (const file of contractFiles) {
    hash.update(file).update("\0").update(await readFile(path.join(appDir, ".factory", file))).update("\0");
  }
  return hash.digest("hex");
}

// Every authoritative input a plan or review must reconcile: the frozen contract plus the specs,
// mockups and prototype handoffs this run was given. The shared uploads folder also holds files for
// other briefs, so a run's uploads are exactly those its own intake transcript attached.
export function runInputs(job) {
  return [...new Set(JSON.stringify(job.transcript ?? []).match(/\.factory\/uploads\/[A-Za-z0-9._-]+/g) ?? [])].sort();
}

// A missing input hashes as deleted, so removal changes the digest instead of throwing.
export async function sourceSet(appDir, uploads) {
  const files = [...contractFiles.map((file) => `.factory/${file}`), ...uploads];
  return Promise.all(files.map(async (file) => {
    const body = await readFile(path.join(appDir, file)).catch((error) => { if (error.code === "ENOENT" && file.startsWith(".factory/uploads/")) return null; throw error; });
    return { path: file, sha256: body ? createHash("sha256").update(body).digest("hex") : "deleted" };
  }));
}

const uploadsOf = (sources) => sources.map((item) => item.path).filter((file) => file.startsWith(".factory/uploads/"));

// The one original-check registry: full review, feature plans and scoped reviews all use these IDs.
export function originalChecks(brief) {
  return [
    ...(brief?.mustHaves ?? []).map((text, i) => ({ id: `MH-${i + 1}`, text })),
    ...(brief?.acceptanceScenarios ?? []).map((text, i) => ({ id: `SC-${i + 1}`, text })),
  ];
}

// Scoped reviews pass their own checks and the candidate source identity the verdict must name.
export async function prepareReview(appDir, job, { checks = originalChecks(job.brief), candidate } = {}) {
  const request = {
    version: 1, jobId: job.id, token: randomUUID(), contractDigest: await contractDigest(appDir), checks,
    sources: await sourceSet(appDir, runInputs(job)),
    ...(candidate ? { candidate } : {}),
  };
  if (!request.checks.length) throw new Error("Review requires at least one intake requirement or acceptance scenario.");
  await rm(path.join(appDir, ".factory", "review-result.json"), { force: true });
  await writeFile(path.join(appDir, ".factory", "review-request.json"), JSON.stringify(request, null, 2) + "\n");
  return request;
}

export async function validateReview(appDir, request) {
  if (!request) throw new Error("No current review request; a fresh review is required.");
  if (await contractDigest(appDir) !== request.contractDigest) throw new Error("Frozen contract changed during or after review.");
  if (request.sources && JSON.stringify(await sourceSet(appDir, uploadsOf(request.sources))) !== JSON.stringify(request.sources)) throw new Error("Specs or prototype inputs changed during or after review.");
  const report = JSON.parse(await readFile(path.join(appDir, ".factory", "review-result.json"), "utf8"));
  if (report.version !== 1 || report.jobId !== request.jobId || report.token !== request.token || report.contractDigest !== request.contractDigest) {
    throw new Error("Review verdict is stale or does not match this run and frozen contract.");
  }
  if (request.candidate && report.candidate !== request.candidate) throw new Error("Review verdict is not bound to the checked candidate source.");
  if (!["pass", "blocked"].includes(report.verdict) || !Array.isArray(report.blockers) || report.blockers.some(x => typeof x !== "string" || !x.trim())) {
    throw new Error("Review verdict/blockers are invalid.");
  }
  if (!Array.isArray(report.checks) || report.checks.length !== request.checks.length) throw new Error("Review does not cover every intake requirement and acceptance scenario.");
  const expected = new Set(request.checks.map(x => x.id));
  const seen = new Set();
  const root = await realpath(appDir);
  for (const check of report.checks) {
    if (!expected.has(check.id) || seen.has(check.id)) throw new Error("Review contains unknown or duplicate check IDs.");
    seen.add(check.id);
  }
  const failedChecks = report.checks.filter(check => check.status !== "pass").map(check => ({
    id: check.id, text: request.checks.find(item => item.id === check.id).text,
    status: check.status ?? "unverified", reason: typeof check.reason === "string" ? check.reason : "",
  }));
  if (failedChecks.length || report.verdict !== "pass" || report.blockers.length) {
    const first = failedChecks[0];
    const message = first ? `Review blocked: ${first.id} — ${first.text} (${first.status}).` : "Review blocked: unresolved reviewer findings.";
    const output = [message, "", "All unfinished checks:",
      ...failedChecks.map(check => `- ${check.id} (${check.status}): ${check.text}${check.reason ? ` — ${check.reason}` : ""}`),
      "", "Reviewer blockers:", ...report.blockers.map(item => `- ${item}`), "",
      "Read .factory/review-request.json, .factory/review-result.json and .factory/REVIEW.md for requirement and test details.",
      "Implement missing behavior and execute the absent checks. Do not waive scope or change statuses merely to pass review.",
    ].join("\n");
    const error = new Error(message);
    error.details = { failedChecks, blockers: report.blockers, output, logPath: ".factory/REVIEW.md" };
    throw error;
  }
  seen.clear();
  for (const check of report.checks) {
    if (!expected.has(check.id) || seen.has(check.id)) throw new Error("Review contains unknown or duplicate check IDs.");
    seen.add(check.id);
    if (check.status !== "pass") throw new Error(`Review blocked: ${check.id} is ${check.status ?? "unverified"}.`);
    if (!Array.isArray(check.evidence) || !check.evidence.length) throw new Error(`Review check ${check.id} has no evidence.`);
    for (const file of check.evidence) {
      if (typeof file !== "string" || !file.trim() || path.isAbsolute(file)) throw new Error("Review evidence must be a project-relative file.");
      const absolute = await realpath(path.resolve(root, file)).catch((error) => {
        if (error.code === "ENOENT") throw new Error(`Review evidence ${file} for ${check.id} does not exist.`);
        throw error;
      });
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative) || /^(data|node_modules|\.git)(\/|$)/.test(relative) || /^\.factory\/(review-result|review-request)\.json$/.test(relative)) {
        throw new Error("Review evidence cannot escape the project, read owner data or cite its own verdict.");
      }
      if (!(await readFile(absolute)).length) throw new Error(`Review evidence ${file} is empty.`);
    }
  }
  if (report.verdict !== "pass" || report.blockers.length) throw new Error(`Review blocked: ${report.blockers.join("; ") || "reviewer did not approve"}`);
  return report;
}

// Planning verdicts bind approval to the exact plan bytes and frozen contract; a finished turn is not approval.
export async function preparePlanReview(appDir, job, planDigest, extra = {}) {
  const request = { ...extra, version: 1, jobId: job.id, token: randomUUID(), contractDigest: await contractDigest(appDir), planDigest };
  await rm(path.join(appDir, ".factory", "plan-review-result.json"), { force: true });
  await writeFile(path.join(appDir, ".factory", "plan-review-request.json"), JSON.stringify(request, null, 2) + "\n");
  return request;
}

export async function validatePlanReview(appDir, request) {
  let report;
  try { report = JSON.parse(await readFile(path.join(appDir, ".factory", "plan-review-result.json"), "utf8")); }
  catch { throw new Error("Plan review wrote no readable verdict."); }
  if (report?.version !== 1 || report.jobId !== request.jobId || report.token !== request.token || report.contractDigest !== request.contractDigest || report.planDigest !== request.planDigest) {
    throw new Error("Plan verdict is stale or does not match this run, plan and frozen contract.");
  }
  if (!["approve", "blocked"].includes(report.verdict) || !Array.isArray(report.blockers) || report.blockers.some(x => typeof x !== "string" || !x.trim())) {
    throw new Error("Plan verdict/blockers are invalid.");
  }
  if (report.verdict !== "approve" || report.blockers.length) {
    const error = new Error(`Plan review blocked: ${report.blockers[0] ?? "reviewer did not approve"}`);
    error.details = { blockers: report.blockers };
    throw error;
  }
  return report;
}

// Enrich older terse review failures from matching artifacts without rewriting run history.
export async function withReviewDiagnostics(job, appDir) {
  if (job.error?.code !== "review_rejected" || !job.reviewRequest) return job;
  try { await validateReview(appDir, job.reviewRequest); }
  catch (error) {
    if (error.details?.failedChecks) return { ...job, recovery: null, error: {
      ...job.error, message: error.message, details: { ...job.error.details, ...error.details },
    } };
  }
  return job;
}
