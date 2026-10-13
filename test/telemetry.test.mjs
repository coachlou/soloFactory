import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProvider } from "../src/providers.mjs";
import { JobStore } from "../src/store.mjs";
import { SoloFactory, stageUsage, usageTotals } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";

const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [
  { role: "assistant", content: "What should we build?" },
  { role: "user", content: "A daily tracker with clear acceptance behavior." },
];

// Fake CLIs on PATH that print the shapes captured from the real CLIs on 2026-09-26,
// so the real spawn → parse → usage path runs without spending tokens.
async function withFakeCli(name, body, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-fake-cli-"));
  await writeFile(path.join(dir, name), `#!${process.execPath}\n${body}`);
  await chmod(path.join(dir, name), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test("the real Claude adapter returns usage from the CLI envelope", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sf-claude-run-"));
  const envelope = {
    type: "result", result: "ok", total_cost_usd: 0.1325718,
    usage: { input_tokens: 2, cache_creation_input_tokens: 31783, cache_read_input_tokens: 26979, output_tokens: 4 },
    modelUsage: { "claude-sonnet-5": {} },
  };
  const result = await withFakeCli("claude", `process.stdin.resume(); process.stdin.on("end", () => {
  console.log("Background tasks still running after 600s; terminating.");
  console.log(${JSON.stringify(JSON.stringify(envelope))});
});`, () => createProvider("claude").run({ cwd, prompt: "reply with ok", logPath: path.join(cwd, "log.txt") }));
  assert.equal(result.message, "ok");
  assert.deepEqual(result.usage, { inputTokens: 58764, cachedInputTokens: 26979, cacheWriteTokens: 31783, outputTokens: 4, costUsd: 0.1325718, models: ["claude-sonnet-5"] });
});

test("Claude routes planning, plan corrections and every review to the reasoning profile, with configurable overrides", async () => {
  const keys = ["SOLOFACTORY_CLAUDE_MODEL", "SOLOFACTORY_CLAUDE_EFFORT", "SOLOFACTORY_CLAUDE_REASONING_MODEL", "SOLOFACTORY_CLAUDE_REASONING_EFFORT"];
  const saved = keys.map(key => process.env[key]);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sf-claude-profiles-"));
  const capture = path.join(cwd, "args.json");
  try {
    for (const key of keys) delete process.env[key];
    await withFakeCli("claude", `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({result:"ok"})));`, async () => {
      const run = async (stage, model, effort) => {
        await createProvider("claude").run({cwd, prompt:"ok", context:{stage}});
        const args = JSON.parse(await readFile(capture,"utf8"));
        assert.equal(args[args.indexOf("--model") + 1], model, stage);
        assert.equal(args[args.indexOf("--effort") + 1], effort, stage);
      };
      for (const stage of ["interview", "build", "build-resume", "build-slice-PEOPLE", "slice-resume-PEOPLE", "repair-2", "recovery-feature-PEOPLE"]) await run(stage, "opus", "medium");
      for (const stage of ["specification", "specification-resume", "plan-review", "recovery-plan-id", "review", "review-resume", "recovery-feature-PEOPLE-review-2", "feature-plan", "feature-plan-resume", "plan-review-2", "plan-correction-1"]) await run(stage, "opus", "low");
      process.env.SOLOFACTORY_CLAUDE_MODEL = "coding-model";
      process.env.SOLOFACTORY_CLAUDE_EFFORT = "high";
      process.env.SOLOFACTORY_CLAUDE_REASONING_MODEL = "review-model";
      process.env.SOLOFACTORY_CLAUDE_REASONING_EFFORT = "medium";
      await run("build", "coding-model", "high");
      await run("review", "review-model", "medium");
    });
  } finally {
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
  }
});

test("Claude turns ignore the owner's personal config and write turns may run the plan's proofs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sf-claude-isolation-"));
  const capture = path.join(cwd, "args.json");
  await withFakeCli("claude", `require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(capture + ".stdin")}, input); console.log(JSON.stringify({result:"ok"})); });`, async () => {
    const args = async (mode, context) => {
      await createProvider("claude").run({ cwd, prompt: "ok", mode, context });
      return JSON.parse(await readFile(capture, "utf8"));
    };
    const write = await args("write", { stage: "build-slice-F1", proofCommands: [["node", "scripts/process-check.mjs"], ["node", "scripts/process-check.mjs"]] });
    assert.equal(write[write.indexOf("--setting-sources") + 1], "project,local");
    assert.ok(write.includes("--strict-mcp-config"));
    assert.equal(write[write.indexOf("--disallowedTools") + 1], "Agent");
    assert.equal(write.filter((arg) => arg === "Bash(node scripts/process-check.mjs:*)").length, 1);
    assert.ok(write.includes("Bash(node --test:*)"));
    const read = await args("read", { stage: "review" });
    assert.ok(read.includes("--strict-mcp-config"));
    assert.ok(!read.includes("--allowedTools"));
    assert.match(await readFile(`${capture}.stdin`, "utf8"), /^ok\n\nShell: .*one per Bash/s, "every turn learns that compound commands are denied");
  });
});

test("the real Codex adapter sums every turn.completed and reports no cost", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sf-codex-run-"));
  const turn = { type: "turn.completed", usage: { input_tokens: 23152, cached_input_tokens: 12032, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 3 } };
  const result = await withFakeCli("codex", `const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume(); process.stdin.on("end", () => {
  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "done");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
  console.log(${JSON.stringify(JSON.stringify(turn))});
  console.log(${JSON.stringify(JSON.stringify(turn))});
});`, () => createProvider("codex").run({ cwd, prompt: "reply with ok", logPath: path.join(cwd, "log.txt") }));
  assert.equal(result.message, "done");
  assert.equal(result.usage.inputTokens, 2 * 23152);
  assert.equal(result.usage.cachedInputTokens, 2 * 12032);
  assert.equal(result.usage.outputTokens, 10, "reasoning tokens are already inside output_tokens");
  assert.equal(result.usage.costUsd, null);
});

test("a failed run then a resume logs two segments, the last one cumulative", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sf-telemetry-resume-"));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief, transcript, provider: "fixture", sdlc: "single" });
  const fixture = createFixtureProvider();
  const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, costUsd: 0.001, models: ["m"] };
  let failBuild = true;
  const provider = {
    id: "fixture",
    async run(options) {
      if (failBuild && options.context.stage === "build") {
        const error = new Error("Package registry could not be reached.");
        error.code = "network_unavailable";
        throw error;
      }
      return { ...(await fixture.run(options)), usage };
    },
  };
  const factory = new SoloFactory({
    store,
    provider,
    commandRunner: async () => ({ code: 0, output: "passed" }),
    deployer: async () => ({ mode: "fixture", status: "live", url: "http://127.0.0.1:9977" }),
  });
  t.after(() => factory.shutdown());

  assert.equal((await factory.start(job.id)).state, "failed");
  failBuild = false;
  assert.equal((await factory.resume(job.id)).state, "completed");

  const lines = (await readFile(path.join(root, ".solofactory", "runs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.state), ["failed", "completed"]);
  assert.equal(lines[0].failedState, "building");
  assert.ok(lines.every((line) => line.jobId === job.id && line.variant === "baseline"));
  const [first, last] = lines.map((line) => line.tokens.total.inputTokens);
  assert.ok(first > 0 && last > first, `last segment (${last}) must include the first (${first})`);
  assert.equal(lines[1].tokens.turnsWithoutUsage, 1, "the build turn that threw is counted as missing usage");
});

test("a run mixing Claude and Codex turns keeps its cost unknown", () => {
  const event = (stage, usage) => ({ type: "agent.completed", stage, usage });
  const totals = usageTotals([
    event("specification", { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, costUsd: 0.5, models: ["claude-sonnet-5"] }),
    event("build-slice-1", { inputTokens: 2000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20, costUsd: null, models: ["gpt-5.6-sol"] }),
    event("build-slice-2", { inputTokens: 3000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 30, costUsd: null, models: ["gpt-5.6-sol"] }),
  ]);
  assert.equal(totals.total.inputTokens, 6000);
  assert.equal(totals.total.costUsd, null, "a partial Claude-only cost would understate the run");
  assert.equal(totals.byStage.slice.inputTokens, 5000, "slices fold into one stage");
  assert.equal(totals.byStage.specification.costUsd, 0.5);
});

test("stage usage buckets each turn into the stage it finished in and reports the current step alone", () => {
  const usage = (input, output) => ({ inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: output, costUsd: null, models: [] });
  const history = [
    { state: "specifying", label: "Plan", startedAt: "2026-10-13T10:00:00Z", endedAt: "2026-10-13T10:10:00Z" },
    { state: "building", label: "Build", startedAt: "2026-10-13T10:10:00Z", endedAt: "2026-10-13T10:30:00Z" },
    { state: "specifying", label: "Repair plan", startedAt: "2026-10-13T11:00:00Z" },
  ];
  const events = [
    { type: "agent.completed", at: "2026-10-13T10:05:00Z", usage: usage(100, 10) },
    { type: "agent.completed", at: "2026-10-13T10:20:00Z", usage: usage(200, 20) },
    { type: "agent.completed", at: "2026-10-13T11:05:00Z", usage: usage(300, 30) },
    { type: "agent.completed", at: "2026-10-13T11:06:00Z" },
  ];
  const { byState, current } = stageUsage(history, events, Date.parse("2026-10-13T11:15:00Z"));
  assert.equal(byState.specifying.durationMs, 25 * 60_000);
  assert.equal(byState.specifying.tokens.inputTokens, 400);
  assert.equal(byState.building.tokens.outputTokens, 20);
  assert.deepEqual([current.label, current.durationMs, current.tokens.inputTokens], ["Repair plan", 15 * 60_000, 300]);
  assert.equal(stageUsage([], events).current, null);
});
