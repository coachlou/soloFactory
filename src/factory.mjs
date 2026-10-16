import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAllowedCommand, runProcess, subscriptionEnvironment } from "./process.mjs";
import { buildPrompt, continuationPrompt, featureBuildPrompt, featurePlanPrompt, featureReviewPrompt, planAuditPrompt, planCorrectionPrompt, planReviewPrompt, repairPrompt, reviewPrompt, sliceBuildPrompt, sliceContinuationPrompt, specificationPrompt } from "./prompts.mjs";
import { PLAN_SCHEMA_FIXES, assertConsolidation, caseResults, featureProofs, impactedFeatures, proofsOf, orderSlices, integrationProofs, outsideWrites, writesCover, pendingChecks, pendingProofFailure, recordPendingProofs, validateFeaturePlan, validateSlicePlan } from "./wbs.mjs";
export { pendingProofFailure };
import { contractDigest, originalChecks, preparePlanReview, prepareReview, runInputs, sourceSet, validatePlanReview, validateReview } from "./review.mjs";
import { addUsage } from "./providers.mjs";
import { measureRun } from "./measure.mjs";
import { RunMonitor, failureSignature, incidentRecord, repeatedFailure, watchConfig, workerAlive } from "./watchdog.mjs";
import { amendRepairPlan, archiveReview, assertBatch, consolidationBase, keepCorrecting, assertPlanningCurrent, digest, exhaustedPreparations, planFeatureRecovery, planKey, resumeAmendedReview, reviewedPlanKeys, runFeatureRecovery, sourceBaseline, validateRecoveryApproval, validateRecoveryPlan } from "./feature-recovery.mjs";

// Which harness produced a run, so runs.jsonl can compare harness changes. Read once at load.
const harnessRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASE_REPORTER = fileURLToPath(new URL("./case-reporter.mjs", import.meta.url));
const HARNESS = {
  version: JSON.parse(await readFile(path.join(harnessRoot, "package.json"), "utf8")).version,
  commit: (() => {
    // An installed copy sits inside the owner's project repo, whose HEAD is not the factory's: the distro's
    // VERSION stamp ("solofactory 0.9.7 (dcc9d2d) synced ...") names the real build.
    const stamped = existsSync(path.join(harnessRoot, "VERSION")) && readFileSync(path.join(harnessRoot, "VERSION"), "utf8").match(/\(([0-9a-f]{7,})\)/)?.[1];
    if (stamped) return stamped;
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: harnessRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: harnessRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return dirty ? `${sha}-dirty` : sha;
    } catch {
      return null;
    }
  })(),
};

// An oversized prompt is rebuilt identically on this build, so its retry waits for a different factory build.
const OVERSIZED_PROMPT = new Set(["prompt_too_large", "input_too_large"]);
const BUILD_ID = `${HARNESS.version}+${HARNESS.commit}`;
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

// Test files and fixtures: never widened into, since editing another feature's tests can weaken them.
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export class SoloFactory {
  constructor({ store, provider, maxRepairs = 2, batchRepairsFrom = 10, autoStartRepairs = true, commandRunner = runProcess, deployer, watch = watchConfig() } = {}) {
    this.store = store;
    this.watch = watch;
    this.provider = provider;
    this.maxRepairs = maxRepairs;
    this.batchRepairsFrom = batchRepairsFrom;
    this.autoStartRepairs = autoStartRepairs;
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

  // Refusals happen here, before activate writes anything: a refused action leaves the saved run unchanged.
  async resume(jobId, { features } = {}) {
    assertBatch(features);
    const job = await this.continuable(jobId);
    if (features && job.recoveryPhase?.status !== "running") throw new FactoryError("bad_batch", "A batch size applies only to an approved repair plan that is running.");
    const next = continuationAction(job, { maxRepairs: this.maxRepairs });
    if (next.action !== "resume") throw new FactoryError(["prepare-plan", "revise-inputs", "amend-plan"].includes(next.action) ? "repair_plan_required" : "recovery_approval_required", `${next.reason} Next: ${next.label} (POST ${next.endpoint}).`, { nextAction: next });
    // Exhausted corrections: Resume buys one review only for a plan the reviewer has not already blocked.
    await assertPlanReviewable(this.store, job, this.maxRepairs);
    return this.activate(jobId, (signal) => this.runResume(jobId, signal, { features }));
  }

  async planRecovery(jobId, guidance = "", { features } = {}) {
    const job = await this.continuable(jobId);
    // Only the policy's planning actions reach the planner; a run Resume can continue is not replanned.
    const next = continuationAction(job, { maxRepairs: this.maxRepairs });
    if (!admitsPlanning(next)) throw new FactoryError("not_continuable", `Prepare repair plan is not the next step: ${next.reason}`, { nextAction: next });
    await assertPlanInputsRevised(this.store, job);
    // An interrupted amendment review continues as a review; it never becomes a fresh planner run.
    if (await amendmentResumable(this.store, job)) return this.activate(jobId, signal => resumeAmendedReview(this, jobId, signal));
    return this.activate(jobId, signal => planFeatureRecovery(this, jobId, signal, guidance, { features }));
  }

  // The owner's corrected plan gets one independent review. Admission re-validates under writer ownership,
  // before activation writes anything, so a rejection leaves the saved run untouched.
  async amendRecovery(jobId, submission) {
    return this.activate(jobId, (signal) => amendRepairPlan(this, jobId, signal, submission),
      async () => assertPlanAmendable(this.store, await this.store.read(jobId), submission, { maxRepairs: this.maxRepairs }));
  }

  async startRecovery(jobId, planDigest, { features } = {}) {
    assertBatch(features);
    await validateRecoveryApproval(this, await this.continuable(jobId), planDigest);
    return this.activate(jobId, signal => runFeatureRecovery(this, jobId, signal, planDigest, { features }));
  }

  // The policy's "none" (owner-cancelled, dismissed, not parked) refuses every continuation.
  async continuable(jobId) {
    const job = await this.store.read(jobId);
    const next = continuationAction(job, { maxRepairs: this.maxRepairs });
    if (next.action === "none") throw new FactoryError("not_continuable", next.reason, { nextAction: next });
    if (next.action === "factory-fix") throw new FactoryError("factory_fix_required", next.reason, { nextAction: next });
    return job;
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
        job.error = null;
        job.failedState = null;
        job.recovery = null;
        // `attempt` stays run-wide so repair labels and logs never overwrite the parked run's; each rebuilt
        // feature's budget is re-derived from it. Agent sessions and any repair plan describe rewound work.
        job.agentSessions = {};
        if (job.recoveryPhase) (job.recoveryPhaseHistory ??= []).push({ ...job.recoveryPhase, status: "discarded" });
        job.recoveryPhase = null;
        if (job.planVersion === 2) Object.assign(job, { featureCursor: null, setAside: null, bugProofs: null, finalBudgetSet: false, repairBudgetLimit: null });
        else job.repairBudgetLimit = job.attempt + this.maxRepairs;
        await this.store.writeState(job);
        await this.emit(job.id, { type: "job.restarted", state: job.state, message: `Restarting from slice ${sliceId} at ${base.slice(0, 7)}` });
        if (job.planVersion === 2) return await this.buildFeatures(job, signal);
        return await this.buildSlices(job, signal, { resumeFrom: index, fresh: true });
      } catch (error) {
        return this.fail(jobId, signal, error);
      }
    });
  }

  async activate(jobId, runner, admit) {
    if (this.active) throw new FactoryError("factory_busy", `Run ${this.active.jobId} is already active.`);
    const controller = new AbortController();
    // One monitor per active run; it only observes, and stops with the run.
    const monitor = new RunMonitor({ jobId, config: this.watch, emit: (event) => this.store.appendEvent(jobId, event) }).start();
    this.active = { jobId, controller, monitor };
    // A new invocation starts without the last park's incident; attempts and continuations stay durable.
    let rejected = false;
    const promise = (async () => {
      // `admit` validates under ownership before the incident below is cleared; a refusal writes nothing.
      try { await admit?.(); } catch (error) { rejected = true; throw error; }
      const job = await this.store.read(jobId).catch(() => null);
      if (job?.watch?.incident || job?.watch?.observed) {
        delete job.watch.incident; delete job.watch.observed;
        await this.store.writeState(job);
      }
      return runner(controller.signal);
    })().finally(async () => {
      monitor.stop();
      if (this.active?.jobId === jobId) this.active = null;
      if (!rejected) await this.logRun(jobId).catch(() => {});
    });
    this.active.promise = promise;
    return promise;
  }

  // Live supervision for the active run, or null when this factory is not running it.
  supervision(jobId) {
    return this.active?.jobId === jobId ? this.active.monitor.snapshot() : null;
  }

  // Durable worker ownership: a restart checks this pid before anything may write again.
  trackWorker(job, child, info) {
    job.worker = { pid: child.pid, serverPid: process.pid, kind: info.kind, label: info.label, startedAt: new Date().toISOString() };
    this.monitorOf(job)?.spawned({ ...info, pid: child.pid });
    return this.store.writeState(job);
  }

  async releaseWorker(job, pending) {
    await pending;
    this.monitorOf(job)?.exited();
    if (!job.worker) return;
    job.worker = null;
    await this.store.writeState(job);
  }

  monitorOf(job) {
    return this.active?.jobId === job.id ? this.active.monitor : null;
  }

  // `shutdown`: the server is stopping, not the owner cancelling; the run parks as interrupted.
  async cancel(jobId, { shutdown = false } = {}) {
    if (this.active?.jobId !== jobId) throw new FactoryError("not_active", "That run is not active.");
    this.active.controller.abort(shutdown ? "shutdown" : undefined);
  }

  // Takes effect at the next stage boundary (between slices in slice mode), never mid-turn.
  async pause(jobId) {
    if (this.active?.jobId !== jobId) throw new FactoryError("not_active", "That run is not active.");
    this.active.pauseRequested = true;
  }

  pausePending(jobId) {
    return this.active?.jobId === jobId && Boolean(this.active.pauseRequested);
  }

  // A pending Pause parks before the next agent turn. Callers save whatever resume needs first.
  takePause(before) {
    if (!this.active?.pauseRequested) return;
    this.active.pauseRequested = false;
    throw new FactoryError("paused", `Paused before ${before}`, { before });
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

  async runResume(jobId, signal, { features } = {}) {
    let job = await this.store.read(jobId);
    if (!TERMINAL.has(job.state) || job.state === "completed") {
      throw new FactoryError("not_resumable", "Only a failed, cancelled, or interrupted run can be resumed.");
    }
    // resume() refused every other action before activation; this guards direct callers.
    const next = continuationAction(job, { maxRepairs: this.maxRepairs });
    if (next.action !== "resume") {
      throw new FactoryError(["prepare-plan", "revise-inputs", "amend-plan"].includes(next.action) ? "repair_plan_required" : "recovery_approval_required", `${next.reason} Next: ${next.label} (POST ${next.endpoint}).`, { nextAction: next });
    }
    if (job.recoveryPhase?.status === "running") return runFeatureRecovery(this, jobId, signal, null, { features });
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
      // Every planning turn passed the mutation guard before plan_blocked parked the run, so a spec change
      // since then is the owner's revision: re-baseline it and give it a fresh correction budget.
      if (job.planVersion === 2 && !job.approvedPlan && !job.recoveryPhase && previousError?.code === "plan_blocked" && await initialInputsRevised(this.store, job)) {
        job.planBaseline.inputs = digest(await sourceSet(appDir, runInputs(job)));
        Object.assign(job, { planCorrections: 0, planSchemaFixes: 0, planBlockedDigests: [], planBlockerHistory: [], planBlockerCounts: [] });
        await this.emit(job.id, { type: "plan.inputs_revised", state: failedState, message: "The supplied specs changed since the plan was blocked; plan review restarts with a fresh correction budget." });
      }
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
      if (job.reviewFailure) {
        // Parked by a Pause after the review blocked: repair the recorded blockers, then review the repaired app.
        await this.assertInputs(job);
        const { code, message, details } = job.reviewFailure;
        delete job.reviewFailure;
        job = await this.repairFindings(job, new FactoryError(code, message, details), signal);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
        continue;
      }
      job = await this.stage(job, "reviewing", "Reviewing against the frozen contract");
      await this.assertInputs(job);
      let request;
      const pending = integrationProofs(job).map((entry) => ({ id: entry.key, text: obligationCheck(entry.obligation).text }));
      const caseIds = integrationProofs(job).flatMap((entry) => (entry.obligation.cases ?? []).map((item) => item.id));
      try { request = await prepareReview(appDir, job, { checks: [...originalChecks(job.brief), ...pending], caseResults: caseIds.length ? Object.fromEntries(caseIds.map((id) => [id, job.caseResults?.[id] ?? { status: "missing" }])) : undefined }); }
      catch (error) { throw new FactoryError("review_rejected", `Cannot review the frozen contract: ${error.message}`); }
      if (job.reviewContractDigest && request.contractDigest !== job.reviewContractDigest) {
        throw new FactoryError("review_rejected", "Frozen contract changed after the first review; scope cannot be narrowed during repair.");
      }
      job.reviewContractDigest = request.contractDigest;
      job.reviewRequest = request;
      await this.store.writeState(job);
      const prompt = reviewPrompt({ featureReviewed: job.planVersion === 2 });
      const reviewed = await sourceBaseline(this.store, { head: false });
      try {
        await this.invoke(job, "review", prompt, signal);
      } catch (error) {
        // A capped review is mid-check, not wrong; restarting cold repeats the whole read (2026-10-16:
        // the medialibrary final review spent 44 of 45 minutes before a verdict). Keyed per attempt so a
        // review after a repair gets its own allowance.
        if (error.code !== "agent_hard_timeout" || !await this.allowContinuation(job, `review-${job.attempt}`)) throw error;
        await this.invoke(job, "review-resume", prompt, signal, { resumeSessionId: error.details?.sessionId ?? null });
      }
      try {
        await this.requireReview(job);
      } catch (failure) {
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "review", message: failure.message });
        if (this.active?.pauseRequested) {
          this.active.pauseRequested = false;
          job.reviewFailure = { code: failure.code, message: failure.message, details: failure.details };
          await this.store.writeState(job);
          throw new FactoryError("paused", "Paused before repairing", { before: "reviewing" });
        }
        job = await this.repairFindings(job, failure, signal);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
        continue;
      }
      // Reviewers only judge: a pass on source the reviewer itself changed covers an unchecked edit,
      // so the edit is verified like any change and the new candidate gets a fresh review.
      if (await sourceBaseline(this.store, { head: false }) !== reviewed) {
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "review", message: "The reviewer changed source; its verdict is void and the app is rechecked." });
        job.reviewEdits = (job.reviewEdits ?? 0) + 1;
        if (job.reviewEdits > 2) throw new FactoryError("review_rejected", `The final reviewer kept changing source instead of reporting blockers (${job.reviewEdits} reviews).`);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
        continue;
      }
      const attempt = job.attempt;
      // The reviewer changed nothing, so the integration verify that preceded it still holds.
      const verified = job.integrationVerified;
      if (verified?.set === integrationSet(job) && verified.candidate === await sourceBaseline(this.store, { head: false })) {
        await this.commit(job, "factory: reviewing passed gates");
        await this.emit(job.id, { type: "gate.skipped", state: job.state, gate: "integration", candidate: verified.candidate, message: "post-review verify skipped: source unchanged" });
      } else {
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
      }
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
    await writeFile(path.join(factoryDir, "plan-request.json"), `${JSON.stringify({ version: 1, jobId: job.id, contractDigest: contract, checks, sources, toolchain: { node: process.version } }, null, 2)}\n`);
    // Planning agents run this to check slices.json with the controller's own validation before finishing.
    await writeFile(path.join(factoryDir, "check-plan.mjs"), `import ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./check-plan.mjs", import.meta.url))).href)};\n`);
    job = await this.stage(job, "specifying", "Planning features against the frozen contract");
    // Persisted, so a mutation left behind by a parked planning turn still blocks after resume.
    job.planBaseline ??= { source: await sourceBaseline(this.store, { head: false }), contract };
    job.planBaseline.inputs ??= digest(sources);
    job.planCorrections ??= 0;
    job.planSchemaFixes ??= 0;
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
      if (job.planBlockers) {
        // Saved by a Pause after the review blocked. A plan edited while paused is reviewed afresh.
        if (!(plan instanceof Error) && job.planBlockedDigests?.includes(await planFileDigest(appDir))) blockers = job.planBlockers;
        delete job.planBlockers;
      }
      if (blockers) { /* correct the recorded blockers below */ }
      else if (plan instanceof Error) blockers = [plan.message];
      else {
        this.takePause("specifying");
        const planDigest = digest(plan);
        const priorBlockers = job.planBlockerHistory ?? [];
        const request = await preparePlanReview(appDir, job, planDigest, { checks, sources, ...(priorBlockers.length && { priorBlockers }) });
        job.planReviews += 1;
        await this.store.writeState(job);
        await this.invoke(job, `plan-review-${job.planReviews}`, planAuditPrompt({ followOn: job.followOn, rereview: priorBlockers.length > 0 }), signal);
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
          // Durable, so neither a restart nor switching back to an earlier rejected plan buys another review.
          job.planBlockedDigests = [...new Set([...(job.planBlockedDigests ?? []), await planFileDigest(appDir)])];
          job.planBlockerHistory = [...new Set([...(job.planBlockerHistory ?? []), ...blockers])];
          job.planBlockerCounts = [...(job.planBlockerCounts ?? []), blockers.length];
          await this.store.writeState(job);
        }
      }
      await this.emit(job.id, { type: "plan.blocked", state: job.state, message: blockers[0], blockers });
      // Only before a turn that would run, so a Pause never delays an exhausted budget's failure.
      const pauseBeforeTurn = async () => {
        if (!this.active?.pauseRequested) return;
        if (!(plan instanceof Error)) job.planBlockers = blockers;
        await this.store.writeState(job);
        this.takePause("specifying");
      };
      if (plan instanceof Error && job.planSchemaFixes < PLAN_SCHEMA_FIXES) {
        await pauseBeforeTurn();
        job.planSchemaFixes += 1;
        await this.store.writeState(job);
        await this.invoke(job, `plan-schema-fix-${job.planSchemaFixes}`, planCorrectionPrompt(blockers), signal);
        await guard();
        plan = await readPlan();
        continue;
      }
      // A plan that no longer parses is not progress, even after two shrinking reviews.
      if (!keepCorrecting(job.planCorrections, this.maxRepairs, plan instanceof Error ? [] : job.planBlockerCounts)) {
        throw new FactoryError("plan_blocked", `The feature plan is still blocked after ${job.planCorrections} corrections: ${blockers[0]}`, { blockers, output: blockers.join("\n") });
      }
      await pauseBeforeTurn();
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
    // Set-aside features and everything that depends on them wait; sliceDone, not position, says what is built.
    const waiting = new Set((job.setAside ?? []).map((entry) => entry.id));
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      if (job.sliceDone?.includes(slice.id) || waiting.has(slice.id)) continue;
      if (slice.dependsOn.some((id) => waiting.has(id))) {
        waiting.add(slice.id);
        await this.emit(job.id, { type: "slice.waiting", state: job.state, slice: slice.id, message: `Feature ${slice.id} waits for a set-aside feature it depends on` });
        continue;
      }
      await this.assertPlanCurrent(job);
      if (job.featureCursor?.id !== slice.id) {
        // Each feature gets maxRepairs; set once per feature, so resume never refills it.
        job.featureCursor = { id: slice.id, substage: "implementing", implementStarted: false, reviews: 0, startedAt: new Date().toISOString(), attemptBefore: job.attempt, base: await this.store.git("rev-parse", "HEAD") };
        job.repairBudgetLimit = job.attempt + this.maxRepairs;
        job.sliceIndex = i;
        await this.store.writeState(job);
        await this.emit(job.id, { type: "slice.started", state: job.state, slice: slice.id, message: `Feature ${i + 1}/${slices.length}: ${slice.title}` });
      }
      try {
        job = await this.proveFeature(job, slice, checks, `${i + 1}/${slices.length}`, signal);
      } catch (error) {
        if (!await this.setAside(job, slice, error, signal)) throw error;
        waiting.add(slice.id);
        continue;
      }
      const cursor = job.featureCursor;
      job.sliceStats ||= {};
      job.sliceStats[slice.id] = {
        startedAt: cursor.startedAt,
        durationMs: Date.now() - new Date(cursor.startedAt).getTime(),
        repairs: job.attempt - cursor.attemptBefore,
        reviews: cursor.reviews,
        commit: cursor.commit,
        ...(cursor.widened && { widened: cursor.widened }),
      };
      job.sliceDone = [...(job.sliceDone ?? []), slice.id];
      job.sliceIndex = i + 1;
      job.featureCursor = null;
      await this.store.writeState(job);
      await this.emit(job.id, { type: "slice.completed", state: job.state, slice: slice.id, message: `Feature ${i + 1}/${slices.length} verified${pendingNote(pendingChecks(slice, { plan: job.approvedPlan.plan, outstanding: job.outstandingProofs }))}` });
    }
    if (job.setAside?.length) await this.parkSetAside(job, waiting);
    if (!job.finalBudgetSet) {
      job.repairBudgetLimit = job.attempt + this.maxRepairs;
      job.finalBudgetSet = true;
      await this.store.writeState(job);
    }
    return this.finishFromBuild(job, signal, { includeInstall: false });
  }

  // Continue past a blocked feature (PRD stage 4): a feature that ran out of repairs moves its work to a ref and
  // the tree returns to where the feature started, so features that don't depend on it keep building. Declared
  // writes keep that work disjoint from theirs. Only a feature with independent work left behind it is set aside.
  async setAside(job, slice, error, signal) {
    const cursor = job.featureCursor;
    const slices = job.approvedPlan.plan.slices;
    if (signal?.aborted || !["quality_gate_failed", "review_rejected", "review_unstable"].includes(error.code) || !cursor?.base || cursor.restored || !slices.every((item) => item.writes)) return false;
    const waiting = new Set([slice.id, ...(job.setAside ?? []).map((entry) => entry.id)]);
    let independent = false;
    for (const item of slices.slice(slices.indexOf(slice) + 1)) {
      if (item.dependsOn.some((id) => waiting.has(id))) waiting.add(item.id);
      else if (!job.sliceDone?.includes(item.id)) independent = true;
    }
    if (!independent) return false;
    await this.store.commit(`factory: set aside ${slice.id}`);
    const ref = `refs/factory/set-aside/${slice.id}`;
    await this.store.git("update-ref", ref, "HEAD");
    // State first: a crash after the reset still finds the ref to restore from.
    (job.setAside ??= []).push({ id: slice.id, ref, base: cursor.base, cursor, remaining: job.repairBudgetLimit == null ? null : job.repairBudgetLimit - (job.attempt ?? 0), limit: job.repairBudgetLimit, error: { code: error.code, message: error.message, details: error.details } });
    job.featureCursor = null;
    await this.store.writeState(job);
    await this.store.reset(cursor.base);
    await this.emit(job.id, { type: "slice.set_aside", state: job.state, slice: slice.id, message: `Feature ${slice.id} set aside (${error.message}); features that don't depend on it continue` });
    return true;
  }

  // The run parks once, on the first set-aside feature with its work restored over everything built since: the
  // same parked state as a feature that blocked the run, so Resume, repair plans and restart work unchanged.
  // Only the feature's declared writes come back: the set-aside commit took the whole tree, including files the
  // writes gate rejected, which a later feature may own. Its repairs left come back on top of the shared attempt
  // counter, which the features built meanwhile advanced.
  // ponytail: always-writable files (README, package-lock.json) take the set-aside feature's version.
  async parkSetAside(job, waiting) {
    const [entry, ...rest] = job.setAside;
    const slices = job.approvedPlan.plan.slices;
    const writes = [...slices.find((item) => item.id === entry.id).writes, ...(entry.cursor?.widened ?? [])];
    const changes = (await this.store.git("diff", "--name-status", "-z", "--no-renames", entry.base, entry.ref, "--", ".", ":(exclude).factory/review-request.json", ":(exclude).factory/review-result.json")).split("\0").filter(Boolean);
    for (let n = 0; n < changes.length; n += 2) {
      if (outsideWrites([changes[n + 1]], writes).length) continue;
      if (changes[n] === "D") await rm(path.join(this.store.appDir(job.id), changes[n + 1]), { force: true });
      else await this.store.git("checkout", entry.ref, "--", changes[n + 1]);
    }
    await this.store.git("reset", "-q");
    // An entry saved by an older release has only its ceiling.
    const limit = entry.remaining == null ? entry.limit : (job.attempt ?? 0) + entry.remaining;
    Object.assign(job, { setAside: rest, featureCursor: { ...entry.cursor, restored: true }, sliceIndex: slices.findIndex((item) => item.id === entry.id), repairBudgetLimit: limit });
    await this.store.writeState(job);
    const blocked = [...waiting].filter((id) => id !== entry.id);
    throw new FactoryError(entry.error.code, `${entry.error.message} Features that don't depend on ${entry.id} were built; still waiting: ${blocked.join(", ")}.`, entry.error.details);
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
    const repairReview = async (failure) => {
      // A spent gate budget must still leave one repair allowance for the review's findings.
      if (failure.code === "review_rejected" && !cursor.reviewRepairsGranted && job.attempt >= (job.repairBudgetLimit ?? this.maxRepairs)) {
        cursor.reviewRepairsGranted = true;
        job.repairBudgetLimit = Math.min(job.attempt + this.maxRepairs, scope.totalRepairLimit ?? Infinity);
        await this.store.writeState(job);
      }
      return this.repair(job, failure, signal, slice);
    };
    const candidate = () => sourceBaseline(this.store, { head: false });
    // Proof pending integration runs before the final review; the checks it proves stay unverified until then.
    const pending = pendingChecks(slice, { plan, outstanding: job.outstandingProofs });
    const owned = checks.filter((check) => slice.closes.includes(check.id) && !pending.includes(check.id));
    const runnable = slice.acceptance.filter((item) => !item.proof?.pending);
    const reviewChecks = [...owned, ...runnable.map(obligationCheck)];
    // Oversized features are read from this file instead of the prompt; .factory/logs is gitignored, so no write-scope check sees it.
    await mkdir(path.join(appDir, ".factory/logs"), { recursive: true });
    await writeFile(path.join(appDir, ".factory/logs/feature.json"), JSON.stringify(slice, null, 2));
    for (;;) {
      // A batched repair plan only builds here; its checks run once over the whole batch.
      if (scope.buildOnly && cursor.substage !== "implementing") return job;
      // Parked by a Pause after a blocking review: repair the recorded blockers, not another review turn.
      if (cursor.substage === "repairing") {
        // A repair interrupted after resume already spent its attempt on these blockers: check and review again.
        if (!cursor.reviewFailure) { await save("checking"); continue; }
        const { code, message, details } = cursor.reviewFailure;
        delete cursor.reviewFailure;
        job = await repairReview(new FactoryError(code, message, details));
        await save("checking");
        continue;
      }
      if (cursor.substage === "implementing") {
        // Repair features often target behavior that already partly exists: run their checks before
        // building. A pass goes straight to the scoped review; a failure tells the builder what failed.
        // Never through repair(): checking first spends no repair budget and feeds no loop detector.
        if (scope.probe && !cursor.implementStarted && !cursor.prechecked && runnable.length && runnable.every((item) => item.proof)) {
          job = await this.stage(job, "verifying", `Checking feature ${position} before building — ${slice.title}`);
          const failure = await this.verify(job, await this.readManifest(appDir), signal, { includeInstall: true, proofs: runnable });
          // A timed-out check proved nothing for the builder; resume reruns this precheck.
          if (failure?.code === "gate_timeout") throw failure;
          cursor.prechecked = true;
          if (!failure) {
            cursor.preVerified = true;
            cursor.candidate = await candidate();
            await this.emit(job.id, { type: "feature.preverified", state: job.state, slice: slice.id, message: `Feature ${slice.id} already passes its checks; skipping its build turn for review` });
            await save("reviewing");
            continue;
          }
          cursor.precheck = await this.writePrecheck(job, slice, failure);
          await this.store.writeState(job);
        }
        job = await this.stage(job, "building", `Feature ${position} — ${slice.title}`);
        const resumed = cursor.implementStarted;
        cursor.implementStarted = true;
        await this.store.writeState(job);
        const label = resumed ? labels.resume : labels.build;
        // The last feature writes the README; left to the final reviewer it is a source change that forces the post-review gate rerun.
        const [index, total] = position.split("/");
        const prompt = featureBuildPrompt(slice, { owned, planDigest, planFile, followOn: job.followOn, resumed, precheck: cursor.precheck, last: index === total });
        const before = await candidate();
        try {
          await this.invoke(job, label, prompt, signal, { resumeSessionId: this.resumeSessionFor(job, label) });
        } catch (error) {
          // A build that hit the safety cap while still changing files is too big for one turn, not stuck:
          // continue it once in its own session (the stage's one continuation allowance) instead of parking.
          if (error.code !== "agent_hard_timeout" || await candidate() === before || !await this.allowContinuation(job, labels.build)) throw error;
          await this.invoke(job, labels.resume, featureBuildPrompt(slice, { owned, planDigest, planFile, followOn: job.followOn, resumed: true, precheck: cursor.precheck, last: index === total }), signal, { resumeSessionId: error.details?.sessionId ?? this.resumeSessionFor(job, labels.resume) });
        }
        await save("checking");
        if (scope.buildOnly) return job;
      }
      if (cursor.substage === "checking") {
        // Feature-scoped: build, this feature's proofs and the proofs of earlier features its changes can reach,
        // installing only when its dependencies changed. The whole suite first runs at final integration.
        const reached = scope.cursor ? [] : await this.reachedProofs(job, slice);
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: await depsDigest(appDir) !== job.installedDeps, slice, proofs: [...runnable.filter((item) => item.proof), ...reached] });
        cursor.candidate = await candidate();
        await save("reviewing");
      }
      if (cursor.substage === "reviewing") {
        job = await this.stage(job, "reviewing", `Reviewing feature ${position} — ${slice.title}`);
        if (await candidate() !== cursor.candidate) { await save("checking"); continue; }
        await assertCurrent();
        const reviewLimit = this.maxRepairs + 2 + (cursor.reviewRepairsGranted ? this.maxRepairs : 0);
        if (cursor.reviews >= reviewLimit) throw new FactoryError("review_unstable", `Feature ${slice.id} did not reach a stable reviewed candidate after ${cursor.reviews} reviews.`);
        cursor.reviews += 1;
        const caseIds = runnable.flatMap((item) => (item.cases ?? []).map((entry) => entry.id));
        const request = await prepareReview(appDir, job, { checks: reviewChecks, candidate: cursor.candidate, caseResults: caseIds.length ? Object.fromEntries(caseIds.map((id) => [id, job.caseResults?.[id] ?? { status: "missing" }])) : undefined });
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
          // A pre-verified feature's builder never ran: the reviewer's blockers are its first build, not a repair.
          if (cursor.preVerified && !cursor.implementStarted) {
            cursor.precheck = await this.writePrecheck(job, slice, failure);
            await save("implementing");
            continue;
          }
          if (this.active?.pauseRequested) {
            this.active.pauseRequested = false;
            cursor.reviewFailure = { code: failure.code, message: failure.message, details: failure.details };
            await save("repairing");
            throw new FactoryError("paused", "Paused before repairing", { before: "reviewing" });
          }
          job = await repairReview(failure);
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

  async writePrecheck(job, slice, failure) {
    const relative = `.factory/precheck-${slice.id}.txt`;
    await writeFile(path.join(this.store.appDir(job.id), relative), failure.details?.output ?? failure.message);
    return relative;
  }

  // A feature's build and resume turns share one session. Exact match: a substring let API resume
  // API-AUTH's session, and a recovery build resume its own reviewer's (`<label>-review-1`).
  resumeSessionFor(job, label) {
    const stageKey = (value) => value.replace(/^build-slice-|^slice-resume-/, "").replace(/-resume$/, "");
    const match = Object.entries(job.agentSessions ?? {}).findLast(([key]) => stageKey(key) === stageKey(label));
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
    // Same outcome as a restart finding the run mid-flight: interrupted, with its stage, cursor and budgets kept.
    const interrupted = signal.aborted && signal.reason === "shutdown";
    const cancelled = signal.aborted && !interrupted;
    job.failedState = inferFailedState(job);
    const previous = job.stageHistory.at(-1);
    if (previous && !previous.endedAt) previous.endedAt = new Date().toISOString();
    job.state = interrupted ? "interrupted" : cancelled ? "cancelled" : "failed";
    job.stage = interrupted ? "Interrupted by shutdown" : cancelled ? "Cancelled" : "Run paused — action needed";
    job.error = interrupted ? { code: "process_restarted", message: "The factory stopped during this run. Its files are preserved and can be resumed.", details: {} } : {
      code: cancelled ? "cancelled" : error.code ?? "unexpected_error",
      message: cancelled ? "The owner cancelled this run." : error.message,
      details: OVERSIZED_PROMPT.has(error.code) ? { ...error.details, build: BUILD_ID } : error.details ?? {},
    };
    job.recovery = buildRecovery(job, this.store.appDir(jobId), undefined, { maxRepairs: this.maxRepairs });
    job.watch = { ...job.watch, observed: { ...this.supervision(jobId), status: "Action needed", monitoring: false } };
    job.watch.incident = incidentRecord(job);
    await this.store.writeState(job);
    await this.emit(job.id, {
      type: interrupted ? "job.interrupted" : cancelled ? "job.cancelled" : "job.failed",
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
    job.recovery = { ...buildRecovery(job, this.store.appDir(job.id)), title: "Paused by the owner", summary: before === "verifying" ? "The tree is committed; its last checks failed. Resume reruns them and repairs from there."
      : job.planBlockers ? "The plan is saved; its plan review blocked. Resume corrects it without reviewing again."
      : job.recoveryPhase?.status === "plan_failed" ? "Repair-plan preparation stopped before its next turn. Prepare the repair plan again to continue."
      : job.featureCursor?.substage === "repairing" || job.reviewFailure ? "The tree is committed; its review blocked. Resume repairs the recorded blockers without reviewing again."
      : `The tree is committed and green. Resume continues from ${before}.` };
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
    if (this.active?.jobId === jobId) this.active.monitor.observe(event);
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
    await this.emit(job.id, { type: "agent.started", state: job.state, stage: label, feature: featureOf(job), promptChars: prompt.length, message: `${this.provider.id} started ${label}` });
    const monitor = this.monitorOf(job);
    let spawned;
    let result;
    try {
      result = await this.provider.run({
        cwd: appDir,
        prompt,
        logPath,
        signal,
        mode: "write",
        resumeSessionId,
        onEvent: (event) => {
          monitor?.activity();
          if (event.type === "agent.backoff") monitor?.recovering();
          return this.emit(job.id, { ...event, state: job.state });
        },
        context: {
          stage: label,
          job,
          proofCommands: planProofCommands(job),
          onActivity: () => monitor?.activity(),
          onSpawn: (child, { hardTimeoutMs } = {}) => { spawned = this.trackWorker(job, child, { kind: "agent", label, hardLimitMs: hardTimeoutMs ?? null }); },
          allowContinuation: () => this.allowContinuation(job, label),
        },
      });
    } catch (error) {
      // A failed turn's session is kept too, so its resume continues that context instead of starting cold.
      if (error.details?.sessionId) {
        (job.agentSessions ||= {})[label] = error.details.sessionId;
        await this.store.writeState(job);
      }
      throw error;
    } finally {
      await this.releaseWorker(job, spawned);
    }
    if (result.sessionId) {
      job.agentSessions ||= {};
      job.agentSessions[label] = result.sessionId;
      await this.store.writeState(job);
    }
    await this.emit(job.id, { type: "agent.completed", state: job.state, stage: label, feature: featureOf(job), usage: result.usage ?? null, message: `${label} worker completed` });
    return result;
  }

  // The one automatic transient continuation per stage invocation, shared by the provider's idle
  // retry and any later process: recorded durably before dispatch, never renewed by Resume or restart.
  // ponytail: a manual resume's `-resume` label shares its stage's allowance; keyed by label text.
  async allowContinuation(job, label) {
    const key = label.replace(/-resume(?:-\d+)?$/, "");
    job.watch ??= {};
    job.watch.continuations ??= {};
    const used = job.watch.continuations[key] ?? 0;
    if (used >= 1) {
      await this.emit(job.id, { type: "watchdog.decision", state: job.state, decision: "continuation_refused", message: `No automatic continuation for ${label}: this stage already used its one allowance.` });
      return false;
    }
    job.watch.continuations[key] = used + 1;
    await this.store.writeState(job);
    await this.emit(job.id, { type: "watchdog.decision", state: job.state, decision: "continuation", message: `Continuing ${label} once in its preserved session (1 of 1 automatic continuations).` });
    return true;
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
    // Without a feature this is the integrated app: every verified feature's proofs rerun once, and
    // every proof pending integration runs here.
    if (!slice) {
      for (const entry of integrationProofs(job)) { entry.status = "pending"; delete entry.candidate; delete entry.verifiedAt; delete entry.proofCandidate; }
      await this.store.writeState(job);
      // Each feature's proofs already passed when it was built (Lou, 2026-10-16); the suite, build and health run once here.
      proofs = [...proofs, ...(job.bugProofs ?? []), ...await this.releaseQaProofs(job), ...integrationProofs(job).map(entry => ({ id: entry.gate.slice("proof-".length), key: entry.key, proof: entry.obligation.proof, cases: entry.obligation.cases }))];
    }
    let current = job;
    let first = null;
    for (;;) {
      current = await this.stage(current, "verifying", "Running deterministic quality gates");
      const failure = (slice?.writes && await this.writesFailure(current, slice)) || await this.verify(current, manifest, signal, { includeInstall, proofs, first, skipTest: Boolean(slice && proofs.length) });
      if (!failure) {
        if (!slice) {
          const candidate = await sourceBaseline(this.store, { head: false });
          if (integrationProofs(current).some(entry => entry.proofCandidate !== candidate)) throw new FactoryError("review_rejected", "Integration gates changed the application source; proof evidence is stale.");
          current.integrationVerified = { candidate, set: integrationSet(current) };
          await this.store.writeState(current);
        }
        const passed = slice ? `slice ${slice.id}` : [...current.stageHistory].reverse().find((s) => !["verifying", "repairing"].includes(s.state))?.state ?? "build";
        await this.commit(current, `factory: ${passed} passed gates`);
        return current;
      }
      if (failure.code === "gate_timeout") throw failure;
      // A pending Pause parks before the repair turn, not after it. Nothing is recorded or spent:
      // resume reruns these checks (no budget) and repairs from a fresh failure.
      if (this.active?.pauseRequested) {
        this.active.pauseRequested = false;
        throw new FactoryError("paused", "Paused before repairing", { before: "verifying" });
      }
      current = await this.repair(current, failure, signal, slice, proofs.filter((proof) => proof.description));
      manifest = await this.readManifest(this.store.appDir(current.id));
      // Reinstall only when the repair touched dependencies or install itself failed.
      includeInstall = failure.details?.gate === "install" || await depsDigest(this.store.appDir(current.id)) !== current.installedDeps;
      // The gate that just failed is the likeliest to fail again, so the next pass learns that first.
      first = failure.details?.command ?? null;
    }
  }

  // Findings from earlier releases stay fixed: every qa/ test in the tree reruns at final integration.
  async releaseQaProofs(job) {
    if (job.planVersion !== 2) return [];
    const known = new Set((job.bugProofs ?? []).map((bug) => bug.proof.command.at(-1)));
    const files = await readdir(path.join(this.store.appDir(job.id), "qa")).catch(() => []);
    return files.filter((file) => /\.test\.[cm]?js$/.test(file) && !known.has(`qa/${file}`))
      .map((file) => ({ id: `QA-${file.replace(/\.test\.[cm]?js$/, "")}`, proof: { command: ["node", "--test", `qa/${file}`] } }));
  }

  // A feature may change only the files it declared; impact selection later trusts these lists. Diffing
  // from the feature's start commit also catches files the agent committed itself. A cursor without a
  // base (saved by an older release) falls back to the uncommitted tree.
  // A plan's file lists can miss a file the feature's checks need (run 2026-10-07-4f2dd1cf: VIEWER-DATES wrote only its
  // test while its fix lived in app.js, so three repairs changed nothing). An edit to an existing source file no unbuilt
  // feature owns widens this feature's writes on its cursor instead of failing; tests, new files and deletions still fail.
  async writesFailure(job, slice) {
    const recovery = job.recoveryPhase?.cursor?.id === slice.id;
    const cursor = recovery ? job.recoveryPhase.cursor : job.featureCursor?.id === slice.id ? job.featureCursor : null;
    const base = cursor?.base;
    const list = async (...args) => (await this.store.git(...args)).split("\0").filter(Boolean);
    const changed = base ? [...new Set([...await list("diff", "--name-only", "-z", base), ...await list("ls-files", "-z", "-o", "--exclude-standard")])]
      : await list("ls-files", "-z", "-m", "-o", "-d", "--exclude-standard");
    const writes = [...slice.writes, ...(cursor?.widened ?? [])];
    let outside = outsideWrites(changed, writes);
    if (outside.length && base) {
      const modified = new Set(await list("diff", "--name-only", "-z", "--diff-filter=M", base));
      const plan = recovery ? job.recoveryPhase.plan : job.approvedPlan?.plan;
      const done = (recovery ? job.recoveryPhase.done : job.sliceDone) ?? [];
      const others = (plan?.slices ?? []).filter((item) => item.id !== slice.id && !done.includes(item.id) && item.writes);
      const widen = outside.filter((file) => modified.has(file) && !TEST_PATH.test(file) && !others.some((item) => writesCover(item.writes, file)));
      if (widen.length) {
        cursor.widened = [...(cursor.widened ?? []), ...widen];
        await this.store.writeState(job);
        await this.emit(job.id, { type: "slice.writes_widened", state: job.state, slice: slice.id, files: widen, message: `Feature ${slice.id} needed ${widen.join(", ")} beyond its declared writes; its writes now include them` });
        outside = outside.filter((file) => !widen.includes(file));
      }
    }
    if (!outside.length) return null;
    const message = `Feature ${slice.id} changed files outside its declared writes: ${outside.join(", ")}.`;
    await this.emit(job.id, { type: "gate.failed", state: job.state, gate: "writes", feature: slice.id, message });
    return new FactoryError("quality_gate_failed", message, { gate: "writes", output: `${message}\nDeclared writes: ${writes.join(", ")}\nAn existing source file outside the writes is allowed when the fix needs it, but not another feature's tests, a new file outside the writes, a deletion, or a file an unbuilt feature owns. Move the change into an allowed file or revert it.` });
  }

  // Merge check: proofs of built features whose files (or whose dependencies' files) this feature changed
  // since the last verified feature. Plans need no cumulative regression proofs to protect earlier work.
  // ponytail: computed once per check; a repair that reaches further is caught at final integration.
  async reachedProofs(job, slice) {
    const done = job.sliceDone ?? [];
    const base = job.sliceStats?.[done.at(-1)]?.commit;
    if (!base || !slice.writes) return [];
    const files = async (...args) => (await this.store.git(...args)).split("\0").filter(Boolean);
    const changed = [...new Set([...await files("diff", "--name-only", "-z", base), ...await files("ls-files", "-z", "-o", "--exclude-standard")])];
    // Widened writes count as owned, so later edits to those files rerun this feature's proofs.
    const slices = job.approvedPlan.plan.slices.map((item) => job.sliceStats?.[item.id]?.widened && item.writes ? { ...item, writes: [...item.writes, ...job.sliceStats[item.id].widened] } : item);
    const ids = impactedFeatures(slices, done, changed) ?? [];
    if (ids.length) await this.emit(job.id, { type: "slice.impact", state: job.state, slice: slice.id, impacted: ids, message: `Feature ${slice.id} changed files of ${ids.join(", ")}; rerunning their proofs` });
    const built = slices.filter((item) => done.includes(item.id) || item.id === slice.id);
    return proofsOf(built.filter((item) => ids.includes(item.id)), built);
  }

  // Release QA: a finding with a failing test is a bug item of the latest feature whose writes cover its files,
  // repaired under that feature's writes gate, so the committed finding test cannot be edited away. Findings no
  // feature owns, or whose tests already pass, get the unscoped repair. Bug items share the final-stage budget.
  async repairFindings(job, failure, signal) {
    const slices = job.planVersion === 2 ? job.approvedPlan?.plan?.slices ?? [] : [];
    const owned = new Map();
    // Every finding's test stays a proof for the rest of the run, so final integration reruns fixed bugs.
    job.bugProofs ??= [];
    for (const bug of failure.details?.bugs ?? []) {
      const proof = { id: `BUG-${job.bugProofs.length + 1}`, proof: { command: ["node", "--test", bug.test] }, description: bug.description };
      job.bugProofs.push(proof);
      const owner = slices.findLast((slice) => slice.writes && bug.files.some((file) => writesCover(slice.writes, file)));
      if (owner) (owned.get(owner) ?? owned.set(owner, []).get(owner)).push(proof);
    }
    await this.store.writeState(job);
    if (!owned.size) return this.repair(job, failure, signal);
    const attempt = job.attempt;
    await this.commit(job, "factory: release QA findings recorded");
    const manifest = await this.readManifest(this.store.appDir(job.id));
    for (const [owner, proofs] of owned) {
      for (const bug of proofs) await this.emit(job.id, { type: "review.bug", state: job.state, feature: owner.id, bug: bug.id, message: `${bug.id} assigned to ${owner.id}: ${bug.description}` });
      job = await this.verifyWithRepairs(job, manifest, signal, { includeInstall: false, slice: owner, proofs });
    }
    return job.attempt === attempt ? this.repair(job, failure, signal) : job;
  }

  // One repair turn against a recorded failure. Throws the failure itself once the budget is spent.
  async repair(job, failure, signal, slice = null, bugs = []) {
    await this.recordAttempt(job, failure, slice);
    const loop = repeatedFailure(job.watch.attempts.filter((item) => item.scope === job.watch.attempts.at(-1).scope), this.watch.loopThreshold);
    if (loop) {
      await this.emit(job.id, { type: "watchdog.decision", state: job.state, decision: "loop", message: `Stopped repeated work: ${failure.details?.gate ?? failure.code} failed the same way ${loop.count} times on unchanged code.` });
      throw new FactoryError(failure.code ?? "quality_gate_failed", `${failure.message} The same failure repeated ${loop.count} times on unchanged code, so no further repair turn runs.`, { ...failure.details, loop });
    }
    if (job.attempt >= (job.repairBudgetLimit ?? this.maxRepairs)) throw failure;
    job.attempt += 1;
    await this.store.writeState(job);
    const failureRelative = `.factory/last-failure-${job.attempt}.txt`;
    await writeFile(path.join(this.store.appDir(job.id), failureRelative), failure.details?.output ?? failure.message);
    // ponytail: a big slice is read from this file (same one the build prompt uses) so the repair prompt stays under the cap.
    if (slice) await writeFile(path.join(this.store.appDir(job.id), ".factory/logs/feature.json"), JSON.stringify(slice, null, 2));
    job = await this.stage(job, "repairing", `Repairing failed ${failure.details?.gate ?? "unknown"} gate`);
    const label = `repair-${job.attempt}`;
    const before = await sourceBaseline(this.store, { head: false });
    try {
      await this.invoke(job, label, repairPrompt(failureRelative, slice, bugs), signal);
    } catch (error) {
      // Same rule as a capped build: a repair still changing files at the cap is too big for one turn, not stuck.
      // VISUAL-EVIDENCE, 2026-10-15: two 45-minute repairs each made ~50 edits, then a cold restart burned a repair.
      if (error.code !== "agent_hard_timeout" || await sourceBaseline(this.store, { head: false }) === before || !await this.allowContinuation(job, label)) throw error;
      await this.invoke(job, `${label}-resume`, repairPrompt(failureRelative, slice, bugs), signal, { resumeSessionId: error.details?.sessionId ?? null });
    }
    return job;
  }

  // A completed failed attempt, recorded before any repair is dispatched. Never cleared by
  // Resume, retry or restart, so a new invocation cannot evade a detected loop.
  async recordAttempt(job, failure, slice) {
    let candidate = null;
    try { candidate = await sourceBaseline(this.store, { head: false }); } catch {}
    const scope = `${slice?.id ?? job.recoveryPhase?.cursor?.id ?? job.featureCursor?.id ?? "app"}:${failure.details?.gate ?? failure.code}`;
    job.watch ??= {};
    job.watch.attempts = [...(job.watch.attempts ?? []), { ...failureSignature(failure, { scope, candidate }), log: failure.details?.gate ? gateLog(job, failure.details.gate) : null, at: new Date().toISOString() }].slice(-30);
    await this.store.writeState(job);
  }

  async verify(job, manifest, signal, { includeInstall, proofs = [], first = null, skipTest = false }) {
    // skipTest: a feature's own proofs are its acceptance; the whole suite runs at integration. A proof that
    // is the test command itself keeps the test gate, so its gate name and repair routing are unchanged.
    if (proofs.some((item) => JSON.stringify(item.proof.command) === JSON.stringify(manifest.commands.test))) skipTest = false;
    const gates =["install", "test", "build"].filter((gate) => (gate !== "install" || includeInstall) && (gate !== "test" || !skipTest)).map((gate) => [gate, manifest.commands[gate]]);
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
        if (item.cases) (gate[3] ??= []).push(...item.cases.map((entry) => ({ id: entry.id, requirement: item.id })));
      }
    }
    // Install stays ahead of it: every other gate needs the dependencies.
    const at = first ? gates.findIndex(([gate, command]) => gate !== "install" && JSON.stringify(command) === JSON.stringify(first)) : -1;
    if (at > 0) gates.splice(includeInstall ? 1 : 0, 0, ...gates.splice(at, 1));
    const integrated = proofs.some(item => item.key);
    let candidate = null;
    for (const [gate, command, proofKeys = [], cases = []] of gates) {
      // Install may create a lockfile before tests run. Bind evidence to the source tested,
      // including install itself only when it is also an integration proof.
      if (candidate === null && (gate !== "install" || proofKeys.length)) {
        candidate = await sourceBaseline(this.store, { head: false });
        if (integrated) for (const entry of integrationProofs(job)) entry.proofCandidate = candidate;
      }
      const feature = featureOf(job);
      const started = Date.now();
      job.activeCommand = { gate, command, startedAt: new Date().toISOString() };
      await this.store.writeState(job);
      await this.emit(job.id, { type: "gate.started", state: job.state, gate, command, feature, candidate, message: `${gate}: ${command.join(" ")}` });
      const gateMs = this.watch.gateMs ?? 5 * 60_000;
      const timeoutMs = gate === "install" ? Math.max(10 * 60_000, gateMs) : gateMs;
      // ponytail: node:test only; a proof that sets its own --test-reporter fails loudly on the mismatch.
      const events = cases.length ? path.join(this.store.jobDir(job.id), `cases-${gate}-${job.attempt ?? 0}.jsonl`) : null;
      if (events) await rm(events, { force: true });
      // An inherited NODE_TEST_CONTEXT makes node --test skip its files and report nothing, so cased gates drop it.
      const env = events ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--test-reporter="${CASE_REPORTER}" --test-reporter-destination=/dev/null --test-reporter=spec --test-reporter-destination=stdout`].filter(Boolean).join(" "), SOLOFACTORY_CASE_EVENTS: events, NODE_TEST_CONTEXT: undefined } : {};
      let spawned;
      let result;
      try {
        result = await this.commandRunner({
          executable: command[0],
          args: command.slice(1),
          cwd: this.store.appDir(job.id),
          logPath: path.join(this.store.appDir(job.id), gateLog(job, gate)),
          gate,
          env,
          timeoutMs,
          signal,
          // A command inside its own deadline is waiting, not stalled; the progress window never stops it.
          onSpawn: (child) => { spawned = this.trackWorker(job, child, { kind: "command", label: gate, gate, command, hardLimitMs: timeoutMs }); },
        });
      } finally {
        await this.releaseWorker(job, spawned);
      }
      const durationMs = Date.now() - started;
      let caseFailure = null;
      let caseOutput = null;
      if (events) {
        const results = caseResults(cases, await readFile(events, "utf8").catch(() => ""));
        job.caseResults = { ...job.caseResults, ...Object.fromEntries(Object.entries(results).map(([id, value]) => [id, { ...value, gate, at: new Date().toISOString() }])) };
        await this.store.writeState(job);
        const failed = Object.entries(results).filter(([, value]) => value.status !== "passed");
        if (failed.length === cases.length && failed.every(([, value]) => value.status === "missing")) caseFailure = `${gate} recorded no test events for its cases; cased proofs must run under node:test without their own --test-reporter.`;
        else if (failed.length) caseFailure = `${gate} cases did not pass: ${failed.map(([id, value]) => `${id} ${value.status}`).join(", ")}.`;
        if (failed.length) {
          const names = (status) => failed.filter(([, value]) => value.status === status).map(([id]) => `[${id}]`).join(", ");
          const missing = names("missing");
          caseOutput = [
            missing ? `Gate ${gate}: expected passing test(s) named ${missing} but none ran (no matching case events; check the test-name pattern and node:test reporter).` : `Gate ${gate}: expected cases did not pass.`,
            `Failed cases: ${names("failed") || "none"}.`,
            `Never ran: ${missing || "none"}.`,
            ...(names("skipped") ? [`Skipped/todo cases: ${names("skipped")}.`] : []),
          ].join("\n");
        }
        result = { ...result, caseResults: results };
      }
      if (result.timedOut) {
        // A killed command proved nothing about the app, so it is not handed to a repair turn.
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate, feature, durationMs, message: `${gate} timed out` });
        return new FactoryError("gate_timeout", `${gate} did not finish within its ${timeoutMs / 60_000}-minute limit, so no repair turn ran: a timeout is not a failed check. If the checks are only slow, restart SoloFactory with SOLOFACTORY_GATE_MINUTES set higher (at most 60), then Resume. If they hang, the app needs fixing.`, {
          gate, command, durationMs, proofKeys, timeoutMs, timeoutReason: result.timeoutReason, output: result.output,
        });
      }
      if (result.code !== 0 || caseFailure) {
        await this.emit(job.id, { type: "gate.failed", state: job.state, gate, feature, durationMs, cases: caseCounts(result.caseResults), message: `${gate} failed` });
        return new FactoryError("quality_gate_failed", result.code !== 0 ? `${gate} failed with exit ${result.code}.${caseFailure ? ` ${caseFailure}` : ""}` : caseFailure, {
          gate,
          command,
          durationMs,
          proofKeys,
          ...(result.caseResults ? { cases: result.caseResults } : {}),
          output: caseOutput ? `${caseOutput}\n\n${result.output ?? ""}` : result.output,
        });
      }
      await this.emit(job.id, { type: "gate.passed", state: job.state, gate, feature, durationMs, cases: caseCounts(result.caseResults), message: `${gate} passed` });
      // After install, since install may write the lockfile.
      if (gate === "install") job.installedDeps = await depsDigest(this.store.appDir(job.id));
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
    // Health answered, so a failing metrics route is the app's bug: give it the same repair as a bad schema.
    const metrics = await fetchJson(`${url}${manifest.metricsPath}`).catch((error) => {
      throw new FactoryError("invalid_metrics", `The app metrics endpoint failed: ${error.message}.`, { missing: [], received: undefined });
    });
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
      stages: stageUsage(job.stageHistory, allEvents),
    };
    const measurement = measureRun(allEvents);
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
      measurement,
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
      codex: this.provider.id === "codex" ? { model: process.env.SOLOFACTORY_CODEX_MODEL || "gpt-6.1-sol", effort: process.env.SOLOFACTORY_CODEX_REASONING_EFFORT || "medium" } : undefined,
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

// A rejected review, failed gate or failed integration proof with no repair attempts left: another Resume would only rerun it.
export function repairsExhausted(job, maxRepairs = 2) {
  return (["review_rejected", "quality_gate_failed"].includes(job.error?.code) || Boolean(pendingProofFailure(job))) && (job.attempt ?? 0) >= (job.repairBudgetLimit ?? maxRepairs);
}

// Stopped because approved inputs changed: Resume would stop again; only a new plan can continue.
export function inputsChanged(job) {
  return job.error?.code === "inputs_changed";
}

// Formatting-insensitive plan identity; null when unparseable (a malformed plan already costs no review).
async function planFileDigest(appDir) {
  try { return digest(JSON.parse(await readFile(path.join(appDir, ".factory/slices.json"), "utf8"))); } catch { return null; }
}

// The initial feature plan (not a recovery phase) is still blocked after its automatic corrections.
function initialPlanBlocked(job, maxRepairs) {
  return job.planVersion === 2 && !job.approvedPlan && !job.recoveryPhase && job.error?.code === "plan_blocked" && (job.planCorrections ?? 0) >= maxRepairs;
}

// Shared by the controller and the HTTP route so a refusal reaches the owner before anything is queued.
export async function assertPlanReviewable(store, job, maxRepairs) {
  if (initialPlanBlocked(job, maxRepairs) && job.planBlockedDigests?.includes(await planFileDigest(store.appDir(job.id))) && !await initialInputsRevised(store, job)) {
    throw new FactoryError("plan_unchanged", "Automatic plan corrections are exhausted and .factory/slices.json is a plan the reviewer already blocked. Correct the plan, then Resume for one independent review.");
  }
}

async function initialInputsRevised(store, job) {
  return Boolean(job.planBaseline?.inputs) && digest(await sourceSet(store.appDir(job.id), runInputs(job))) !== job.planBaseline.inputs;
}

// A repair plan still blocked after its corrections: retrying the same inputs cannot pass review.
// The message match recognizes runs saved before the plan_blocked code.
export function planBlockedOut(job) {
  return job.recoveryPhase?.status === "plan_failed" && (job.error?.code === "plan_blocked" || /plan is still blocked after \d+ corrections/.test(job.error?.message ?? ""));
}

// An interrupted amendment review that the current inputs still match: its continuation is a review, not a plan.
async function amendmentResumable(store, job) {
  const phase = job.recoveryPhase;
  if (!phase?.amendment || !["planning", "plan_failed"].includes(phase.status) || planBlockedOut(job)) return false;
  return digest(await sourceSet(store.appDir(), runInputs(job))) === phase.request.sourcesDigest;
}

// Refuses a futile repair-plan preparation before any turn runs: the current inputs' fingerprint already
// exhausted its corrections in the budget ledger (the latest plan, or earlier inputs switched back to).
export async function assertPlanInputsRevised(store, job) {
  const exhausted = exhaustedPreparations(job);
  // ponytail: runs saved before the `blocked` flag are recognized only for their latest preparation.
  if (planBlockedOut(job) && !exhausted.includes(job.recoveryPhase)) exhausted.push(job.recoveryPhase);
  if (!exhausted.length || await amendmentResumable(store, job)) return;
  const now = digest(await sourceSet(store.appDir(), runInputs(job)));
  const phase = exhausted.find((item) => item.request?.sourcesDigest === now);
  if (!phase) return;
  const blockers = phase.planBlockers ?? [];
  const policy = continuationAction(job);
  const next = policy.action === "amend-plan" ? policy : { action: "revise-inputs", label: "Revise inputs and prepare a new plan", endpoint: `/api/jobs/${job.id}/recovery-plan`, reason: "Approve the ready plan, or change the specs or prototype only if the inputs themselves are wrong." };
  throw new FactoryError("plan_inputs_unchanged", `These inputs have exhausted their plan corrections. ${next.reason}${blockers.length ? ` Plan review blockers: ${blockers.join("; ")}.` : ""} Next: ${next.label} (POST ${next.endpoint}).`, { nextAction: next, blockers });
}

// Preflight for a submitted corrected plan, run by the HTTP route and again under writer ownership. It reads only:
// every refusal precedes any state write, archive or provider turn. status: 400 malformed, 409 stale or duplicate.
export const MAX_AMENDED_PLAN_BYTES = 4_000_000;
export async function assertPlanAmendable(store, job, { phaseId, plan } = {}, { maxRepairs = 2, busy = false } = {}) {
  const refuse = (code, message, status) => new FactoryError(code, message, { status });
  const next = continuationAction(job, { maxRepairs, busy });
  if (![next, ...(next.alternatives ?? [])].some((item) => item.action === "amend-plan")) throw refuse("amendment_not_allowed", `A corrected plan cannot be reviewed now. ${next.reason}`, 409);
  const prior = job.recoveryPhase;
  if (phaseId !== prior.id) throw refuse("amendment_stale", "The plan was prepared for a different recovery phase than the one now waiting. Download the current help packet and correct that plan.", 409);
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.version !== 2) throw refuse("amendment_invalid", "The corrected plan must be a version 2 repair plan (a JSON object).", 400);
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_AMENDED_PLAN_BYTES) throw refuse("amendment_too_large", `The corrected plan exceeds ${MAX_AMENDED_PLAN_BYTES} bytes.`, 413);
  let valid;
  try { valid = validateRecoveryPlan(plan, prior.request, { fresh: true }); }
  catch (error) { throw refuse("amendment_invalid", `The corrected plan is not valid for this request: ${error.message}`, 400); }
  // Replacing a reviewed plan must map every obligation it held; a blocked plan's obligations were never accepted.
  const base = consolidationBase(job, prior);
  if (base) {
    try { assertConsolidation(valid, base); }
    catch (error) { throw refuse("amendment_unmapped", error.message, 400); }
  }
  try { await assertPlanningCurrent(store, job, prior, "The corrected plan"); }
  catch (error) { throw refuse("amendment_inputs_changed", `${error.message} Prepare a new plan against the current inputs instead.`, 409); }
  if ((await reviewedPlanKeys(store.appDir(), job, prior.request.sourcesDigest)).has(planKey(valid))) throw refuse("amendment_duplicate", "This plan, ignoring formatting and its request id, was already reviewed for these inputs. Submit a corrected plan that differs in content.", 409);
}

// The one continuation policy: the controller, the HTTP API and the dashboard all ask this which
// action may continue a parked run, so a banner can never offer an action the controller refuses.
// `busy`: a worker already holds or has queued this run.
// approve-plan: a ready plan may be revised with feedback before it is approved.
const PLANNING_ACTIONS = new Set(["prepare-plan", "revise-inputs", "retry-plan", "approve-plan"]);
export const admitsPlanning = (next) => PLANNING_ACTIONS.has(next.action) || Boolean(next.alternatives?.some((item) => PLANNING_ACTIONS.has(item.action)));

export function continuationAction(job, { maxRepairs = 2, busy = false } = {}) {
  const next = (action, label, endpoint, reason) => ({ action, label, endpoint: endpoint && `/api/jobs/${job.id}/${endpoint}`, reason });
  const phase = job.recoveryPhase?.status;
  if (job.dismissed || !PARKED_STATES.has(job.state)) return next("none", null, null, "Only an unresolved parked run can continue.");
  if (busy) return next("none", null, null, "A worker is already running or queued for this run; wait for it to park.");
  if (job.state === "cancelled") return next("none", null, null, "The owner cancelled this run; start over to build it again.");
  // Restart reconciliation: never a second writer while the old worker may still write.
  if (job.error?.code === "worker_unconfirmed" && workerAlive(job.error.details?.pid)) return next("stop-worker", `Stop worker ${job.error.details.pid}`, null, `A ${job.error.details.kind ?? "worker"} from before the restart (pid ${job.error.details.pid}, ${job.error.details.label}) is still running and may write to the workspace. Stop that process; Resume becomes available once it has exited.`);
  if (OVERSIZED_PROMPT.has(job.error?.code) && job.error.details?.build === BUILD_ID) return next("factory-fix", null, null, "SoloFactory built a prompt over its size limit. This factory build would build the same prompt again, so retrying cannot help. Install a SoloFactory fix; the retry returns once a different build is running.");
  if (planBlockedOut(job)) return { ...next("amend-plan", "Submit corrected plan for review", "recovery-review", "Automatic plan corrections are exhausted. The plan still has review blockers. Correct the plan and submit it for review. Change the requirements only if the inputs themselves are wrong."),
    alternatives: [next("revise-inputs", "Revise inputs and prepare a new plan", "recovery-plan", "Use this only if the specs or prototype inputs themselves are wrong or ambiguous; it prepares a new plan with a fresh correction budget.")] };
  if (job.recoveryPhase?.amendment && (phase === "planning" || phase === "plan_failed")) return next("retry-plan", "Resume plan review", "recovery-plan", "The review of the submitted corrected plan stopped before it finished. Resume plan review: it only reviews that plan again; it does not start the planner or renew plan corrections.");
  if (phase === "planning" || phase === "plan_failed") return next("retry-plan", "Retry repair-plan preparation", "recovery-plan", `${phase === "planning" ? "Repair-plan preparation stopped before it finished" : "Repair-plan preparation failed"}, so no plan is approved. Retry repair-plan preparation; Resume cannot continue an unapproved plan.`);
  if (phase === "ready") return { ...next("approve-plan", "Approve and continue repairs", "recovery-start", "The repair plan passed independent review, but a Pause stopped it before repairs started. Approve and continue repairs to start it; Resume does not start an unapproved plan."),
    alternatives: [next("amend-plan", "Submit corrected plan for review", "recovery-review", "Replaces the ready plan with your corrected plan. The ready plan stays in history as evidence but can no longer be approved. The replacement gets one independent review and no automatic corrections; if it passes, repairs start on their own.")] };
  if (repairsExhausted(job, maxRepairs)) return next("prepare-plan", "Prepare repair plan", "recovery-plan", "The repair budget is exhausted. Prepare a repair plan; once it passes independent review, repairs start on their own. Resume does not renew the budget or rerun the same review.");
  // Resume would hit the same review cap; only a repair plan can move this feature.
  if (job.error?.code === "review_unstable") return next("prepare-plan", "Prepare repair plan", "recovery-plan", "The feature did not reach a stable reviewed candidate within its review limit. Prepare a repair plan; once it passes independent review, repairs start on their own. Resume would stop at the same limit.");
  if (job.error?.details?.loop) return job.error.code === "review_rejected" || pendingProofFailure(job)
    ? next("prepare-plan", "Prepare repair plan", "recovery-plan", "The same failure repeated on unchanged code, so repeating repairs cannot help. Prepare a repair plan; once it passes independent review, repairs start on their own. Resume does not renew the budget.")
    : next("resume", job.state === "paused" ? "Resume" : "Resume current run", "resume", "The same failure repeated on unchanged code. Change the code or inputs first: Resume reruns the checks, and no repair turn runs while the code is unchanged.");
  if (initialPlanBlocked(job, maxRepairs)) return next("resume", "Resume plan review", "resume", "Automatic plan corrections are exhausted. Correct .factory/slices.json, then Resume for one independent review; a plan the reviewer already blocked is refused. If the supplied specs themselves are wrong or incomplete, revise them or add a spec file instead: Resume then reviews against them with a fresh correction budget.");
  if (inputsChanged(job)) return next("prepare-plan", "Prepare repair plan", "recovery-plan", "The specs or prototype inputs changed after the plan was approved. Prepare a repair plan against the current inputs.");
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
  const loop = job.error?.details?.loop;
  const unconfirmed = job.error?.code === "worker_unconfirmed";
  const planBlocked = planBlockedOut(job);
  const title = unconfirmed ? "A worker from before the restart may still be running" : planBlocked ? "The repair plan needs a correction" : loop ? "Repeated failure on unchanged code" : stale ? "Specs or prototype inputs changed" : exhausted ? "Repair budget exhausted" : reviewBlocked ? "Required functionality or evidence is unfinished" : primary?.title
    ?? (timeoutReason === "idle" ? "The coding agent became inactive" : timeoutReason === "hard" ? "The run reached its safety cap" : "The run paused before completion");
  const actions = diagnostics.map((item) => item.action);
  if (!actions.length) {
    if (unconfirmed) {
      actions.push(`Stop process ${job.error.details.pid} (${job.error.details.label}) or wait for it to exit; the factory will not start a second worker beside it.`);
      actions.push("Once it has exited, Resume continues this run from its preserved files.");
    } else if (planBlocked) {
      actions.push(`Download the plan help packet: the blocked plan, the request, the reviewer's blockers and the source references. Fix the plan yourself or hand the packet to your coding agent.`);
      actions.push("Submit corrected plan for review: it gets one independent review and, if it passes, repairs start on their own.");
      actions.push("Revise inputs and prepare a new plan only if the specs or prototype themselves are wrong or ambiguous.");
    } else if (initialPlanBlocked(job, maxRepairs)) {
      actions.push(`Read the reviewer's blockers; automatic plan corrections are exhausted (${job.planCorrections} used) and nothing has been built.`);
      actions.push("Correct .factory/slices.json, then Resume plan review: it runs one independent review and does not renew corrections. A plan the reviewer already blocked is refused.");
      actions.push("Revise the supplied specs, or add a spec file, only if the inputs themselves are wrong or incomplete; Resume then reviews the plan against them with a fresh correction budget.");
    } else if (loop) {
      actions.push(`Read the repeated failure in ${loop.logs?.at(-1) ?? "the named log"}; the last repairs did not change the code.`);
      actions.push("Change the code or inputs, or prepare a repair plan; Resume does not renew the repair budget.");
    } else if (stale) {
      actions.push("Prepare repair plan: the factory compares the changed inputs with the approved plan and plans the unfinished work against the current inputs; verified features stay done.");
      actions.push("Once the plan passes independent review, repairs start on their own. Resume would stop again on the same changed inputs.");
    } else if (exhausted) {
      actions.push(pendingProofFailure(job)
        ? "Prepare repair plan: the factory plans features for the requirements the failed integration proof supports, from its obligation, command and output."
        : job.error.code === "quality_gate_failed"
          ? `Prepare repair plan: the factory plans a fix for the failed ${job.error.details?.gate ?? "quality"} gate from its command and output, with the unfinished checks and every spec and prototype input.`
          : "Prepare repair plan: the factory plans features for the unfinished checks from the review findings and every spec and prototype input.");
      actions.push("Once the plan passes independent review, a new bounded repair phase starts on its own; Pause stops it before the next feature.");
      actions.push("Resume does not renew the repair budget; dashboard chat explains or shapes briefs and does not resume a run.");
    } else if (reviewBlocked) {
      actions.push("Read the unfinished checks and reviewer blockers in this packet and .factory/REVIEW.md.");
      actions.push("Implement the missing behavior and run its acceptance checks; preserve the frozen contract and existing data.");
      actions.push("Use Resume on this run's card to continue its preserved files. Dashboard chat explains or shapes briefs; it does not resume a run.");
    } else actions.push("Review the recovery packet and the named log, then resume this run from its preserved files.");
  }
  const attempts = job.error?.details?.autoResumes ?? 0;
  const summary = unconfirmed ? `The factory restarted while ${job.error.details.label} (pid ${job.error.details.pid}) was running. Nothing new starts until that process has exited, so two workers never write at once.`
    : planBlocked ? `Automatic plan corrections are exhausted (${job.recoveryPhase.corrections ?? 0} used) and the independent reviewer still blocks the plan. No repairs have started; the plan, its logs and your files are preserved.`
    : loop ? `${loop.gate ?? "A check"} failed the same way ${loop.count} times without any code change, so the factory stopped repeating it. Files and evidence are preserved.`
    : reviewBlocked ? `The review did not approve the app. ${job.attempt ?? 0} automatic repairs have been used; green tests do not prove the missing features are complete.` : diagnostics.length
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
  const incident = job.watch?.incident ?? (job.error ? incidentRecord(job) : null);
  if (incident) lines.push("", "Incident:", `- Trigger: ${incident.trigger}`, `- Observed: ${incident.observed}`, `- Uncertain: ${incident.uncertain}`, `- Tried: ${incident.tried}`, `- Preserved: ${incident.preserved}`,
    `- Last activity: ${incident.lastActivityAt ?? "unknown"}; last confirmed progress: ${incident.lastProgressAt ? `${incident.lastProgressAt} (${incident.lastProgressType})` : "none recorded"}`,
    ...(incident.fingerprint ? [`- Candidate fingerprint: ${incident.fingerprint}`] : []), ...incident.logs.map((log) => `- Log: ${log}`));
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

// What install consumes. Unchanged since the last passing install means node_modules is still current.
async function depsDigest(appDir) {
  return digest(await Promise.all(["package.json", "package-lock.json", "npm-shrinkwrap.json"].map((file) => readFile(path.join(appDir, file), "utf8").catch(() => null))));
}

// The proof set an integration verify runs; a passing verify only stands for this exact set.
function integrationSet(job) {
  return digest([featureProofs(job).map((item) => [item.id, item.proof.command]), integrationProofs(job).map((entry) => entry.key)]);
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
  const cases = item.cases ? ` (cases, each proved separately by a test named [CASE-ID]: ${item.cases.map((entry) => `${entry.id} ${entry.surface}: ${entry.action}${entry.field ? ` [field ${entry.field}]` : ""}${entry.boundary ? ` [boundary ${entry.boundary}]` : ""} → ${entry.expect}`).join("; ")})` : "";
  return { id: item.id, text: `${item.behavior}${item.sources ? ` (source: ${item.sources.map((ref) => `${ref.path} ${ref.locator}`).join("; ")})` : ""}${item.proof ? ` (proof: ${item.proof.command.join(" ")} → ${item.proof.expect})` : ""}${cases}` };
}

// The feature a turn or gate serves, for per-feature measurement; null while planning or integrating.
const featureOf = (job) => job.recoveryPhase?.cursor?.id ?? job.featureCursor?.id ?? null;
// Per feature: attempts only advance on repairs, so two clean features shared `test-3.log` and the later overwrote the earlier's evidence.
const gateLog = (job, gate) => `.factory/logs/${[gate, featureOf(job), job.attempt].filter((part) => part != null).join("-")}.log`;
// Every proof the controller may gate on, so a builder or repair agent can run it before finishing.
const planProofCommands = (job) => ((job.recoveryPhase?.plan ?? job.approvedPlan?.plan)?.slices ?? [])
  .flatMap((slice) => slice.acceptance ?? []).map((item) => item?.proof?.command).filter(Array.isArray);
const caseCounts = (results) => results ? Object.values(results).reduce((counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {}) : undefined;

function stageKind(label = "unknown") {
  if (/^(build-slice|slice-resume)-/.test(label)) return "slice";
  if (label.startsWith("repair")) return "repair";
  if (/^(plan-review|plan-correction|plan-schema-fix)-\d+$/.test(label)) return label.replace(/-\d+$/, "");
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

// Time and usage per pipeline state, plus the current step alone, so the run screen leads with what is
// happening now. A turn counts toward the stage entry it finished in.
// ponytail: linear scan of stageHistory per turn; index by time if runs reach thousands of stages.
export function stageUsage(history, events, now = Date.now()) {
  const entries = history.map((stage) => ({ state: stage.state, label: stage.label, start: Date.parse(stage.startedAt),
    durationMs: (stage.endedAt ? Date.parse(stage.endedAt) : now) - Date.parse(stage.startedAt), tokens: null }));
  for (const event of events) {
    if (event.type !== "agent.completed" || !event.usage) continue;
    const at = Date.parse(event.at);
    const entry = entries.findLast((item) => item.start <= at);
    if (entry) entry.tokens = addUsage(entry.tokens, event.usage);
  }
  const byState = {};
  for (const { state, durationMs, tokens } of entries) {
    const bucket = byState[state] ??= { durationMs: 0, tokens: null };
    bucket.durationMs += durationMs;
    bucket.tokens = addUsage(bucket.tokens, tokens);
  }
  const last = entries.at(-1);
  return { byState, current: last ? { label: last.label, state: last.state, durationMs: last.durationMs, tokens: last.tokens } : null };
}
