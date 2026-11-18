// GitHub backup of generated apps (docs/github-backup-spec.md). A local bare repo stands in for GitHub; the API is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { JobStore } from "../src/store.mjs";
import { SoloFactory } from "../src/factory.mjs";
import { createFixtureProvider } from "../src/fixture-provider.mjs";
import { createSoloFactoryServer } from "../src/server.mjs";
import { BACKUP_REMOTE, backupState, connectBackup, disconnectBackup, ghGitHub, pushBackup, readBackup, setBackupEnabled } from "../src/github-backup.mjs";

const run = promisify(execFile);
const brief = { workingName: "Pocket Pulse", acceptanceScenarios: ["A user records a score."] };
const transcript = [{ role: "user", content: "A daily tracker with clear acceptance behavior." }];
const types = async (store, id) => (await store.events(id, Infinity)).map((event) => event.type);
const remoteGit = async (bare, ...args) => (await run("git", args, { cwd: bare })).stdout.trim();
const remoteTags = async (bare) => (await remoteGit(bare, "tag", "--list")).split("\n").filter(Boolean).sort();

// A fake GitHub: repos by name, each with visibility and an Actions switch, all pointing at local bare repos.
function fakeGitHub(root) {
  const repos = new Map();
  const calls = [];
  return {
    repos, calls,
    accounts: async () => ["lou"],
    token: async () => "",
    remoteUrl: (owner, repo) => path.join(root, `${owner}-${repo}.git`),
    async addRepo(name, { private: priv = true } = {}) {
      const bare = path.join(root, `lou-${name}.git`);
      await run("git", ["init", "-q", "--bare", bare]);
      repos.set(name, { private: priv, actions: true, bare });
      return bare;
    },
    async request(token, method, route, body) {
      calls.push(`${method} ${route}`);
      if (method === "POST" && route === "/user/repos") {
        if (repos.has(body.name)) return { status: 422, body: { message: "name already exists" } };
        await this.addRepo(body.name, { private: body.private });
        return { status: 201, body: { name: body.name, owner: { login: "lou" } } };
      }
      const [, owner, name, rest] = route.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/) ?? [];
      const repo = owner === "lou" ? repos.get(name) : null;
      if (!repo) return { status: 404, body: { message: "Not Found" } };
      if (method === "GET" && !rest) return { status: 200, body: { private: repo.private } };
      if (method === "PUT" && rest === "/actions/permissions") { repo.actions = body.enabled; return { status: 204, body: null }; }
      return { status: 404, body: null };
    },
  };
}

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-backup-"));
  const dir = path.join(root, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const store = new JobStore(dir);
  await store.init();
  const github = fakeGitHub(root);
  const factories = [];
  t.after(() => Promise.all(factories.map((factory) => factory.shutdown())));
  const release = async () => {
    const job = await store.create({ brief, transcript, provider: "fixture" });
    const factory = new SoloFactory({ store, provider: createFixtureProvider(), github });
    factories.push(factory);
    const result = await factory.start(job.id);
    assert.equal(result.state, "completed", result.error?.message);
    const backup = await factory.backup;
    return { result, backup };
  };
  return { root, dir, store, github, release };
}

test("with no backup set up, a release pushes nothing and adds no remote", async (t) => {
  const { dir, store, github, release } = await project(t);
  const { result, backup } = await release();
  assert.equal(result.release.number, 1);
  assert.equal(backup, null);
  assert.deepEqual(github.calls, []);
  assert.equal(await store.git("remote"), "");
  assert.deepEqual(await backupState(dir), { connected: false, enabled: false });
});

test("connect creates a private repo with Actions off and leaves backup off", async (t) => {
  const { dir, store, github, release } = await project(t);
  await release();
  await github.addRepo("demo"); // the project's name is taken: the next free name is used
  const state = await connectBackup(dir, { account: "lou" }, github);
  assert.deepEqual({ owner: state.owner, repo: state.repo, enabled: state.enabled, created: state.created }, { owner: "lou", repo: "demo-backup", enabled: false, created: true });
  assert.equal(github.repos.get("demo-backup").private, true);
  assert.equal(github.repos.get("demo-backup").actions, false, "no CI can run on the backup");
  assert.match(await store.git("remote"), new RegExp(`^${BACKUP_REMOTE}$`));
  assert.equal(await remoteGit(github.repos.get("demo-backup").bare, "rev-parse", "--all"), "", "connecting pushes nothing");
  assert.equal(await github.request("", "GET", "/repos/lou/demo-backup").then((r) => r.status), 200);
});

test("turning backup on pushes every release so far, then each new release pushes its tag", async (t) => {
  const { dir, store, github, release } = await project(t);
  await release();
  await release();
  const state = await connectBackup(dir, { account: "lou" }, github);
  const on = await setBackupEnabled(dir, true, github);
  assert.equal(on.lastPush.ok, true, on.lastPush.reason);
  assert.equal(on.lastPush.release, 2);
  const bare = github.repos.get(state.repo).bare;
  assert.deepEqual(await remoteTags(bare), ["solofactory/release/1", "solofactory/release/2"]);
  const { result, backup } = await release();
  assert.equal(backup.ok, true, backup.reason);
  assert.equal(await remoteGit(bare, "rev-parse", "main"), result.release.commit);
  assert.deepEqual(await remoteTags(bare), ["solofactory/release/1", "solofactory/release/2", "solofactory/release/3"]);
  assert.ok((await types(store, result.id)).includes("backup.pushed"));
  assert.equal((await backupState(dir)).lastGood.release, 3);
});

test("after a rollback, the next release still backs up and the rolled-back tag is kept on GitHub", async (t) => {
  const { dir, store, github, release } = await project(t);
  const { result: first } = await release();
  await connectBackup(dir, { account: "lou" }, github);
  await setBackupEnabled(dir, true, github);
  await release();
  // What a rollback leaves: main moved back, the rolled-back code kept under its tag.
  await store.git("tag", "solofactory/rolled-back/r2");
  await store.reset(first.release.commit);
  const { result: third, backup } = await release();
  assert.equal(backup.ok, true, backup.reason);
  const bare = github.repos.get("demo").bare;
  assert.equal(await remoteGit(bare, "rev-parse", "main"), third.release.commit, "main follows the Mac after a rollback");
  assert.ok((await remoteTags(bare)).includes("solofactory/rolled-back/r2"));
  assert.ok((await remoteTags(bare)).includes("solofactory/release/2"), "the rolled-back release stays reachable by its tag");
});

test("a main changed on GitHub by hand is never overwritten, and the deploy still counts", async (t) => {
  const { dir, store, github, release } = await project(t);
  await release();
  await connectBackup(dir, { account: "lou" }, github);
  await setBackupEnabled(dir, true, github);
  // Someone pushes to the backup from elsewhere: a new commit on GitHub's main.
  const bare = github.repos.get("demo").bare;
  const tree = await remoteGit(bare, "rev-parse", "main^{tree}");
  const commit = await remoteGit(bare, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-p", "main", "-m", "by hand");
  await remoteGit(bare, "update-ref", "refs/heads/main", commit);
  const { result, backup } = await release();
  assert.equal(result.state, "completed");
  assert.equal(backup.ok, false);
  assert.match(backup.reason, /changed outside SoloFactory/);
  assert.ok((await types(store, result.id)).includes("backup.failed"));
});

test("a repo made public pauses the backup, and a key-shaped value blocks the push", async (t) => {
  const { dir, store, github, release } = await project(t);
  await release();
  await connectBackup(dir, { account: "lou" }, github);
  await setBackupEnabled(dir, true, github);
  github.repos.get("demo").private = false;
  const paused = await pushBackup(dir, { github });
  assert.deepEqual({ ok: paused.ok, paused: paused.paused }, { ok: false, paused: true });
  assert.match(paused.reason, /now public/);
  github.repos.get("demo").private = true;
  await writeFile(path.join(dir, "config.js"), `export const key = "${"sk-" + "a".repeat(24)}";\n`);
  await store.commit("add key");
  const blocked = await pushBackup(dir, { github });
  assert.equal(blocked.code, "secret_found");
  assert.match(blocked.reason, /config\.js/);
});

test("an existing repo is used only when private and empty or already this project's", async (t) => {
  const { dir, github, release } = await project(t);
  await release();
  await github.addRepo("public-one", { private: false });
  await assert.rejects(connectBackup(dir, { account: "lou", repo: "public-one" }, github), /is public/);
  const foreign = await github.addRepo("foreign");
  const seed = await mkdtemp(path.join(os.tmpdir(), "solo-factory-seed-"));
  await run("git", ["init", "-q", seed]);
  await writeFile(path.join(seed, "x.txt"), "x\n");
  await run("git", ["add", "."], { cwd: seed });
  await run("git", ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "x"], { cwd: seed });
  await run("git", ["push", "-q", foreign, "HEAD:main"], { cwd: seed });
  await assert.rejects(connectBackup(dir, { account: "lou", repo: "foreign" }, github), /code from somewhere else/);
  await github.addRepo("empty");
  const state = await connectBackup(dir, { account: "lou", repo: "lou/empty" }, github);
  assert.deepEqual({ repo: state.repo, created: state.created }, { repo: "empty", created: false });
});

test("no token is written anywhere, and disconnect keeps origin and deletes nothing on GitHub", async (t) => {
  const { dir, store, github, release } = await project(t);
  await release();
  await store.git("remote", "add", "origin", "https://example.com/owner/app.git");
  github.token = async () => "ghp_" + "t".repeat(36);
  const local = github.request.bind(github);
  // The credential helper is used only for https; the bare repo needs none, so this checks storage, not transport.
  github.request = local;
  await connectBackup(dir, { account: "lou" }, github);
  await setBackupEnabled(dir, true, github);
  const config = await readFile(path.join(dir, ".solofactory", "backup.json"), "utf8");
  const gitConfig = await readFile(path.join(dir, ".git", "config"), "utf8");
  for (const text of [config, gitConfig]) assert.doesNotMatch(text, /ghp_t/);
  await disconnectBackup(dir);
  assert.equal(await readBackup(dir), null);
  assert.equal(await store.git("remote"), "origin");
  assert.equal(await store.git("remote", "get-url", "origin"), "https://example.com/owner/app.git");
  assert.ok(github.repos.has("demo"), "the GitHub repo is never deleted");
  assert.ok(!github.calls.some((call) => call.startsWith("DELETE")));
});

test("gh accounts and tokens come from the owner's gh sign-in", async () => {
  const runs = [];
  const github = ghGitHub({
    run: async (cmd, args) => {
      runs.push([cmd, ...args].join(" "));
      if (args[1] === "status") return { stdout: "github.com\n  ✓ Logged in to github.com account coachlou (keyring)\n  ✓ Logged in to github.com account other-one (keyring)\n", stderr: "" };
      return { stdout: "gho_example\n", stderr: "" };
    },
  });
  assert.deepEqual(await github.accounts(), ["coachlou", "other-one"]);
  assert.equal(await github.token("other-one"), "gho_example");
  assert.ok(runs.includes("gh auth token --hostname github.com --user other-one"));
  const missing = ghGitHub({ run: async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } });
  await assert.rejects(missing.accounts(), /not installed/);
});

test("the backup API reads, connects, turns on, backs up now and disconnects the open project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "solo-factory-backup-api-"));
  const github = fakeGitHub(root);
  const dir = path.join(root, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const store = new JobStore(dir);
  await store.init();
  await store.commit("first");
  const app = await createSoloFactoryServer({ home: root, root, fixtureMode: true, github });
  t.after(() => app.close().catch(() => {}));
  await app.appsRestarted;
  const port = await new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
  const base = `http://127.0.0.1:${port}/api/projects/backup`;
  const call = async (suffix, method = "GET", body) => {
    const response = await fetch(`${base}${suffix}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await call("")).body, { connected: false, enabled: false });
  assert.deepEqual((await call("/accounts")).body, { accounts: ["lou"] });
  assert.equal((await call("", "PUT", { enabled: true })).status, 400, "nothing to turn on before connecting");
  const connected = await call("/connect", "POST", { account: "lou" });
  assert.equal(connected.body.repo, "demo");
  const on = await call("", "PUT", { enabled: true });
  assert.equal(on.body.lastPush.ok, true, on.body.lastPush.reason);
  assert.equal((await call("/push", "POST")).body.lastPush.ok, true);
  assert.equal((await call("", "DELETE")).body.connected, false);
});
