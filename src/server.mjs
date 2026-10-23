import http from "node:http";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./store.mjs";
import { withReviewDiagnostics } from "./review.mjs";
import { amendmentPacket, assertBatch, validateRecoveryApproval } from "./feature-recovery.mjs";
import { MAX_AMENDED_PLAN_BYTES, assertPlanAmendable, admitsPlanning, assertPlanInputsRevised, assertPlanReviewable, buildRecovery, buildRecoveryPacket, continuationAction, SoloFactory, withContinuation } from "./factory.mjs";
import { watchConfig } from "./watchdog.mjs";
import {
  INTERVIEW_RESPONSE_SCHEMA,
  buildInterviewPrompt,
  makeOpeningTurn,
  validateInterviewResult,
  validateMessages,
} from "./interview.mjs";
import { createProvider, detectProviderDiagnostics, discoverProviders } from "./providers.mjs";
import { createFixtureProvider } from "./fixture-provider.mjs";
import { REPORTABLE_STATES, buildDiagnostics, issuesConfig, renderReport, scrub, validateFeedback } from "./feedback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PARKED = new Set(["failed", "interrupted", "cancelled", "paused"]);
const projectRoot = path.dirname(here);
const publicRoot = path.join(projectRoot, "public");
const manualFile = path.join(projectRoot, "docs", "manual", "index.html");

export async function createSoloFactoryServer(options = {}) {
  const home = options.home ?? process.env.SOLOFACTORY_HOME ?? path.join(projectRoot, ".solofactory");
  // Projects are dirs under root/projects/ or git repos directly under root/. The source checkout keeps them in
  // .solofactory/; the distro points SOLOFACTORY_ROOT at the ambient folder.
  const root = path.resolve(options.root ?? process.env.SOLOFACTORY_ROOT ?? home);
  const activeFile = path.join(home, "active-project");
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  // One JSONL line per operational error, from the server, the browser, and chat agents, for later analysis.
  // ponytail: append-only, no rotation; add a size cap if a real install ever grows it past a few MB.
  const errorLog = path.join(home, "errors.jsonl");
  async function logError(entry) {
    const line = { at: new Date().toISOString(), version };
    for (const [key, value] of Object.entries(entry)) {
      if (value !== undefined && value !== null) line[key] = typeof value === "string" ? scrub(value.slice(0, 2000)).text : value;
    }
    await mkdir(home, { recursive: true }).then(() => appendFile(errorLog, `${JSON.stringify(line)}\n`)).catch(() => {});
  }
  let active; // { id, dir } — the project the owner is viewing; job endpoints default to its store
  let store;
  const stores = new Map();
  const storeFor = (id) => stores.get(id) ?? stores.set(id, new JobStore(path.join(root, id))).get(id);
  async function openProject(id) {
    const next = storeFor(id);
    await next.init();
    // No recoverInterrupted here: another project's run may be live. Restart recovery runs once, at startup.
    for (const job of await next.list()) await ensureRecovery(job, next);
    active = { id, dir: next.project };
    store = next;
    await mkdir(home, { recursive: true });
    await writeFile(activeFile, `${id}\n`);
  }
  // Scheduler (docs/run-queue-spec.md): one active run per project, at most maxActiveRuns overall, FIFO otherwise.
  const maxActiveRuns = Math.max(1, Number(options.maxActiveRuns ?? process.env.SOLOFACTORY_MAX_ACTIVE_RUNS) || 1);
  const runs = new Map(); // projectId -> { jobId, factory, promise }
  const queue = []; // { projectId, jobId, mode: "start" | "resume" | "restart", fromSlice? }
  const jobProject = new Map(); // jobId -> projectId, for jobs the scheduler has touched
  const queuedJobs = [];
  {
    const projects = await discoverProjects(root);
    for (const project of projects) {
      const projectStore = storeFor(project.id);
      await projectStore.recoverInterrupted();
      for (const job of await projectStore.list()) {
        // Seed jobProject from every job on disk, not just queued ones, so a restart doesn't
        // make storeOfJob() fall back to the active project for a job that belongs elsewhere.
        jobProject.set(job.id, project.id);
        if (job.state === "queued") queuedJobs.push({ projectId: project.id, job });
      }
    }
    const remembered = (await readFile(activeFile, "utf8").catch(() => "")).trim();
    await openProject(projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id ?? "projects/default");
  }
  const skill = await readFile(path.join(projectRoot, "skills", "factory-guide.md"), "utf8");
  const fixtureMode = options.fixtureMode ?? process.env.SOLOFACTORY_DEMO === "1";
  // Repair turns per gate budget. Only a smoke test lowers it, to reach an exhausted budget on a real provider.
  const maxRepairs = /^\d+$/.test(process.env.SOLOFACTORY_MAX_REPAIRS ?? "") ? Number(process.env.SOLOFACTORY_MAX_REPAIRS) : 2;
  // Tests that exercise the owner's manual Approve path turn the automatic repair start off.
  const autoStartRepairs = options.autoStartRepairs ?? true;
  watchConfig(); // fails fast on an invalid progress window or loop threshold
  const providerFactory = options.providerFactory ?? ((id) => {
    if (id === "fixture" && fixtureMode) return createFixtureProvider();
    // Runs made with SOLOFACTORY_DEMO=1 persist in the project; outside demo mode they can't run.
    if (id === "fixture") throw new Error("This run was made in demo mode. Start SoloFactory with SOLOFACTORY_DEMO=1 to resume it, or Dismiss it.");
    return createProvider(id);
  });
  const factories = new Map();
  let closing = false;

  // A project's queue waits while its most recently started run is parked and unresolved:
  // the tree may be mid-repair, and the next release must not build on it. A queued resume of that run
  // does not release it: the start would run first, or beside the repair.
  async function blockerFor(projectId) {
    const started = (await storeFor(projectId).list()).filter((job) => job.startedAt);
    const last = started.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return last && PARKED.has(last.state) && !last.dismissed ? last.id : null;
  }

  async function drainOnce() {
    for (let i = 0; i < queue.length && runs.size < maxActiveRuns && !closing; ) {
      const entry = queue[i];
      const blocked = runs.has(entry.projectId) || (entry.mode === "start" && (await blockerFor(entry.projectId)));
      // enqueue may unshift during that await: find this entry again rather than trust the old index.
      i = queue.indexOf(entry);
      if (blocked) { i += 1; continue; }
      queue.splice(i, 1);
      const projectStore = storeFor(entry.projectId);
      await projectStore.init();
      const job = await projectStore.read(entry.jobId);
      const factory = new SoloFactory({ store: projectStore, provider: providerFactory(job.provider), maxRepairs, autoStartRepairs });
      factories.set(job.id, factory);
      const run = { jobId: job.id, factory };
      runs.set(entry.projectId, run);
      const launch = entry.mode === "recovery-plan" ? factory.planRecovery(job.id, entry.guidance, { features: entry.features })
        : entry.mode === "recovery-review" ? factory.amendRecovery(job.id, entry.submission)
        : entry.mode === "recovery-start" ? factory.startRecovery(job.id, entry.planDigest, { features: entry.features })
        : entry.mode === "resume" ? factory.resume(job.id, { features: entry.features }) : entry.mode === "restart" ? factory.restartFromSlice(job.id, entry.fromSlice) : factory.start(job.id);
      run.promise = launch
        .catch((error) => {
          console.error(`run ${job.id}: ${error.message}`);
          return logError({ source: "run", project: entry.projectId, jobId: job.id, code: error.code, message: error.message });
        })
        // A run that fails is settled by the factory, not thrown, so read its final state.
        .then(() => projectStore.read(job.id))
        .then((after) => after.state === "failed" && logError({ source: "run", project: entry.projectId, jobId: job.id, code: after.error?.code, message: after.error?.message, stage: after.failedState }))
        .catch(() => {})
        .finally(() => {
          runs.delete(entry.projectId);
          drain();
        });
    }
  }
  // Serialised so concurrent enqueues and settlements never double-start a project.
  let draining = Promise.resolve();
  const drain = () => (draining = draining.then(drainOnce).catch((error) => {
    console.error(`scheduler: ${error.message}`);
    return logError({ source: "scheduler", code: error.code, message: error.message });
  }));

  // Runs fn on the drainer's chain, so no queued entry launches between fn's checks and its writes.
  const exclusive = (fn) => { const result = draining.then(fn); draining = result.catch(() => {}); return result; };

  function enqueue(projectId, jobId, mode = "start", { front = false, ...extra } = {}) {
    jobProject.set(jobId, projectId);
    queue[front ? "unshift" : "push"]({ projectId, jobId, mode, ...extra });
    return drain();
  }
  for (const { projectId, job } of queuedJobs.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt))) enqueue(projectId, job.id);

  const storeOfJob = (id) => storeFor(jobProject.get(id) ?? active.id);
  // Setting aside or starting over a parked follow-on puts the shipped app back. Runs once per job:
  // the dismissed flag guards it, so a later build is never rewound. Resume keeps the half-built work.
  const rollBack = async (job, jobStore) => {
    if (!PARKED.has(job.state) || job.dismissed || !job.baseCommit) return;
    await jobStore.reset(job.baseCommit);
    await jobStore.appendEvent(job.id, { type: "job.rolled_back", state: job.state, message: `App restored to the release before this run (${job.baseCommit.slice(0, 7)})` });
  };
  const busyJobId = () => runs.get(active.id)?.jobId ?? null;
  const schedulerStatus = () => ({ busyJobId: busyJobId(), maxActiveRuns, activeRuns: [...runs].map(([projectId, run]) => ({ projectId, jobId: run.jobId })) });

  async function annotateJobs(projectId, jobs) {
    const blockedBy = runs.has(projectId) ? null : await blockerFor(projectId);
    return jobs.map((stored) => {
      const position = queue.findIndex((entry) => entry.jobId === stored.id);
      const run = runs.get(projectId);
      const live = run?.jobId === stored.id ? run.factory.supervision(stored.id) : null;
      // Supervision is a label beside the lifecycle, never a replacement: live while this server owns the run,
      // the last observation once it parks.
      const supervision = live ?? (PARKED.has(stored.state) && stored.error && stored.watch?.observed ? { ...stored.watch.observed, status: "Action needed", monitoring: false } : null);
      const job = { ...withContinuation(stored, { maxRepairs, busy: position >= 0 || run?.jobId === stored.id }), supervision, pendingPause: Boolean(run?.factory.pausePending(stored.id)) };
      if (position < 0) return job;
      return { ...job, queuePosition: position + 1, queuedFor: queue[position].mode, blockedBy: queue[position].mode === "start" ? blockedBy : null };
    });
  }

  async function listProjects() {
    return (await discoverProjects(root)).map((project) => ({
      ...project,
      activeJobId: runs.get(project.id)?.jobId ?? null,
      queued: queue.filter((entry) => entry.projectId === project.id).length,
    }));
  }

  // Board (docs/run-board-and-controls-spec.md): every project's jobs bucketed by state.
  // ponytail: re-lists each project's jobs per poll on top of discoverProjects; cache if it shows.
  const BOARD_COLUMN = { repairing: "building", failed: "parked", interrupted: "parked", cancelled: "parked", paused: "parked" };
  async function board() {
    const columns = { queued: [], specifying: [], building: [], reviewing: [], deploying: [], parked: [], completed: [] };
    for (const project of await discoverProjects(root)) {
      const jobs = await annotateJobs(project.id, await storeFor(project.id).list());
      let completed = 0;
      for (const job of jobs) {
        const column = BOARD_COLUMN[job.state] ?? job.state;
        if (!columns[column] || (column === "completed" && completed++ >= 5)) continue;
        const card = {
          jobId: job.id,
          project: project.name,
          projectId: project.id,
          promise: job.brief?.promise ?? null,
          state: job.state,
          stage: job.stage ?? null,
          startedAt: job.startedAt ?? null,
          elapsedMs: job.startedAt ? new Date(job.stageHistory?.at(-1)?.endedAt ?? Date.now()) - new Date(job.startedAt) : null,
        };
        if (job.sdlc === "slices") {
          const total = (job.slicePlanIds ?? []).length;
          const done = (job.sliceDone ?? []).length;
          card.slices = {
            done,
            total,
            current: job.slicePlanIds?.[job.sliceIndex] ?? null,
            substage: job.featureCursor?.substage ?? null,
            repairs: Object.values(job.sliceStats ?? {}).reduce((sum, s) => sum + (s.repairs ?? 0), 0),
          };
        }
        if (job.recoveryPhase?.plan) card.slices = { done: job.recoveryPhase.done.length, total: job.recoveryPhase.plan.slices.length, current: job.recoveryPhase.current ?? null, repairs: 0, remainingRepairs: Math.max(0, (job.repairBudgetLimit ?? 0) - (job.attempt ?? 0)) };
        if (job.blockedBy) card.blockedBy = job.blockedBy;
        columns[column].push(card);
      }
    }
    return { columns, maxActiveRuns, active: runs.size };
  }

  // Switching only changes what the owner is viewing; runs in other projects keep going.
  async function selectProject(response, id) {
    if (!(await discoverProjects(root)).some((p) => p.id === id)) return json(response, 404, { error: `Unknown project: ${id}.` });
    if (id !== active.id) await openProject(id);
    return json(response, 200, { active: active.id, projects: await listProjects(), ...schedulerStatus() });
  }
  const issuesUrl = options.issuesUrl ?? process.env.SOLOFACTORY_ISSUES_URL;
  const issues = issuesConfig(issuesUrl);
  if (issuesUrl && !issues) console.warn("SOLOFACTORY_ISSUES_URL must look like https://github.com/<owner>/<repo>/issues with no query or fragment; GitHub links are disabled.");

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        // Server alive is this response; worker progress is each active run's supervision status.
        return json(response, 200, { ok: true, project: active.id, ...schedulerStatus(), workers: [...runs].map(([projectId, run]) => ({ projectId, jobId: run.jobId, supervision: run.factory.supervision(run.jobId) })) });
      }
      if (request.method === "GET" && url.pathname === "/api/board") {
        return json(response, 200, await board());
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        return json(response, 200, { projects: await listProjects(), active: active.id, ...schedulerStatus() });
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson(request);
        const slug = String(body.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!slug) return json(response, 400, { error: "Project name must contain letters or digits." });
        const id = `projects/${slug}`;
        if (await stat(path.join(root, id)).catch(() => null)) return json(response, 409, { error: `Project ${slug} already exists.` });
        await new JobStore(path.join(root, id)).init();
        return selectProject(response, id);
      }
      if (request.method === "POST" && url.pathname === "/api/projects/select") {
        const body = await readJson(request);
        return selectProject(response, String(body.id ?? ""));
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const providers = fixtureMode
          ? [{ id: "fixture", label: "Fixture subscription", installed: true, authenticated: true, detail: "Deterministic demo provider" }]
          : discoverProviders();
        return json(response, 200, {
          providers,
          opening: makeOpeningTurn(),
          fixtureMode,
          version,
          issues: issues ? { base: issues.base, available: true } : null,
          sdlcOptions: [
            { id: "slices", label: "Planned features", detail: "A reviewed feature plan first, then each feature is built, proved and reviewed before the next starts." },
          ],
        });
      }
      if (request.method === "POST" && url.pathname === "/api/interview/upload") {
        // Images cannot ride inline in the transcript, so they land in the active
        // project where the Guide's own Read tool can open them by path.
        const name = String(url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "");
        if (!IMAGE_EXTENSIONS.test(name)) return json(response, 400, { error: "Only png, jpg, gif, and webp images can be uploaded." });
        const bytes = await readBytes(request, MAX_UPLOAD_BYTES);
        if (!bytes.length) return json(response, 400, { error: "Upload is empty." });
        const relative = path.posix.join(".factory", "uploads", `${Date.now().toString(36)}-${name}`);
        await mkdir(path.join(active.dir, ".factory", "uploads"), { recursive: true });
        await writeFile(path.join(active.dir, relative), bytes);
        return json(response, 200, { path: relative, bytes: bytes.length });
      }
      if (request.method === "POST" && url.pathname === "/api/interview/turn") {
        const body = await readJson(request);
        const provider = requireProvider(body.provider, fixtureMode);
        const messages = validateMessages(body.messages);
        const latest = (await store.list())[0];
        const current = latest ? await withReviewDiagnostics(latest, active.dir) : null;
        const runContext = current ? {
          project: active.id, jobId: current.id, state: current.state, strategy: current.sdlc ?? "single",
          repairAttempts: current.attempt ?? 0,
          featureRecovery: current.recoveryPhase ? { status: current.recoveryPhase.status, done: current.recoveryPhase.done, current: current.recoveryPhase.current,
            // The plan stays on disk (up to MAX_AMENDED_PLAN_BYTES); the guide reads it from the project when it needs it.
            planFile: current.recoveryPhase.planFile ?? null, features: current.recoveryPhase.plan?.slices.length ?? 0, gaps: current.recoveryPhase.request?.checks ?? [], planBlockers: current.recoveryPhase.planBlockers ?? [], remainingRepairs: Math.max(0, (current.repairBudgetLimit ?? 0) - current.attempt) } : null,
          recoveryPacket: PARKED.has(current.state) ? buildRecoveryPacket({ ...current, recovery: current.recovery ?? buildRecovery(current, active.dir) }) : null,
        } : { project: active.id, state: "no-runs" };
        const result = await providerFactory(provider).run({
          // The guide runs inside the active project so its transcript is that project's memory
          // and the CLI picks up the project's own CLAUDE.md/.aai.
          cwd: active.dir,
          prompt: buildInterviewPrompt({ skill, messages, runContext }),
          schema: INTERVIEW_RESPONSE_SCHEMA,
          mode: "read",
          logPath: path.join(active.dir, ".aai", "memory", "interviews", "guide.log"),
          context: { stage: "interview" },
        });
        return json(response, 200, validateInterviewResult(result));
      }
      if (request.method === "POST" && url.pathname === "/api/errors") {
        const body = await readJson(request);
        const source = ["browser", "chat"].includes(body.source) ? body.source : null;
        if (!source || typeof body.message !== "string" || !body.message.trim()) return json(response, 400, { error: "An error report needs source (browser or chat) and a message.", code: "error_report_invalid" });
        const extra = Object.fromEntries(["action", "code", "jobId", "project"].filter((key) => typeof body[key] === "string").map((key) => [key, body[key].slice(0, 200)]));
        await logError({ source, ...extra, message: body.message });
        return json(response, 202, { logged: true });
      }
      if (request.method === "GET" && url.pathname === "/api/errors") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
        const text = await readFile(errorLog, "utf8").catch(() => "");
        const errors = text.split("\n").filter(Boolean).slice(-limit).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        return json(response, 200, { errors, file: errorLog });
      }
      if (request.method === "POST" && url.pathname === "/api/feedback/preview") {
        let feedback;
        try {
          feedback = validateFeedback(await readJson(request));
        } catch (error) {
          if (!error.code?.startsWith("feedback_")) throw error;
          return json(response, error.code === "feedback_too_large" ? 413 : 400, { error: error.message, code: error.code });
        }
        let diagnostics = null;
        if (feedback.includeDiagnostics && feedback.jobId) {
          // store.read, not ensureRecovery: previewing a report must never mutate run evidence.
          const jobStore = storeOfJob(feedback.jobId);
          const job = await jobStore.read(feedback.jobId);
          if (!REPORTABLE_STATES.includes(job.state)) return json(response, 409, { error: "Diagnostics are only available for failed, interrupted, or cancelled runs.", code: "feedback_not_reportable" });
          const factory = factories.get(job.id) ?? new SoloFactory({ store: jobStore, provider: providerFactory(job.provider), maxRepairs, autoStartRepairs });
          const { summary } = await factory.telemetry(job.id);
          diagnostics = buildDiagnostics({ job, events: await jobStore.events(job.id, 500), summary, version });
        }
        return json(response, 200, renderReport(feedback.mode, feedback.fields, diagnostics));
      }

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        return json(response, 200, { jobs: await annotateJobs(active.id, await store.list()), project: active.id, ...schedulerStatus() });
      }
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJson(request);
        const provider = requireProvider(body.provider, fixtureMode);
        // Every new run is planned; single builds exist only as history and cannot be requested.
        const sdlc = body.sdlc ?? "slices";
        if (sdlc !== "slices") return json(response, 400, { error: `New runs always plan features first; "${sdlc}" is not available.` });
        validateMessages(body.transcript);
        const validated = validateInterviewResult({
          message: "Ready",
          status: "ready",
          coverage: body.coverage,
          brief: body.brief,
        });
        const job = await store.create({ brief: validated.brief, transcript: body.transcript, provider, sdlc });
        await enqueue(active.id, job.id);
        const [annotated] = await annotateJobs(active.id, [await store.read(job.id)]);
        return json(response, 202, { job: annotated });
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/);
      if (request.method === "GET" && jobMatch) {
        const jobStore = storeOfJob(jobMatch[1]);
        const job = await ensureRecovery(await jobStore.read(jobMatch[1]), jobStore);
        // Superseded plans grow without bound (36MB on a long run) and the 1.5s poll crashed the tab; the UI never reads them.
        const [{ recoveryPhaseHistory, ...annotated }] = await annotateJobs(jobProject.get(job.id) ?? active.id, [job]);
        return json(response, 200, { job: { ...annotated, idleGaps: await jobStore.idleGaps(job.id) }, events: await jobStore.events(job.id) });
      }
      const telemetryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/telemetry$/);
      if (request.method === "GET" && telemetryMatch) {
        const jobStore = storeOfJob(telemetryMatch[1]);
        const job = await jobStore.read(telemetryMatch[1]);
        const factory = factories.get(job.id) ?? new SoloFactory({ store: jobStore, provider: providerFactory(job.provider), maxRepairs, autoStartRepairs });
        return json(response, 200, await factory.telemetry(job.id));
      }
      const artifactMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/artifacts\/([a-z]+)$/);
      if (request.method === "GET" && artifactMatch) {
        const artifact = await storeOfJob(artifactMatch[1]).artifact(artifactMatch[1], artifactMatch[2]);
        response.writeHead(200, { "content-type": artifact.file.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8" });
        return response.end(artifact.content);
      }
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const id = cancelMatch[1];
        const position = queue.findIndex((entry) => entry.jobId === id);
        if (position >= 0) {
          // Dequeue. A queued start never ran, so it is simply cancelled; a queued resume stays parked.
          const [entry] = queue.splice(position, 1);
          const jobStore = storeFor(entry.projectId);
          const job = await jobStore.read(id);
          if (job.state === "queued") {
            Object.assign(job, { state: "cancelled", stage: "Removed from queue", completedAt: new Date().toISOString() });
            await jobStore.writeState(job);
            await jobStore.appendEvent(id, { type: "job.dequeued", state: job.state, message: "Removed from queue" });
          }
          drain();
          return json(response, 202, { ok: true, dequeued: true });
        }
        const run = [...runs.values()].find((item) => item.jobId === id);
        if (!run) return json(response, 409, { error: "That run is not active." });
        await run.factory.cancel(id);
        return json(response, 202, { ok: true });
      }
      const pauseMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/pause$/);
      if (request.method === "POST" && pauseMatch) {
        const run = [...runs.values()].find((item) => item.jobId === pauseMatch[1]);
        if (!run) return json(response, 409, { error: "That run is not active." });
        await run.factory.pause(pauseMatch[1]);
        return json(response, 202, { ok: true, pausing: true });
      }
      const dismissMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/dismiss$/);
      if (request.method === "POST" && dismissMatch) {
        // Owner accepts a parked run as-is, which releases its project's queue. The rollback is a hard reset,
        // so it never runs beside a writer: a live run, or a queued resume or recovery of this project.
        const id = dismissMatch[1];
        const projectId = jobProject.get(id) ?? active.id;
        const jobStore = storeOfJob(id);
        const outcome = await exclusive(async () => {
          const job = await jobStore.read(id);
          if (!PARKED.has(job.state)) return { status: 409, body: { error: "Only a parked run can be dismissed." } };
          if (runs.has(projectId) || queue.some((entry) => entry.projectId === projectId && entry.mode !== "start")) return { status: 409, body: { error: "This project has a running or queued writer; dismiss it after that writer parks." } };
          await rollBack(job, jobStore);
          job.dismissed = true;
          await jobStore.writeState(job);
          await jobStore.appendEvent(job.id, { type: "job.dismissed", state: job.state, message: "Dismissed by owner; queued runs may proceed" });
          return { status: 202, body: { job } };
        });
        if (outcome.status === 202) await drain();
        return json(response, outcome.status, outcome.body);
      }
      const featureRecoveryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-(plan|start)$/);
      if (request.method === "POST" && featureRecoveryMatch) {
        const [ , id, action] = featureRecoveryMatch;
        const projectId = jobProject.get(id) ?? active.id;
        const jobStore = storeOfJob(id);
        const job = await jobStore.read(id);
        const next = continuationAction(job, { maxRepairs, busy: runs.has(projectId) || queue.some(entry => entry.jobId === id) });
        if (!PARKED.has(job.state) || job.dismissed || runs.has(projectId) || queue.some(entry => entry.projectId === projectId && entry.mode !== "start")) return json(response, 409, { error: "Feature recovery requires an idle, unresolved parked run. Pause an active run first.", nextAction: next });
        if (next.action === "none") return json(response, 409, { error: next.reason, nextAction: next });
        if (action === "plan" && !admitsPlanning(next)) return json(response, 409, { error: `Prepare repair plan is not the next step: ${next.reason}`, nextAction: next });
        const body = await readJson(request);
        if (action === "start") {
          try { await validateRecoveryApproval({ store: jobStore }, job, body.planDigest); }
          catch (error) { return json(response, 409, { error: error.message }); }
        } else if (job.recoveryPhase && !["planning", "plan_failed", "ready", "running", "built"].includes(job.recoveryPhase.status)) return json(response, 409, { error: "This run already has an active recovery plan." });
        else {
          try { await assertPlanInputsRevised(jobStore, job); }
          catch (error) { return json(response, 409, { error: error.message, nextAction: error.details.nextAction, blockers: error.details.blockers }); }
        }
        if (body.guidance !== undefined && (typeof body.guidance !== "string" || body.guidance.length > 6000)) return json(response, 400, { error: "Recovery plan feedback must be text of at most 6000 characters." });
        try { assertBatch(body.features); } catch (error) { return json(response, 400, { error: error.message }); }
        if (runs.has(projectId) || queue.some(entry => entry.projectId === projectId && entry.mode !== "start")) return json(response, 409, { error: "The project acquired another writer; retry after it parks." });
        await enqueue(projectId, id, `recovery-${action}`, { front: true, planDigest: body.planDigest, guidance: body.guidance ?? "", features: body.features });
        return json(response, 202, { accepted: true, jobId: id });
      }
      const amendMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-review$/);
      if (request.method === "POST" && amendMatch) {
        const [ , id] = amendMatch;
        const projectId = jobProject.get(id) ?? active.id;
        const jobStore = storeOfJob(id);
        const job = await jobStore.read(id);
        const busy = runs.has(projectId) || queue.some(entry => entry.projectId === projectId && entry.mode !== "start");
        // Bounded, never truncated: the plan plus a small envelope; the controller repeats every check under ownership.
        let body;
        try { body = await readJson(request, MAX_AMENDED_PLAN_BYTES + 100_000); }
        catch (error) { return json(response, error.code === "body_too_large" ? 413 : 400, { error: error.code === "body_too_large" ? `The corrected plan exceeds ${MAX_AMENDED_PLAN_BYTES} bytes.` : error.message, code: error.code === "body_too_large" ? "amendment_too_large" : "amendment_invalid" }); }
        try { await assertPlanAmendable(jobStore, job, { phaseId: body.phaseId, plan: body.plan }, { maxRepairs, busy: busy || queue.some(entry => entry.jobId === id) }); }
        catch (error) { return json(response, error.details?.status ?? 500, { error: error.message, code: error.code, nextAction: continuationAction(job, { maxRepairs, busy }) }); }
        await enqueue(projectId, id, "recovery-review", { front: true, submission: { phaseId: body.phaseId, plan: body.plan } });
        return json(response, 202, { accepted: true, jobId: id });
      }
      // A spec the owner adds after intake joins the run the way intake attachments do: a file in .factory/uploads
      // named in the transcript. Every input digest, plan request and review then includes it.
      const inputMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/inputs$/);
      if (request.method === "POST" && inputMatch) {
        const [ , id] = inputMatch;
        const projectId = jobProject.get(id) ?? active.id;
        const jobStore = storeOfJob(id);
        const busy = () => runs.has(projectId) || queue.some(entry => entry.projectId === projectId && entry.mode !== "start");
        const parked = (job) => !busy() && continuationAction(job, { maxRepairs }).action !== "none";
        if (!parked(await jobStore.read(id))) return json(response, 409, { error: "Inputs can be added only to an idle, unresolved parked run. Pause an active run first." });
        const name = String(url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "");
        if (!INPUT_EXTENSIONS.test(name)) return json(response, 400, { error: "Specs and prototypes can be md, txt, json, html, yaml, csv, pdf or image files." });
        let bytes;
        try { bytes = await readBytes(request, MAX_UPLOAD_BYTES); }
        catch (error) { return json(response, 413, { error: `The file exceeds ${MAX_UPLOAD_BYTES} bytes.` }); }
        if (!bytes.length) return json(response, 400, { error: "The file is empty." });
        // Re-read after the body: a run may have started while it streamed.
        const job = await jobStore.read(id);
        if (!parked(job)) return json(response, 409, { error: "The run acquired a writer; retry after it parks." });
        const relative = path.posix.join(".factory", "uploads", `${Date.now().toString(36)}-${name}`);
        await mkdir(path.join(jobStore.appDir(id), ".factory", "uploads"), { recursive: true });
        await writeFile(path.join(jobStore.appDir(id), relative), bytes);
        job.transcript = [...(job.transcript ?? []), { role: "user", content: `Attached file: ${relative}` }];
        await jobStore.writeState(job);
        await jobStore.appendEvent(id, { type: "inputs.added", state: job.state, message: `Owner added ${relative}` });
        return json(response, 200, { path: relative, bytes: bytes.length });
      }
      // Owner waiver of one stuck reviewer test; the run then waits for Resume.
      const waiveMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/waive-proof$/);
      if (request.method === "POST" && waiveMatch) {
        const projectId = jobProject.get(waiveMatch[1]) ?? active.id;
        if (runs.has(projectId) || queue.some(entry => entry.projectId === projectId && entry.mode !== "start")) return json(response, 409, { error: "Pause the active run before waiving a test." });
        const jobStore = storeFor(projectId);
        const job = await jobStore.read(waiveMatch[1]);
        const { proof, reason } = await readJson(request);
        const factory = new SoloFactory({ store: jobStore, provider: providerFactory(job.provider), maxRepairs, autoStartRepairs });
        try { return json(response, 200, { job: await factory.waiveProof(job.id, String(proof ?? ""), String(reason ?? "")) }); }
        catch (error) { return json(response, 409, { error: error.message, code: error.code }); }
      }
      const packetMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-plan-packet$/);
      if (request.method === "GET" && packetMatch) {
        const jobStore = storeOfJob(packetMatch[1]);
        const job = await jobStore.read(packetMatch[1]);
        const next = continuationAction(job, { maxRepairs });
        // Blocked plans need a correction; a ready plan offers a replacement as its alternative.
        if (next.action !== "amend-plan" && !next.alternatives?.some((item) => item.action === "amend-plan")) return json(response, 409, { error: next.reason, nextAction: next });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="plan-help-${job.id}.json"` });
        return response.end(JSON.stringify(await amendmentPacket(jobStore, job), null, 2));
      }
      const resumeMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const projectId = jobProject.get(resumeMatch[1]) ?? active.id;
        const jobStore = storeFor(projectId);
        const job = await ensureRecovery(await jobStore.read(resumeMatch[1]), jobStore);
        const next = continuationAction(job, { maxRepairs, busy: queue.some((entry) => entry.jobId === job.id) || runs.get(projectId)?.jobId === job.id });
        if (next.action !== "resume") return json(response, 409, { error: next.endpoint ? `${next.reason} Next: ${next.label} (POST ${next.endpoint}).` : next.reason, nextAction: next });
        try { await assertPlanReviewable(jobStore, job, maxRepairs); } catch (error) { return json(response, 409, { error: error.message, code: error.code, nextAction: next }); }
        const { features } = await readJson(request);
        try { assertBatch(features); } catch (error) { return json(response, 400, { error: error.message }); }
        if (features && job.recoveryPhase?.status !== "running") return json(response, 400, { error: "A batch size applies only to an approved repair plan that is running." });
        // Front of the queue: resolving a parked run is what unblocks everything behind it.
        await enqueue(projectId, job.id, "resume", { front: true, features });
        return json(response, 202, { job, resumed: true, queued: queue.some((entry) => entry.jobId === job.id) });
      }
      const relaunchMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/relaunch$/);
      if (request.method === "POST" && relaunchMatch) {
        const jobStore = storeOfJob(relaunchMatch[1]);
        const job = await jobStore.read(relaunchMatch[1]);
        const factory = factories.get(job.id) ?? new SoloFactory({ store: jobStore, provider: providerFactory(job.provider), maxRepairs, autoStartRepairs });
        factories.set(job.id, factory); // keeps the relaunched child reachable for shutdown
        try {
          return json(response, 200, { job: await factory.relaunch(job.id) });
        } catch (error) {
          if (error.code === "not_relaunchable") return json(response, 409, { error: error.message });
          throw error;
        }
      }
      const restartMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/restart$/);
      if (request.method === "POST" && restartMatch) {
        const projectId = jobProject.get(restartMatch[1]) ?? active.id;
        const job = await storeFor(projectId).read(restartMatch[1]);
        const { fromSlice } = await readJson(request);
        if (!PARKED.has(job.state) || queue.some((entry) => entry.jobId === job.id)) return json(response, 409, { error: "Only a parked run can be restarted from a slice." });
        const index = (job.sliceDone ?? []).indexOf(fromSlice);
        if (index < 1) return json(response, 400, { error: index === 0 ? "Restarting from the first slice is a fresh run; use start over." : `Slice ${fromSlice} has not completed in this run.` });
        await enqueue(projectId, job.id, "restart", { front: true, fromSlice });
        return json(response, 202, { job, restartedFrom: fromSlice });
      }
      const recoveryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-packet$/);
      if (request.method === "GET" && recoveryMatch) {
        const jobStore = storeOfJob(recoveryMatch[1]);
        const preserved = await ensureRecovery(await jobStore.read(recoveryMatch[1]), jobStore);
        const enriched = await withReviewDiagnostics(preserved, jobStore.appDir());
        const job = withContinuation({ ...enriched, recovery: enriched.recovery ?? buildRecovery(enriched, jobStore.appDir(), undefined, { maxRepairs }) }, { maxRepairs });
        if (!job.recovery || !["failed", "interrupted", "cancelled", "paused"].includes(job.state)) {
          return json(response, 409, { error: "That run does not need recovery." });
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return response.end(buildRecoveryPacket(job));
      }
      const retryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/retry$/);
      if (request.method === "POST" && retryMatch) {
        const projectId = jobProject.get(retryMatch[1]) ?? active.id;
        const jobStore = storeFor(projectId);
        const original = await jobStore.read(retryMatch[1]);
        if (runs.get(projectId)?.jobId === original.id) return json(response, 409, { error: "That run is still active." });
        const job = await jobStore.create({ brief: original.brief, transcript: original.transcript, provider: original.provider });
        // Starting over replaces the original, so it no longer holds the queue, and the new run goes first.
        if (PARKED.has(original.state)) {
          await rollBack(original, jobStore);
          original.dismissed = true;
          await jobStore.writeState(original);
        }
        await enqueue(projectId, job.id, "start", { front: true });
        return json(response, 202, { job, retriedFrom: original.id });
      }

      if (request.method === "GET") return serveStatic(response, url.pathname);
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.code === "ENOENT" ? 404 : /invalid|must|unknown|coverage|transcript|message/i.test(error.message) ? 400 : 500;
      await logError({ source: "server", status, request: `${request.method} ${request.url.split("?")[0]}`, code: error.code, message: error.message });
      return json(response, status, { error: error.message, code: error.code ?? "request_failed" });
    }
  });

  return {
    server,
    get store() {
      return store;
    },
    async close() {
      closing = true;
      queue.length = 0;
      const live = [...runs.values()];
      await Promise.all(live.map((run) => run.factory.cancel(run.jobId, { shutdown: true }).catch(() => {})));
      await Promise.all(live.map((run) => run.promise));
      await draining;
      await Promise.all([...factories.values()].map((factory) => factory.shutdown()));
      // server.close() waits for every open request to finish, so one stalled request (a
      // browser tab mid-fetch) kept the process alive after SIGTERM. Give in-flight requests a
      // short grace period, then drop whatever connections remain.
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      let timer;
      await Promise.race([closed, new Promise((resolve) => (timer = setTimeout(resolve, 1000)))]);
      clearTimeout(timer);
      server.closeAllConnections();
      await closed;
    },
  };
}

// A project is any non-hidden child of root/ or root/projects/ that is a git repo.
// ponytail: readdir on every call; cache by mtime if a root ever holds hundreds of repos.
async function discoverProjects(root) {
  const projects = [];
  for (const parent of ["", "projects"]) {
    const entries = await readdir(path.join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || (parent === "" && entry.name === "projects")) continue;
      const id = parent ? `${parent}/${entry.name}` : entry.name;
      // Anything under projects/ counts (a hand-seeded folder is initialised on first open);
      // directly under root only git repos do, so .aai/, .ailib/, node_modules/ never appear.
      if (!parent && !(await stat(path.join(root, id, ".git")).catch(() => null))) continue;
      const runs = await new JobStore(path.join(root, id)).list();
      const last = runs[0];
      projects.push({ id, name: entry.name, runCount: runs.length, lastRun: last ? { id: last.id, state: last.state, createdAt: last.createdAt, workingName: last.brief?.workingName ?? null } : null });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureRecovery(job, store) {
  if (!job.error || job.recovery?.version === 2 || !["failed", "interrupted", "cancelled"].includes(job.state)) return job;
  const logDir = path.join(store.appDir(job.id), ".factory", "logs");
  let names = [];
  try {
    names = (await readdir(logDir)).filter((name) => name.endsWith(".log"));
  } catch {
    // A restart can happen before the first log is created.
  }
  const messageLogPath = job.error.message?.match(/See (\/.*?\.log)\.?$/)?.[1] ?? null;
  // Only the failing turn's log: earlier turns' output (specs, source) would match blocker words.
  // It is the log the error names, else the newest one.
  const named = messageLogPath && path.dirname(messageLogPath) === logDir && names.includes(path.basename(messageLogPath)) ? path.basename(messageLogPath) : null;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(logDir, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const failing = named ?? dated.sort((a, b) => b.at - a.at)[0]?.name;
  const diagnostics = detectProviderDiagnostics(failing ? await readFile(path.join(logDir, failing), "utf8").catch(() => "") : "");
  job.error.details ||= {};
  job.error.details.logPath ||= messageLogPath;
  job.recovery = buildRecovery(job, store.appDir(job.id), diagnostics, { legacy: true });
  await store.writeState(job);
  await store.appendEvent(job.id, {
    type: "recovery.prepared",
    state: job.state,
    message: diagnostics.length
      ? `Recovery prepared with ${diagnostics.length} concrete blocker${diagnostics.length === 1 ? "" : "s"}`
      : "Recovery prepared from preserved run evidence",
  });
  return job;
}

function requireProvider(id, fixtureMode) {
  if (fixtureMode && id === "fixture") return id;
  const provider = discoverProviders().find((item) => item.id === id);
  if (!provider?.authenticated) throw new Error(provider?.detail ?? "Select an authenticated subscription provider.");
  return id;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const MAX_UPLOAD_BYTES = 20_000_000;
const INPUT_EXTENSIONS = /\.(md|markdown|txt|json|html?|ya?ml|csv|pdf|png|jpe?g|gif|webp)$/i;

async function readBytes(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Keep reading (not storing) past the limit so the client gets its answer instead of a reset connection.
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw Object.assign(new Error("Request body is too large."), { code: "body_too_large" });
  return Buffer.concat(chunks);
}

async function readJson(request, limit = 1_000_000) {
  const data = (await readBytes(request, limit)).toString("utf8");
  try {
    return JSON.parse(data || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function serveStatic(response, pathname) {
  const map = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
  const file = pathname === "/manual" ? manualFile : map[pathname] && path.join(publicRoot, map[pathname]);
  if (!file) return json(response, 404, { error: "Not found" });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  response.writeHead(200, { "content-type": types[path.extname(file)], "cache-control": "no-store" });
  response.end(await readFile(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  const app = await createSoloFactoryServer();
  app.server.on("error", async (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    // A running factory answers /api/health with a workers list; anything else is another app.
    const health = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    console.error(Array.isArray(health?.workers)
      ? `SoloFactory is already running at http://${host}:${port} — open that in your browser instead of starting another.`
      : `Port ${port} is in use by another app. Start SoloFactory on a different port:\n  PORT=5000 bash start.sh\nthen open http://${host}:5000`);
    process.exit(1);
  });
  app.server.listen(port, host, () => {
    console.log(`SoloFactory is ready at http://${host}:${port}`);
  });
  const stop = async () => {
    // Backstop: close() still waits, unbounded, on runs that ignore cancellation. Never outlive a signal by more than 10s.
    setTimeout(() => {
      console.error("Shutdown took over 10s; exiting anyway.");
      process.exit(1);
    }, 10_000).unref();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
