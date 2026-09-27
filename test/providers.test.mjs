import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverProviders } from "../src/providers.mjs";

// Detection is a PATH scan, so it must find an executable on PATH and ignore a
// non-executable file of the same name. The old /usr/bin/env `which` shell-out
// reported everything missing wherever that absolute path is absent.
function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try { return fn(); } finally { process.env.PATH = saved; }
}

const installed = () => Object.fromEntries(discoverProviders().map((p) => [p.id, p.installed]));

test("a provider on PATH is found; an empty PATH finds nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-path-"));
  writeFileSync(path.join(dir, "codex"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(dir, "codex"), 0o755);

  assert.equal(withPath(dir, installed).codex, true);
  assert.equal(withPath(dir, installed).claude, false);
  assert.equal(withPath("", installed).codex, false);
});

test("a non-executable file with the right name is not a provider", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-path-"));
  writeFileSync(path.join(dir, "claude"), "not executable");
  chmodSync(path.join(dir, "claude"), 0o644);

  assert.equal(withPath(dir, installed).claude, false);
});

// A fake `claude` that reports whatever status file it is given — unless an API key
// reaches it, in which case it reports API auth. The check must never see that key.
function claudeWith(status, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-claude-"));
  const statusFile = path.join(dir, "status.json");
  writeFileSync(statusFile, status);
  writeFileSync(
    path.join(dir, "claude"),
    `#!/bin/sh\n[ -n "$ANTHROPIC_API_KEY" ] && { echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; }\ncat "${statusFile}"\n`,
  );
  chmodSync(path.join(dir, "claude"), 0o755);
  const env = { PATH: `${dir}${path.delimiter}/bin${path.delimiter}/usr/bin`, ...extraEnv };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return discoverProviders().find((p) => p.id === "claude");
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
}

const subscription = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });

test("a subscription sign-in is selectable even with ANTHROPIC_API_KEY in the shell", () => {
  const claude = claudeWith(subscription, { ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.equal(claude.authenticated, true);
  assert.match(claude.detail, /subscription/);
});

test("each unusable Claude state names its own fix", () => {
  assert.match(claudeWith(JSON.stringify({ loggedIn: false })).detail, /claude auth login/);
  assert.match(claudeWith("error: unknown command 'auth'").detail, /claude update/);
  const helper = claudeWith(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: "apiKeyHelper" }));
  assert.equal(helper.authenticated, false);
  assert.match(helper.detail, /API key/);
});

// Shapes captured from the real CLIs on 2026-09-26 (claude 'reply with ok', codex exec --json).
test("usage parses both CLIs into one shape and sums without inventing a cost", async () => {
  const { claudeUsage, codexUsage, addUsage } = await import("../src/providers.mjs");
  const claude = claudeUsage({
    total_cost_usd: 0.1325718,
    usage: { input_tokens: 2, cache_creation_input_tokens: 31783, cache_read_input_tokens: 26979, output_tokens: 4 },
    modelUsage: { "claude-sonnet-5": {} },
  });
  assert.deepEqual(claude, { inputTokens: 58764, cachedInputTokens: 26979, cacheWriteTokens: 31783, outputTokens: 4, costUsd: 0.1325718, models: ["claude-sonnet-5"] });

  const codex = codexUsage({ input_tokens: 23152, cached_input_tokens: 12032, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }, "gpt-5.6-sol");
  assert.equal(codex.inputTokens, 23152);
  assert.equal(codex.costUsd, null);
  assert.equal(addUsage(codex, codex).costUsd, null);
  assert.equal(addUsage(codex, codex).outputTokens, 10);
  assert.equal(addUsage(null, claude), claude);
  assert.equal(claudeUsage({ result: "no usage block" }), null);
});
