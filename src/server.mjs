import http from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./store.mjs";
import { buildRecovery, buildRecoveryPacket, SoloFactory } from "./factory.mjs";
import {
  INTERVIEW_RESPONSE_SCHEMA,
  buildInterviewPrompt,
  makeOpeningTurn,
  validateInterviewResult,
  validateMessages,
} from "./interview.mjs";
import { createProvider, detectProviderDiagnostics, discoverProviders } from "./providers.mjs";
import { createFixtureProvider } from "./fixture-provider.mjs";
import { REPORTABLE_STATES, buildDiagnostics, issuesConfig, renderReport, validateFeedback } from "./feedback.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PARKED = new Set(["failed", "interrupted", "cancelled"]);
const projectRoot = path.dirname(here);
const publicRoot = path.join(projectRoot, "public");

export async function createSoloFactoryServer(options = {}) {
  const home = options.home ?? process.env.SOLOFACTORY_HOME ?? path.join(projectRoot, ".solofactory");
  // Projects are dirs under root/projects/ or git repos directly under root/. The source checkout keeps them in
  // .solofactory/; the distro points SOLOFACTORY_ROOT at the ambient folder.
  const root = path.resolve(options.root ?? process.env.SOLOFACTORY_ROOT ?? home);
  const activeFile = path.join(home, "active-project");
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
  const queue = []; // { projectId, jobId, mode: "start" | "resume" }
  const jobProject = new Map(); // jobId -> projectId, for jobs the scheduler has touched
  const queuedJobs = [];
  {
    const projects = await discoverProjects(root);
    for (const project of projects) {
      const projectStore = storeFor(project.id);
      await projectStore.recoverInterrupted();
      for (const job of await projectStore.list()) if (job.state === "queued") queuedJobs.push({ projectId: project.id, job });
    }
    const remembered = (await readFile(activeFile, "utf8").catch(() => "")).trim();
    await openProject(projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id ?? "projects/default");
  }
  const skill = await readFile(path.join(projectRoot, "skills", "factory-guide.md"), "utf8");
  const fixtureMode = options.fixtureMode ?? process.env.SOLOFACTORY_DEMO === "1";
  const providerFactory = options.providerFactory ?? ((id) => (id === "fixture" && fixtureMode ? createFixtureProvider() : createProvider(id)));
  const factories = new Map();
  let closing = false;

  // A project's queue waits while its most recently started run is parked and unresolved:
  // the tree may be mid-repair, and the next release must not build on it.
  async function blockerFor(projectId) {
    const started = (await storeFor(projectId).list()).filter((job) => job.startedAt);
    const last = started.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return last && PARKED.has(last.state) && !last.dismissed && !queue.some((entry) => entry.jobId === last.id) ? last.id : null;
  }

  async function drainOnce() {
    for (let i = 0; i < queue.length && runs.size < maxActiveRuns && !closing; ) {
      const entry = queue[i];
      if (runs.has(entry.projectId) || (entry.mode === "start" && (await blockerFor(entry.projectId)))) { i += 1; continue; }
      queue.splice(i, 1);
      const projectStore = storeFor(entry.projectId);
      await projectStore.init();
      const job = await projectStore.read(entry.jobId);
      const factory = new SoloFactory({ store: projectStore, provider: providerFactory(job.provider) });
      factories.set(job.id, factory);
      const run = { jobId: job.id, factory };
      runs.set(entry.projectId, run);
      run.promise = (entry.mode === "resume" ? factory.resume(job.id) : factory.start(job.id))
        .catch((error) => console.error(`run ${job.id}: ${error.message}`))
        .finally(() => {
          runs.delete(entry.projectId);
          drain();
        });
    }
  }
  // Serialised so concurrent enqueues and settlements never double-start a project.
  let draining = Promise.resolve();
  const drain = () => (draining = draining.then(drainOnce).catch((error) => console.error(`scheduler: ${error.message}`)));

  function enqueue(projectId, jobId, mode = "start", { front = false } = {}) {
    jobProject.set(jobId, projectId);
    queue[front ? "unshift" : "push"]({ projectId, jobId, mode });
    return drain();
  }
  for (const { projectId, job } of queuedJobs.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt))) enqueue(projectId, job.id);

  const storeOfJob = (id) => storeFor(jobProject.get(id) ?? active.id);
  const busyJobId = () => runs.get(active.id)?.jobId ?? null;
  const schedulerStatus = () => ({ busyJobId: busyJobId(), maxActiveRuns, activeRuns: [...runs].map(([projectId, run]) => ({ projectId, jobId: run.jobId })) });

  async function annotateJobs(projectId, jobs) {
    const blockedBy = runs.has(projectId) ? null : await blockerFor(projectId);
    return jobs.map((job) => {
      const position = queue.findIndex((entry) => entry.jobId === job.id);
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

  // Switching only changes what the owner is viewing; runs in other projects keep going.
  async function selectProject(response, id) {
    if (!(await discoverProjects(root)).some((p) => p.id === id)) return json(response, 404, { error: `Unknown project: ${id}.` });
    if (id !== active.id) await openProject(id);
    return json(response, 200, { active: active.id, projects: await listProjects(), ...schedulerStatus() });
  }
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const issuesUrl = options.issuesUrl ?? process.env.SOLOFACTORY_ISSUES_URL;
  const issues = issuesConfig(issuesUrl);
  if (issuesUrl && !issues) console.warn("SOLOFACTORY_ISSUES_URL must look like https://github.com/<owner>/<repo>/issues with no query or fragment; GitHub links are disabled.");

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { ok: true, project: active.id, ...schedulerStatus() });
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
            { id: "single", label: "Single build (v0 behavior)", detail: "One implementation turn for the whole app, then gates." },
            { id: "slices", label: "Vertical slices (wbs)", detail: "Walking skeleton first, then one bounded agent turn per slice, gated after each." },
          ],
        });
      }
      if (request.method === "POST" && url.pathname === "/api/interview/turn") {
        const body = await readJson(request);
        const provider = requireProvider(body.provider, fixtureMode);
        const messages = validateMessages(body.messages);
        const result = await providerFactory(provider).run({
          // The guide runs inside the active project so its transcript is that project's memory
          // and the CLI picks up the project's own CLAUDE.md/.aai.
          cwd: active.dir,
          prompt: buildInterviewPrompt({ skill, messages }),
          schema: INTERVIEW_RESPONSE_SCHEMA,
          mode: "read",
          logPath: path.join(active.dir, ".aai", "memory", "interviews", "guide.log"),
          context: { stage: "interview" },
        });
        return json(response, 200, validateInterviewResult(result));
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
          const factory = factories.get(job.id) ?? new SoloFactory({ store: jobStore, provider: providerFactory(job.provider) });
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
        const sdlc = body.sdlc ?? "single";
        if (!["single", "slices"].includes(sdlc)) return json(response, 400, { error: `Unknown SDLC strategy: ${sdlc}.` });
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
        const [annotated] = await annotateJobs(jobProject.get(job.id) ?? active.id, [job]);
        return json(response, 200, { job: annotated, events: await jobStore.events(job.id) });
      }
      const telemetryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/telemetry$/);
      if (request.method === "GET" && telemetryMatch) {
        const jobStore = storeOfJob(telemetryMatch[1]);
        const job = await jobStore.read(telemetryMatch[1]);
        const factory = factories.get(job.id) ?? new SoloFactory({ store: jobStore, provider: providerFactory(job.provider) });
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
      const dismissMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/dismiss$/);
      if (request.method === "POST" && dismissMatch) {
        // Owner accepts a parked run as-is, which releases its project's queue.
        const jobStore = storeOfJob(dismissMatch[1]);
        const job = await jobStore.read(dismissMatch[1]);
        if (!PARKED.has(job.state)) return json(response, 409, { error: "Only a failed, interrupted, or cancelled run can be dismissed." });
        job.dismissed = true;
        await jobStore.writeState(job);
        await jobStore.appendEvent(job.id, { type: "job.dismissed", state: job.state, message: "Dismissed by owner; queued runs may proceed" });
        await drain();
        return json(response, 202, { job });
      }
      const resumeMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const projectId = jobProject.get(resumeMatch[1]) ?? active.id;
        const jobStore = storeFor(projectId);
        const job = await ensureRecovery(await jobStore.read(resumeMatch[1]), jobStore);
        if (!job.recovery?.canResume || !["failed", "interrupted"].includes(job.state) || queue.some((entry) => entry.jobId === job.id)) {
          return json(response, 409, { error: "That run cannot be resumed from its current state." });
        }
        // Front of the queue: resolving a parked run is what unblocks everything behind it.
        await enqueue(projectId, job.id, "resume", { front: true });
        return json(response, 202, { job, resumed: true, queued: queue.some((entry) => entry.jobId === job.id) });
      }
      const recoveryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-packet$/);
      if (request.method === "GET" && recoveryMatch) {
        const jobStore = storeOfJob(recoveryMatch[1]);
        const job = await ensureRecovery(await jobStore.read(recoveryMatch[1]), jobStore);
        if (!job.recovery || !["failed", "interrupted", "cancelled"].includes(job.state)) {
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
        const job = await jobStore.create({ brief: original.brief, transcript: original.transcript, provider: original.provider, sdlc: original.sdlc ?? "single" });
        // Starting over replaces the original, so it no longer holds the queue, and the new run goes first.
        if (PARKED.has(original.state)) {
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
      await Promise.all(live.map((run) => run.factory.cancel(run.jobId).catch(() => {})));
      await Promise.all(live.map((run) => run.promise));
      await draining;
      await Promise.all([...factories.values()].map((factory) => factory.shutdown()));
      await new Promise((resolve) => server.close(resolve));
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
  const chunks = await Promise.all(names.map((name) => readFile(path.join(logDir, name), "utf8").catch(() => "")));
  const diagnostics = detectProviderDiagnostics(chunks.join("\n"));
  const messageLogPath = job.error.message?.match(/See (\/.*?\.log)\.?$/)?.[1] ?? null;
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

async function readJson(request) {
  let data = "";
  for await (const chunk of request) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("Request body is too large.");
  }
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
  const fileName = map[pathname];
  if (!fileName) return json(response, 404, { error: "Not found" });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  response.writeHead(200, { "content-type": types[path.extname(fileName)], "cache-control": "no-store" });
  response.end(await readFile(path.join(publicRoot, fileName)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  const app = await createSoloFactoryServer();
  app.server.listen(port, host, () => {
    console.log(`SoloFactory is ready at http://${host}:${port}`);
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
