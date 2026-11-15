import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runProcess, subscriptionEnvironment } from "./process.mjs";

// ponytail: PATH scan rather than shelling out to `which`, which needed a hardcoded
// /usr/bin/env and so reported every provider missing anywhere that path is absent.
// PATHEXT is the Windows half; harmless elsewhere, where it is unset and the suffix is "".
function commandExists(command) {
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      try {
        accessSync(path.join(dir, command + suffix), constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

function codexStatus() {
  if (!commandExists("codex")) return { installed: false, authenticated: false, detail: "Codex CLI is not installed." };
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8", env: subscriptionEnvironment() });
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
  // Same stripped environment the runs get, so this checks the auth a build will actually use.
  const result = spawnSync("claude", ["auth", "status"], { encoding: "utf8", env: subscriptionEnvironment() });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Older Claude Code has no `auth status`; a signed-in owner would otherwise be told to sign in.
    return { installed: true, authenticated: false, detail: "Could not read Claude Code's sign-in. Run `claude update`, then reload." };
  }
  // Whatever API source survives the stripped env comes from settings (e.g. apiKeyHelper) and would bill the API.
  const usesApi =
    String(parsed.authMethod ?? "").toLowerCase().includes("api") ||
    Boolean(parsed.apiKeySource) ||
    (parsed.apiProvider && parsed.apiProvider !== "firstParty");
  const problem = !parsed.loggedIn
    ? "Run `claude auth login` with your Claude subscription account, then reload."
    : usesApi
      ? "Claude Code is set to use an API key, not your subscription. Remove apiKeyHelper from ~/.claude/settings.json, run `claude auth login`, then reload."
      : null;
  return { installed: true, authenticated: !problem, detail: problem ?? "Signed in with Claude subscription" };
}

export function discoverProviders() {
  return [
    { id: "codex", label: "Codex", ...codexStatus() },
    { id: "claude", label: "Claude Code", ...claudeStatus() },
  ];
}

// Stage tiers a profile sets: the Guide interview, planning and every review, and the coding stages.
const REASONING_STAGE = /^(specification(?:-|$)|feature-plan(?:-|$)|plan-review$|plan-correction-|recovery-plan-)|(?:^|-)review(?:-|$)/;
export function stageTier(stage = "") {
  return stage === "interview" ? "guide" : REASONING_STAGE.test(stage) ? "plan" : "code";
}

// A run's profile (job.models) names a model and effort per tier. Both are passed to a CLI as arguments.
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export function checkModels(models) {
  if (models == null) return null;
  if (typeof models !== "object") throw new Error("A profile must name a model and effort for each stage.");
  const out = {};
  for (const tier of ["guide", "plan", "code"]) {
    const { model, effort } = models[tier] ?? {};
    if (!MODEL_ID.test(String(model ?? ""))) throw new Error(`The ${tier} model must be a model id such as gpt-6-luna or sonnet.`);
    if (!EFFORTS.includes(effort)) throw new Error(`The ${tier} effort must be one of ${EFFORTS.join(", ")}.`);
    out[tier] = { model: String(model), effort };
  }
  if (models.advisor !== undefined) out.advisor = Boolean(models.advisor);
  return out;
}

async function codexRun({ cwd, prompt, schema, logPath, signal, onEvent, mode = "write", resumeSessionId = null, context = {}, models = null }) {
  await mkdir(cwd, { recursive: true });
  const idleTimeoutMs = minutesFromEnv("SOLOFACTORY_AGENT_IDLE_MINUTES", 6);
  const hardTimeoutMs = minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45);
  const backoffMs = secondsFromEnv("SOLOFACTORY_AGENT_BACKOFF_SECONDS", 15);
  const maxAutoResumes = mode === "read" ? 0 : 1;
  // Factory runs must be reproducible across retries. Do not inherit a newly
  // selected interactive model when resuming an older subscription session.
  // A run without a profile keeps the one env model for every stage, so older runs resume as they started.
  const tier = models?.[stageTier(context.stage)];
  const model = tier?.model || process.env.SOLOFACTORY_CODEX_MODEL || "gpt-6.1-sol";
  const reasoningEffort = tier?.effort || process.env.SOLOFACTORY_CODEX_REASONING_EFFORT || "medium";
  const overallStarted = Date.now();
  let sessionId = resumeSessionId;
  let autoResumes = 0;
  let usage = null;
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
      context,
    });
    sessionId = attempt.sessionId ?? sessionId;
    usage = addUsage(usage, attempt.usage);
    if (attempt.result.code === 0) {
      const final = await readFile(attempt.resultPath, "utf8");
      return { ...(schema ? JSON.parse(final) : { message: final.trim() }), sessionId, autoResumes, usage };
    }

    const diagnostics = detectProviderDiagnostics(attempt.result.lines.join("\n"));
    const mayResume =
      attempt.result.timedOut &&
      attempt.result.timeoutReason === "idle" &&
      diagnostics.length === 0 &&
      sessionId &&
      autoResumes < maxAutoResumes &&
      Date.now() - overallStarted + backoffMs < hardTimeoutMs &&
      // The controller's durable allowance for this stage invocation: recorded before the
      // continuation is dispatched, and refused when an earlier process already used it.
      (await context.allowContinuation?.() ?? true);

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
      usage,
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
  context = {},
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
  let usage = null;
  const result = await runProcess({
    executable: "codex",
    args,
    cwd,
    stdin: prompt,
    logPath,
    signal,
    idleTimeoutMs,
    hardTimeoutMs,
    onSpawn: (child) => context.onSpawn?.(child, { hardTimeoutMs }),
    onActivity: context.onActivity,
    onLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && event.thread_id) observedSessionId = event.thread_id;
        if (event.type === "turn.completed") usage = addUsage(usage, codexUsage(event.usage, model));
        const type = event.type ?? event.event ?? "agent_event";
        onEvent?.({ type, message: humanizeAgentEvent(event) });
      } catch {
        onEvent?.({ type: "agent_output", message: line.slice(0, 500) });
      }
    },
  });
  return { result, resultPath, sessionId: observedSessionId, usage };
}

// Claude's prefix allow-list never matches compound commands: smoke 13's 24 denials were all `cd <project> && ...`,
// pipes, loops, heredoc writes or python edits. Each denial costs the turn a round trip.
const CLAUDE_SHELL_RULE = `Shell: you are already in the project root. Only plain single commands are approved, one per Bash
call; a command with cd, &&, ;, |, a loop, a heredoc or a redirect is denied without running. Read files with
Read, create and change them with Write and Edit, and search with Glob and Grep.`;

async function claudeRun({ cwd, prompt, schema, logPath, signal, onEvent, mode = "write", resumeSessionId = null, context = {}, models = null }) {
  await mkdir(cwd, { recursive: true });
  const reasoningTask = stageTier(context.stage) === "plan";
  // The Guide interview turns a vague idea into a brief every later stage builds on, so it gets Opus at medium
  // with an Opus advisor (Lou, 2026-11-08), not the Sonnet build profile. Turns are few, so the cost is small.
  const guideTask = context.stage === "interview";
  const model = guideTask
    ? process.env.SOLOFACTORY_CLAUDE_GUIDE_MODEL || "opus"
    : reasoningTask
    ? process.env.SOLOFACTORY_CLAUDE_REASONING_MODEL || "opus"
    // Builders and repairs on Sonnet: same review pass rate as Opus on the 2026-11-08 smokes at about a third
    // less per feature, and Opus filled a member's 5h subscription window in one run. Judgment stays on Opus.
    : process.env.SOLOFACTORY_CLAUDE_MODEL || "sonnet";
  const effort = guideTask
    ? process.env.SOLOFACTORY_CLAUDE_GUIDE_EFFORT || "medium"
    : reasoningTask
    ? process.env.SOLOFACTORY_CLAUDE_REASONING_EFFORT || "low"
    : process.env.SOLOFACTORY_CLAUDE_EFFORT || "medium";
  // ponytail: Claude Code takes an advisor model only, not an advisor effort; the advisor runs at its own level.
  const advisor = guideTask ? (models?.advisor === false ? "" : process.env.SOLOFACTORY_CLAUDE_GUIDE_ADVISOR ?? "opus") : "";
  // A custom profile replaces the env and built-in choices for its stage; the built-in Claude profile sends none.
  const tier = models?.[stageTier(context.stage)];
  // stream-json, not json: json printed nothing until exit, so 45-minute build turns left empty logs, fed the
  // watchdog nothing and had no session id to continue after a cap (SEARCH-UI, 2026-10-14). Sessions persist
  // so a capped or interrupted turn resumes its own context instead of starting cold.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", tier?.model || model, "--effort", tier?.effort || effort];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // Agent turns must not inherit the owner's personal Claude Code config: on 2026-10-12 builds ran the user's
  // Fable advisor (62% of a feature's cost), an rtk hook that rewrote commands, and every claude.ai connector.
  args.push("--setting-sources", "project,local", "--strict-mcp-config");
  if (advisor) args.push("--settings", JSON.stringify({ advisorModel: advisor }));
  args.push("--permission-mode", mode === "read" ? "plan" : "acceptEdits");
  // Headless acceptEdits silently denies unlisted shell commands, so repair agents shipped fixes they could not run
  // (~20 denials per repair on 2026-09-27; 46 across smoke 11's builds). Allow the commands the controller's own
  // gates run, including the plan's proof commands, plus read-only orientation. Plain node too: a member run
  // (2026-11-03) lost 56 calls to `node scripts/build.js` and `node -e`, and npm scripts already run any node.
  if (mode !== "read") {
    const proofs = [...new Set((context.proofCommands ?? []).map((command) => `Bash(${command.join(" ")}:*)`))];
    args.push("--disallowedTools", "Agent");
    args.push("--allowedTools", "Bash(npm install:*)", "Bash(npm test:*)", "Bash(npm run build:*)", "Bash(node .factory/check-plan.mjs:*)",
      "Bash(node --test:*)", "Bash(node:*)", "Bash(ls:*)", "Bash(git ls-files:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", ...proofs);
  }
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  // Tool round trips per turn. 320 real turns (2026-09..11 logs) used p50 18, p99 77, max 141, so the default only
  // stops a turn that is going round in circles; the 45-minute cap still bounds time. 0 turns it off.
  const maxTurns = claudeMaxTurns();
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  let sessionId = resumeSessionId;
  // Usage per assistant message, kept so a killed turn still reports what it spent (see partialClaudeUsage).
  const spent = new Map();
  const result = await runProcess({
    executable: "claude",
    args,
    cwd,
    stdin: `${prompt}\n\n${CLAUDE_SHELL_RULE}`,
    logPath,
    signal,
    // `claude -p --output-format json` prints nothing until the process ends, so
    // CLI silence is NOT an inactivity signal: the idle clock is disabled and only
    // the 45-minute hard cap applies. Killing a working build after 6 quiet minutes
    // was losing real progress (observed 2026-09-03 on the Snap & Go build).
    idleTimeoutMs: null,
    hardTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45),
    onSpawn: (child) => context.onSpawn?.(child, { hardTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45) }),
    onActivity: context.onActivity,
    onLine(line) {
      const { record, sessionId: seen, event } = claudeStreamLine(line);
      sessionId = seen ?? sessionId;
      if (record?.type === "assistant" && record.message?.usage) spent.set(record.message.id ?? spent.size, record.message.usage);
      if (event) onEvent?.(event);
    },
  });
  // At the cap Claude ends with an error_max_turns result (exit code varies by CLI version). It is not a timeout:
  // no automatic continuation, so a turn that went round in circles is not given another lap.
  const capped = result.lines.map((line) => claudeStreamLine(line).record).findLast((record) => record?.type === "result" && record.subtype === "error_max_turns");
  if (capped) {
    const error = new Error(`Claude Code used its ${maxTurns}-step limit for one turn without finishing. Partial work is preserved. Resume starts a fresh turn; raise SOLOFACTORY_AGENT_MAX_TURNS if this work genuinely needs more steps.`);
    error.code = "agent_turn_cap";
    error.details = { provider: "Claude Code", logPath, sessionId: capped.session_id ?? sessionId, maxTurns, numTurns: capped.num_turns ?? null, usage: claudeUsage(capped), durationMs: result.durationMs, canResume: true };
    throw error;
  }
  if (result.code !== 0) {
    throw providerFailure({
      provider: "Claude Code",
      result,
      diagnostics: detectProviderDiagnostics(result.lines.join("\n")),
      logPath,
      sessionId,
      usage: partialClaudeUsage(spent),
      autoResumes: 0,
      idleTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_IDLE_MINUTES", 6),
      hardTimeoutMs: minutesFromEnv("SOLOFACTORY_AGENT_HARD_MINUTES", 45),
    });
  }
  // The envelope is the stream's `result` event; plain-text lines ("Background tasks still running after
  // 600s; terminating.", seen 2026-09-18) can sit between records.
  const envelope = result.lines.map((line) => claudeStreamLine(line).record).findLast((record) => record?.type === "result");
  if (!envelope) throw new Error(`Claude Code exited without a result record. See ${logPath}.`);
  const final = envelope.structured_output ?? envelope.result;
  const usage = claudeUsage(envelope);
  sessionId = envelope.session_id ?? sessionId;
  return schema ? { ...(typeof final === "string" ? JSON.parse(final) : final), usage, sessionId } : { message: String(final ?? "").trim(), usage, sessionId };
}

// One stream-json line: the session it names, and a dashboard event per tool call in the codex vocabulary
// ("Completed Edit src/app.js"). Text, thinking and tool results stay in the log only, so the 160-event
// window is not flooded.
export function claudeStreamLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return {}; }
  const sessionId = record?.session_id ?? null;
  const tools = record?.type === "assistant" ? (record.message?.content ?? []).filter((block) => block.type === "tool_use") : [];
  const target = (input = {}) => String(input.file_path ?? input.path ?? input.command ?? input.pattern ?? "").split("\n")[0].slice(0, 160);
  const event = tools.length ? { type: "item.completed", message: tools.map((tool) => `Completed ${tool.name} ${target(tool.input)}`.trim()).join("; ").slice(0, 500) } : null;
  return { record, sessionId, event };
}

// Token usage in one shape for both CLIs. inputTokens counts every input token, cached or not
// (Codex already reports it that way; Claude splits it three ways). costUsd is the CLI's own
// list-price figure: Claude reports it even on a subscription, Codex reports none (null).
export function claudeUsage(envelope) {
  const u = envelope?.usage;
  if (!u) return null;
  const cached = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (u.input_tokens ?? 0) + cached + written,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: u.output_tokens ?? 0,
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    models: Object.keys(envelope.modelUsage ?? {}),
  };
}

// What a turn that never reached its result envelope still spent: one record per message id, since
// stream-json repeats a message per content block. Member run 2026-11-03: workers killed by the usage
// limit left 9.5M input tokens out of the run's totals. No envelope means no CLI cost figure (null).
function partialClaudeUsage(messages) {
  let usage = null;
  for (const u of messages.values()) usage = addUsage(usage, claudeUsage({ usage: u }));
  return usage;
}

export function codexUsage(u, model) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    cachedInputTokens: u.cached_input_tokens ?? 0,
    cacheWriteTokens: u.cache_write_input_tokens ?? 0,
    // reasoning_output_tokens is a breakdown already inside output_tokens, as in the OpenAI API.
    outputTokens: u.output_tokens ?? 0,
    costUsd: null,
    models: model ? [model] : [],
  };
}

// Sums two usage records. A null cost (Codex reports none) makes the sum unknown:
// showing only the known part would understate a mixed run.
export function addUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const cost = a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: cost,
    models: [...new Set([...(a.models ?? []), ...(b.models ?? [])])],
  };
}

export function detectProviderDiagnostics(output = "") {
  const { transport, commands } = executionFailureText(output);
  const rules = [
    {
      // Codex's own wording for a service outage (run 4f2dd1cf, 2026-10-14); Claude reports 5xx as api_error_status.
      code: "provider_unavailable",
      pattern: /model is at capacity|unexpected status 50[234]\b|overloaded_error|"api_error_status":\s*5\d\d/i,
      title: "The provider's service is temporarily unavailable",
      action: "This is a provider outage, not a problem with the run. Resume in a few minutes; the preserved files and session are kept.",
    },
    {
      code: "model_cli_incompatible",
      pattern: /requires a newer version of Codex|Model metadata .* not found|resuming session with different model/i,
      title: "The configured Codex model is incompatible with this run",
      action: "Resume with the model recorded for this run, or update the Codex CLI. The preserved files do not need to be rebuilt.",
    },
    {
      code: "usage_limit",
      pattern: /usage[ _]limit|session limit|rate[ _]limit|quota exceeded|too many requests|insufficient_quota/i,
      title: "Subscription usage is unavailable",
      action: "Wait for the subscription limit to reset or select another signed-in subscription provider. No automatic retry was attempted.",
    },
    {
      code: "input_too_large",
      pattern: /input_too_large|Input exceeds the maximum length/i,
      title: "The prompt exceeded the provider's input limit",
      action: "This is a factory defect: retrying the same input cannot fit. Report it with this log; no inference ran.",
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
      // The only rule read from a failed command's output: the others (sign-in, network, permission) also
      // match an app's own test output, and misreading that skips the same-session resume.
      fromCommands: true,
      action: "In Terminal, run `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`, confirm `xcodebuild -version` works, then resume this run. TestFlight does not change the local build-tool selection.",
    },
    {
      code: "permission_denied",
      pattern: /operation not permitted|permission denied|EACCES/i,
      title: "The build was blocked by a local permission",
      action: "Review the named path or command permission, correct it, then resume the preserved run.",
    },
  ];
  const found = rules
    .filter((rule) => rule.pattern.test(transport) || (rule.fromCommands && rule.pattern.test(commands)))
    .map(({ pattern, fromCommands, ...diagnostic }) => diagnostic);
  // An outage ends the turn, so any limit or permission text beside it came from earlier work in that turn.
  return found[0]?.code === "provider_unavailable" ? [found[0]] : found;
}

function executionFailureText(output) {
  const relevant = [];
  const commands = [];
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
        commands.push(item.aggregated_output ?? item.output ?? "");
      }
      if (/failed|error/i.test(event.type ?? "") || event.is_error === true) relevant.push(event.message ?? JSON.stringify(event));
    } catch {
      // Provider startup and transport failures can be plain text rather than event JSON.
      relevant.push(line);
    }
  }
  return { transport: relevant.join("\n"), commands: commands.join("\n") };
}

function providerFailure({ provider, result, diagnostics, logPath, sessionId, usage = null, autoResumes, idleTimeoutMs, hardTimeoutMs }) {
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
    usage,
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

export function claudeMaxTurns(env = process.env) {
  const raw = env.SOLOFACTORY_AGENT_MAX_TURNS;
  if (raw === undefined || raw === "") return 150;
  if (!/^\d+$/.test(raw) || Number(raw) > 1000) throw new Error(`SOLOFACTORY_AGENT_MAX_TURNS must be a whole number from 0 to 1000 (got "${raw}").`);
  return Number(raw);
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

// Owner policy: no agent is ever sent more than INLINE_PROMPT_CHARS inline, because agents differ in how much context
// they have. A longer prompt is written to a file in the agent's workspace and the agent is told to read it first
// (progressive disclosure). The file itself is still capped at MAX_PROMPT_CHARS: past that, no agent could use it.
export const INLINE_PROMPT_CHARS = 50_000;
export const MAX_PROMPT_CHARS = 200_000;

export function assertPromptSize(prompt, label = "agent") {
  if (prompt.length <= MAX_PROMPT_CHARS) return;
  throw Object.assign(new Error(`The ${label} prompt is ${prompt.length} characters, over SoloFactory's ${MAX_PROMPT_CHARS}-character prompt limit. This is a factory defect: retrying the same input cannot fit. Report it; no agent was started.`),
    { code: "prompt_too_large", details: { label, chars: prompt.length, max: MAX_PROMPT_CHARS } });
}

export async function spillPrompt({ cwd, prompt, context = {} }) {
  if (prompt.length <= INLINE_PROMPT_CHARS) return prompt;
  assertPromptSize(prompt, context.stage);
  const relative = `.factory/logs/prompt-${String(context.stage ?? "agent").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80)}.md`;
  await mkdir(path.join(cwd, ".factory/logs"), { recursive: true });
  await writeFile(path.join(cwd, relative), prompt);
  return `Your complete instructions are in ${relative} (too long to send inline). Read that whole file first, then carry out exactly what it says; it is addressed to you.`;
}

export function createProvider(id, models = null) {
  const checked = checkModels(models);
  const guarded = (run) => async (args) => run({ ...args, models: checked, prompt: await spillPrompt(args) });
  if (id === "codex") return { id, run: guarded(codexRun) };
  if (id === "claude") return { id, run: guarded(claudeRun) };
  throw new Error(`Unknown provider '${id}'.`);
}
