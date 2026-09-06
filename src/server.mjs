import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
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
  const store = options.store ?? new JobStore(home, { jobsRoot: options.jobsRoot ?? process.env.SOLOFACTORY_JOBS_ROOT });
  await store.init();
  await store.recoverInterrupted();
  for (const job of await store.list()) await ensureRecovery(job, store);
  const skill = await readFile(path.join(projectRoot, "skills", "factory-guide.md"), "utf8");
  const fixtureMode = options.fixtureMode ?? process.env.SOLOFACTORY_DEMO === "1";
  const providerFactory = options.providerFactory ?? ((id) => (id === "fixture" && fixtureMode ? createFixtureProvider() : createProvider(id)));
  const factories = new Map();
  let busyJobId = null;
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const issuesUrl = options.issuesUrl ?? process.env.SOLOFACTORY_ISSUES_URL;
  const issues = issuesConfig(issuesUrl);
  if (issuesUrl && !issues) console.warn("SOLOFACTORY_ISSUES_URL must look like https://github.com/<owner>/<repo>/issues with no query or fragment; GitHub links are disabled.");

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { ok: true, busyJobId });
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
          cwd: path.join(home, "interviews"),
          prompt: buildInterviewPrompt({ skill, messages }),
          schema: INTERVIEW_RESPONSE_SCHEMA,
          mode: "read",
          logPath: path.join(home, "interviews", "guide.log"),
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
        return json(response, 200, { jobs: await store.list(), busyJobId });
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
        busyJobId = job.id;
        factory.start(job.id).finally(() => {
          if (busyJobId === job.id) busyJobId = null;
        });
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
        busyJobId = job.id;
        factory.resume(job.id).finally(() => {
          if (busyJobId === job.id) busyJobId = null;
        });
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
        busyJobId = job.id;
        factory.start(job.id).finally(() => {
          if (busyJobId === job.id) busyJobId = null;
        });
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
    store,
    async close() {
      await Promise.all([...factories.values()].map((factory) => factory.shutdown()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
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
