// A busy port exits with a plain message instead of a stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

async function occupy(handler) {
  const blocker = createServer(handler);
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  return blocker;
}

async function start(port, extra = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "solo-factory-port-"));
  const child = spawn(process.execPath, [serverFile], { env: { ...process.env, PORT: String(port), SOLOFACTORY_HOME: home, SOLOFACTORY_ROOT: home, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { code, output };
}

test("a port held by another app exits 1 with the PORT= instruction", async () => {
  const blocker = await occupy((request, response) => { response.writeHead(404); response.end(); });
  const { port } = blocker.address();
  try {
    const { code, output } = await start(port);
    assert.equal(code, 1);
    assert.match(output, new RegExp(`Port ${port} is in use by another app`));
    assert.match(output, /PORT=5000 bash start\.sh/);
    assert.doesNotMatch(output, /EADDRINUSE|at Server\./);
  } finally { blocker.close(); }
});

test("a port held by a running SoloFactory exits 1 and points at it", async () => {
  const blocker = await occupy((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, project: "x", workers: [] }));
  });
  const { port } = blocker.address();
  try {
    const { code, output } = await start(port);
    assert.equal(code, 1);
    assert.match(output, new RegExp(`SoloFactory is already running at http://127.0.0.1:${port}`));
  } finally { blocker.close(); }
});

test("a non-loopback HOST exits 1 before listening", async () => {
  const { code, output } = await start(0, { HOST: "0.0.0.0" });
  assert.equal(code, 1);
  assert.match(output, /HOST=0\.0\.0\.0 would expose/);
  assert.doesNotMatch(output, /is ready at/);
});
