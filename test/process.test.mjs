import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertAllowedCommand, runProcess, subscriptionEnvironment } from "../src/process.mjs";
import { createProvider, detectProviderDiagnostics } from "../src/providers.mjs";

test("subscription environment strips common API keys", () => {
  const original = process.env.OPENAI_API_KEY;
  const originalPort = process.env.PORT;
  process.env.OPENAI_API_KEY = "must-not-pass";
  process.env.PORT = "4173";
  const env = subscriptionEnvironment({ SAFE_VALUE: "yes" });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(subscriptionEnvironment({ PORT: "8123" }).PORT, "8123");
  assert.equal(env.SAFE_VALUE, "yes");
  const routed = subscriptionEnvironment({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_USE_BEDROCK: "1" });
  assert.deepEqual([routed.ANTHROPIC_AUTH_TOKEN, routed.ANTHROPIC_BASE_URL, routed.CLAUDE_CODE_USE_BEDROCK], [undefined, undefined, undefined]);
  if (original === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
});

test("command contract rejects shell execution", () => {
  assert.deepEqual(assertAllowedCommand(["npm", "test"]), ["npm", "test"]);
  assert.throws(() => assertAllowedCommand(["sh", "-lc", "anything"]), /Unsupported executable/);
  assert.throws(() => assertAllowedCommand("npm test"), /arrays of strings/);
});

test("agent activity extends the idle deadline", async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "let n=0; const timer=setInterval(() => { console.log(++n); if (n === 6) clearInterval(timer); }, 30)"],
    idleTimeoutMs: 100,
    hardTimeoutMs: 1_000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /6/);
});

test("silence triggers an idle timeout", async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 500)"],
    idleTimeoutMs: 50,
    hardTimeoutMs: 1_000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutReason, "idle");
});

test("continuous activity still respects the total safety cap", async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ["-e", "setInterval(() => console.log('working'), 50)"],
    idleTimeoutMs: 400,
    hardTimeoutMs: 800,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutReason, "hard");
});

test("provider diagnostics distinguish limits from recoverable local blockers", () => {
  assert.deepEqual(detectProviderDiagnostics("usage limit exceeded").map((item) => item.code), ["usage_limit"]);
  assert.deepEqual(
    detectProviderDiagnostics("The 'gpt-6-astra' model requires a newer version of Codex.").map((item) => item.code),
    ["model_cli_incompatible"],
  );
  const local = detectProviderDiagnostics(
    "getaddrinfo ENOTFOUND registry.npmjs.org\nxcodebuild requires Xcode; active developer directory '/Library/Developer/CommandLineTools'",
  );
  assert.deepEqual(local.map((item) => item.code), ["network_unavailable", "xcode_not_selected"]);
  assert.match(local[1].action, /\/Applications\/Xcode\.app\/Contents\/Developer/);
  const successfulSpecOutput = JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", status: "completed", exit_code: 0, aggregated_output: "Camera permission denied is an acceptance scenario." },
  });
  assert.deepEqual(detectProviderDiagnostics(successfulSpecOutput), []);
});

test("Codex makes one same-session retry after silence and does not retry a concrete blocker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-provider-"));
  const bin = path.join(root, "bin");
  const fake = path.join(bin, "codex");
  const countFile = path.join(root, "calls.txt");
  await mkdir(bin);
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_COUNT, JSON.stringify(args) + "\\n");
if (args[1] === "resume") {
  const result = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(result, "continued successfully\\n");
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-session" }));
  if (process.env.FAKE_CODEX_BLOCKER === "1") console.error("getaddrinfo ENOTFOUND registry.npmjs.org");
  setTimeout(() => {}, 1500);
}
`);
  await chmod(fake, 0o755);
  const previous = {
    PATH: process.env.PATH,
    idle: process.env.SOLOFACTORY_AGENT_IDLE_MINUTES,
    hard: process.env.SOLOFACTORY_AGENT_HARD_MINUTES,
    backoff: process.env.SOLOFACTORY_AGENT_BACKOFF_SECONDS,
    count: process.env.FAKE_CODEX_COUNT,
    blocker: process.env.FAKE_CODEX_BLOCKER,
    model: process.env.SOLOFACTORY_CODEX_MODEL,
    reasoning: process.env.SOLOFACTORY_CODEX_REASONING_EFFORT,
  };
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.SOLOFACTORY_AGENT_IDLE_MINUTES = "0.01";
  process.env.SOLOFACTORY_AGENT_HARD_MINUTES = "0.1";
  process.env.SOLOFACTORY_AGENT_BACKOFF_SECONDS = "0";
  process.env.FAKE_CODEX_COUNT = countFile;
  delete process.env.SOLOFACTORY_CODEX_MODEL;
  delete process.env.SOLOFACTORY_CODEX_REASONING_EFFORT;
  const provider = createProvider("codex");
  try {
    const events = [];
    const result = await provider.run({ cwd: root, prompt: "build", mode: "write", onEvent: (event) => events.push(event) });
    assert.equal(result.message, "continued successfully");
    assert.equal(result.autoResumes, 1);
    assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 2);
    const calls = (await readFile(countFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.every((args) => args.includes("--model") && args.includes("gpt-6.1-sol")));
    assert.ok(calls.every((args) => args.includes('model_reasoning_effort="medium"')));
    assert.ok(events.some((event) => event.type === "agent.backoff"));

    await writeFile(countFile, "");
    process.env.FAKE_CODEX_BLOCKER = "1";
    await assert.rejects(
      () => provider.run({ cwd: root, prompt: "build", mode: "write" }),
      (error) => error.code === "network_unavailable" && error.details.autoResumes === 0,
    );
    assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);
  } finally {
    restoreEnv("PATH", previous.PATH);
    restoreEnv("SOLOFACTORY_AGENT_IDLE_MINUTES", previous.idle);
    restoreEnv("SOLOFACTORY_AGENT_HARD_MINUTES", previous.hard);
    restoreEnv("SOLOFACTORY_AGENT_BACKOFF_SECONDS", previous.backoff);
    restoreEnv("FAKE_CODEX_COUNT", previous.count);
    restoreEnv("FAKE_CODEX_BLOCKER", previous.blocker);
    restoreEnv("SOLOFACTORY_CODEX_MODEL", previous.model);
    restoreEnv("SOLOFACTORY_CODEX_REASONING_EFFORT", previous.reasoning);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Claude is not idle-killed by its non-streaming CLI; the hard cap still guards it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-claude-"));
  const bin = path.join(root, "bin");
  const fake = path.join(bin, "claude");
  await mkdir(bin);
  // Mirrors `claude -p --output-format json`: no stdout until the process ends,
  // even while it is genuinely working. Sleeps well past the old 600 ms idle
  // window, then prints the single result envelope.
  await writeFile(fake, `#!/usr/bin/env node
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);
console.log(JSON.stringify({ type: "result", subtype: "success", result: "done", is_error: false }));
`);
  await chmod(fake, 0o755);
  const previous = { PATH: process.env.PATH, hard: process.env.SOLOFACTORY_AGENT_HARD_MINUTES };
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.SOLOFACTORY_AGENT_HARD_MINUTES = "0.25"; // 15 s hard cap
  try {
    const provider = createProvider("claude");
    const result = await provider.run({ cwd: root, prompt: "work silently", mode: "write" });
    assert.equal(result.message, "done");
  } finally {
    restoreEnv("PATH", previous.PATH);
    restoreEnv("SOLOFACTORY_AGENT_HARD_MINUTES", previous.hard);
  }
});

// Successful agent output over the 200K tail cap, full of auth-looking source constants. The tail cut
// lands inside a JSON record; that fragment must never be read as a plain-text provider error.
const noisyCodex = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_COUNT, JSON.stringify(args) + "\\n");
const ok = (text) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, aggregated_output: text } }) + "\\n";
const noise = (size) => "x".repeat(size) + " export const UNAUTHORIZED = 401; const INVALID_CREDENTIAL = 'invalid credential token'; // user is not logged in ";
if (args[1] === "resume") {
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "continued successfully\\n");
  console.log(JSON.stringify({ type: "turn.completed" }));
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "noisy-session" }));
  // An oversized single record, then two records the 200K tail cut lands inside.
  process.stdout.write(ok(noise(260_000)) + ok(noise(150_000)) + ok(noise(150_000)));
  setTimeout(() => {}, 1500);
}
`;

test("auth-like strings in truncated successful output are not an auth diagnostic; idle auto-resume survives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-noisy-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), noisyCodex);
  await chmod(path.join(bin, "codex"), 0o755);
  const keys = ["PATH", "SOLOFACTORY_AGENT_IDLE_MINUTES", "SOLOFACTORY_AGENT_HARD_MINUTES", "SOLOFACTORY_AGENT_BACKOFF_SECONDS", "FAKE_CODEX_COUNT"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.SOLOFACTORY_AGENT_IDLE_MINUTES = "0.01";
  process.env.SOLOFACTORY_AGENT_HARD_MINUTES = "0.1";
  process.env.SOLOFACTORY_AGENT_BACKOFF_SECONDS = "0";
  process.env.FAKE_CODEX_COUNT = path.join(root, "calls.txt");
  try {
    const provider = createProvider("codex");
    const result = await provider.run({ cwd: root, prompt: "build", mode: "write" });
    assert.equal(result.message, "continued successfully");
    assert.equal(result.autoResumes, 1);
    await assert.rejects(
      () => provider.run({ cwd: root, prompt: "review", mode: "read" }),
      (error) => error.code === "agent_idle_timeout" && error.details.diagnostics.length === 0,
    );
  } finally {
    for (const key of keys) restoreEnv(key, previous[key]);
  }
});

test("a failing Claude run with auth-like strings in truncated output is not an auth diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-noisy-claude-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), `#!/usr/bin/env node
const ok = (text) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, aggregated_output: text } }) + "\\n";
const noise = (size) => "x".repeat(size) + " export const UNAUTHORIZED = 401; const INVALID_CREDENTIAL = 'invalid credential token'; // user is not logged in ";
process.stdout.write(ok(noise(260_000)) + ok(noise(150_000)) + ok(noise(150_000)), () => process.exit(1));
`);
  await chmod(path.join(bin, "claude"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    await assert.rejects(
      () => createProvider("claude").run({ cwd: root, prompt: "build", mode: "write" }),
      (error) => error.code === "provider_failed" && error.details.diagnostics.length === 0,
    );
  } finally {
    restoreEnv("PATH", previous);
  }
});

test("process output keeps complete records for diagnostics across chunk boundaries and the tail cap", async () => {
  const record = (n) => JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, aggregated_output: `${n} ${"y".repeat(90_000)} UNAUTHORIZED` } });
  const script = `const r=${JSON.stringify([1, 2, 3, 4].map(record))};let i=0;const out=r.join("\\n")+"\\n";const t=setInterval(()=>{process.stdout.write(out.slice(i,i+7_000));i+=7_000;if(i>=out.length)clearInterval(t);},1);`;
  const result = await runProcess({ executable: process.execPath, args: ["-e", script], hardTimeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.ok(result.output.length <= 200_000);
  assert.ok(!result.output.startsWith("{"), "the tail cap starts mid-record");
  assert.ok(result.lines.every((line) => JSON.parse(line)), "every diagnostic line is a complete record");
  assert.deepEqual(detectProviderDiagnostics(result.lines.join("\n")), []);
});

test("a record cut off by a kill is not kept as diagnostic evidence; a final plain-text line is", async () => {
  const cut = `process.stdout.write('{"type":"item.completed","item":{"aggregated_output":"UNAUTHORIZED not logged in');setInterval(()=>{},1000);`;
  const killed = await runProcess({ executable: process.execPath, args: ["-e", cut], hardTimeoutMs: 300 });
  assert.equal(killed.timedOut, true);
  assert.deepEqual(killed.lines, []);
  assert.deepEqual(detectProviderDiagnostics(killed.lines.join("\n")), []);
  const plain = await runProcess({ executable: process.execPath, args: ["-e", `process.stdout.write("Error: Not logged in");process.exit(1)`] });
  assert.deepEqual(detectProviderDiagnostics(plain.lines.join("\n")).map((item) => item.code), ["authentication"]);
});

test("genuine structured and plain-text authentication failures are still detected", () => {
  const structured = [
    JSON.stringify({ type: "thread.started", thread_id: "s" }),
    JSON.stringify({ type: "error", message: "authentication failed: token expired" }),
  ].join("\n");
  assert.deepEqual(detectProviderDiagnostics(structured).map((item) => item.code), ["authentication"]);
  assert.deepEqual(detectProviderDiagnostics(JSON.stringify({ type: "item.completed", item: { type: "error", message: "401 Unauthorized" } })).map((item) => item.code), ["authentication"]);
  assert.deepEqual(detectProviderDiagnostics("Error: Not logged in. Please run codex login.").map((item) => item.code), ["authentication"]);
});
