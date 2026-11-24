// The return summary and "How do you know it works?" (spec item 7). Pure: the server reads the
// full event file and the log folder, these only turn them into plain words. No agent turn.
import { riskLine } from "./risk.mjs";

const PROOF_EVENTS = new Set(["gate.passed", "gate.failed", "gate.skipped"]);
const STATUS = { "gate.passed": "passed", "gate.failed": "failed", "gate.skipped": "skipped" };

// The last result of each gate, per feature, in first-seen order. Small enough to cache per run.
export function proofResults(events) {
  const last = new Map();
  for (const event of events) {
    if (!PROOF_EVENTS.has(event.type) || !event.gate) continue;
    const feature = event.feature ?? event.slice ?? null;
    const key = `${event.gate}\u0000${feature ?? ""}`;
    last.delete(key); // re-insert so order follows the latest run of each gate
    last.set(key, { gate: event.gate, feature, status: STATUS[event.type], message: event.message ?? "", passedCases: event.cases?.passed ?? 0 });
  }
  return [...last.values()];
}

const list = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PARKED_WORDS = {
  paused: "The run is paused",
  interrupted: "The run was interrupted",
  cancelled: "The run was stopped",
  failed: "The run stopped on a problem",
};

export function runSummary(job, proofs) {
  const done = new Set(job.sliceDone ?? []);
  const titles = (job.approvedPlan?.plan?.slices ?? []).filter((slice) => done.has(slice.id)).map((slice) => slice.title);
  const sentences = [];
  if (titles.length) sentences.push(`Built ${plural(titles.length, "feature")}: ${list(titles)}.`);
  else if (job.brief?.workingName) sentences.push(`Built ${job.brief.workingName}.`);

  const passed = proofs.filter((proof) => proof.status === "passed");
  const cases = passed.reduce((sum, proof) => sum + proof.passedCases, 0);
  const failing = proofs.filter((proof) => proof.status === "failed").length;
  const checked = [
    passed.length && `${plural(passed.length, "check")} passed${cases ? `, covering ${plural(cases, "test case")}` : ""}`,
    failing && `${plural(failing, "check")} last failed`,
  ].filter(Boolean);
  if (checked.length) sentences.push(`${checked.join("; ").replace(/^./, (c) => c.toUpperCase())}.`);

  // Never claim "live" unless it is: a rolled-back or parked run says what it is instead.
  if (job.state === "completed" && job.deployment?.url && !job.rolledBack) sentences.push(`It is live at ${job.deployment.url}.`);
  else if (job.rolledBack) sentences.push("This release was rolled back, so it is not what is live now.");
  else if (PARKED_WORDS[job.state]) sentences.push(`${PARKED_WORDS[job.state]}, so nothing from it is live yet.`);

  const held = [];
  if (job.waivedProofs?.length) held.push(`you waived ${plural(job.waivedProofs.length, "proof")} (${job.waivedProofs.map((proof) => proof.id).join(", ")})`);
  if (job.dataBackup?.confirmedAt) held.push("you confirmed the data backup before it went live");
  if (held.length) sentences.push(`${held.join(", and ").replace(/^./, (c) => c.toUpperCase())}.`);
  return sentences.join(" ");
}

// The evidence view. null fields mean "not recorded for this run"; the hub says so in words.
export function runEvidence(job, proofs, logs) {
  return {
    proofs: proofs.length ? proofs : null,
    logs: logs?.length ? logs : null,
    deployChecks: job.state === "completed" && job.deployment ? "Health, metrics and home page answered at deploy." : null,
    riskLine: riskLine(job.risks),
    risks: Array.isArray(job.risks) && job.risks.length ? job.risks : null,
  };
}
