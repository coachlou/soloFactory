import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RECOMMENDED_NODE_MAJOR, SUPPORTED_NODE_MAJORS, nodeVersionStatus } from "../src/node-version.mjs";

test("Node 24 and 26 LTS are supported; others warn with the fix", () => {
  assert.deepEqual(nodeVersionStatus("v24.22.3"), { version: "v24.22.3", major: 24, supported: true, problem: null });
  assert.equal(nodeVersionStatus("v26.13.1").problem, null);
  for (const v of ["v22.22.1", "v23.1.0", "v25.0.0", "v27.0.0"]) assert.match(nodeVersionStatus(v).problem, /does not support\. It supports Node 24 and 26 LTS.*A4.*B3.*not changed/, v);
  assert.match(nodeVersionStatus("v20.19.0").problem, /too old to run SoloFactory/);
});

test("every place that names the supported Node agrees", async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
  assert.equal((await read(".nvmrc")).trim(), String(RECOMMENDED_NODE_MAJOR));
  assert.equal((await read(".node-version")).trim(), String(RECOMMENDED_NODE_MAJOR));
  assert.equal(JSON.parse(await read("package.json")).engines.node, SUPPORTED_NODE_MAJORS.map((m) => `^${m}`).join(" || "));
  assert.match(await read(".github/workflows/test.yml"), new RegExp(`node: \\[${SUPPORTED_NODE_MAJORS.join(", ")}\\]`));
  for (const sh of ["distro/install.d/post.sh", "distro/run.sh"]) assert.match(await read(sh), new RegExp(`SUPPORTED="${SUPPORTED_NODE_MAJORS.join(" ")}"`), sh);
});
