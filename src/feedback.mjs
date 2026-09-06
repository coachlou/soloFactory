// Feedback reporting: pure report/fingerprint builders. The allowlist in
// buildDiagnostics is the privacy boundary; scrub() is defense in depth only.
import { FactoryError } from "./factory.mjs";

export const ALLOWED_EVENTS = Object.freeze([
  "job.created", "job.failed", "job.interrupted", "job.cancelled", "job.resumed", "job.completed",
  "stage.started", "gate.started", "gate.passed", "gate.failed", "slice.started", "slice.completed",
  "agent.started", "agent.completed", "agent.backoff", "deployment.started", "deployment.stopped",
]);
export const REPORTABLE_STATES = Object.freeze(["failed", "interrupted", "cancelled"]);
export const FREQUENCIES = Object.freeze(["once", "sometimes", "often"]);
export const AREAS = Object.freeze(["interview", "specification", "build", "verification", "recovery", "dashboard", "deployment", "generated app", "other"]);

const LIMITS = { title: 120, body: 4000, request: 32 * 1024, lifecycle: 20 };
const ISSUES_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/?$/;

export function selectErrorCode(job) {
  return job.error?.details?.diagnostics?.[0]?.code ?? job.error?.code ?? "unexpected_error";
}

export function buildFingerprint(job) {
  const gate = job.error?.details?.gate;
  return `${job.provider}:${selectErrorCode(job)}:${job.failedState ?? job.state}${gate ? `:${gate}` : ""}`;
}

export function buildDiagnostics({ job, events = [], summary = {}, version }) {
  const startedAt = new Date(job.startedAt ?? job.createdAt).getTime();
  const endedAt = new Date(job.completedAt ?? job.updatedAt).getTime();
  return {
    version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    provider: job.provider,
    strategy: job.sdlc ?? "single",
    state: job.state,
    failedState: job.failedState ?? null,
    errorCode: selectErrorCode(job),
    gate: job.error?.details?.gate ?? null,
    repairs: summary.repairs ?? 0,
    agentTurns: summary.agentTurns ?? 0,
    gateRuns: summary.gateRuns ?? 0,
    slicesPlanned: summary.slicesPlanned ?? 0,
    slicesCompleted: summary.slicesCompleted ?? 0,
    elapsedSeconds: Math.max(0, Math.floor((endedAt - startedAt) / 1000)) || 0,
    fingerprint: buildFingerprint(job),
    lifecycle: events
      .filter((event) => ALLOWED_EVENTS.includes(event.type))
      .slice(-LIMITS.lifecycle)
      .map((event) => ({
        type: event.type,
        state: event.state ?? null,
        ref: event.gate ?? event.slice ?? null,
        durationMs: typeof event.durationMs === "number" ? event.durationMs : null,
        at: event.at ?? null,
      })),
  };
}

const SCRUB = [
  /(?:\/(?:Users|home|Volumes|private|tmp)\/[^\s|`)]+)/g,
  /\b[A-Za-z]:\\[^\s|`)]+/g,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{12,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

export function scrub(text) {
  let changed = false;
  const out = SCRUB.reduce((acc, pattern) => acc.replace(pattern, () => { changed = true; return "[redacted]"; }), text);
  return { text: out, changed };
}

export function validateFeedback(body) {
  if (JSON.stringify(body ?? {}).length > LIMITS.request) throw new FactoryError("feedback_too_large", `Feedback request exceeds ${LIMITS.request} bytes.`);
  const mode = body?.mode;
  if (!["problem", "improvement"].includes(mode)) throw new FactoryError("feedback_invalid", "mode must be problem or improvement.");
  const raw = body.fields ?? {};
  const text = (key, max, required) => {
    const value = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (required && !value) throw new FactoryError("feedback_invalid", `${key} is required.`);
    if (value.length > max) throw new FactoryError("feedback_too_large", `${key} exceeds ${max} characters.`);
    return value;
  };
  const fields = { title: text("title", LIMITS.title, true).replace(/\s+/g, " ") };
  if (mode === "problem") {
    fields.happened = text("happened", LIMITS.body, true);
    fields.expected = text("expected", LIMITS.body, true);
    fields.context = text("context", LIMITS.body, false);
  } else {
    fields.friction = text("friction", LIMITS.body, true);
    fields.outcome = text("outcome", LIMITS.body, true);
    fields.workaround = text("workaround", LIMITS.body, false);
    if (!FREQUENCIES.includes(raw.frequency)) throw new FactoryError("feedback_invalid", `frequency must be one of ${FREQUENCIES.join(", ")}.`);
    if (!AREAS.includes(raw.area)) throw new FactoryError("feedback_invalid", `area must be one of ${AREAS.join(", ")}.`);
    fields.frequency = raw.frequency;
    fields.area = raw.area;
  }
  const jobId = body.jobId == null ? null : String(body.jobId);
  if (jobId !== null && !/^[a-z0-9-]+$/.test(jobId)) throw new FactoryError("feedback_invalid", "jobId is malformed.");
  return { mode, fields, jobId, includeDiagnostics: body.includeDiagnostics === true };
}

export function issuesConfig(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!ISSUES_URL.test(trimmed)) return null;
  const base = trimmed.replace(/\/$/, "");
  return {
    base,
    search: (q) => `${base}?q=${encodeURIComponent(`is:issue ${q}`)}`,
    newProblem: (title) => `${base}/new?template=problem.yml&title=${encodeURIComponent(`[Problem] ${title}`)}`,
    newImprovement: (title) => `${base}/new?template=improvement.yml&title=${encodeURIComponent(`[Improvement] ${title}`)}`,
  };
}

// User text is the reporter's own words; only a leading '#' is escaped so it cannot forge a section heading.
const inert = (text) => text.replace(/^(\s*)#/gm, "$1\\#");
const section = (heading, text) => (text ? `## ${heading}\n\n${inert(text)}\n\n` : "");

function renderDiagnostics(d) {
  const rows = [
    ["SoloFactory", d.version], ["Platform", `${d.platform} ${d.arch}`], ["Node", d.node], ["Provider", d.provider],
    ["Strategy", d.strategy], ["State", d.state], ["Failed state", d.failedState ?? "—"], ["Error code", d.errorCode],
    ["Gate", d.gate ?? "—"], ["Repairs", d.repairs], ["Agent turns", d.agentTurns], ["Gate runs", d.gateRuns],
    ["Slices", `${d.slicesCompleted}/${d.slicesPlanned}`], ["Elapsed", `${d.elapsedSeconds}s`], ["Fingerprint", `\`${d.fingerprint}\``],
  ];
  let out = `## SoloFactory diagnostics\n\n| Field | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n\n`;
  if (d.lifecycle.length) {
    out += `## Recent lifecycle\n\n| Type | State | Ref | Duration | At |\n|---|---|---|---|---|\n`;
    out += d.lifecycle.map((e) => `| ${e.type} | ${e.state ?? "—"} | ${e.ref ?? "—"} | ${e.durationMs == null ? "—" : `${e.durationMs}ms`} | ${e.at ?? "—"} |`).join("\n");
    out += "\n";
  }
  return scrub(out);
}

export function renderReport(mode, fields, diagnostics = null) {
  let body = `# ${inert(fields.title)}\n\n`;
  if (mode === "problem") {
    body += section("What happened", fields.happened) + section("Expected result", fields.expected) + section("Additional context", fields.context);
  } else {
    body += section("Problem or friction", fields.friction) + section("Desired outcome", fields.outcome) + section("Current workaround", fields.workaround);
    body += `## Context\n\n- Frequency: ${fields.frequency}\n- Area: ${fields.area}\n\n`;
  }
  let redacted = false;
  if (diagnostics) {
    const scrubbed = renderDiagnostics(diagnostics);
    body += scrubbed.text;
    redacted = scrubbed.changed;
  }
  return { markdown: body.trimEnd() + "\n", fingerprint: diagnostics?.fingerprint ?? null, redacted };
}
