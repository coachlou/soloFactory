import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

// Run supervision: observes the factory's own active run and reports a status. It never edits job
// state, starts a worker or retries anything; recovery decisions stay with the controller.

const PROGRESS_EVENTS = new Set(["gate.passed", "git.committed", "plan.approved", "slice.completed", "recovery.slice.completed", "job.completed"]);
const NOTABLE = new Set(["Progress needs checking", "Recovering"]);

// Only these settings live here; idle/hard/backoff stay with the providers that enforce them.
export function watchConfig(env = process.env) {
  const read = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
    return Number(raw);
  };
  return {
    // 0 turns the progress warning off; idle and hard caps still bound every worker.
    progressMs: read("SOLOFACTORY_PROGRESS_MINUTES", 20, 0, 240) * 60_000,
    loopThreshold: read("SOLOFACTORY_LOOP_THRESHOLD", 3, 2, 10),
    // Hard limit for each test/proof gate (install keeps at least 10). Raised for slow aggregate proofs; still bounded.
    gateMs: read("SOLOFACTORY_GATE_MINUTES", 5, 1, 60) * 60_000,
    tickMs: 15_000,
  };
}

// Volatile parts of gate output that differ between otherwise identical failures.
export function normalizeFailure(text = "") {
  return String(text)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/\S*/g, "<tmp>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s|seconds?|milliseconds?)\b/g, "<duration>")
    .replace(/(?:duration_ms|elapsed|took)\D{0,3}\d+(?:\.\d+)?/gi, "<duration>")
    .replace(/:\d{4,5}\b/g, ":<port>")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(-8_000);
}

// A completed failed attempt: what failed, where, and on which source candidate.
export function failureSignature(failure, { scope, candidate }) {
  const details = failure.details ?? {};
  const checks = (details.failedChecks ?? []).map((check) => check.id ?? check).sort();
  return {
    scope,
    code: failure.code ?? "unexpected_error",
    gate: details.gate ?? null,
    checks: checks.length ? checks : [...(details.proofKeys ?? [])].sort(),
    digest: createHash("sha256").update(normalizeFailure(details.output ?? failure.message)).digest("hex").slice(0, 16),
    candidate,
  };
}

// The last `threshold` attempts are the same failure on the same unchanged candidate. An unknown
// candidate never counts as unchanged: a false loop would stop work the repair budget still allows.
export function repeatedFailure(attempts = [], threshold = 3) {
  const recent = attempts.slice(-threshold);
  if (recent.length < threshold || !recent[0].candidate) return null;
  const key = ({ scope, code, gate, checks, digest, candidate }) => JSON.stringify([scope, code, gate, checks, digest, candidate]);
  return recent.every((item) => key(item) === key(recent[0])) ? { count: threshold, scope: recent[0].scope, gate: recent[0].gate, checks: recent[0].checks, candidate: recent[0].candidate, logs: recent.map((item) => item.log).filter(Boolean) } : null;
}

// Pure status rule shared by the monitor, the API and the dashboard.
export function supervisionStatus(obs, now, { progressMs }) {
  if (!obs) return "Working";
  if (obs.recovering) return "Recovering";
  if (obs.worker?.kind === "command") return "Waiting for command";
  if (obs.worker?.kind !== "agent") return "Working";
  if (obs.activityMono === null || obs.activityMono < obs.worker.startedMono) return "Progress unknown";
  const since = Math.max(obs.progressMono ?? 0, obs.stageMono ?? 0);
  return progressMs > 0 && now - since > progressMs ? "Progress needs checking" : "Working";
}

export class RunMonitor {
  constructor({ jobId, emit, config, now = () => performance.now(), wall = () => Date.now() }) {
    Object.assign(this, { jobId, emit, config, now, wall });
    const t = now();
    this.obs = { stage: null, stageMono: t, stageSeq: 0, worker: null, activityMono: null, activityAt: null, progressMono: t, progressAt: null, progressType: null, recovering: false };
    this.seen = new Set();
    this.status = null;
    this.incident = null;
    this.timer = null;
  }

  start() {
    // One timer per active run, stopped with the run.
    this.timer = setInterval(() => this.tick(), this.config.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  iso() { return new Date(this.wall()).toISOString(); }

  // Durable events the controller already writes. Only accepted results count as progress;
  // the same result repeated within one stage (log chatter, a re-run proof) does not.
  observe(event) {
    if (event.type === "stage.started") Object.assign(this.obs, { stage: event.message, stageMono: this.now(), stageSeq: this.obs.stageSeq + 1 });
    if (!PROGRESS_EVENTS.has(event.type)) return;
    const key = `${this.obs.stageSeq}:${event.type}:${event.gate ?? event.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    Object.assign(this.obs, { progressMono: this.now(), progressAt: this.iso(), progressType: event.type });
    this.tick();
  }

  activity() {
    this.obs.activityMono = this.now();
    this.obs.activityAt = this.iso();
  }

  spawned({ kind, label, pid, gate = null, command = null, hardLimitMs = null }) {
    this.obs.recovering = false;
    this.obs.worker = { kind, label, pid, gate, command, hardLimitMs, startedMono: this.now(), startedAt: this.iso() };
    this.tick();
  }

  exited() {
    this.obs.worker = null;
    this.tick();
  }

  recovering() {
    this.obs.recovering = true;
    this.tick();
  }

  snapshot() {
    const { worker, stage, activityAt, progressAt, progressType } = this.obs;
    return {
      status: supervisionStatus(this.obs, this.now(), this.config),
      monitoring: Boolean(this.timer),
      stage,
      worker: worker && { kind: worker.kind, label: worker.label, pid: worker.pid, gate: worker.gate, command: worker.command, startedAt: worker.startedAt, ageMs: Math.round(this.now() - worker.startedMono), hardLimitMs: worker.hardLimitMs },
      lastActivityAt: activityAt,
      lastProgressAt: progressAt,
      lastProgressType: progressType,
      progressWindowMs: this.config.progressMs,
      incident: this.incident,
    };
  }

  // Emits only on a status transition, never per tick.
  tick() {
    const status = supervisionStatus(this.obs, this.now(), this.config);
    if (status === this.status) return;
    const previous = this.status;
    this.status = status;
    if (status === "Progress needs checking") {
      const minutes = Math.round(this.config.progressMs / 60_000);
      this.incident = {
        trigger: "progress_window",
        stage: this.obs.stage,
        worker: this.obs.worker?.label ?? null,
        observed: `The worker is still active (last activity ${this.obs.activityAt}) but ${this.obs.stage ?? "this stage"} has produced no accepted result for over ${minutes} minutes.`,
        uncertain: "This is a warning, not proof of a stall: the worker may still finish. It is not stopped; the idle and hard caps remain the deadlines.",
        lastProgressAt: this.obs.progressAt,
        at: this.iso(),
      };
    }
    // Waiting and Progress unknown follow gate.started and agent.started, which are already recorded;
    // only a warning, a recovery and the return from either are news.
    if (![status, previous].some((item) => NOTABLE.has(item))) return;
    this.emit({ type: "supervision.changed", status, message: `Supervision: ${status}` })?.catch?.(() => {});
  }
}

// Worker ownership across restarts: a recorded pid that still exists may still be writing.
// ponytail: pid reuse can keep an unrelated process "alive"; that errs toward parking, never a second writer.
export function workerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const clip = (text, max = 400) => {
  const redacted = String(text ?? "").replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "<redacted>").replace(/(Bearer|token|api[_-]?key)(["':=\s]+)\S+/gi, "$1$2<redacted>");
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};

// Bounded incident for the dashboard and recovery packet: what was observed, what is uncertain,
// what was tried, what is preserved and the one next action the shared policy allows.
export function incidentRecord(job) {
  const details = job.error?.details ?? {};
  const loop = details.loop;
  const observed = job.watch?.observed ?? {};
  const next = job.recovery?.nextAction;
  const continuations = Object.values(job.watch?.continuations ?? {}).reduce((sum, used) => sum + used, 0);
  const label = details.logPath ? details.logPath.split("/").pop().replace(/\.log$/, "") : observed.worker?.label ?? job.failedState;
  const minutes = (ms) => `${Math.max(1, Math.round((ms ?? 0) / 60_000))} minute${Math.round((ms ?? 0) / 60_000) === 1 ? "" : "s"}`;
  const code = job.error?.code;
  const featureCursor = job.recoveryPhase?.cursor ?? job.featureCursor;
  const featureRepairs = featureCursor?.id && Number.isFinite(featureCursor.attemptBefore) ? (job.attempt ?? 0) - featureCursor.attemptBefore : null;
  const turns = (n) => `${n} repair turn${n === 1 ? "" : "s"}`;
  const verified = [...new Set([...(job.sliceDone ?? []), ...(job.recoveryPhase?.done ?? [])])];
  return {
    trigger: loop ? "repeated_failure" : details.timeoutReason ? `${details.timeoutReason}_timeout` : code ?? "unknown",
    stage: job.failedState ?? null,
    cursor: job.recoveryPhase ? { recoveryPhase: job.recoveryPhase.id, status: job.recoveryPhase.status, feature: job.recoveryPhase.cursor?.id ?? null, substage: job.recoveryPhase.cursor?.substage ?? null }
      : job.featureCursor ? { feature: job.featureCursor.id, substage: job.featureCursor.substage } : null,
    observed: clip(loop ? `${loop.gate ?? "A check"} failed the same way ${loop.count} times on unchanged code${loop.checks?.length ? ` (${loop.checks.join(", ")})` : ""}.`
      : details.timeoutReason === "idle" ? `${label} stopped producing output for ${minutes(details.idleForMs)}.`
      : details.timeoutReason === "hard" ? `${label} reached its ${minutes(details.durationMs)} safety cap.`
      : code === "worker_unconfirmed" ? `A worker from before the restart (pid ${details.pid}, ${details.label}) was still running.`
      : job.error?.message),
    uncertain: loop ? "Whether another repair would help: the last repairs left the code unchanged."
      : details.timeoutReason === "idle" ? "Why the worker went quiet. Silence alone does not show a sign-in, quota or network problem."
      : code === "worker_unconfirmed" ? "Whether that worker is still writing to the workspace."
      : "Nothing beyond the recorded error.",
    // job.attempt counts the whole run; the feature's own share is measured from its cursor baseline.
    tried: `${featureRepairs == null ? `${turns(job.attempt ?? 0)} in the whole run` : `${turns(featureRepairs)} on ${featureCursor.id} (${job.attempt ?? 0} in the whole run)`}; ${continuations} automatic continuation${continuations === 1 ? "" : "s"}.`,
    preserved: `Workspace files, logs and evidence are preserved${verified.length ? `, including ${verified.length} verified feature${verified.length === 1 ? "" : "s"} (${verified.join(", ")})` : ""}.`,
    nextAction: next?.label ?? clip(next?.reason ?? ""),
    selectedAction: next?.action ?? null,
    outcome: job.state,
    lastActivityAt: observed.lastActivityAt ?? null,
    lastProgressAt: observed.lastProgressAt ?? null,
    lastProgressType: observed.lastProgressType ?? null,
    fingerprint: loop?.candidate?.slice(0, 16) ?? null,
    attempts: { repairs: job.attempt ?? 0, continuations },
    logs: [details.logPath, ...(loop?.logs ?? [])].filter(Boolean).slice(0, 5),
    at: new Date().toISOString(),
  };
}
