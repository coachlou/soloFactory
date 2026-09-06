import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_EVENTS,
  buildDiagnostics,
  buildFingerprint,
  issuesConfig,
  renderReport,
  scrub,
  selectErrorCode,
  validateFeedback,
} from "../src/feedback.mjs";

// Shaped like a real state.json after fail(): every field an implementer might be tempted to read.
function leakyJob(overrides = {}) {
  return {
    id: "2026-09-06-deadbeef",
    state: "failed",
    failedState: "verifying",
    provider: "codex",
    sdlc: "slices",
    brief: { workingName: "Secret App", promise: "PRIVATE BRIEF TEXT" },
    transcript: [{ role: "user", content: "TRANSCRIPT SECRET sk-live-abcdefghijklmnop" }],
    createdAt: "2026-09-06T10:00:00.000Z",
    startedAt: "2026-09-06T10:00:05.000Z",
    updatedAt: "2026-09-06T10:04:05.000Z",
    completedAt: null,
    attempt: 2,
    agentSessions: { codex: "sess_SESSIONID123" },
    error: {
      code: "quality_gate_failed",
      message: "test failed with exit 1. See /Users/lou/.solofactory/jobs/x/app/.factory/logs/test-2.log.",
      details: {
        gate: "test",
        command: ["npm", "test"],
        output: "AGENT OUTPUT http://localhost:5555/secret token=ghp_ABCDEFGHIJKLMNOP",
        logPath: "/Users/lou/.solofactory/jobs/x/app/.factory/logs/test-2.log",
        diagnostics: [{ code: "network_unavailable", title: "t", action: "a" }],
      },
    },
    recovery: { workspace: "/Users/lou/.solofactory/jobs/x/app", summary: "RECOVERY SUMMARY" },
    stageHistory: [{ state: "building", label: "Building", startedAt: "2026-09-06T10:00:05.000Z", endedAt: "2026-09-06T10:03:00.000Z" }],
    ...overrides,
  };
}

const leakyEvents = [
  { at: "t1", type: "job.created", state: "queued", message: "Run queued" },
  { at: "t2", type: "agent.started", state: "building", message: "codex started build with session sess_SESSIONID123" },
  { at: "t3", type: "deployment.log", state: "deploying", message: "APP STDOUT password=hunter2" },
  { at: "t4", type: "gate.failed", state: "verifying", gate: "test", durationMs: 1234, message: "test failed" },
  { at: "t5", type: "recovery.prepared", state: "failed", message: "Recovery prepared" },
  { at: "t6", type: "job.failed", state: "failed", message: "See /Users/lou/private.log" },
];

const problemFields = { title: "Test gate fails on slices", happened: "It failed", expected: "It passes" };

test("error code prefers provider diagnostics, then job error, then unexpected_error", () => {
  assert.equal(selectErrorCode(leakyJob()), "network_unavailable");
  assert.equal(selectErrorCode(leakyJob({ error: { code: "quality_gate_failed", details: {} } })), "quality_gate_failed");
  assert.equal(selectErrorCode(leakyJob({ error: null })), "unexpected_error");
});

test("fingerprint is stable across id, time, path, exit code, and version; includes gate only when present", () => {
  const a = buildFingerprint(leakyJob());
  const b = buildFingerprint(leakyJob({ id: "other", createdAt: "2030-01-01T00:00:00.000Z", error: { ...leakyJob().error, message: "exit 7 /elsewhere.log" } }));
  assert.equal(a, b);
  assert.equal(a, "codex:network_unavailable:verifying:test");
  const noGate = leakyJob({ error: { code: "agent_idle_timeout", details: {} }, failedState: "building" });
  assert.equal(buildFingerprint(noGate), "codex:agent_idle_timeout:building");
  assert.equal(buildFingerprint(leakyJob({ state: "cancelled", failedState: null, error: { code: "cancelled" } })), "codex:cancelled:cancelled");
});

test("diagnostics contain nothing outside the allowlist", () => {
  const d = buildDiagnostics({ job: leakyJob(), events: leakyEvents, summary: { repairs: 1, agentTurns: 2, gateRuns: 3, slicesPlanned: 2, slicesCompleted: 1 }, version: "0.1.0" });
  const text = JSON.stringify(d);
  for (const forbidden of ["TRANSCRIPT", "PRIVATE BRIEF", "sess_", "/Users/", "http://", "AGENT OUTPUT", "ghp_", "sk-live", "hunter2", "RECOVERY SUMMARY", "Run queued", "deadbeef", "See "]) {
    assert.equal(text.includes(forbidden), false, `leaked: ${forbidden}`);
  }
  assert.equal(d.errorCode, "network_unavailable");
  assert.equal(d.gate, "test");
  assert.equal(d.elapsedSeconds, 240);
  assert.deepEqual(d.lifecycle.map((e) => e.type), ["job.created", "agent.started", "gate.failed", "job.failed"]);
  assert.deepEqual(d.lifecycle[2], { type: "gate.failed", state: "verifying", ref: "test", durationMs: 1234, at: "t4" });
  assert.equal(Object.hasOwn(d.lifecycle[0], "message"), false);
  assert.equal(ALLOWED_EVENTS.includes("deployment.log"), false);
});

test("lifecycle is capped at the 20 most recent allowed events", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ at: `t${i}`, type: "stage.started", state: "building" }));
  const d = buildDiagnostics({ job: leakyJob(), events: many, version: "0.1.0" });
  assert.equal(d.lifecycle.length, 20);
  assert.equal(d.lifecycle[0].at, "t30");
});

test("scrubber redacts paths and credential shapes and reports that it fired", () => {
  const { text, changed } = scrub("see /Users/lou/x.log and C:\\Users\\lou\\y token sk-abcdefghijklmnop Bearer abcdefghijklmnop");
  assert.equal(changed, true);
  assert.equal(text, "see [redacted] and [redacted] token [redacted] [redacted]");
  assert.deepEqual(scrub("gate test passed in 12ms"), { text: "gate test passed in 12ms", changed: false });
});

test("problem report omits empty optional sections and diagnostics when disabled", () => {
  const { markdown, fingerprint, redacted } = renderReport("problem", { ...problemFields, context: "" }, null);
  assert.equal(fingerprint, null);
  assert.equal(redacted, false);
  assert.match(markdown, /^# Test gate fails on slices\n\n## What happened\n\nIt failed\n\n## Expected result\n\nIt passes\n$/);
  assert.doesNotMatch(markdown, /Additional context|SoloFactory diagnostics|Recent lifecycle/);
});

test("problem report with diagnostics shows code, state, fingerprint, and lifecycle table", () => {
  const d = buildDiagnostics({ job: leakyJob(), events: leakyEvents, summary: {}, version: "0.1.0" });
  const { markdown, fingerprint, redacted } = renderReport("problem", problemFields, d);
  assert.equal(fingerprint, "codex:network_unavailable:verifying:test");
  assert.equal(redacted, false);
  assert.match(markdown, /\| Error code \| network_unavailable \|/);
  assert.match(markdown, /\| Failed state \| verifying \|/);
  assert.match(markdown, /`codex:network_unavailable:verifying:test`/);
  assert.match(markdown, /## Recent lifecycle\n\n\| Type \|/);
  assert.match(markdown, /\| gate\.failed \| verifying \| test \| 1234ms \| t4 \|/);
});

test("improvement report carries context and optional workaround", () => {
  const fields = { title: "Faster resume", friction: "Slow", outcome: "Fast", workaround: "", frequency: "often", area: "recovery" };
  const { markdown } = renderReport("improvement", fields, null);
  assert.match(markdown, /## Problem or friction\n\nSlow/);
  assert.match(markdown, /## Context\n\n- Frequency: often\n- Area: recovery/);
  assert.doesNotMatch(markdown, /Current workaround/);
});

test("user text cannot forge headings and is never HTML", () => {
  const { markdown } = renderReport("problem", { title: "<script>alert(1)</script>", happened: "# Fake heading\nreal", expected: "ok" }, null);
  assert.match(markdown, /^# <script>alert\(1\)<\/script>\n/);
  assert.match(markdown, /\\# Fake heading\nreal/);
  assert.doesNotMatch(markdown, /&lt;|<div|<p>/);
});

test("validation enforces required fields, enums, and bounds", () => {
  const ok = validateFeedback({ mode: "problem", fields: { ...problemFields, title: "  padded   title " }, jobId: "abc-123", includeDiagnostics: true });
  assert.equal(ok.fields.title, "padded title");
  assert.equal(ok.includeDiagnostics, true);
  assert.equal(validateFeedback({ mode: "problem", fields: problemFields }).jobId, null);
  assert.throws(() => validateFeedback({ mode: "bug", fields: problemFields }), { code: "feedback_invalid" });
  assert.throws(() => validateFeedback({ mode: "problem", fields: { title: "x" } }), { code: "feedback_invalid", message: /happened is required/ });
  assert.throws(() => validateFeedback({ mode: "problem", fields: { ...problemFields, title: "t".repeat(121) } }), { code: "feedback_too_large" });
  assert.throws(() => validateFeedback({ mode: "problem", fields: { ...problemFields, happened: "h".repeat(4001) } }), { code: "feedback_too_large" });
  assert.throws(() => validateFeedback({ mode: "problem", fields: { ...problemFields, context: "c".repeat(33_000) } }), { code: "feedback_too_large" });
  assert.throws(() => validateFeedback({ mode: "improvement", fields: { title: "t", friction: "f", outcome: "o", frequency: "daily", area: "build" } }), { code: "feedback_invalid", message: /frequency/ });
  assert.throws(() => validateFeedback({ mode: "improvement", fields: { title: "t", friction: "f", outcome: "o", frequency: "once", area: "kitchen" } }), { code: "feedback_invalid", message: /area/ });
  assert.throws(() => validateFeedback({ mode: "problem", fields: problemFields, jobId: "../etc" }), { code: "feedback_invalid" });
});

test("issues URL is validated strictly and derives search and template links without a body", () => {
  const cfg = issuesConfig("https://github.com/acme/solo-factory/issues/");
  assert.equal(cfg.base, "https://github.com/acme/solo-factory/issues");
  assert.equal(cfg.search("codex:usage_limit:building"), "https://github.com/acme/solo-factory/issues?q=is%3Aissue%20codex%3Ausage_limit%3Abuilding");
  const url = new URL(cfg.newProblem("Gate fails"));
  assert.equal(url.pathname, "/acme/solo-factory/issues/new");
  assert.equal(url.searchParams.get("template"), "problem.yml");
  assert.equal(url.searchParams.get("title"), "[Problem] Gate fails");
  assert.equal(url.searchParams.has("body"), false);
  assert.equal(new URL(cfg.newImprovement("x")).searchParams.get("template"), "improvement.yml");
  for (const bad of [
    undefined, "", "http://github.com/a/b/issues", "https://github.com/a/b", "https://github.com/a/b/issues?x=1",
    "https://github.com/a/b/issues#frag", "https://user:pw@github.com/a/b/issues", "https://gitlab.com/a/b/issues", "https://github.com/a/b/issues/new",
  ]) assert.equal(issuesConfig(bad), null, `accepted: ${bad}`);
});
