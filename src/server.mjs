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
const projectRoot = path.dirname(here);
const publicRoot = path.join(projectRoot, "public");

export async function createSoloFactoryServer(options = {}) {
  const home = options.home ?? process.env.SOLOFACTORY_HOME ?? path.join(projectRoot, ".solofactory");
  // Projects are dirs under root/projects/ or git repos directly under root/. The source checkout keeps them in
  // .solofactory/; the distro points SOLOFACTORY_ROOT at the ambient folder.
  const root = path.resolve(options.root ?? process.env.SOLOFACTORY_ROOT ?? home);
  const activeFile = path.join(home, "active-project");
  let active; // { id, dir, store } — every job endpoint works on this project's store
  let store;
  async function openProject(id) {
    const next = new JobStore(path.join(root, id));
    await next.init();
    await next.recoverInterrupted();
    for (const job of await next.list()) await ensureRecovery(job, next);
    active = { id, dir: next.project };
    store = next;
    await mkdir(home, { recursive: true });
    await writeFile(activeFile, `${id}\n`);
  }
  {
    const projects = await discoverProjects(root);
    const remembered = (await readFile(activeFile, "utf8").catch(() => "")).trim();
    await openProject(projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id ?? "projects/default");
  }
  const skill = await readFile(path.join(projectRoot, "skills", "factory-guide.md"), "utf8");
  const fixtureMode = options.fixtureMode ?? process.env.SOLOFACTORY_DEMO === "1";
  const providerFactory = options.providerFactory ?? ((id) => (id === "fixture" && fixtureMode ? createFixtureProvider() : createProvider(id)));
  const factories = new Map();
  let busyJobId = null;
  let busyRun = null; // promise of the active run, awaited when a switch cancels it

  function launch(job, run) {
    busyJobId = job.id;
    busyRun = run().finally(() => {
      if (busyJobId === job.id) busyJobId = busyRun = null;
    });
  }

  // Selecting a project while a run is active is refused unless the caller opts into cancelling it.
  async function selectProject(response, id, { cancel = false } = {}) {
    if (!(await discoverProjects(root)).some((p) => p.id === id)) return json(response, 404, { error: `Unknown project: ${id}.` });
    if (busyJobId && id !== active.id) {
      if (!cancel) return json(response, 409, { error: `Run ${busyJobId} is still active.`, busyJobId });
      await factories.get(busyJobId)?.cancel(busyJobId);
      await busyRun;
    }
    if (id !== active.id) await openProject(id);
    return json(response, 200, { active: active.id, projects: await discoverProjects(root) });
  }
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const issuesUrl = options.issuesUrl ?? process.env.SOLOFACTORY_ISSUES_URL;
  const issues = issuesConfig(issuesUrl);
  if (issuesUrl && !issues) console.warn("SOLOFACTORY_ISSUES_URL must look like https://github.com/<owner>/<repo>/issues with no query or fragment; GitHub links are disabled.");

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { ok: true, busyJobId, project: active.id });
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        return json(response, 200, { projects: await discoverProjects(root), active: active.id, busyJobId });
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await readJson(request);
        const slug = String(body.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!slug) return json(response, 400, { error: "Project name must contain letters or digits." });
        const id = `projects/${slug}`;
        if (busyJobId && body.cancel !== true) return json(response, 409, { error: `Run ${busyJobId} is still active.`, busyJobId });
        if (await stat(path.join(root, id)).catch(() => null)) return json(response, 409, { error: `Project ${slug} already exists.` });
        await new JobStore(path.join(root, id)).init();
        return selectProject(response, id, { cancel: body.cancel === true });
      }
      if (request.method === "POST" && url.pathname === "/api/projects/select") {
        const body = await readJson(request);
        return selectProject(response, String(body.id ?? ""), { cancel: body.cancel === true });
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
          const job = await store.read(feedback.jobId);
          if (!REPORTABLE_STATES.includes(job.state)) return json(response, 409, { error: "Diagnostics are only available for failed, interrupted, or cancelled runs.", code: "feedback_not_reportable" });
          const factory = factories.get(job.id) ?? new SoloFactory({ store, provider: providerFactory(job.provider) });
          const { summary } = await factory.telemetry(job.id);
          diagnostics = buildDiagnostics({ job, events: await store.events(job.id, 500), summary, version });
        }
        return json(response, 200, renderReport(feedback.mode, feedback.fields, diagnostics));
      }

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        return json(response, 200, { jobs: await store.list(), busyJobId, project: active.id });
      }
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        if (busyJobId) return json(response, 409, { error: `Run ${busyJobId} is already active.` });
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
        const factory = new SoloFactory({ store, provider: providerFactory(provider) });
        factories.set(job.id, factory);
        launch(job, () => factory.start(job.id));
        return json(response, 202, { job });
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/);
      if (request.method === "GET" && jobMatch) {
        const job = await ensureRecovery(await store.read(jobMatch[1]), store);
        return json(response, 200, { job, events: await store.events(job.id) });
      }
      const telemetryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/telemetry$/);
      if (request.method === "GET" && telemetryMatch) {
        const job = await store.read(telemetryMatch[1]);
        const factory = factories.get(job.id) ?? new SoloFactory({ store, provider: providerFactory(job.provider) });
        return json(response, 200, await factory.telemetry(job.id));
      }
      const artifactMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/artifacts\/([a-z]+)$/);
      if (request.method === "GET" && artifactMatch) {
        const artifact = await store.artifact(artifactMatch[1], artifactMatch[2]);
        response.writeHead(200, { "content-type": artifact.file.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8" });
        return response.end(artifact.content);
      }
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const factory = factories.get(cancelMatch[1]);
        if (!factory) return json(response, 409, { error: "That run is not active." });
        await factory.cancel(cancelMatch[1]);
        return json(response, 202, { ok: true });
      }
      const resumeMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        if (busyJobId) return json(response, 409, { error: `Run ${busyJobId} is already active.` });
        const job = await ensureRecovery(await store.read(resumeMatch[1]), store);
        if (!job.recovery?.canResume || !["failed", "interrupted"].includes(job.state)) {
          return json(response, 409, { error: "That run cannot be resumed from its current state." });
        }
        const factory = new SoloFactory({ store, provider: providerFactory(job.provider) });
        factories.set(job.id, factory);
        launch(job, () => factory.resume(job.id));
        return json(response, 202, { job, resumed: true });
      }
      const recoveryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/recovery-packet$/);
      if (request.method === "GET" && recoveryMatch) {
        const job = await ensureRecovery(await store.read(recoveryMatch[1]), store);
        if (!job.recovery || !["failed", "interrupted", "cancelled"].includes(job.state)) {
          return json(response, 409, { error: "That run does not need recovery." });
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return response.end(buildRecoveryPacket(job));
      }
      const retryMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/retry$/);
      if (request.method === "POST" && retryMatch) {
        if (busyJobId) return json(response, 409, { error: `Run ${busyJobId} is already active.` });
        const original = await store.read(retryMatch[1]);
        const job = await store.create({ brief: original.brief, transcript: original.transcript, provider: original.provider, sdlc: original.sdlc ?? "single" });
        const factory = new SoloFactory({ store, provider: providerFactory(job.provider) });
        factories.set(job.id, factory);
        launch(job, () => factory.start(job.id));
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
      if (busyJobId) {
        await factories.get(busyJobId)?.cancel(busyJobId);
        await busyRun;
      }
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
