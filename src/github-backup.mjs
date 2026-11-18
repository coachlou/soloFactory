// GitHub backup of a generated app (docs/github-backup-spec.md): after each good release, push the app's code and its
// release tags to a private GitHub repo the owner picks per project. Off until the owner turns it on. It uses the owner's
// own `gh` sign-in on their Mac; SoloFactory stores no GitHub credential and ships none.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CREDENTIAL_PATTERNS } from "./credentials.mjs";

const execFileAsync = promisify(execFile);
export const BACKUP_REMOTE = "solofactory-backup";
const API = "https://api.github.com";
// The token reaches git through this one-shot helper and the child's environment only, never .git/config or a URL.
const HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$SOLOFACTORY_BACKUP_TOKEN"; }; f';

export class BackupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const scrub = (text) => CREDENTIAL_PATTERNS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), String(text ?? ""));

// The owner's GitHub, through their gh sign-in. Tests pass a stub with the same three functions.
export function ghGitHub({ run = execFileAsync, fetchImpl = globalThis.fetch } = {}) {
  const gh = async (...args) => {
    try {
      const { stdout, stderr } = await run("gh", args, { env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
      return `${stdout}\n${stderr}`;
    } catch (error) {
      if (error.code === "ENOENT") throw new BackupError("gh_missing", "The GitHub CLI (gh) is not installed. Install it, run gh auth login, then try again.");
      // gh auth status exits non-zero when one account has a problem; its output still lists the good ones.
      if (args[0] === "auth" && args[1] === "status" && (error.stdout || error.stderr)) return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      throw new BackupError("gh_failed", scrub(`gh ${args.slice(0, 2).join(" ")} failed: ${(error.stderr || error.message).trim()}`));
    }
  };
  return {
    async accounts() {
      const out = await gh("auth", "status", "--hostname", "github.com");
      const found = [...out.matchAll(/(?:account|as)\s+([A-Za-z0-9-]+)/g)].map((match) => match[1]);
      return [...new Set(found)];
    },
    async token(account) {
      const token = (await gh("auth", "token", "--hostname", "github.com", "--user", account)).trim().split(/\s+/)[0];
      if (!token) throw new BackupError("not_signed_in", `GitHub account ${account} is not signed in to gh. Run gh auth login, then try again.`);
      return token;
    },
    async request(token, method, route, body) {
      let response;
      try {
        response = await fetchImpl(`${API}${route}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SoloFactory" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new BackupError("offline", `Could not reach GitHub: ${error.message}`);
      }
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}

const configFile = (project) => path.join(project, ".solofactory", "backup.json");

// Missing or disconnected means off. Nothing in it is a secret.
export async function readBackup(project) {
  const config = JSON.parse(await readFile(configFile(project), "utf8").catch(() => "{}"));
  return config?.repo ? config : null;
}

async function writeBackup(project, config) {
  await mkdir(path.dirname(configFile(project)), { recursive: true });
  await writeFile(configFile(project), `${JSON.stringify(config ?? {}, null, 2)}\n`);
  return config;
}

// What the hub shows. GitHub is not called, so the page can poll it.
export async function backupState(project) {
  const config = await readBackup(project);
  if (!config) return { connected: false, enabled: false };
  const { account, owner, repo, enabled, created, connectedAt, lastPush, lastGood, actionsOff } = config;
  return { connected: true, enabled: Boolean(enabled), account, owner, repo, url: `https://github.com/${owner}/${repo}`, created: Boolean(created), actionsOff: actionsOff !== false, connectedAt, lastPush: lastPush ?? null, lastGood: lastGood ?? null };
}

async function git(project, args, token = "") {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "credential.helper=", "-c", `credential.helper=${HELPER}`, ...args], {
      cwd: project,
      env: { ...process.env, SOLOFACTORY_BACKUP_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    error.message = scrub(`${error.stdout ?? ""}\n${error.stderr || error.message}`.trim());
    throw error;
  }
}

const repoName = (project) => path.basename(project).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "solofactory-app";
// A config's url is GitHub's; tests point it at a local bare repo.
const remoteUrl = (config) => config.url ?? `https://github.com/${config.owner}/${config.repo}.git`;

// The first commit on the remote's main, if any. Empty repo: null.
async function remoteMain(project, url, token) {
  const out = await git(project, ["ls-remote", url, "refs/heads/main"], token);
  return out.split(/\s+/)[0] || null;
}

async function disableActions(github, token, owner, repo) {
  const result = await github.request(token, "PUT", `/repos/${owner}/${repo}/actions/permissions`, { enabled: false });
  return result.status < 300;
}

// Connect a project: a new private repo (default), or an existing private one that is empty or already this
// project's backup. Leaves backup off; turning it on is the owner's separate choice.
export async function connectBackup(project, { account, repo: existing } = {}, github = ghGitHub()) {
  if (!account) throw new BackupError("no_account", "Pick the GitHub account to back up to.");
  const token = await github.token(account);
  let owner = account, repo, created = false;
  if (!existing) {
    const base = repoName(project);
    for (const name of [base, `${base}-backup`, ...[2, 3, 4, 5].map((n) => `${base}-backup-${n}`)]) {
      const result = await github.request(token, "POST", "/user/repos", { name, private: true, has_issues: false, has_projects: false, has_wiki: false, auto_init: false, description: "SoloFactory backup (code and release tags)" });
      if (result.status === 201) { owner = result.body.owner?.login ?? account; repo = result.body.name; created = true; break; }
      if (result.status !== 422) throw new BackupError("create_failed", `GitHub refused to create ${name} (${result.status}): ${result.body?.message ?? "no reason given"}`);
    }
    if (!repo) throw new BackupError("create_failed", `Every name from ${base} to ${base}-backup-5 is taken under ${account}. Pick an existing repo instead.`);
  } else {
    [owner, repo] = existing.includes("/") ? existing.split("/") : [account, existing];
    const found = await github.request(token, "GET", `/repos/${owner}/${repo}`);
    if (found.status === 404) throw new BackupError("repo_missing", `${owner}/${repo} was not found, or ${account} cannot see it.`);
    if (found.status >= 300) throw new BackupError("repo_unreadable", `GitHub answered ${found.status} for ${owner}/${repo}.`);
    if (!found.body.private) throw new BackupError("repo_public", `${owner}/${repo} is public. Backups go only to a private repo.`);
  }
  const config = { account, owner, repo, enabled: false, created, connectedAt: new Date().toISOString(), lastPush: null, lastGood: null, lease: null };
  if (github.remoteUrl) config.url = github.remoteUrl(owner, repo); // tests: a local bare repo stands in for GitHub
  const url = remoteUrl(config);
  if (!created) {
    const head = await remoteMain(project, url, token);
    if (head && !(await git(project, ["cat-file", "-e", `${head}^{commit}`]).then(() => true, () => false))) {
      throw new BackupError("foreign_history", `${owner}/${repo} already holds code from somewhere else. Pick an empty repo, or this project's earlier backup.`);
    }
    config.lease = head;
  }
  // No CI on the backup: with Actions off, a workflow file in the app can never run there.
  config.actionsOff = await disableActions(github, token, owner, repo).catch(() => false);
  const remotes = (await git(project, ["remote"])).split("\n");
  await git(project, ["remote", remotes.includes(BACKUP_REMOTE) ? "set-url" : "add", BACKUP_REMOTE, url]);
  return writeBackup(project, config).then(() => backupState(project));
}

export async function setBackupEnabled(project, enabled, github = ghGitHub()) {
  const config = await readBackup(project);
  if (!config) throw new BackupError("not_connected", "Connect a GitHub repo first.");
  config.enabled = Boolean(enabled);
  await writeBackup(project, config);
  // Turning it on backs up every release so far.
  if (config.enabled) await pushBackup(project, { github });
  return backupState(project);
}

// Disconnect forgets the repo here. It never deletes anything on GitHub.
export async function disconnectBackup(project) {
  const remotes = (await git(project, ["remote"]).catch(() => "")).split("\n");
  if (remotes.includes(BACKUP_REMOTE)) await git(project, ["remote", "remove", BACKUP_REMOTE]);
  await writeBackup(project, {});
  return backupState(project);
}

// Added lines of the commits about to be pushed that look like a key. A backup cannot be taken back once pushed.
async function secretsIn(project, since) {
  const range = since && (await git(project, ["cat-file", "-e", `${since}^{commit}`]).then(() => true, () => false)) ? [`${since}..HEAD`] : ["HEAD"];
  const diff = await git(project, ["log", "-p", "--format=", "--no-color", ...range]);
  const found = new Set();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { file = line.replace(/^\+\+\+ (b\/)?/, ""); continue; }
    if (!line.startsWith("+")) continue;
    if (CREDENTIAL_PATTERNS.some((pattern) => new RegExp(pattern.source).test(line))) found.add(file);
  }
  return [...found];
}

function pushReason(error) {
  const text = error.message ?? String(error);
  if (/stale info|fetch first|non-fast-forward|\[rejected\]/i.test(text)) return "the main branch on GitHub was changed outside SoloFactory, so it was not overwritten. Look at the repo, then Back up now";
  if (/Could not resolve host|unable to access|timed out|Network is unreachable/i.test(text)) return "GitHub could not be reached";
  if (/Authentication failed|403|401|Permission denied/i.test(text)) return "GitHub refused the sign-in. Run gh auth login, then Back up now";
  if (/not found|does not appear to be a git repository/i.test(text)) return "the repo was not found";
  return text.split("\n").slice(-2).join(" ");
}

// One backup: main (with a lease, because a rollback moves it back) and every solofactory/* tag (never forced).
// Never throws: the result is recorded in backup.json and returned, for the run's events and the hub.
export async function pushBackup(project, { github = ghGitHub(), release = null } = {}) {
  const config = await readBackup(project);
  if (!config) return { skipped: "not_connected" };
  if (!config.enabled) return { skipped: "off" };
  const at = new Date().toISOString();
  const record = async (result) => {
    config.lastPush = { at, ...result };
    if (result.ok) config.lastGood = config.lastPush;
    await writeBackup(project, config);
    return config.lastPush;
  };
  try {
    const token = await github.token(config.account);
    const found = await github.request(token, "GET", `/repos/${config.owner}/${config.repo}`);
    if (found.status === 404) return record({ ok: false, code: "repo_missing", reason: `${config.owner}/${config.repo} was not found. Connect the backup again.` });
    if (found.status >= 300) return record({ ok: false, code: "github_error", reason: `GitHub answered ${found.status}.` });
    if (!found.body?.private) return record({ ok: false, code: "repo_public", paused: true, reason: `${config.owner}/${config.repo} is now public. Make it private, then press Back up now.` });
    const secrets = await secretsIn(project, config.lastGood?.commit);
    if (secrets.length) return record({ ok: false, code: "secret_found", reason: `A value that looks like a key is in ${secrets.slice(0, 3).join(", ")}. Remove it with a new release, then Back up now.` });
    const head = await git(project, ["rev-parse", "HEAD"]);
    const url = remoteUrl(config);
    await git(project, ["push", "--porcelain", `--force-with-lease=refs/heads/main:${config.lease ?? ""}`, url, "HEAD:refs/heads/main"], token);
    await git(project, ["push", "--porcelain", url, "refs/tags/solofactory/*:refs/tags/solofactory/*"], token);
    config.lease = head;
    const tags = (await git(project, ["tag", "--list", "solofactory/release/*"])).split("\n").filter(Boolean);
    const number = release?.number ?? Math.max(0, ...tags.map((tag) => Number(tag.split("/").pop())).filter(Number.isInteger));
    return record({ ok: true, commit: head, release: number || null });
  } catch (error) {
    return record({ ok: false, code: error.code && typeof error.code === "string" ? error.code : "push_failed", reason: scrub(error instanceof BackupError ? error.message : `The push failed: ${pushReason(error)}.`) });
  }
}
