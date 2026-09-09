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
