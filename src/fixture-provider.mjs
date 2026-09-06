import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COVERAGE_KEYS, makeOpeningTurn } from "./interview.mjs";

const sampleBrief = {
  workingName: "Pocket Pulse",
  promise: "Track one daily signal and see a useful seven-day trend.",
  primaryUser: "A solo consultant who wants a two-minute daily check-in.",
  problem: "Important personal operating signals are scattered across notes.",
  currentAlternative: "An inconsistent paper note.",
  coreWorkflow: ["Open the app", "Record today's score and note", "Review the seven-day trend"],
  mustHaves: ["Add an entry", "See recent entries", "See a seven-day average"],
  nonGoals: ["Teams", "Billing", "Native mobile apps"],
  dataAndAccess: ["Local browser data", "No login", "No sensitive data"],
  integrations: ["None"],
  businessModel: "Personal tool",
  usage: "One owner, once per day",
  visualDirection: "Calm, editorial, high contrast",
  deployment: "Verified local deployment",
  acceptanceScenarios: ["A user records a score and immediately sees it in the recent list."],
  constraints: ["Keyboard accessible", "Works at mobile width"],
  later: ["CSV export"],
};

const fixtureSlicePlan = {
  slices: [
    {
      id: "SLICE-SKELETON",
      title: "Walking skeleton",
      objective: "A running, health-checked Pocket Pulse server with manifest, build, and aggregate metrics.",
      acceptance: [
        "GET /health answers ok",
        "GET /_factory/metrics returns privacy-preserving aggregate counters",
        "npm run build produces dist/",
        "factory.json v1 declares install, test, build and start commands",
      ],
      demo: "Start the app and curl /health and /_factory/metrics; both answer with valid JSON.",
      dependsOn: [],
    },
    {
      id: "SLICE-UI",
      title: "Recording UI and docs",
      objective: "A usable recording page with one-command README on top of the walking skeleton.",
      acceptance: [
        "[SC-1] The served page invites the owner to record a daily score",
        "README documents npm install, test, build and start",
      ],
      demo: "Open the served page and see the record-your-score form and the README instructions.",
      dependsOn: ["SLICE-SKELETON"],
    },
  ],
};

export function createFixtureProvider() {
  return {
    id: "fixture",
    async run({ cwd, schema, context }) {
      if (schema) {
        return {
          ...makeOpeningTurn(),
          message: "I have enough detail for the fixture build. Review the brief and start when ready.",
          status: "ready",
          coverage: Object.fromEntries(COVERAGE_KEYS.map((key) => [key, "complete"])),
          brief: sampleBrief,
        };
      }
      await mkdir(path.join(cwd, ".factory"), { recursive: true });
      if (context.stage.startsWith("specification")) {
        const body = (title) => `# ${title}\n\nPocket Pulse is a deliberately small personal SaaS fixture used to prove the complete SoloFactory lifecycle. It lets one owner record a daily score and short note, then inspect recent entries and a seven-day summary. The application has no login, billing, team features, external analytics, or remote services. Data remains in the browser.\n\nThe primary end-to-end scenario is observable: open the app, submit a score and note, see the new entry, and see the summary update. The server exposes a health endpoint and privacy-preserving aggregate request telemetry. Keyboard access, mobile layout, explicit empty states, and clear failures are required. This document is intentionally substantive enough to exercise the specification gate without hiding fixture behavior.\n`;
        await writeFile(path.join(cwd, ".factory", "PRD.md"), body("Product requirements"));
        await writeFile(path.join(cwd, ".factory", "PLAN.md"), body("Implementation plan"));
        await writeFile(path.join(cwd, ".factory", "ACCEPTANCE.md"), body("Acceptance contract"));
        if (context.job?.sdlc === "slices") {
          await writeFile(path.join(cwd, ".factory", "slices.json"), `${JSON.stringify(fixtureSlicePlan, null, 2)}\n`);
        }
      } else if (context.job?.sdlc === "slices" && /^(build-slice-|slice-resume-)/.test(context.stage)) {
        await writeFixtureSlice(cwd, context.job.sliceIndex ?? 0);
      } else if (context.stage === "build" || context.stage === "build-resume" || context.stage === "repair-resume") {
        await writeFixtureApp(cwd);
      } else if (context.stage.startsWith("review")) {
        await writeFile(path.join(cwd, ".factory", "REVIEW.md"), "# Review\n\nFixture contract inspected; no changes required.\n");
      }
      return { message: `${context.stage} complete` };
    },
  };
}

async function writeFixtureSlice(cwd, index) {
  const files = {
    "package.json": JSON.stringify(
      {
        name: "pocket-pulse-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test", build: "node build.mjs", start: "node server.mjs" },
      },
      null,
      2,
    ),
    "factory.json": JSON.stringify(
      {
        version: 1,
        commands: {
          install: ["npm", "install", "--no-audit", "--no-fund"],
          test: ["npm", "test"],
          build: ["npm", "run", "build"],
          start: ["npm", "start"],
        },
        healthPath: "/health",
        metricsPath: "/_factory/metrics",
      },
      null,
      2,
    ),
    "build.mjs": `import { mkdir, copyFile } from "node:fs/promises"; await mkdir("dist", { recursive: true }); await copyFile("index.html", "dist/index.html"); console.log("built");\n`,
    "server.mjs": fixtureServerSource,
    "server.test.mjs": `import test from "node:test"; import assert from "node:assert/strict"; import { metricsSnapshot } from "./server.mjs"; test("metrics are privacy-preserving aggregates", () => { const value = metricsSnapshot(); assert.equal(typeof value.requests.total, "number"); assert.equal(Array.isArray(value.routes), true); });\n`,
  };
  if (index === 0) {
    files["index.html"] = `<!doctype html><html><body><main><h1>Pocket Pulse</h1><p>Walking skeleton.</p></main></body></html>\n`;
  } else {
    files["index.html"] = `<!doctype html><html><body><main><h1>Pocket Pulse</h1><form><label>Record your daily score <input type="number" /></label><button type="submit">Save</button></form><p>Slice UI delivered.</p></main></body></html>\n`;
    files["README.md"] = "# Pocket Pulse\n\nRun `npm install && npm test && npm run build && npm start`.\n";
    files["ui.test.mjs"] = `import test from "node:test"; import assert from "node:assert/strict"; import { readFile } from "node:fs/promises"; test("recording UI ships in the source page", async () => { const html = await readFile("index.html", "utf8"); assert.match(html, /Record your daily score/); });\n`;
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(cwd, name), `${content}\n`);
  }
}

async function writeFixtureApp(cwd) {
  const files = {
    "package.json": JSON.stringify(
      {
        name: "pocket-pulse-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node --test", build: "node build.mjs", start: "node server.mjs" },
      },
      null,
      2,
    ),
    "factory.json": JSON.stringify(
      {
        version: 1,
        commands: {
          install: ["npm", "install", "--no-audit", "--no-fund"],
          test: ["npm", "test"],
          build: ["npm", "run", "build"],
          start: ["npm", "start"],
        },
        healthPath: "/health",
        metricsPath: "/_factory/metrics",
      },
      null,
      2,
    ),
    "build.mjs": `import { mkdir, copyFile } from "node:fs/promises"; await mkdir("dist", { recursive: true }); await copyFile("index.html", "dist/index.html"); console.log("built");\n`,
    "index.html": `<!doctype html><html><body><main><h1>Pocket Pulse</h1><p>Fixture app deployed.</p></main></body></html>\n`,
    "server.mjs": fixtureServerSource,
    "server.test.mjs": `import test from "node:test"; import assert from "node:assert/strict"; import { metricsSnapshot } from "./server.mjs"; test("metrics are privacy-preserving aggregates", () => { const value = metricsSnapshot(); assert.equal(typeof value.requests.total, "number"); assert.equal(Array.isArray(value.routes), true); });\n`,
    "README.md": "# Pocket Pulse\n\nRun `npm install && npm test && npm run build && npm start`.\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(cwd, name), `${content}\n`);
  }
}

const fixtureServerSource = `import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const started = Date.now();
const routes = new Map();
let active = 0;
let total = 0;
let errors = 0;
const latencies = [];
export function metricsSnapshot() {
  const average = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return { startedAt: new Date(started).toISOString(), uptimeSeconds: Math.floor((Date.now() - started) / 1000), requests: { total, errors, active }, latencyMs: { count: latencies.length, average, p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0 }, routes: [...routes.values()] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) http.createServer(async (req, res) => {
  const began = Date.now(); active += 1; total += 1;
  const route = req.url === "/health" ? "/health" : req.url === "/_factory/metrics" ? "/_factory/metrics" : "/";
  const key = req.method + " " + route;
  const item = routes.get(key) ?? { method: req.method, path: route, count: 0, errors: 0 };
  item.count += 1; routes.set(key, item);
  try {
    if (route === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); }
    else if (route === "/_factory/metrics") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(metricsSnapshot())); }
    else { res.setHeader("content-type", "text/html"); res.end(await readFile("dist/index.html")); }
  } catch { errors += 1; item.errors += 1; res.statusCode = 500; res.end("error"); }
  finally { active -= 1; latencies.push(Date.now() - began); if (latencies.length > 500) latencies.shift(); }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
`;
