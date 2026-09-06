import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAllowedCommand, runProcess, subscriptionEnvironment } from "./process.mjs";
import { buildPrompt, continuationPrompt, planReviewPrompt, repairPrompt, reviewPrompt, sliceBuildPrompt, sliceContinuationPrompt, specificationPrompt } from "./prompts.mjs";
import { orderSlices, validateSlicePlan } from "./wbs.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class FactoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

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

  async activate(jobId, runner) {
    if (this.active) throw new FactoryError("factory_busy", `Run ${this.active.jobId} is already active.`);
    const controller = new AbortController();
    const promise = runner(controller.signal).finally(() => {
      if (this.active?.jobId === jobId) this.active = null;
    });
    this.active = { jobId, controller, promise };
    return promise;
  }

  async cancel(jobId) {
    if (this.active?.jobId !== jobId) throw new FactoryError("not_active", "That run is not active.");
    this.active.controller.abort();
  }

  async run(jobId, signal) {
    let job = await this.store.read(jobId);
    try {
      job.startedAt ||= new Date().toISOString();
      job.error = null;
      await this.store.writeState(job);
      const appDir = this.store.appDir(jobId);
      const factoryDir = path.join(appDir, ".factory");
      await mkdir(path.join(factoryDir, "logs"), { recursive: true });
      await writeFile(
        path.join(factoryDir, "requirements.json"),
        `${JSON.stringify({ brief: job.brief, transcript: job.transcript }, null, 2)}\n`,
      );

      job = await this.stage(job, "specifying", "Writing PRD, plan, and acceptance contract");
      await this.invoke(job, "specification", specificationPrompt(job.sdlc === "slices"), signal);
      await this.validateSpecification(appDir);

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

      if (failedState === "specifying") {
        job = await this.stage(job, "specifying", "Finishing the interrupted specification");
        await this.invoke(job, "specification-resume", continuationPrompt("specification", job.sdlc === "slices"), signal, { resumeSessionId });
        await this.validateSpecification(appDir);
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
        job = await this.stage(job, "reviewing", "Continuing the contract review");
        await this.invoke(job, "review-resume", continuationPrompt("review"), signal, { resumeSessionId });
        job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
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
    job = await this.stage(job, "reviewing", "Reviewing against the frozen contract");
    await this.invoke(job, "review", reviewPrompt(), signal);
    job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: false });
    return this.deployAndComplete(job, signal);
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
    await this.invoke(job, "plan-review", planReviewPrompt(), signal);
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
  async buildSlices(job, signal, { resumeFrom = null } = {}) {
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
      const resumed = resumeFrom != null && i === from;
      const label = resumed ? `slice-resume-${slice.id}` : `build-slice-${slice.id}`;
      const prompt = resumed ? sliceContinuationPrompt(slice, ordered) : sliceBuildPrompt(slice, ordered);
      await this.invoke(job, label, prompt, signal, { resumeSessionId: this.resumeSessionFor(job, label) });
      job = await this.verifyWithRepairs(job, await this.readManifest(appDir), signal, { includeInstall: i === 0, slice });
      const repairs = job.attempt - attemptBefore;
      job.sliceStats ||= {};
      job.sliceStats[slice.id] = {
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Date.now() - startedAtMs,
        repairs,
        verifyRuns: repairs + 1,
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
    job = await this.stage(job, "deploying", "Launching and checking the application");
    const manifest = await this.readManifest(appDir);
    const deployment = this.deployer
      ? await this.deployer({ job, appDir, manifest, signal, emit: (event) => this.emit(job.id, event) })
      : await this.deployLocal(job, manifest, signal);
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
    job.recovery = buildRecovery(job, this.store.appDir(jobId));
    await this.store.writeState(job);
    await this.emit(job.id, {
      type: cancelled ? "job.cancelled" : "job.failed",
      state: job.state,
      message: job.error.message,
    });
    return job;
  }

  async stage(job, state, label) {
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
    await this.emit(job.id, { type: "agent.completed", state: job.state, message: `${label} worker completed` });
    return result;
  }

  async validateSpecification(appDir) {
    const required = ["PRD.md", "PLAN.md", "ACCEPTANCE.md"];
    for (const name of required) {
      const content = await readFile(path.join(appDir, ".factory", name), "utf8").catch(() => "");
      if (content.trim().length < 300) {
        throw new FactoryError("invalid_specification", `${name} is missing or too thin.`);
      }
    }
    const top = await readdir(appDir, { withFileTypes: true });
    const unexpected = top.filter((entry) => entry.name !== ".factory").map((entry) => entry.name);
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

  async verifyWithRepairs(job, manifest, signal, { includeInstall, slice = null }) {
    let current = job;
    for (;;) {
      current = await this.stage(current, "verifying", "Running deterministic quality gates");
      const failure = await this.verify(current, manifest, signal, { includeInstall });
      if (!failure) return current;
      if (current.attempt >= this.maxRepairs) throw failure;
      current.attempt += 1;
      await this.store.writeState(current);
      const failureRelative = `.factory/last-failure-${current.attempt}.txt`;
      await writeFile(path.join(this.store.appDir(current.id), failureRelative), failure.details.output ?? failure.message);
      current = await this.stage(current, "repairing", `Repairing failed ${failure.details.gate} gate`);
      await this.invoke(current, `repair-${current.attempt}`, repairPrompt(failureRelative, slice), signal);
      manifest = await this.readManifest(this.store.appDir(current.id));
      includeInstall = true;
    }
  }

  async verify(job, manifest, signal, { includeInstall }) {
    const gates = includeInstall ? ["install", "test", "build"] : ["test", "build"];
    for (const gate of gates) {
      const command = manifest.commands[gate];
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
    const logPath = path.join(this.store.appDir(job.id), ".factory", "logs", "deployment.log");
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn(command[0], command.slice(1), {
      cwd: this.store.appDir(job.id),
      env: subscriptionEnvironment({ PORT: String(port), NODE_ENV: "production" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.deployments.set(job.id, child);
    signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.once("exit", async (code) => {
      log.end();
      this.deployments.delete(job.id);
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

  async telemetry(jobId) {
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
    const summary = {
      strategy: job.sdlc ?? "single",
      slicesPlanned: (job.slicePlanIds ?? []).length,
      slicesCompleted: (job.sliceDone ?? []).length,
      agentTurns,
      repairs,
      gateRuns,
      stageCount: job.stageHistory.length,
    };
    let app = null;
    if (job.deployment?.url && job.deployment.status === "live") {
      try {
        const manifest = await this.readManifest(this.store.appDir(jobId));
        app = await fetchJson(`${job.deployment.url}${manifest.metricsPath}`);
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

  async shutdown() {
    for (const child of this.deployments.values()) child.kill("SIGTERM");
    this.deployments.clear();
  }
}

export function inferFailedState(job) {
  if (job.failedState && !TERMINAL.has(job.failedState)) return job.failedState;
  return [...(job.stageHistory ?? [])].reverse().find((stage) => !TERMINAL.has(stage.state))?.state ?? "building";
}

export function buildRecovery(job, workspace, diagnostics = job.error?.details?.diagnostics ?? [], { legacy = false } = {}) {
  const failedState = inferFailedState(job);
  const timeoutReason = job.error?.details?.timeoutReason;
  const primary = diagnostics[0];
  const title = primary?.title
    ?? (timeoutReason === "idle" ? "The coding agent became inactive" : timeoutReason === "hard" ? "The run reached its safety cap" : "The run paused before completion");
  const actions = diagnostics.map((item) => item.action);
  if (!actions.length) {
    actions.push("Review the recovery packet and the named log, then resume this run from its preserved files.");
  }
  const attempts = job.error?.details?.autoResumes ?? 0;
  const summary = diagnostics.length
    ? `${diagnostics.map((item) => item.title).join("; ")}. The partial app and completed specification are intact.`
    : timeoutReason === "idle"
      ? `The agent stopped producing activity. ${attempts ? "Its one bounded same-session retry was used." : "A manual resume can continue without starting over."}`
      : "The factory stopped safely. Its existing files and evidence are intact, so recovery does not require a new run.";
  return {
    version: 2,
    status: job.state === "cancelled" ? "cancelled" : "needs_owner",
    title,
    summary,
    failedState,
    actions,
    workspace,
    logPath: job.error?.details?.logPath ?? null,
    filesPreserved: true,
    canResume: job.state !== "cancelled",
    automaticRetry: legacy
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
    "",
    "Recommended actions:",
    ...recovery.actions.map((action) => `- ${action}`),
  ];
  if (recovery.logPath) lines.push("", `Log: ${recovery.logPath}`);
  lines.push(
    "",
    "Please inspect the preserved workspace and evidence, help resolve any external blocker, and continue from the current state. Do not start over or redo completed work unless the evidence requires it.",
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
  if (
    !value ||
    typeof value.uptimeSeconds !== "number" ||
    typeof value.requests?.total !== "number" ||
    typeof value.requests?.errors !== "number" ||
    typeof value.latencyMs?.average !== "number" ||
    !(Array.isArray(value.routes) || (value.routes && typeof value.routes === "object" && !Array.isArray(value.routes)))
  ) {
    throw new FactoryError("invalid_metrics", "The app metrics endpoint returned an invalid schema.");
  }
  return value;
}
