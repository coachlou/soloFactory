import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SUPPORTED_NODE_MAJOR, nodeVersionStatus } from "../src/node-version.mjs";

test("Node 24 is the only supported major; others warn with the fix", () => {
  assert.deepEqual(nodeVersionStatus("v24.11.0"), { version: "v24.11.0", major: 24, supported: true, problem: null });
  assert.match(nodeVersionStatus("v26.5.0").problem, /v26\.5\.0, which is newer than the supported Node 24 LTS.*A4.*B3.*not changed/);
  assert.match(nodeVersionStatus("v22.22.1").problem, /older than the supported Node 24 LTS/);
  assert.match(nodeVersionStatus("v20.19.0").problem, /too old to run SoloFactory/);
});

test("every place that pins Node names the same major", async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
  assert.equal((await read(".nvmrc")).trim(), String(SUPPORTED_NODE_MAJOR));
  assert.equal((await read(".node-version")).trim(), String(SUPPORTED_NODE_MAJOR));
  assert.equal(JSON.parse(await read("package.json")).engines.node, `${SUPPORTED_NODE_MAJOR}.x`);
  assert.match(await read(".github/workflows/test.yml"), /node-version-file: \.nvmrc/);
  for (const sh of ["distro/install.d/post.sh", "distro/run.sh"]) assert.match(await read(sh), new RegExp(`SUPPORTED=${SUPPORTED_NODE_MAJOR}\\b`), sh);
});
