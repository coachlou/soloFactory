import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAllowedCommand, runProcess, subscriptionEnvironment } from "./process.mjs";
import { buildPrompt, continuationPrompt, featureBuildPrompt, featurePlanPrompt, featureReviewPrompt, planAuditPrompt, planCorrectionPrompt, planReviewPrompt, repairPrompt, reviewPrompt, sliceBuildPrompt, sliceContinuationPrompt, specificationPrompt } from "./prompts.mjs";
import { orderSlices, integrationProofs, pendingChecks, pendingProofFailure, recordPendingProofs, validateFeaturePlan, validateSlicePlan } from "./wbs.mjs";
export { pendingProofFailure };
import { contractDigest, originalChecks, preparePlanReview, prepareReview, runInputs, sourceSet, validatePlanReview, validateReview } from "./review.mjs";
import { addUsage } from "./providers.mjs";
import { archiveReview, digest, exhaustedPreparations, planFeatureRecovery, runFeatureRecovery, sourceBaseline } from "./feature-recovery.mjs";

// Which harness produced a run, so runs.jsonl can compare harness changes. Read once at load.
const harnessRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = {
  version: JSON.parse(await readFile(path.join(harnessRoot, "package.json"), "utf8")).version,
  commit: (() => {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: harnessRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: harnessRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return dirty ? `${sha}-dirty` : sha;
    } catch {
      return null;
    }
  })(),
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "paused"]);
const PARKED_STATES = new Set(["failed", "cancelled", "interrupted", "paused"]);
// A pause lands only where the tree is green and committed: before a stage that follows a passed gate.
const PAUSE_POINTS = new Set(["specifying", "building", "reviewing", "deploying"]);

export class FactoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Live local deployments keyed by project directory. Module-level because the server makes
// one SoloFactory per run, and a project's next release must stop the previous release's app.
const liveByProject = new Map();

export class SoloFactory {
  constructor({ store, provider, maxRepairs = 2, commandRunner = runProcess, deployer } = {}) {
    this.store = store;
    this.provider = provider;
    this.maxRepairs = maxRepairs;
    this.commandRunner = commandRunner;
    this.deployer = deployer;
    this.active = null;
    this.deployments = new Map();
  }

  isBusy() {
    return Boolean(this.active);
  }

  async start(jobId) {
    return this.activate(jobId, (signal) => this.run(jobId, signal));
  }

  async resume(jobId) {
    return this.activate(jobId, (signal) => this.runResume(jobId, signal));
  }

  async planRecovery(jobId, guidance = "") {
    await assertPlanInputsRevised(this.store, await this.store.read(jobId));
    return this.activate(jobId, signal => planFeatureRecovery(this, jobId, signal, guidance));
  }

  async startRecovery(jobId, planDigest) {
    return this.activate(jobId, signal => runFeatureRecovery(this, jobId, signal, planDigest));
  }

  // Rewinds a parked slice run to the commit before `sliceId` and rebuilds from there.
  async restartFromSlice(jobId, sliceId) {
    return this.activate(jobId, async (signal) => {
      let job = await this.store.read(jobId);
      if (!TERMINAL.has(job.state) || job.state === "completed") throw new FactoryError("not_parked", "Only a parked run can be restarted from a slice.");
      const index = (job.sliceDone ?? []).indexOf(sliceId);
      if (index < 1) throw new FactoryError("bad_slice", index === 0 ? "Restarting from the first slice is a fresh run; use start over." : `Slice ${sliceId} has not completed in this run.`);
      const base = job.sliceStats?.[job.sliceDone[index - 1]]?.commit;
      if (!base) throw new FactoryError("no_commit", `No commit is recorded before slice ${sliceId}; this run predates restart support.`);
      try {
        await this.store.reset(base);
        job.sliceDone = job.sliceDone.slice(0, index);
        job.sliceStats = Object.fromEntries(Object.entries(job.sliceStats).filter(([id]) => job.sliceDone.includes(id)));
        job.sliceIndex = index;
        job.attempt = 0;
        job.error = null;
        job.failedState = null;
        job.recovery = null;
        // Attempts restart at zero, so every v2 budget is re-derived from the rewound cursor.
        if (job.planVersion === 2) Object.assign(job, { featureCursor: null, finalBudgetSet: false, repairBudgetLimit: null });
        await this.store.writeState(job);
        await this.emit(job.id, { type: "job.restarted", state: job.state, message: `Restarting from slice ${sliceId} at ${base.slice(0, 7)}` });
        if (job.planVersion === 2) return await this.buildFeatures(job, signal);
        return await this.buildSlices(job, signal, { resumeFrom: index, fresh: true });
      } catch (error) {
        return this.fail(jobId, signal, error);
      }
    });
  }

  async activate(jobId, runner) {
    if (this.active) throw new FactoryError("factory_busy", `Run ${this.active.jobId} is already active.`);
    const controller = new AbortController();
    const promise = runner(controller.signal).finally(async () => {
      if (this.active?.jobId === jobId) this.active = null;
      await this.logRun(jobId).catch(() => {});
    });
    this.active = { jobId, controller, promise };
    return promise;
  }

  async cancel(jobId) {
    if (this.active?.jobId !== jobId) throw new FactoryError("not_active", "That run is not active.");
    this.active.controller.abort();
  }

  // Takes effect at the next stage boundary (between slices in slice mode), never mid-turn.
  async pause(jobId) {
    if (this.active?.jobId !== jobId) throw new FactoryError("not_active", "That run is not active.");
    this.active.pauseRequested = true;
  }

  async run(jobId, signal) {
    let job = await this.store.read(jobId);
    try {
      job.startedAt ||= new Date().toISOString();
      job.error = null;
      await this.store.writeState(job);
      const appDir = this.store.appDir(jobId);
      const factoryDir = path.join(appDir, ".factory");
      // A manifest already in the project means an earlier release shipped: spec and slice
      // this brief as an increment on top of it. Stamped once so resumes stay consistent.
      job.followOn ??= existsSync(path.join(appDir, "factory.json"));
      // The shipped app (plus anything attached since) is what "Set it aside" and "Start over"
      // rewind a failed follow-on to; data/ is gitignored, so the rewind keeps owner data.
      // Only a clean tree is a safe point: if the commit failed, record nothing and never rewind.
      if (job.followOn && !job.baseCommit) {
        await this.commit(job, "factory: before follow-on");
        if (!(await this.store.git("status", "--porcelain").catch(() => "unknown"))) job.baseCommit = await this.store.git("rev-parse", "HEAD");
      }
      await mkdir(path.join(factoryDir, "logs"), { recursive: true });
      await writeFile(
        path.join(factoryDir, "requirements.json"),
        `${JSON.stringify({ brief: job.brief, transcript: job.transcript }, null, 2)}\n`,
      );

      job = await this.stage(job, "specifying", "Writing PRD, plan, and acceptance contract");
      const before = await readdir(appDir);
      const planned = job.planVersion === 2;
      await this.invoke(job, "specification", specificationPrompt(job.sdlc === "slices" && !planned, { followOn: job.followOn }), signal);
      await this.validateSpecification(appDir, before);
      await this.commit(job, "factory: specification");

      if (planned) {
        job.specified = true;
        await this.store.writeState(job);
        job = await this.planFeatures(job, signal);
        return await this.buildFeatures(job, signal);
      }
      if (job.sdlc === "slices") {
        if (!job.planReviewed) job = await this.reviewSlicePlan(job, signal);
        return await this.buildSlices(job, signal);
      }
      job = await this.stage(job, "building", "Building the application");
      await this.invoke(job, "build", buildPrompt(), signal);
      return await this.finishFromBuild(job, signal);
    } catch (error) {
      return this.fail(jobId, signal, error);
    }
  }

  async runResume(jobId, signal) {
    let job = await this.store.read(jobId);
    if (!TERMINAL.has(job.state) || job.state === "completed") {
      throw new FactoryError("not_resumable", "Only a failed, cancelled, or interrupted run can be resumed.");
    }
    // ponytail: "none" (cancelled, dismissed) stays resumable here as before; the API refuses it.
    const next = continuationAction(job, { maxRepairs: this.maxRepairs });
    if (!["resume", "none"].includes(next.action)) {
      throw new FactoryError(["prepare-plan", "revise-inputs"].includes(next.action) ? "repair_plan_required" : "recovery_approval_required", `${next.reason} Next: ${next.label} (POST ${next.endpoint}).`, { nextAction: next });
    }
    if (job.recoveryPhase?.status === "running") return runFeatureRecovery(this, jobId, signal);
    if (job.recoveryPhase?.status === "built") {
      try {
        job.error = null; job.failedState = null; job.recovery = null;
        await this.store.writeState(job);
        job = await this.reviewAndVerify(job, signal);
        return await this.deployAndComplete(job, signal);
      } catch (error) { return this.fail(jobId, signal, error); }
    }
    const appDir = this.store.appDir(jobId);
    const failedState = inferFailedState(job);
    const previousError = job.error;
    const resumeSessionId = previousError?.details?.sessionId ?? null;

    try {
      await mkdir(path.join(appDir, ".factory", "logs"), { recursive: true });
      await writeFile(
        path.join(appDir, ".factory", "recovery.json"),
        `${JSON.stringify({ failedState, error: previousError, recovery: job.recovery }, null, 2)}\n`,
      );
      job.error = null;
      // `failedState` is a recovery cursor, not a permanent job property. Once
      // recovery starts, later failures must capture the stage that actually
      // failed instead of reusing this stale cursor.
      job.failedState = null;
      job.recovery = { ...job.recovery, status: "resuming", resumedAt: new Date().toISOString() };
      await this.store.writeState(job);
      await this.emit(job.id, {
        type: "job.resumed",
        state: failedState,
        message: `Resuming the preserved run from ${failedState}`,
      });

      if (job.planVersion === 2) {
        if (!job.approvedPlan) {
          if (!job.specified) {
            job = await this.stage(job, "specifying", "Finishing the interrupted specification");
            const before = await readdir(appDir);
            await this.invoke(job, "specification-resume", continuationPrompt("specification", false, { followOn: job.followOn }), signal, { resumeSessionId });
            await this.validateSpecification(appDir, before);
            await this.commit(job, "factory: specification");
            job.specified = true;
            await this.store.writeState(job);
          }
          job = await this.planFeatures(job, signal);
          return await this.buildFeatures(job, signal);
        }
        if (job.featureCursor || (job.sliceIndex ?? 0) < job.approvedPlan.plan.slices.length) return await this.buildFeatures(job, signal);
        // Final integration keeps its own budget: no refill on resume.
        if (failedState === "deploying") return await this.deployAndComplete(job, signal);
        if (failedState === "reviewing") return await this.deployAndComplete(await this.reviewAndVerify(job, signal), signal);
        return await this.finishFromBuild(job, signal);
      }

      if (failedState === "specifying") {
        job = await this.stage(job, "specifying", "Finishing the interrupted specification");
        const before = await readdir(appDir);
        await this.invoke(job, "specification-resume", continuationPrompt("specification", job.sdlc === "slices", { followOn: job.followOn }), signal, { resumeSessionId });
        await this.validateSpecification(appDir, before);
        await this.commit(job, "factory: specification");
        if (job.sdlc === "slices") {
          if (!job.planReviewed) job = await this.reviewSlicePlan(job, signal);
          return await this.buildSlices(job, signal);
        }
        job = await this.stage(job, "building", "Building the application");
        await this.invoke(job, "build", buildPrompt(), signal);
        return await this.finishFromBuild(job, signal);
      }

      if (job.sdlc === "slices" && ["building", "verifying", "repairing"].includes(failedState)) {
        return await this.buildSlices(job, signal, { resumeFrom: job.sliceIndex ?? 0 });
      }

      if (failedState === "building") {
        job = await this.stage(job, "building", "Continuing the existing application build");
        await this.invoke(job, "build-resume", continuationPrompt("build"), signal, { resumeSessionId });
        return await this.finishFromBuild(job, signal);
      }

      if (failedState === "repairing") {
        job = await this.stage(job, "repairing", "Continuing the interrupted repair");
        await this.invoke(job, "repair-resume", continuationPrompt("repair"), signal, { resumeSessionId });
        return await this.finishFromBuild(job, signal);
      }

      if (failedState === "reviewing") {
        job = await this.reviewAndVerify(job, signal);
        return await this.deployAndComplete(job, signal);
      }

      if (failedState === "deploying") return await this.deployAndComplete(job, signal);

      // Verification failures do not need another agent turn until a gate proves a code repair is needed.
      return await this.finishFromBuild(job, signal);
    } catch (error) {
      return this.fail(jobId, signal, error);
    }
  }

  async finishFromBuild(job, signal, { includeInstall = true } = {}) {
    const appDir = this.store.appDir(job.id);
    job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall });
    job = await this.reviewAndVerify(job, signal);
    return this.deployAndComplete(job, signal);
  }

  // The final review evaluates the same input set the plan was approved against.
  async assertInputs(job) {
    const approved = job.recoveryPhase?.request?.sourcesDigest ?? job.approvedPlan?.sourcesDigest;
    if (approved && digest(await sourceSet(this.store.appDir(job.id), runInputs(job))) !== approved) {
      throw new FactoryError("inputs_changed", "The specs or prototype inputs changed after the plan was approved; prepare a repair plan against the current inputs.");
    }
  }

  async requireReview(job) {
    try {
      return await validateReview(this.store.appDir(job.id), job.reviewRequest);
    } catch (error) {
      throw new FactoryError("review_rejected", error.message, { gate: "review", output: error.message, ...error.details });
    }
  }

  async reviewAndVerify(job, signal) {
    const appDir = this.store.appDir(job.id);
    for (;;) {
      job = await this.stage(job, "reviewing", "Reviewing against the frozen contract");
      await this.assertInputs(job);
      let request;
      const pending = integrationProofs(job).map((entry) => ({ id: entry.key, text: obligationCheck(entry.obligation).text }));
      try { request = await prepareReview(appDir, job, { checks: [...originalChecks(job.brief), ...pending] }); }
      catch (error) { throw new FactoryError("review_rejected", `Cannot review the frozen contract: ${error.message}`); }
      if (job.reviewContractDigest && request.contractDigest !== job.reviewContractDigest) {
        throw new FactoryError("review_rejected", "Frozen contract changed after the first review; scope cannot be narrowed during repair.");
      }
      job.reviewContractDigest = request.contractDigest;
      job.reviewRequest = request;
      await this.store.writeState(job);
      await this.invoke(job, "review", reviewPrompt(), signal);
      try {
        await this.requireReview(job);
      } catch (failure) {
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "review", message: failure.message });
        job = await this.repair(job, failure, signal);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
        continue;
      }
      const attempt = job.attempt;
      job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
      // Any gate repair changes the app after the verdict; require a fresh review.
      if (attempt !== job.attempt) continue;
      await this.requireReview(job);
      const candidate = await sourceBaseline(this.store, { head: false });
      for (const entry of integrationProofs(job)) {
        if (entry.proofCandidate !== candidate) throw new FactoryError("review_rejected", "Integration proof evidence no longer matches the reviewed source.");
        Object.assign(entry, { status: "passed", candidate, verifiedAt: new Date().toISOString() });
      }
      await this.store.writeState(job);
      await this.emit(job.id, { type: "gate.passed", state: job.state, gate: "review", message: "All intake checks have a passing review with evidence" });
      return job;
    }
  }

  sliceScenarioCount(job) {
    return Array.isArray(job.brief?.acceptanceScenarios) ? job.brief.acceptanceScenarios.length : 0;
  }

  // Second-opinion plan review: a fresh-context agent turn that audits and may
  // rewrite .factory/slices.json before any build turn spends budget. The plan
  // is validated before AND after the turn, so a reviewer that leaves the plan
  // invalid parks the run fail-closed (invalid_slice_plan).
  async reviewSlicePlan(job, signal) {
    const appDir = this.store.appDir(job.id);
    const scenarioCount = this.sliceScenarioCount(job);
    await this.loadSlicePlan(appDir, scenarioCount); // pre-check: don't spend a turn on garbage
    job = await this.stage(job, "specifying", "Auditing the slice plan (second opinion)");
    await this.invoke(job, "plan-review", planReviewPrompt({ followOn: job.followOn }), signal);
    await this.loadSlicePlan(appDir, scenarioCount); // revalidate after the reviewer's rewrite
    job.planReviewed = true;
    await this.store.writeState(job);
    return job;
  }

  // Vertical-slice build loop (job.sdlc === "slices"). Executes the validated
  // .factory/slices.json plan one slice at a time: controller-run gates after
  // each slice (install once on the walking skeleton, test+build per slice),
  // bounded repairs scoped to the failing slice, then the whole-project gate
  // via finishFromBuild with install disabled.
  async buildSlices(job, signal, { resumeFrom = null, fresh = false } = {}) {
    const appDir = this.store.appDir(job.id);
    const scenarioCount = Array.isArray(job.brief?.acceptanceScenarios) ? job.brief.acceptanceScenarios.length : 0;
    const plan = await this.loadSlicePlan(appDir, scenarioCount);
    const ordered = orderSlices(plan);
    job.slicePlanIds = ordered.map((slice) => slice.id);
    await this.store.writeState(job);
    let index = Number.isInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom : job.sliceIndex ?? 0;
    const from = Math.min(Math.max(0, index), ordered.length);
    for (let i = from; i < ordered.length; i++) {
      const slice = ordered[i];
      job.sliceIndex = i;
      job = await this.stage(job, "building", `Slice ${i + 1}/${ordered.length} — ${slice.title}`);
      await this.emit(job.id, { type: "slice.started", state: job.state, slice: slice.id, message: `Slice ${i + 1}/${ordered.length}: ${slice.title}` });
      const attemptBefore = job.attempt;
      const startedAtMs = Date.now();
      const resumed = !fresh && resumeFrom != null && i === from;
      const label = resumed ? `slice-resume-${slice.id}` : `build-slice-${slice.id}`;
      const prompt = resumed ? sliceContinuationPrompt(slice, ordered) : sliceBuildPrompt(slice, ordered, { followOn: job.followOn });
      await this.invoke(job, label, prompt, signal, { resumeSessionId: this.resumeSessionFor(job, label) });
      job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: i === 0, slice });
      const repairs = job.attempt - attemptBefore;
      job.sliceStats ||= {};
      job.sliceStats[slice.id] = {
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Date.now() - startedAtMs,
        repairs,
        verifyRuns: repairs + 1,
        commit: await this.store.git("rev-parse", "HEAD"),
      };
      job.sliceDone = [...(job.sliceDone ?? []), slice.id];
      job.sliceIndex = i + 1;
      await this.store.writeState(job);
      await this.emit(job.id, { type: "slice.completed", state: job.state, slice: slice.id, message: `Slice ${i + 1}/${ordered.length} complete` });
    }
    job.sliceIndex = ordered.length;
    await this.store.writeState(job);
    return this.finishFromBuild(job, signal, { includeInstall: false });
  }

  // Version-2 planning: a planner writes .factory/slices.json, a fresh reviewer returns a
  // verdict bound to the plan digest, contract digest and token. No build turn runs before
  // approval. Planning turns may not touch app source or the contract (preserved, never reset).
  async planFeatures(job, signal) {
    const appDir = this.store.appDir(job.id);
    const factoryDir = path.join(appDir, ".factory");
    const contract = await contractDigest(appDir);
    const checks = originalChecks(job.brief);
    // Detailed obligations come from every authoritative input, not only the MH/SC summaries.
    const sources = await sourceSet(appDir, runInputs(job));
    await writeFile(path.join(factoryDir, "plan-request.json"), `${JSON.stringify({ version: 1, jobId: job.id, contractDigest: contract, checks, sources }, null, 2)}\n`);
    job = await this.stage(job, "specifying", "Planning features against the frozen contract");
    // Persisted, so a mutation left behind by a parked planning turn still blocks after resume.
    job.planBaseline ??= { source: await sourceBaseline(this.store, { head: false }), contract };
    job.planBaseline.inputs ??= digest(sources);
    job.planCorrections ??= 0;
    job.planReviews ??= 0;
    await this.store.writeState(job);
    const guard = async () => {
      if (await sourceBaseline(this.store, { head: false }) !== job.planBaseline.source || await contractDigest(appDir) !== job.planBaseline.contract || digest(await sourceSet(appDir, runInputs(job))) !== job.planBaseline.inputs) {
        throw new FactoryError("plan_mutation", "A planning turn changed application source, the frozen contract or the supplied specs; no feature was built. The changes are preserved for inspection.");
      }
    };
    const readPlan = async () => {
      try {
        return validateFeaturePlan(JSON.parse(await readFile(path.join(factoryDir, "slices.json"), "utf8")), { jobId: job.id, contractDigest: contract, checks, sources: sources.map((item) => item.path) });
      } catch (error) {
        return error;
      }
    };
    await guard();
    let plan = await readPlan();
    if (plan instanceof Error && !job.planDrafted) {
      await this.invoke(job, "feature-plan", featurePlanPrompt({ followOn: job.followOn }), signal);
      job.planDrafted = true;
      await this.store.writeState(job);
      await guard();
      plan = await readPlan();
    }
    for (;;) {
      let blockers;
      if (plan instanceof Error) blockers = [plan.message];
      else {
        const planDigest = digest(plan);
        const request = await preparePlanReview(appDir, job, planDigest, { checks, sources });
        job.planReviews += 1;
        await this.store.writeState(job);
        await this.invoke(job, `plan-review-${job.planReviews}`, planAuditPrompt({ followOn: job.followOn }), signal);
        await guard();
        const after = await readPlan();
        if (after instanceof Error || digest(after) !== planDigest) {
          throw new FactoryError("plan_verdict_invalid", "The planning reviewer changed the plan, so its verdict cannot approve it. Resume reviews the current plan afresh.");
        }
        try {
          await validatePlanReview(appDir, request);
          return await this.approvePlan(job, plan, planDigest, { ...request, sourcesDigest: digest(sources) });
        } catch (error) {
          if (!error.details?.blockers) throw new FactoryError("plan_verdict_invalid", error.message);
          blockers = error.details.blockers.length ? error.details.blockers : [error.message];
        }
      }
      await this.emit(job.id, { type: "plan.blocked", state: job.state, message: blockers[0] });
      if (job.planCorrections >= this.maxRepairs) {
        throw new FactoryError("plan_blocked", `The feature plan is still blocked after ${job.planCorrections} corrections: ${blockers[0]}`, { blockers, output: blockers.join("\n") });
      }
      job.planCorrections += 1;
      await this.store.writeState(job);
      await this.invoke(job, `plan-correction-${job.planCorrections}`, planCorrectionPrompt(blockers), signal);
      await guard();
      plan = await readPlan();
    }
  }

  async approvePlan(job, plan, planDigest, request) {
    job.approvedPlan = { plan, digest: planDigest, contractDigest: request.contractDigest, sourcesDigest: request.sourcesDigest, sources: request.sources, token: request.token, approvedAt: new Date().toISOString() };
    job.slicePlanIds = plan.slices.map((slice) => slice.id);
    job.sliceIndex = 0;
    await writeFile(path.join(this.store.jobDir(job.id), "approved-plan.json"), `${JSON.stringify(job.approvedPlan, null, 2)}\n`);
    await this.store.writeState(job);
    // Committed so restart-from-slice resets and resumes always see the approved plan.
    await this.commit(job, "factory: feature plan approved");
    await this.emit(job.id, { type: "plan.approved", state: job.state, message: `Feature plan approved: ${plan.slices.length} feature${plan.slices.length === 1 ? "" : "s"}` });
    return job;
  }

  // Fail closed when the workspace plan or frozen contract no longer matches what was approved.
  async assertPlanCurrent(job) {
    const appDir = this.store.appDir(job.id);
    const approved = job.approvedPlan;
    let current = null;
    const inputs = await sourceSet(appDir, runInputs(job));
    if (approved.sourcesDigest && digest(inputs) !== approved.sourcesDigest) {
      throw new FactoryError("inputs_changed", "The specs or prototype inputs changed after the feature plan was approved; execution is blocked. Prepare a repair plan against the current inputs.");
    }
    try {
      // Plans approved before source citations existed keep validating without them.
      current = validateFeaturePlan(JSON.parse(await readFile(path.join(appDir, ".factory", "slices.json"), "utf8")), { jobId: job.id, contractDigest: approved.contractDigest, checks: originalChecks(job.brief), sources: approved.sourcesDigest ? inputs.map((item) => item.path) : null });
    } catch {
      // Unreadable or invalid counts as changed.
    }
    if (!current || digest(current) !== approved.digest || await contractDigest(appDir) !== approved.contractDigest) {
      throw new FactoryError("stale_plan", "The approved feature plan or frozen contract changed after approval; execution is blocked.");
    }
  }

  // Executes the approved plan one feature at a time. A feature enters sliceDone only after
  // gates, its proofs, a candidate-bound scoped review and a durable checkpoint commit.
  async buildFeatures(job, signal) {
    const slices = job.approvedPlan.plan.slices;
    const checks = originalChecks(job.brief);
    for (let i = job.sliceIndex ?? 0; i < slices.length; i++) {
      const slice = slices[i];
      await this.assertPlanCurrent(job);
      if (job.featureCursor?.id !== slice.id) {
        // Each feature gets maxRepairs; set once per feature, so resume never refills it.
        job.featureCursor = { id: slice.id, substage: "implementing", implementStarted: false, reviews: 0, startedAt: new Date().toISOString(), attemptBefore: job.attempt };
        job.repairBudgetLimit = job.attempt + this.maxRepairs;
        job.sliceIndex = i;
        await this.store.writeState(job);
        await this.emit(job.id, { type: "slice.started", state: job.state, slice: slice.id, message: `Feature ${i + 1}/${slices.length}: ${slice.title}` });
      }
      job = await this.proveFeature(job, slice, checks, `${i + 1}/${slices.length}`, signal);
      const cursor = job.featureCursor;
      job.sliceStats ||= {};
      job.sliceStats[slice.id] = {
        startedAt: cursor.startedAt,
        durationMs: Date.now() - new Date(cursor.startedAt).getTime(),
        repairs: job.attempt - cursor.attemptBefore,
        reviews: cursor.reviews,
        commit: cursor.commit,
      };
      job.sliceDone = [...(job.sliceDone ?? []), slice.id];
      job.sliceIndex = i + 1;
      job.featureCursor = null;
      await this.store.writeState(job);
      await this.emit(job.id, { type: "slice.completed", state: job.state, slice: slice.id, message: `Feature ${i + 1}/${slices.length} verified${pendingNote(pendingChecks(slice, { plan: job.approvedPlan.plan, outstanding: job.outstandingProofs }))}` });
    }
    if (!job.finalBudgetSet) {
      job.repairBudgetLimit = job.attempt + this.maxRepairs;
      job.finalBudgetSet = true;
      await this.store.writeState(job);
    }
    return this.finishFromBuild(job, signal, { includeInstall: false });
  }

  // Cursor substages: implementing → checking → reviewing → committing → verified. Each is
  // persisted before the next stage boundary so pause/resume continues exactly where it stopped.
  // Recovery passes its own scope (cursor, labels, plan check) so it gets the same safeguards.
  async proveFeature(job, slice, checks, position, signal, scope = {}) {
    const appDir = this.store.appDir(job.id);
    const {
      cursor = job.featureCursor,
      assertCurrent = () => this.assertPlanCurrent(job),
      planDigest = job.approvedPlan?.digest,
      plan = job.approvedPlan?.plan,
      planFile,
      labels = { build: `build-slice-${slice.id}`, resume: `slice-resume-${slice.id}`, review: (n) => `feature-review-${slice.id}-${n}` },
    } = scope;
    const save = (substage) => { cursor.substage = substage; return this.store.writeState(job); };
    const candidate = () => sourceBaseline(this.store, { head: false });
    // Proof pending integration runs before the final review; the checks it proves stay unverified until then.
    const pending = pendingChecks(slice, { plan, outstanding: job.outstandingProofs });
    const owned = checks.filter((check) => slice.closes.includes(check.id) && !pending.includes(check.id));
    const runnable = slice.acceptance.filter((item) => !item.proof?.pending);
    const reviewChecks = [...owned, ...runnable.map(obligationCheck)];
    for (;;) {
      if (cursor.substage === "implementing") {
        job = await this.stage(job, "building", `Feature ${position} — ${slice.title}`);
        const resumed = cursor.implementStarted;
        cursor.implementStarted = true;
        await this.store.writeState(job);
        const label = resumed ? labels.resume : labels.build;
        const prompt = featureBuildPrompt(slice, { owned, planDigest, planFile, followOn: job.followOn, resumed });
        await this.invoke(job, label, prompt, signal, { resumeSessionId: this.resumeSessionFor(job, label) });
        await save("checking");
      }
      if (cursor.substage === "checking") {
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: true, slice, proofs: runnable.filter((item) => item.proof) });
        cursor.candidate = await candidate();
        await save("reviewing");
      }
      if (cursor.substage === "reviewing") {
        job = await this.stage(job, "reviewing", `Reviewing feature ${position} — ${slice.title}`);
        if (await candidate() !== cursor.candidate) { await save("checking"); continue; }
        await assertCurrent();
        if (cursor.reviews >= this.maxRepairs + 2) throw new FactoryError("review_unstable", `Feature ${slice.id} did not reach a stable reviewed candidate after ${cursor.reviews} reviews.`);
        cursor.reviews += 1;
        const request = await prepareReview(appDir, job, { checks: reviewChecks, candidate: cursor.candidate });
        // Kept off job.reviewRequest, which always names the final whole-app review.
        cursor.reviewRequest = request;
        await this.store.writeState(job);
        const label = labels.review(cursor.reviews);
        await this.invoke(job, label, featureReviewPrompt(slice), signal);
        await archiveReview(this, job, label);
        if (await candidate() !== cursor.candidate) {
          await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "review", message: "The reviewer changed source; its verdict is void and the feature is rechecked." });
          await save("checking");
          continue;
        }
        try {
          await this.requireReview({ ...job, reviewRequest: request });
        } catch (failure) {
          await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "review", message: failure.message });
          job = await this.repair(job, failure, signal, slice);
          await save("checking");
          continue;
        }
        await this.emit(job.id, { type: "gate.passed", state: job.state, gate: "review", slice: slice.id, message: `Feature ${slice.id} review passed` });
        await save("committing");
      }
      if (cursor.substage === "committing") {
        if (await candidate() !== cursor.candidate) { await save("checking"); continue; }
        try {
          await this.store.commit(`factory: feature ${slice.id} verified`);
          if (await this.store.git("status", "--porcelain")) throw new Error("working tree is not clean after the commit");
        } catch (error) {
          throw new FactoryError("checkpoint_failed", `Feature ${slice.id} passed review but its checkpoint commit failed: ${error.message}`);
        }
        cursor.commit = await this.store.git("rev-parse", "HEAD");
        await save("verified");
      }
      if (cursor.substage === "verified") {
        // The durable ledger every later integration gate, final review and repair plan reads.
        recordPendingProofs(job, planDigest, slice);
        await this.store.writeState(job);
        return job;
      }
    }
  }

  resumeSessionFor(job, label) {
    const stageKey = label.replace(/^build-slice-|^slice-resume-/, "");
    const match = Object.entries(job.agentSessions ?? {}).find(([key]) => key.includes(stageKey));
    return match ? match[1] : null;
  }

  async loadSlicePlan(appDir, scenarioCount = 0) {
    let raw;
    try {
      raw = await readFile(path.join(appDir, ".factory", "slices.json"), "utf8");
    } catch (error) {
      throw new FactoryError("invalid_slice_plan", `slices.json could not be read: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new FactoryError("invalid_slice_plan", `slices.json is not valid JSON: ${error.message}`);
    }
    try {
      return validateSlicePlan(parsed, { scenarioCount });
    } catch (error) {
      throw new FactoryError("invalid_slice_plan", error.message);
    }
  }

  async deployAndComplete(job, signal) {
    const appDir = this.store.appDir(job.id);
    let deployment;
    // Legacy deployment resumes also need the new review gate.
    if (!job.reviewRequest) job = await this.reviewAndVerify(job, signal);
    for (;;) {
      await this.requireReview(job);
      job = await this.stage(job, "deploying", "Launching and checking the application");
      const manifest = await this.readManifest(appDir);
      try {
        deployment = this.deployer
          ? await this.deployer({ job, appDir, manifest, signal, emit: (event) => this.emit(job.id, event) })
          : await this.deployLocal(job, manifest, signal);
        break;
      } catch (error) {
        // A broken metrics contract or a crash on launch is usually a code defect the repair worker can fix
        // (e.g. a production-only env check); a port or timeout problem is not. Same bounded repair budget as the gates.
        if (error.code !== "invalid_metrics" && error.code !== "deployment_exited") throw error;
        this.deployments.get(job.id)?.kill("SIGTERM");
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "deploy", message: error.message });
        let output;
        if (error.code === "invalid_metrics") {
          const received = error.details?.received ? `\nReceived top-level keys: ${error.details.received.join(", ")}` : "";
          output = `GET ${manifest.metricsPath} failed the controller's metrics contract.\n${error.message}${received}`;
        } else {
          const log = await readFile(path.join(appDir, ".factory", "logs", "deployment.log"), "utf8").catch(() => "");
          output = `The app exited on launch. It runs with only PORT and NODE_ENV=production set; it must start without any other env vars.\n${error.message}\n${log.slice(-8_000)}`;
        }
        error.details = { ...error.details, gate: "deploy", output };
        job = await this.repair(job, error, signal);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: true });
        job = await this.reviewAndVerify(job, signal);
      }
    }
    job.deployment = deployment;
    job.recovery = null;
    job.failedState = null;
    job = await this.stage(job, "completed", "Application is live and verified");
    job.completedAt = new Date().toISOString();
    await this.store.writeState(job);
    await this.emit(job.id, { type: "job.completed", state: "completed", message: `Working app: ${deployment.url}` });
    return job;
  }

  async fail(jobId, signal, error) {
    const job = await this.store.read(jobId);
    await this.refreshProofEvidence(job);
    if (error.code === "paused") return this.park(job, error.details.before);
    const cancelled = signal.aborted;
    job.failedState = inferFailedState(job);
    const previous = job.stageHistory.at(-1);
    if (previous && !previous.endedAt) previous.endedAt = new Date().toISOString();
    job.state = cancelled ? "cancelled" : "failed";
    job.stage = cancelled ? "Cancelled" : "Run paused — action needed";
    job.error = {
      code: cancelled ? "cancelled" : error.code ?? "unexpected_error",
      message: cancelled ? "The owner cancelled this run." : error.message,
      details: error.details ?? {},
    };
    job.recovery = buildRecovery(job, this.store.appDir(jobId), undefined, { maxRepairs: this.maxRepairs });
    await this.store.writeState(job);
    await this.emit(job.id, {
      type: cancelled ? "job.cancelled" : "job.failed",
      state: job.state,
      message: job.error.message,
    });
    return job;
  }

  async park(job, before) {
    const previous = job.stageHistory.at(-1);
    if (previous && !previous.endedAt) previous.endedAt = new Date().toISOString();
    await this.commit(job, "factory: paused");
    job.failedState = before;
    job.state = "paused";
    job.stage = `Paused before ${before}`;
    job.error = null;
    job.recovery = { ...buildRecovery(job, this.store.appDir(job.id)), title: "Paused by the owner", summary: `The tree is committed and green. Resume continues from ${before}.` };
    await this.store.writeState(job);
    await this.emit(job.id, { type: "job.paused", state: job.state, message: job.stage });
    return job;
  }

  async refreshProofEvidence(job) {
    const passed = integrationProofs(job).filter(entry => entry.status === "passed");
    if (!passed.length) return;
    const candidate = await sourceBaseline(this.store, { head: false });
    for (const entry of passed) if (entry.candidate !== candidate) {
      entry.status = "pending"; delete entry.candidate; delete entry.verifiedAt; delete entry.proofCandidate;
    }
  }

  async stage(job, state, label) {
    await this.refreshProofEvidence(job);
    if (this.active?.pauseRequested && PAUSE_POINTS.has(state)) {
      this.active.pauseRequested = false;
      throw new FactoryError("paused", `Paused before ${state}`, { before: state });
    }
    const now = new Date().toISOString();
    const previous = job.stageHistory.at(-1);
    if (previous && !previous.endedAt) previous.endedAt = now;
    job.state = state;
    job.stage = label;
    job.activeCommand = null;
    job.stageHistory.push({ state, label, startedAt: now, endedAt: TERMINAL.has(state) ? now : null });
    await this.store.writeState(job);
    await this.emit(job.id, { type: "stage.started", state, message: label });
    return job;
  }

  async emit(jobId, event) {
    return this.store.appendEvent(jobId, event);
  }

  // Stage-boundary commit into the project repo. Best effort: a git hiccup is evidence, not a build failure.
  async commit(job, message) {
    try {
      if (await this.store.commit(message)) await this.emit(job.id, { type: "git.committed", state: job.state, message });
    } catch (error) {
      await this.emit(job.id, { type: "git.failed", state: job.state, message: `commit failed: ${error.message}` });
    }
  }

  async invoke(job, label, prompt, signal, { resumeSessionId = null } = {}) {
    const appDir = this.store.appDir(job.id);
    const logPath = path.join(appDir, ".factory", "logs", `${label}.log`);
    await this.emit(job.id, { type: "agent.started", state: job.state, message: `${this.provider.id} started ${label}` });
    const result = await this.provider.run({
      cwd: appDir,
      prompt,
      logPath,
      signal,
      mode: "write",
      resumeSessionId,
      onEvent: (event) => this.emit(job.id, { ...event, state: job.state }),
      context: { stage: label, job },
    });
    if (result.sessionId) {
      job.agentSessions ||= {};
      job.agentSessions[label] = result.sessionId;
      await this.store.writeState(job);
    }
    await this.emit(job.id, { type: "agent.completed", state: job.state, stage: label, usage: result.usage ?? null, message: `${label} worker completed` });
    return result;
  }

  // `before` is the repo's top-level listing before the spec turn: the repo already holds
  // .git, .gitignore, .solofactory and any earlier build, so only *new* entries count as early code.
  async validateSpecification(appDir, before = []) {
    const required = ["PRD.md", "PLAN.md", "ACCEPTANCE.md"];
    for (const name of required) {
      const content = await readFile(path.join(appDir, ".factory", name), "utf8").catch(() => "");
      if (content.trim().length < 300) {
        throw new FactoryError("invalid_specification", `${name} is missing or too thin.`);
      }
    }
    const top = await readdir(appDir);
    const unexpected = top.filter((name) => name !== ".factory" && !before.includes(name));
    if (unexpected.length) {
      throw new FactoryError(
        "spec_created_code",
        `Specification stage created application files early: ${unexpected.join(", ")}.`,
      );
    }
  }

  async readManifest(appDir) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(appDir, "factory.json"), "utf8"));
    } catch (error) {
      throw new FactoryError("invalid_manifest", `factory.json could not be read: ${error.message}`);
    }
    if (manifest.version !== 1 || !manifest.commands || manifest.healthPath !== "/health") {
      throw new FactoryError("invalid_manifest", "factory.json must use version 1 and healthPath /health.");
    }
    if (manifest.metricsPath !== "/_factory/metrics") {
      throw new FactoryError("invalid_manifest", "factory.json must expose metricsPath /_factory/metrics.");
    }
    for (const name of ["install", "test", "build", "start"]) {
      try {
        assertAllowedCommand(manifest.commands[name]);
      } catch (error) {
        throw new FactoryError("invalid_manifest", `${name}: ${error.message}`);
      }
    }
    return manifest;
  }

  async verifyWithRepairs(job, manifest, signal, { includeInstall, slice = null, proofs = [] }) {
    // Without a feature this is the integrated app: every proof pending integration runs here.
    if (!slice) {
      for (const entry of integrationProofs(job)) { entry.status = "pending"; delete entry.candidate; delete entry.verifiedAt; delete entry.proofCandidate; }
      await this.store.writeState(job);
      proofs = [...proofs, ...integrationProofs(job).map(entry => ({ id: entry.gate.slice("proof-".length), key: entry.key, proof: entry.obligation.proof }))];
    }
    let current = job;
    for (;;) {
      current = await this.stage(current, "verifying", "Running deterministic quality gates");
      const failure = await this.verify(current, manifest, signal, { includeInstall, proofs });
      if (!failure) {
        if (!slice && integrationProofs(current).length) {
          const candidate = await sourceBaseline(this.store, { head: false });
          if (integrationProofs(current).some(entry => entry.proofCandidate !== candidate)) throw new FactoryError("review_rejected", "Integration gates changed the application source; proof evidence is stale.");
        }
        const passed = slice ? `slice ${slice.id}` : [...current.stageHistory].reverse().find((s) => !["verifying", "repairing"].includes(s.state))?.state ?? "build";
        await this.commit(current, `factory: ${passed} passed gates`);
        return current;
      }
      current = await this.repair(current, failure, signal, slice);
      manifest = await this.readManifest(this.store.appDir(current.id));
      includeInstall = true;
    }
  }

  // One repair turn against a recorded failure. Throws the failure itself once the budget is spent.
  async repair(job, failure, signal, slice = null) {
    if (job.attempt >= (job.repairBudgetLimit ?? this.maxRepairs)) throw failure;
    job.attempt += 1;
    await this.store.writeState(job);
    const failureRelative = `.factory/last-failure-${job.attempt}.txt`;
    await writeFile(path.join(this.store.appDir(job.id), failureRelative), failure.details?.output ?? failure.message);
    job = await this.stage(job, "repairing", `Repairing failed ${failure.details?.gate ?? "unknown"} gate`);
    await this.invoke(job, `repair-${job.attempt}`, repairPrompt(failureRelative, slice), signal);
    return job;
  }

  async verify(job, manifest, signal, { includeInstall, proofs = [] }) {
    const gates = (includeInstall ? ["install", "test", "build"] : ["test", "build"]).map((gate) => [gate, manifest.commands[gate]]);
    // Each distinct obligation proof is its own gate; one identical to an earlier command already ran.
    const seen = new Map();
    for (const gate of gates) {
      const key = JSON.stringify(gate[1]);
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(gate);
    }
    for (const item of proofs) {
      const key = JSON.stringify(item.proof.command);
      if (!seen.has(key)) {
        const gate = [`proof-${item.id}`, item.proof.command];
        seen.set(key, [gate]); gates.push(gate);
      }
      for (const gate of seen.get(key)) {
        gate[2] ??= [];
        if (item.key && !gate[2].includes(item.key)) gate[2].push(item.key);
      }
    }
    const integrated = proofs.some(item => item.key);
    let candidate = null;
    for (const [gate, command, proofKeys = []] of gates) {
      // Install may create a lockfile before tests run. Bind evidence to the source tested,
      // including install itself only when it is also an integration proof.
      if (integrated && candidate === null && (gate !== "install" || proofKeys.length)) {
        candidate = await sourceBaseline(this.store, { head: false });
        for (const entry of integrationProofs(job)) entry.proofCandidate = candidate;
      }
      const started = Date.now();
      job.activeCommand = { gate, command, startedAt: new Date().toISOString() };
      await this.store.writeState(job);
      await this.emit(job.id, { type: "gate.started", state: job.state, gate, message: `${gate}: ${command.join(" ")}` });
      const result = await this.commandRunner({
        executable: command[0],
        args: command.slice(1),
        cwd: this.store.appDir(job.id),
        logPath: path.join(this.store.appDir(job.id), ".factory", "logs", `${gate}-${job.attempt}.log`),
        timeoutMs: gate === "install" ? 10 * 60_000 : 5 * 60_000,
        signal,
      });
      const durationMs = Date.now() - started;
      if (result.code !== 0) {
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate, durationMs, message: `${gate} failed` });
        return new FactoryError("quality_gate_failed", `${gate} failed with exit ${result.code}.`, {
          gate,
          command,
          durationMs,
          proofKeys,
          output: result.output,
        });
      }
      await this.emit(job.id, { type: "gate.passed", state: job.state, gate, durationMs, message: `${gate} passed` });
    }
    job.activeCommand = null;
    await this.store.writeState(job);
    return null;
  }

  async deployLocal(job, manifest, signal) {
    const command = manifest.commands.start;
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    const appDir = this.store.appDir(job.id);
    const previous = liveByProject.get(appDir);
    if (previous) {
      liveByProject.delete(appDir);
      if (previous.jobId !== job.id) {
        try {
          const old = await this.store.read(previous.jobId);
          if (old.deployment?.status === "live") {
            old.deployment.status = "replaced";
            old.deployment.stoppedAt = new Date().toISOString();
            old.deployment.replacedBy = job.id;
            await this.store.writeState(old);
            await this.emit(old.id, { type: "deployment.replaced", state: old.state, message: `Replaced by run ${job.id}.` });
          }
        } catch {
          // A missing old run record must not block the new release from deploying.
        }
      }
      previous.child.kill("SIGTERM");
    }
    const logPath = path.join(appDir, ".factory", "logs", "deployment.log");
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn(command[0], command.slice(1), {
      cwd: this.store.appDir(job.id),
      env: subscriptionEnvironment({ PORT: String(port), NODE_ENV: "production" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.deployments.set(job.id, child);
    liveByProject.set(appDir, { jobId: job.id, child });
    signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.once("exit", async (code) => {
      log.end();
      this.deployments.delete(job.id);
      if (liveByProject.get(appDir)?.child === child) liveByProject.delete(appDir);
      try {
        const latest = await this.store.read(job.id);
        if (latest.deployment?.status === "live") {
          latest.deployment.status = "stopped";
          latest.deployment.stoppedAt = new Date().toISOString();
          latest.deployment.exitCode = code;
          await this.store.writeState(latest);
          await this.emit(job.id, { type: "deployment.stopped", state: latest.state, message: `App process stopped with exit ${code}.` });
        }
      } catch {
        // The durable run evidence remains readable even if shutdown races process exit.
      }
    });

    await this.emit(job.id, { type: "deployment.started", state: job.state, message: `Waiting for ${url}${manifest.healthPath}` });
    await waitForHttp(`${url}${manifest.healthPath}`, child, signal);
    const metrics = await fetchJson(`${url}${manifest.metricsPath}`);
    validateMetrics(metrics);
    return { mode: "local", status: "live", url, port, pid: child.pid, startedAt: new Date().toISOString() };
  }

  // Starts a completed run's built app again on a fresh port; only the project's newest run may, since one app runs per project.
  async relaunch(jobId) {
    const job = await this.store.read(jobId);
    if (job.state !== "completed" || job.deployment?.status === "live") throw new FactoryError("not_relaunchable", "Only a completed run whose app is not running can be relaunched.");
    // A newer run blocks only if its work may still be in the folder: set aside with a rollback
    // point means the server rewound it, so the folder holds this job's release again.
    const runs = await this.store.list();
    const newer = runs.slice(0, runs.findIndex((run) => run.id === job.id));
    if (newer.some((run) => !(run.dismissed && run.baseCommit))) throw new FactoryError("not_relaunchable", "A newer run exists in this project; relaunch that one.");
    const manifest = await this.readManifest(this.store.appDir(jobId));
    await mkdir(path.join(this.store.appDir(jobId), ".factory", "logs"), { recursive: true }); // gitignored, so may be absent
    job.deployment = await this.deployLocal(job, manifest, new AbortController().signal);
    await this.store.writeState(job);
    await this.emit(job.id, { type: "deployment.relaunched", state: job.state, message: `App relaunched: ${job.deployment.url}` });
    return job;
  }

  async telemetry(jobId, { probeApp = true } = {}) {
    const job = await this.store.read(jobId);
    const events = await this.store.events(jobId, 500);
    const stageDurations = job.stageHistory.map((stage) => ({
      state: stage.state,
      label: stage.label,
      durationMs: new Date(stage.endedAt ?? new Date()).getTime() - new Date(stage.startedAt).getTime(),
    }));
    const agentTurns = events.filter((event) => event.type === "agent.started").length;
    const gateRuns = events.filter((event) => event.type === "gate.started").length;
    const repairs = events.filter((event) => event.type === "gate.failed").length;
    // Summed over the whole event log, not the 500-event window above, so long slice runs stay exact.
    const allEvents = await this.store.events(jobId, Infinity);
    const summary = {
      strategy: job.sdlc ?? "single",
      slicesPlanned: (job.slicePlanIds ?? []).length,
      slicesCompleted: (job.sliceDone ?? []).length,
      agentTurns,
      repairs,
      gateRuns,
      stageCount: job.stageHistory.length,
      tokens: usageTotals(allEvents),
    };
    let app = null;
    if (probeApp && job.deployment?.url && job.deployment.status === "live") {
      try {
        const manifest = await this.readManifest(this.store.appDir(jobId));
        try {
          app = await fetchJson(`${job.deployment.url}${manifest.metricsPath}`);
        } catch (error) {
          // Nothing answered: the app died after the record said live (e.g. the server restarted), so stop claiming it.
          job.deployment.status = "stopped";
          job.deployment.stoppedAt = new Date().toISOString();
          await this.store.writeState(job);
          throw error;
        }
        validateMetrics(app);
      } catch (error) {
        app = { unavailable: true, message: error.message };
      }
    }
    return {
      job: { id: job.id, state: job.state, stage: job.stage, attempt: job.attempt, sdlc: job.sdlc ?? "single" },
      sliceStats: job.sliceStats ?? {},
      summary,
      stageDurations,
      events,
      app,
    };
  }

  // One line per run segment (each start/resume ends in completed, failed, paused, or cancelled)
  // in <project>/.solofactory/runs.jsonl. Totals are cumulative, so the last line for a jobId is the
  // whole run. SOLOFACTORY_VARIANT labels the harness configuration being compared ("baseline", ...).
  async logRun(jobId) {
    const job = await this.store.read(jobId);
    const { summary, stageDurations } = await this.telemetry(jobId, { probeApp: false });
    const record = {
      at: new Date().toISOString(),
      jobId,
      project: path.basename(this.store.project),
      state: job.state,
      failedState: job.failedState ?? null,
      variant: process.env.SOLOFACTORY_VARIANT || "baseline",
      harness: HARNESS,
      provider: this.provider.id,
      codex: this.provider.id === "codex" ? { model: process.env.SOLOFACTORY_CODEX_MODEL || "gpt-5.6-sol", effort: process.env.SOLOFACTORY_CODEX_REASONING_EFFORT || "low" } : undefined,
      sdlc: summary.strategy,
      followOn: Boolean(job.followOn),
      wallMs: Date.now() - new Date(job.startedAt ?? job.createdAt).getTime(),
      activeMs: stageDurations.reduce((sum, stage) => sum + stage.durationMs, 0),
      stageMs: stageDurations.reduce((acc, stage) => ({ ...acc, [stage.state]: (acc[stage.state] ?? 0) + stage.durationMs }), {}),
      ...summary,
    };
    await appendFile(path.join(this.store.project, ".solofactory", "runs.jsonl"), `${JSON.stringify(record)}\n`);
  }

  async shutdown() {
    for (const child of this.deployments.values()) child.kill("SIGTERM");
    this.deployments.clear();
  }
}

export function inferFailedState(job) {
  if (job.failedState && !TERMINAL.has(job.failedState)) return job.failedState;
  return [...(job.stageHistory ?? [])].reverse().find((stage) => !TERMINAL.has(stage.state))?.state ?? "building";
}

// A rejected review or failed integration proof with no repair attempts left: another Resume would only rerun it.
export function repairsExhausted(job, maxRepairs = 2) {
  return (job.error?.code === "review_rejected" || Boolean(pendingProofFailure(job))) && (job.attempt ?? 0) >= (job.repairBudgetLimit ?? maxRepairs);
}

// Stopped because approved inputs changed: Resume would stop again; only a new plan can continue.
export function inputsChanged(job) {
  return job.error?.code === "inputs_changed";
}

// A repair plan still blocked after its corrections: retrying the same inputs cannot pass review.
// The message match recognizes runs saved before the plan_blocked code.
export function planBlockedOut(job) {
  return job.recoveryPhase?.status === "plan_failed" && (job.error?.code === "plan_blocked" || /plan is still blocked after \d+ corrections/.test(job.error?.message ?? ""));
}

// Refuses a futile repair-plan preparation before any turn runs: the current inputs' fingerprint already
// exhausted its corrections in the budget ledger (the latest plan, or earlier inputs switched back to).
export async function assertPlanInputsRevised(store, job) {
  const exhausted = exhaustedPreparations(job);
  // ponytail: runs saved before the `blocked` flag are recognized only for their latest preparation.
  if (planBlockedOut(job) && !exhausted.includes(job.recoveryPhase)) exhausted.push(job.recoveryPhase);
  if (!exhausted.length) return;
  const now = digest(await sourceSet(store.appDir(), runInputs(job)));
  const phase = exhausted.find((item) => item.request?.sourcesDigest === now);
  if (!phase) return;
  const blockers = phase.planBlockers ?? [];
  const next = { action: "revise-inputs", label: "Revise inputs and prepare a new plan", endpoint: `/api/jobs/${job.id}/recovery-plan`, reason: "These inputs have exhausted their plan corrections. Revise the specs or prototype to prepare a new plan." };
  throw new FactoryError("plan_inputs_unchanged", `${next.reason}${blockers.length ? ` Plan review blockers: ${blockers.join("; ")}.` : ""} Next: ${next.label} (POST ${next.endpoint}).`, { nextAction: next, blockers });
}

// The one continuation policy: the controller, the HTTP API and the dashboard all ask this which
// action may continue a parked run, so a banner can never offer an action the controller refuses.
// `busy`: a worker already holds or has queued this run.
export function continuationAction(job, { maxRepairs = 2, busy = false } = {}) {
  const next = (action, label, endpoint, reason) => ({ action, label, endpoint: endpoint && `/api/jobs/${job.id}/${endpoint}`, reason });
  const phase = job.recoveryPhase?.status;
  if (job.dismissed || !PARKED_STATES.has(job.state)) return next("none", null, null, "Only an unresolved parked run can continue.");
  if (busy) return next("none", null, null, "A worker is already running or queued for this run; wait for it to park.");
  if (planBlockedOut(job)) return next("revise-inputs", "Revise inputs and prepare a new plan", "recovery-plan", `The repair plan is still blocked after ${job.recoveryPhase.corrections ?? 0} plan corrections: ${job.recoveryPhase.planBlockers?.[0] ?? job.error?.message}. Retrying with the same inputs cannot pass review. Revise the specs or prototype inputs to resolve the blockers, then prepare a new plan.`);
  if (phase === "planning" || phase === "plan_failed") return next("retry-plan", "Retry repair-plan preparation", "recovery-plan", `${phase === "planning" ? "Repair-plan preparation stopped before it finished" : "Repair-plan preparation failed"}, so no plan is approved. Retry repair-plan preparation; Resume cannot continue an unapproved plan.`);
  if (phase === "ready") return next("approve-plan", "Approve and continue repairs", "recovery-start", "Review and approve the recovery plan before execution; Resume does not start an unapproved plan.");
  if (repairsExhausted(job, maxRepairs)) return next("prepare-plan", "Prepare repair plan", "recovery-plan", "The repair budget is exhausted. Prepare a repair plan and approve it; Resume does not renew the budget or rerun the same review.");
  if (inputsChanged(job)) return next("prepare-plan", "Prepare repair plan", "recovery-plan", "The specs or prototype inputs changed after the plan was approved. Prepare a repair plan against the current inputs.");
  if (job.state === "cancelled") return next("none", null, null, "The owner cancelled this run; start over to build it again.");
  return next("resume", job.state === "paused" ? "Resume" : "Resume current run", "resume", phase === "running" ? "Resume continues the approved repair plan from its cursor." : "Resume continues this run from its preserved files.");
}

// Points resume wording at the action the policy allows. Idempotent, so stored banners can be re-derived.
function retarget(actions = [], next) {
  if (next.action === "resume" || !next.label) return actions;
  const lower = next.label[0].toLowerCase() + next.label.slice(1);
  const out = actions.map((text) => text
    .replace(/then resume (?:this|the preserved) run(?: from its preserved files)?\./i, `then ${lower}.`)
    .replace(/Use Resume on this run's card to continue its preserved files\./, `Use ${next.label} on this run's card.`));
  return out.some((text) => text.startsWith(next.label)) ? out : [...out, `${next.label}: ${next.reason}`];
}

// Presentation for API responses: derives the banner from the policy without writing the job.
export function withContinuation(job, options) {
  const nextAction = continuationAction(job, options);
  if (!job.recovery) return { ...job, nextAction };
  return { ...job, nextAction, recovery: { ...job.recovery, canResume: nextAction.action === "resume", nextAction, actions: retarget(job.recovery.actions, nextAction) } };
}

export function buildRecovery(job, workspace, diagnostics = job.error?.details?.diagnostics ?? [], { legacy = false, maxRepairs = 2 } = {}) {
  const failedState = inferFailedState(job);
  const timeoutReason = job.error?.details?.timeoutReason;
  const primary = diagnostics[0];
  const reviewBlocked = job.error?.code === "review_rejected";
  const exhausted = repairsExhausted(job, maxRepairs);
  const stale = inputsChanged(job);
  const title = stale ? "Specs or prototype inputs changed" : exhausted ? "Repair budget exhausted" : reviewBlocked ? "Required functionality or evidence is unfinished" : primary?.title
    ?? (timeoutReason === "idle" ? "The coding agent became inactive" : timeoutReason === "hard" ? "The run reached its safety cap" : "The run paused before completion");
  const actions = diagnostics.map((item) => item.action);
  if (!actions.length) {
    if (stale) {
      actions.push("Prepare repair plan: the factory compares the changed inputs with the approved plan and plans the unfinished work against the current inputs; verified features stay done.");
      actions.push("Review the plan, then Approve and continue repairs. Resume would stop again on the same changed inputs.");
    } else if (exhausted) {
      actions.push(pendingProofFailure(job)
        ? "Prepare repair plan: the factory plans features for the requirements the failed integration proof supports, from its obligation, command and output."
        : "Prepare repair plan: the factory plans features for the unfinished checks from the review findings and every spec and prototype input.");
      actions.push("Review the remaining gaps, proposed features and proof checks, then Approve and continue repairs to start a new bounded repair phase.");
      actions.push("Resume does not renew the repair budget; dashboard chat explains or shapes briefs and does not resume a run.");
    } else if (reviewBlocked) {
      actions.push("Read the unfinished checks and reviewer blockers in this packet and .factory/REVIEW.md.");
      actions.push("Implement the missing behavior and run its acceptance checks; preserve the frozen contract and existing data.");
      actions.push("Use Resume on this run's card to continue its preserved files. Dashboard chat explains or shapes briefs; it does not resume a run.");
    } else actions.push("Review the recovery packet and the named log, then resume this run from its preserved files.");
  }
  const attempts = job.error?.details?.autoResumes ?? 0;
  const summary = reviewBlocked ? `The review did not approve the app. ${job.attempt ?? 0} automatic repairs have been used; green tests do not prove the missing features are complete.` : diagnostics.length
    ? `${diagnostics.map((item) => item.title).join("; ")}. The partial app and completed specification are intact.`
    : timeoutReason === "idle"
      ? `The agent stopped producing activity. ${attempts ? "Its one bounded same-session retry was used." : "A manual resume can continue without starting over."}`
      : "The factory stopped safely. Its existing files and evidence are intact, so recovery does not require a new run.";
  const nextAction = continuationAction(job, { maxRepairs });
  return {
    version: 2,
    status: job.state === "cancelled" ? "cancelled" : "needs_owner",
    title,
    summary,
    failedState,
    actions: retarget(actions, nextAction),
    workspace,
    logPath: job.error?.details?.logPath ?? null,
    filesPreserved: true,
    canResume: nextAction.action === "resume",
    nextAction,
    automaticRetry: reviewBlocked ? "The bounded repair budget stopped this run. Repeating the error in chat does not perform a repair or resume." : legacy
      ? "This run predates activity-aware recovery; no automatic resume was available."
      : diagnostics.length
        ? "Automatic retry stopped because a concrete blocker was detected, avoiding another token-consuming agent turn."
        : attempts
          ? `Used ${attempts} of 1 bounded same-session retries.`
          : "No automatic retry was needed or safe.",
  };
}

export function buildRecoveryPacket(job) {
  const recovery = job.recovery ?? buildRecovery(job, "Unknown workspace");
  const lines = [
    "SoloFactory recovery request",
    `Run: ${job.id}`,
    `Failed stage: ${recovery.failedState}`,
    `Preserved workspace: ${recovery.workspace}`,
    `Failure: ${job.error?.message ?? recovery.summary}`,
    `Summary: ${recovery.summary}`,
    `Automatic retry: ${recovery.automaticRetry}`,
    "",
    "Recommended actions:",
    ...recovery.actions.map((action) => `- ${action}`),
  ];
  if (job.error?.details?.output && job.error.details.output !== job.error.message) lines.push("", "Review findings:", job.error.details.output);
  if (job.recoveryPhase?.plan) lines.push("", `Feature recovery: ${job.recoveryPhase.status}; ${job.recoveryPhase.done.length}/${job.recoveryPhase.plan.slices.length} verified.`,
    ...job.recoveryPhase.plan.slices.map(slice => `- ${job.recoveryPhase.done.includes(slice.id) ? "Verified" : "Unfinished"}: ${slice.title} (${(slice.closes ?? slice.checks).join(", ")})${pendingNote(pendingChecks(slice, { plan: job.recoveryPhase.plan, outstanding: job.outstandingProofs }))}`));
  if (recovery.logPath) lines.push("", `Log: ${recovery.logPath}`);
  lines.push(
    "",
    job.error?.code === "review_rejected"
      ? "Inspect the preserved workspace and review evidence, implement the unfinished requirements, and verify them against the frozen contract. Do not start over, waive requirements, or redo completed work unless the evidence requires it. Dashboard chat cannot execute this recovery; use the run controls to continue."
      : "Please inspect the preserved workspace and evidence, help resolve any external blocker, and continue from the current state. Do not start over or redo completed work unless the evidence requires it.",
  );
  return `${lines.join("\n")}\n`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, signal, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new FactoryError("cancelled", "Deployment cancelled.");
    if (child.exitCode !== null) throw new FactoryError("deployment_exited", `App exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // Startup races are expected until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill("SIGTERM");
  throw new FactoryError("health_check_failed", `No successful health response from ${url}.`);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

export function validateMetrics(value) {
  const routesOk = Array.isArray(value?.routes) || (value?.routes && typeof value.routes === "object");
  const problems = [
    ["uptimeSeconds", typeof value?.uptimeSeconds === "number"],
    ["requests.total", typeof value?.requests?.total === "number"],
    ["requests.errors", typeof value?.requests?.errors === "number"],
    ["latencyMs.average", typeof value?.latencyMs?.average === "number"],
    ["routes", routesOk],
  ].filter(([, ok]) => !ok).map(([field]) => field);
  if (problems.length) {
    throw new FactoryError(
      "invalid_metrics",
      `The app metrics endpoint returned an invalid schema. Missing or non-numeric: ${problems.join(", ")}.`,
      { missing: problems, received: value === undefined ? undefined : Object.keys(value ?? {}) },
    );
  }
  return value;
}

// Token totals for a run from its agent.completed events: overall, and per stage label with
// repeats folded (see stageKind) so runs of any shape line up.
// Agent labels from invoke(): build-slice-<id>, slice-resume-<id>, repair-<n>, repair-resume, <stage>-resume.
const pendingNote = (ids) => ids.length ? `; ${ids.join(", ")} pending integration proof` : "";

// One acceptance obligation as a review check: behavior, cited source and proof the reviewer must confirm.
function obligationCheck(item) {
  return { id: item.id, text: `${item.behavior}${item.sources ? ` (source: ${item.sources.map((ref) => `${ref.path} ${ref.locator}`).join("; ")})` : ""}${item.proof ? ` (proof: ${item.proof.command.join(" ")} → ${item.proof.expect})` : ""}` };
}

function stageKind(label = "unknown") {
  if (/^(build-slice|slice-resume)-/.test(label)) return "slice";
  if (label.startsWith("repair")) return "repair";
  if (/^(plan-review|plan-correction)-\d+$/.test(label)) return label.replace(/-\d+$/, "");
  if (label.startsWith("feature-review-")) return "feature-review";
  return label.replace(/-resume$/, "");
}

export function usageTotals(events) {
  const byStage = {};
  let total = null;
  // Started minus reported: a turn whose provider threw never emits agent.completed.
  let turnsWithoutUsage = 0;
  for (const event of events) {
    if (event.type === "agent.started") turnsWithoutUsage += 1;
    if (event.type !== "agent.completed" || !event.usage) continue;
    turnsWithoutUsage -= 1;
    const stage = stageKind(event.stage);
    byStage[stage] = addUsage(byStage[stage], event.usage);
    total = addUsage(total, event.usage);
  }
  return { total, byStage, turnsWithoutUsage };
}
