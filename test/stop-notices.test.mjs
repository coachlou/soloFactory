// Plain titles for untitled stops (spec item 2) and the hub's done/needs-you notices (item 3).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRecovery } from "../src/factory.mjs";

const stopped = (code, details = {}, extra = {}) => buildRecovery({ id: "j", state: "failed", stage: "deploying", error: { code, message: "m", details }, ...extra }, "/w");

test("each untitled stop gets its own plain title and summary", () => {
  const titles = {
    health_check_failed: /never answered its health check/,
    deployment_exited: /stopped right after it started/,
    invalid_metrics: /metrics page/,
    page_check_failed: /home page did not load/,
    process_restarted: /restarted during this run/,
    unexpected_error: /unexpected error/,
    gate_infrastructure: /test runner crashed/,
  };
  for (const [code, title] of Object.entries(titles)) {
    const recovery = stopped(code);
    assert.match(recovery.title, title, code);
    assert.doesNotMatch(recovery.summary, /stopped safely/, code);
  }
  assert.equal(stopped("quality_gate_failed", { gate: "start" }).title, "The start check failed");
  assert.equal(stopped("gate_timeout", { gate: "test" }).title, "The test ran past its time limit");
});

test("specific titles still win over the plain ones, and unknown codes keep the generic fallback with their code", () => {
  assert.equal(stopped("quality_gate_failed", { gate: "test" }, { attempt: 2 }).title, "Repair budget exhausted");
  assert.equal(stopped("health_check_failed", { diagnostics: [{ title: "Port 4000 is in use", action: "Free it." }] }).title, "Port 4000 is in use");
  assert.equal(stopped("agent_hard_timeout", { timeoutReason: "hard" }).title, "The run reached its safety cap");
  const other = stopped("no_commit");
  assert.equal(other.title, "The run paused before completion");
  assert.match(other.summary, /stopped safely \(no_commit\)/);
});

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const h = new Function(`${source.slice(source.indexOf("const NEEDS_YOU"), source.indexOf("const BRIEF_SECTIONS"))}; return { recoverySaw, notifyTransitions };`)();
const job = (id, state, extra = {}) => ({ id, state, brief: { workingName: "Notes" }, ...extra });

test("notices fire once per transition, never on the first poll, an owner pause, or another project's jobs", () => {
  const before = [job("a", "building"), job("b", "building"), job("c", "building"), job("d", "completed")];
  assert.deepEqual(h.notifyTransitions(null, before), [], "first poll");
  const after = [
    job("a", "completed", { deployment: { url: "http://127.0.0.1:4100" } }),
    job("b", "failed", { recovery: { title: "The app never answered its health check" } }),
    job("c", "paused", { error: { code: "paused" } }),
    job("d", "completed"),
    job("x", "failed"),
  ];
  assert.deepEqual(h.notifyTransitions(before, after), [
    { jobId: "a", title: "Notes is done", body: "Live at http://127.0.0.1:4100." },
    { jobId: "b", title: "Notes needs you", body: "The app never answered its health check" },
  ]);
  assert.deepEqual(h.notifyTransitions(after, after), [], "no duplicates on the next poll");
  assert.equal(h.notifyTransitions([job("e", "verifying")], [job("e", "interrupted")]).length, 1, "interrupted counts");
  assert.equal(h.notifyTransitions([job("f", "building")], [job("f", "paused", { error: { code: "budget" } })]).length, 1, "a factory pause counts");
});

test("What I saw shows the watchdog's account unless it repeats the summary", () => {
  assert.equal(h.recoverySaw({ watch: { incident: { observed: "build-1 stopped producing output for 9 minutes." } }, recovery: { summary: "s" } }), "build-1 stopped producing output for 9 minutes.");
  assert.equal(h.recoverySaw({ watch: { incident: { observed: "same" } }, recovery: { summary: "same" } }), "");
  assert.equal(h.recoverySaw({}), "");
});
