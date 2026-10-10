import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Anything that would route a CLI to paid API billing instead of the owner's subscription.
const SECRET_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
]);

export function subscriptionEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of SECRET_ENV_KEYS) delete env[key];
  if (!Object.hasOwn(extra, "PORT")) delete env.PORT;
  if (!Object.hasOwn(extra, "HOST")) delete env.HOST;
  env.NO_COLOR = "1";
  return env;
}

function isCutRecord(line) {
  if (!line.trimStart().startsWith("{")) return false;
  try { JSON.parse(line); return false; } catch { return true; }
}

export async function runProcess({
  executable,
  args = [],
  cwd,
  env = {},
  stdin,
  logPath,
  timeoutMs = 10 * 60_000,
  idleTimeoutMs,
  hardTimeoutMs,
  signal,
  onLine,
  keepAlive = false,
}) {
  if (logPath) await mkdir(path.dirname(logPath), { recursive: true });
  const log = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
  const child = spawn(executable, args, {
    cwd,
    env: subscriptionEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  let output = "";
  let lineBuffer = "";
  // Complete lines only, newest last, bounded like `output`. Diagnostics read these instead of the
  // character tail, whose first line is usually a fragment of a JSON record cut at the cap.
  const lines = [];
  let linesSize = 0;
  const keepLine = (line) => {
    lines.push(line);
    linesSize += line.length;
    while (linesSize > 200_000 && lines.length > 1) linesSize -= lines.shift().length;
  };
  let timedOut = false;
  let timeoutReason = null;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let idleTimer = null;
  let hardTimer = null;
  const effectiveIdleTimeout = idleTimeoutMs ?? timeoutMs;
  const effectiveHardTimeout = hardTimeoutMs ?? timeoutMs;

  const terminate = () => {
    if (!child.killed) child.kill("SIGTERM");
  };

  const triggerTimeout = (reason) => {
    if (timedOut || child.exitCode !== null) return;
    timedOut = true;
    timeoutReason = reason;
    terminate();
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  };

  const resetIdleTimer = () => {
    lastActivityAt = Date.now();
    // idleTimeoutMs === null disables the idle clock (used by providers whose CLI
    // streams nothing until the process ends, so silence is not an inactivity signal).
    if (keepAlive || idleTimeoutMs === null || !Number.isFinite(effectiveIdleTimeout) || effectiveIdleTimeout <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => triggerTimeout("idle"), effectiveIdleTimeout);
  };

  const append = (chunk) => {
    const text = chunk.toString();
    resetIdleTimer();
    output = (output + text).slice(-200_000);
    log?.write(text);
    lineBuffer += text;
    const complete = lineBuffer.split(/\r?\n/);
    lineBuffer = complete.pop() ?? "";
    for (const line of complete) if (line.trim()) { keepLine(line); onLine?.(line); }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();

  signal?.addEventListener("abort", terminate, { once: true });
  resetIdleTimer();
  if (!keepAlive && Number.isFinite(effectiveHardTimeout) && effectiveHardTimeout > 0) {
    hardTimer = setTimeout(() => triggerTimeout("hard"), effectiveHardTimeout);
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  }).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    signal?.removeEventListener("abort", terminate);
    if (lineBuffer.trim()) {
      // An unterminated record cut off by a kill is not evidence: its fragment would fall into
      // the plain-text diagnostic fallback. A final plain-text line still counts.
      if (!isCutRecord(lineBuffer)) keepLine(lineBuffer);
      onLine?.(lineBuffer);
    }
    log?.end();
  });

  return {
    ...result,
    output,
    lines,
    timedOut,
    timeoutReason,
    durationMs: Date.now() - startedAt,
    idleForMs: Date.now() - lastActivityAt,
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    child,
  };
}

export function assertAllowedCommand(command) {
  if (!Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("Factory commands must be non-empty arrays of strings.");
  }
  const allowed = new Set(["npm", "node", "npx"]);
  if (!allowed.has(command[0])) {
    throw new Error(`Unsupported executable '${command[0]}'. Allowed: npm, node, npx.`);
  }
  return command;
}
