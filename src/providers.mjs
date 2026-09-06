import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runProcess } from "./process.mjs";

function commandExists(command) {
  const result = spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" });
  return result.status === 0;
}

function codexStatus() {
  if (!commandExists("codex")) return { installed: false, authenticated: false, detail: "Codex CLI is not installed." };
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    installed: true,
    authenticated: result.status === 0 && /Logged in using ChatGPT/i.test(text),
    detail: /Logged in using ChatGPT/i.test(text)
      ? "Signed in with ChatGPT subscription"
      : "Run `codex login` and choose ChatGPT sign-in.",
  };
}

function claudeStatus() {
  if (!commandExists("claude")) return { installed: false, authenticated: false, detail: "Claude Code is not installed." };
  const result = spawnSync("claude", ["auth", "status"], { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = {};
  }
  const apiAuth = String(parsed.authMethod ?? "").toLowerCase().includes("api");
  return {
    installed: true,
    authenticated: Boolean(parsed.loggedIn) && !apiAuth,
    detail: parsed.loggedIn && !apiAuth
      ? "Signed in with Claude subscription"
      : "Run `claude auth login` with a subscription account.",
  };
}

export function discoverProviders() {
  return [
    { id: "codex", label: "Codex", ...codexStatus() },
    { id: "claude", label: "Claude Code", ...claudeStatus() },
  ];
}

async function codexRun({ cwd, prompt, schema, logPath, signal, onEvent, mode = "write", resumeSessionId = null }) {
  await mkdir(cwd, { recursive: true });
  const idleTimeoutMs = minutesFromEnv("SOLOFACTORY_AGENT_IDLE_MINUTES", 6);
  const hardTimeoutMs = minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45);
  const backoffMs = secondsFromEnv("SOLOFACTORY_AGENT_BACKOFF_SECONDS", 15);
  const maxAutoResumes = mode === "read" ? 0 : 1;
  // Factory runs must be reproducible across retries. Do not inherit a newly
  // selected interactive model when resuming an older subscription session.
  const model = process.env.SOLOFACTORY_CODEX_MODEL || "gpt-5.6-sol";
  const reasoningEffort = process.env.SOLOFACTORY_CODEX_REASONING_EFFORT || "low";
  const overallStarted = Date.now();
  let sessionId = resumeSessionId;
  let autoResumes = 0;
  let nextPrompt = prompt;

  for (;;) {
    const remainingHardMs = Math.max(1_000, hardTimeoutMs - (Date.now() - overallStarted));
    const attempt = await runCodexAttempt({
      cwd,
      prompt: nextPrompt,
      schema,
      logPath,
      signal,
      onEvent,
      mode,
      sessionId,
      idleTimeoutMs,
      hardTimeoutMs: remainingHardMs,
      model,
      reasoningEffort,
    });
    sessionId = attempt.sessionId ?? sessionId;
    if (attempt.result.code === 0) {
      const final = await readFile(attempt.resultPath, "utf8");
      return { ...(schema ? JSON.parse(final) : { message: final.trim() }), sessionId, autoResumes };
    }

    const diagnostics = detectProviderDiagnostics(attempt.result.output);
    const mayResume =
      attempt.result.timedOut &&
      attempt.result.timeoutReason === "idle" &&
      diagnostics.length === 0 &&
      sessionId &&
      autoResumes < maxAutoResumes &&
      Date.now() - overallStarted + backoffMs < hardTimeoutMs;

    if (mayResume) {
      autoResumes += 1;
      onEvent?.({
        type: "agent.backoff",
        message: `No agent activity for ${formatMinutes(idleTimeoutMs)}. Preserving the session and resuming once after ${Math.round(backoffMs / 1_000)} seconds.`,
      });
      await delay(backoffMs, signal);
      nextPrompt =
        "Continue from the existing workspace and session. Do not repeat completed analysis or rebuild files that are already correct. Inspect the current files, finish the interrupted stage, run only the checks needed to finish it, and report the result.";
      schema = null;
      continue;
    }

    throw providerFailure({
      provider: "Codex",
      result: attempt.result,
      diagnostics,
      logPath,
      sessionId,
      autoResumes,
      idleTimeoutMs,
      hardTimeoutMs,
    });
  }
}

async function runCodexAttempt({
  cwd,
  prompt,
  schema,
  logPath,
  signal,
  onEvent,
  mode,
  sessionId,
  idleTimeoutMs,
  hardTimeoutMs,
  model,
  reasoningEffort,
}) {
  const nonce = randomUUID();
  const resultPath = path.join(cwd, ".factory", `agent-result-${nonce}.txt`);
  const schemaPath = path.join(cwd, ".factory", `agent-schema-${nonce}.json`);
  await mkdir(path.dirname(resultPath), { recursive: true });
  if (schema) await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const args = sessionId
    ? [
        "exec",
        "resume",
        "--model",
        model,
        "--config",
        `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
        "--skip-git-repo-check",
        "--json",
        "--output-last-message",
        resultPath,
        sessionId,
        "-",
      ]
    : [
        "exec",
        "--model",
        model,
        "--config",
        `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
        "--skip-git-repo-check",
        ...(mode === "read" ? ["--sandbox", "read-only", "--ephemeral"] : ["--approve-for-me"]),
        "--json",
        "--color",
        "never",
        "--output-last-message",
        resultPath,
        "-C",
        cwd,
        ...(schema ? ["--output-schema", schemaPath] : []),
        "-",
      ];

  let observedSessionId = sessionId;
  const result = await runProcess({
    executable: "codex",
    args,
    cwd,
    stdin: prompt,
    logPath,
    signal,
    idleTimeoutMs,
    hardTimeoutMs,
    onLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) observedSessionId = event.thread_id;
        const type = event.type ?? event.event ?? "agent_event";
        onEvent?.({ type, message: humanizeAgentEvent(event) });
      } catch {
        onEvent?.({ type: "agent_output", message: line.slice(0, 500) });
      }
    },
  });
  return { result, resultPath, sessionId: observedSessionId };
}

async function claudeRun({ cwd, prompt, schema, logPath, signal, onEvent, mode = "write" }) {
  await mkdir(cwd, { recursive: true });
  const args = ["-p", "--no-session-persistence", "--output-format", "json"];
  args.push("--permission-mode", mode === "read" ? "plan" : "acceptEdits");
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  const result = await runProcess({
    executable: "claude",
    args,
    cwd,
    stdin: prompt,
    logPath,
    signal,
    // `claude -p --output-format json` prints nothing until the process ends, so
    // CLI silence is NOT an inactivity signal: the idle clock is disabled and only
    // the 45-minute hard cap applies. Killing a working build after 6 quiet minutes
    // was losing real progress (observed 2026-09-03 on the Snap & Go build).
    idleTimeoutMs: null,
    hardTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45),
    onLine(line) {
      onEvent?.({ type: "agent_output", message: line.slice(0, 500) });
    },
  });
  if (result.code !== 0) {
    throw providerFailure({
      provider: "Claude Code",
      result,
      diagnostics: detectProviderDiagnostics(result.output),
      logPath,
      sessionId: null,
      autoResumes: 0,
      idleTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_IDLE_MINUTES", 6),
      hardTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45),
    });
  }
  const envelope = JSON.parse(result.output);
  const final = envelope.structured_output ?? envelope.result;
  return schema ? (typeof final === "string" ? JSON.parse(final) : final) : { message: String(final ?? "").trim() };
}

export function detectProviderDiagnostics(output = "") {
  const diagnosticOutput = executionFailureText(output);
  const rules = [
    {
      code: "model_cli_incompatible",
      pattern: /requires a newer version of Codex|Model metadata .* not found|resuming session with different model/i,
      title: "The configured Codex model is incompatible with this run",
      action: "Resume with the model recorded for this run, or update the Codex CLI. The preserved files do not need to be rebuilt.",
    },
    {
      code: "usage_limit",
      pattern: /usage limit|rate limit|quota exceeded|too many requests|insufficient_quota/i,
      title: "Subscription usage is unavailable",
      action: "Wait for the subscription limit to reset or select another signed-in subscription provider. No automatic retry was attempted.",
    },
    {
      code: "authentication",
      pattern: /not logged in|authentication failed|unauthorized|invalid.*(?:token|credential)/i,
      title: "The coding agent needs sign-in",
      action: "Sign in through the provider CLI, then resume this run from its preserved files.",
    },
    {
      code: "network_unavailable",
      pattern: /ENOTFOUND|ECONNRESET|ETIMEDOUT|Could not resolve|network request .*failed|getaddrinfo/i,
      title: "Package or documentation network access failed",
      action: "Restore network access to the package registry, then resume this run. Starting over is unnecessary.",
    },
    {
      code: "xcode_not_selected",
      pattern: /xcodebuild.*requires Xcode|active developer directory .*CommandLineTools/i,
      title: "Xcode is installed but not selected for command-line builds",
      action: "In Terminal, run `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`, confirm `xcodebuild -version` works, then resume this run. TestFlight does not change the local build-tool selection.",
    },
    {
      code: "permission_denied",
      pattern: /operation not permitted|permission denied|EACCES/i,
      title: "The build was blocked by a local permission",
      action: "Review the named path or command permission, correct it, then resume the preserved run.",
    },
  ];
  return rules.filter((rule) => rule.pattern.test(diagnosticOutput)).map(({ pattern, ...diagnostic }) => diagnostic);
}

function executionFailureText(output) {
  const relevant = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event.item;
      if (item?.type === "error") relevant.push(item.message ?? "");
      if (
        item?.type === "command_execution" &&
        (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0))
      ) {
        relevant.push(item.aggregated_output ?? item.output ?? "");
      }
      if (/failed|error/i.test(event.type ?? "") || event.is_error === true) relevant.push(event.message ?? JSON.stringify(event));
    } catch {
      // Provider startup and transport failures can be plain text rather than event JSON.
      relevant.push(line);
    }
  }
  return relevant.join("\n");
}

function providerFailure({ provider, result, diagnostics, logPath, sessionId, autoResumes, idleTimeoutMs, hardTimeoutMs }) {
  const primary = diagnostics[0];
  const timeoutLabel = result.timeoutReason === "idle"
    ? `${provider} stopped after ${formatMinutes(idleTimeoutMs)} without output`
    : result.timeoutReason === "hard"
      ? `${provider} reached the ${formatMinutes(hardTimeoutMs)} safety cap`
      : `${provider} exited with code ${result.code}`;
  const error = new Error(primary ? `${primary.title}. ${primary.action}` : `${timeoutLabel}. Partial work is preserved.`);
  error.code = primary?.code ?? (result.timedOut ? `agent_${result.timeoutReason}_timeout` : "provider_failed");
  error.details = {
    provider,
    logPath,
    sessionId,
    diagnostics,
    timedOut: result.timedOut,
    timeoutReason: result.timeoutReason,
    idleForMs: result.idleForMs,
    durationMs: result.durationMs,
    autoResumes,
    canResume: Boolean(sessionId),
  };
  return error;
}

function minutesFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60_000;
}

function secondsFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value >= 0 ? value : fallback) * 1_000;
}

function formatMinutes(milliseconds) {
  const minutes = milliseconds / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });
}

function humanizeAgentEvent(event) {
  if (event.type === "thread.started") return "Agent session started";
  if (event.type === "turn.started") return "Agent is working";
  if (event.type === "turn.completed") return "Agent turn completed";
  if (event.type === "item.completed") {
    return event.item?.type === "agent_message" ? "Agent produced a result" : `Completed ${event.item?.type ?? "work item"}`;
  }
  return String(event.message ?? event.type ?? "Agent event").slice(0, 500);
}

export function createProvider(id) {
  if (id === "codex") return { id, run: codexRun };
  if (id === "claude") return { id, run: claudeRun };
  throw new Error(`Unknown provider '${id}'.`);
}
