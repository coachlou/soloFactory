// Verification and agent cost of one run, derived only from its event log: no second ledger.
// Events written before feature/candidate/command fields existed are measured with labelled gaps.
import { addUsage } from "./providers.mjs";

const PARKED = new Set(["job.paused", "job.failed", "job.interrupted"]);
const RESUMED = new Set(["job.resumed", "job.restarted"]);

// What an agent turn was for, from its stage label.
export function activity(label = "") {
  if (/^(specification|feature-plan|plan-|recovery-(plan|correction|schema-fix))/.test(label)) return "planning";
  if (label.startsWith("repair")) return "repair";
  if (label === "review" || label === "review-resume" || /(^feature-review-|-review-\d+$)/.test(label)) return "review";
  return "implement";
}

const at = (event) => new Date(event.at).getTime();
const labelOf = (event) => event.stage ?? event.message?.match(/ started (\S+)$/)?.[1] ?? "unknown";
// Legacy recovery turns name their feature after the phase UUID: recovery-<uuid>-<feature>[-resume|-review-N].
const recoveryFeature = (label) => label.match(/^recovery-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-(.+?)(?:-resume|-review-\d+)?$/)?.[1] ?? null;
const argvOf = (event) => event.command ? JSON.stringify(event.command) : JSON.stringify(event.message?.replace(/^[^:]+: /, "") ?? event.gate);

export function measureRun(events) {
  const buckets = new Map();
  const bucket = (id) => {
    if (!buckets.has(id)) buckets.set(id, {
      id, agent: { turns: 0, interrupted: 0, ms: 0, byActivity: {}, tokens: null, turnsWithoutUsage: 0 },
      gates: { runs: 0, ms: 0, failed: 0, timedOut: 0, interrupted: 0, repeats: 0, unchangedRepeats: 0, reusable: 0, candidateUnknown: 0, byGate: {} },
    });
    return buckets.get(id);
  };
  // Legacy events carry no feature: follow slice.started/slice.completed instead.
  let legacyFeature = null;
  const place = (event, kind) => ("feature" in event ? event.feature : legacyFeature) ?? (kind === "planning" ? "planning" : "integration");
  const history = [];
  let agent = null;
  let gate = null;
  let parkedAt = null;
  let parkedMs = 0;
  const closeAgent = (end) => {
    const b = bucket(agent.bucket);
    if (end) {
      const ms = at(end) - agent.start;
      b.agent.ms += ms;
      b.agent.byActivity[agent.kind] = (b.agent.byActivity[agent.kind] ?? 0) + ms;
      if (end.usage) b.agent.tokens = addUsage(b.agent.tokens, end.usage); else b.agent.turnsWithoutUsage += 1;
    } else { b.agent.interrupted += 1; b.agent.turnsWithoutUsage += 1; }
    agent = null;
  };
  const closeGate = (end) => {
    const b = bucket(gate.bucket);
    const row = (b.gates.byGate[gate.argv] ??= { gate: gate.name, argv: gate.argv, runs: 0, ms: 0, passed: 0, failed: 0, timedOut: 0, interrupted: 0 });
    row.runs += 1;
    if (!end) { b.gates.interrupted += 1; row.interrupted += 1; }
    else {
      b.gates.ms += end.durationMs ?? 0; row.ms += end.durationMs ?? 0;
      const timedOut = end.type === "gate.failed" && /timed out/.test(end.message ?? "");
      if (end.type === "gate.passed") row.passed += 1;
      else if (timedOut) { b.gates.timedOut += 1; row.timedOut += 1; }
      else { b.gates.failed += 1; row.failed += 1; }
    }
    history.push({ argv: gate.argv, candidate: gate.candidate, passed: end?.type === "gate.passed" });
    gate = null;
  };
  for (const event of events) {
    if (event.type === "slice.started") legacyFeature = event.slice;
    if (event.type === "slice.completed" || event.type === "recovery.slice.completed") legacyFeature = null;
    if (PARKED.has(event.type) && parkedAt === null) parkedAt = at(event);
    // Legacy recovery restarts work without job.resumed: the first new turn or gate ends the parking.
    const restarted = RESUMED.has(event.type) || event.type === "agent.started" || event.type === "gate.started";
    if (restarted && parkedAt !== null) { parkedMs += at(event) - parkedAt; parkedAt = null; }
    if (event.type === "agent.started") {
      if (agent) closeAgent(null);
      const label = labelOf(event);
      if (!("feature" in event) && recoveryFeature(label)) legacyFeature = recoveryFeature(label);
      const kind = activity(label);
      agent = { label, kind, start: at(event), bucket: place(event, kind) };
      bucket(agent.bucket).agent.turns += 1;
    } else if (event.type === "agent.completed" && agent) closeAgent(event);
    else if (event.type === "gate.started") {
      if (gate) closeGate(null);
      const argv = argvOf(event);
      const b = bucket(place(event));
      gate = { name: event.gate, argv, candidate: event.candidate ?? null, bucket: b.id };
      b.gates.runs += 1;
      const earlier = history.filter((item) => item.argv === argv);
      if (earlier.length) b.gates.repeats += 1;
      if (!gate.candidate) { if (event.gate !== "install") b.gates.candidateUnknown += 1; }
      else {
        const same = earlier.filter((item) => item.candidate === gate.candidate);
        if (same.length) b.gates.unchangedRepeats += 1;
        if (same.some((item) => item.passed)) b.gates.reusable += 1;
      }
    } else if ((event.type === "gate.passed" || event.type === "gate.failed") && gate && event.gate === gate.name) closeGate(event);
  }
  if (agent) closeAgent(null);
  if (gate) closeGate(null);
  const first = events[0] ? at(events[0]) : 0;
  const last = events.at(-1) ? at(events.at(-1)) : 0;
  const list = [...buckets.values()].map((b) => ({ ...b, gates: { ...b.gates, byGate: Object.values(b.gates.byGate).sort((x, y) => y.ms - x.ms) } }));
  const sum = (pick) => list.reduce((total, b) => total + pick(b), 0);
  const activeMs = sum((b) => b.agent.ms) + sum((b) => b.gates.ms);
  const wallMs = last - first;
  const totalParkedMs = parkedMs + (parkedAt !== null ? last - parkedAt : 0);
  const overlapMs = Math.max(0, totalParkedMs + activeMs - wallMs);
  return {
    wallMs, parkedMs: totalParkedMs, activeMs, overlapMs,
    agentMs: sum((b) => b.agent.ms), gateMs: sum((b) => b.gates.ms),
    tokens: list.reduce((total, b) => b.agent.tokens ? addUsage(total, b.agent.tokens) : total, null),
    buckets: list,
    unavailable: [
      ...(overlapMs ? [`Parked and active intervals overlap by ${(overlapMs / 1000).toFixed(1)}s (a turn or gate ran while the run was parked), so the wall-time split is not a partition.`] : []),
      "Commands workers run inside their own turns are not observed; only controller gates are counted.",
      ...(sum((b) => b.gates.candidateUnknown) ? ["Some gate runs predate candidate recording, so unchanged-candidate repeats are a lower bound."] : []),
      ...(sum((b) => b.agent.turnsWithoutUsage) ? ["Some agent turns reported no token usage (interrupted, or the provider gave none)."] : []),
    ],
  };
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const tok = (usage) => usage ? `${usage.inputTokens ?? 0} in (${usage.cachedInputTokens ?? 0} cached) / ${usage.outputTokens ?? 0} out` : "n/a";

// Operator-readable Markdown: run totals, then one row per feature and its costliest gates.
export function formatMeasurement(m) {
  const lines = [
    `Wall ${secs(m.wallMs)} · parked ${secs(m.parkedMs)} · agent ${secs(m.agentMs)} · controller gates ${secs(m.gateMs)} · other ${secs(Math.max(0, m.wallMs - m.parkedMs - m.activeMs))}`,
    `Tokens: ${tok(m.tokens)}`,
    "",
    "| Phase | Agent turns | Implement | Review | Repair | Planning | Gate runs | Gate time | Failed | Timed out | Repeats | Unchanged-candidate repeats | Reusable after pass | Tokens |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...m.buckets.map((b) => `| ${b.id} | ${b.agent.turns}${b.agent.interrupted ? ` (${b.agent.interrupted} interrupted)` : ""} | ${secs(b.agent.byActivity.implement ?? 0)} | ${secs(b.agent.byActivity.review ?? 0)} | ${secs(b.agent.byActivity.repair ?? 0)} | ${secs(b.agent.byActivity.planning ?? 0)} | ${b.gates.runs} | ${secs(b.gates.ms)} | ${b.gates.failed} | ${b.gates.timedOut} | ${b.gates.repeats} | ${b.gates.unchangedRepeats} | ${b.gates.reusable} | ${tok(b.agent.tokens)} |`),
    "",
    "Costliest gates per phase:",
    ...m.buckets.filter((b) => b.gates.byGate.length).map((b) => `- ${b.id}: ${b.gates.byGate.slice(0, 3).map((g) => `${g.gate} ${secs(g.ms)} ×${g.runs}`).join(", ")}`),
    "",
    ...m.unavailable.map((note) => `Not measured: ${note}`),
  ];
  return lines.join("\n");
}
