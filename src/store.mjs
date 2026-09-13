import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const templatesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "project");
// Discovery anchor appended to the project's CLAUDE.md/AGENTS.md; the "ambient folder" marker is what makes it idempotent.
const ANCHOR = `## Ambient folder

This project is an ambient folder: SoloFactory builds it.
**Read \`.aai/instructions.md\` and follow it before acting.** "Ambient folder"
means a folder with an \`.aai/\` behavior layer.
`;

// A JobStore is rooted in one project: a git repo the factory builds into.
// The app lives at the repo root; run evidence lives in .solofactory/runs/<id>/ (gitignored).
export class JobStore {
  constructor(project) {
    this.project = path.resolve(project);
  }

  async init() {
    await mkdir(this.jobsRoot(), { recursive: true });
    const isRepo = await stat(path.join(this.project, ".git")).then(() => true, () => false);
    if (!isRepo) await this.git("init", "-q");
    // ponytail: append-only ignore rules; a hand-edited .gitignore keeps its own lines
    const ignoreFile = path.join(this.project, ".gitignore");
    const current = await readFile(ignoreFile, "utf8").catch(() => "");
    const missing = [".solofactory/", ".factory/logs/", ".aai/memory/"].filter((rule) => !current.split("\n").includes(rule));
    if (missing.length) await writeFile(ignoreFile, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    await this.scaffoldContext();
  }

  // Project-owned context: written once from templates/project/, never overwritten, so the
  // owner and agents can edit it. Memory is gitignored; the anchors let Claude/Codex find .aai/.
  async scaffoldContext() {
    await mkdir(path.join(this.project, ".aai", "memory", "interviews"), { recursive: true });
    const name = path.basename(this.project);
    for (const file of ["identity.md", "context.md", "instructions.md"]) {
      const target = path.join(this.project, ".aai", file);
      if (await stat(target).catch(() => null)) continue;
      const body = await readFile(path.join(templatesRoot, file), "utf8");
      await writeFile(target, body.replaceAll("{{NAME}}", name));
    }
    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const target = path.join(this.project, file);
      const current = await readFile(target, "utf8").catch(() => "");
      if (current.includes("ambient folder")) continue;
      await writeFile(target, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${ANCHOR}`);
    }
  }

  jobsRoot() {
    return path.join(this.project, ".solofactory", "runs");
  }

  jobDir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid job id.");
    return path.join(this.jobsRoot(), id);
  }

  appDir() {
    return this.project;
  }

  async git(...args) {
    // Identity is pinned so commits work on machines without a global git config.
    const { stdout } = await execFileAsync("git", ["-c", "user.name=SoloFactory", "-c", "user.email=factory@solofactory.local", ...args], { cwd: this.project });
    return stdout.trim();
  }

  // Commits everything the factory produced so far; returns false when the tree is clean.
  async commit(message) {
    await this.git("add", "-A");
    if (!(await this.git("status", "--porcelain"))) return false;
    await this.git("commit", "-q", "-m", message);
    return true;
  }

  async create({ brief, transcript, provider, sdlc = "single" }) {
    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const job = {
      id,
      state: "queued",
      stage: "Queued",
      provider,
      sdlc,
      brief,
      transcript,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      attempt: 0,
      deployment: null,
      error: null,
      failedState: null,
      recovery: null,
      agentSessions: {},
      activeCommand: null,
      stageHistory: [],
    };
    if (sdlc === "slices") {
      job.sliceIndex = 0;
      job.sliceDone = [];
      job.sliceStats = {};
      job.slicePlanIds = [];
    }
    await mkdir(this.jobDir(id), { recursive: true });
    await this.writeState(job);
    await this.appendEvent(id, { type: "job.created", state: "queued", message: "Run queued" });
    return job;
  }

  async read(id) {
    return JSON.parse(await readFile(path.join(this.jobDir(id), "state.json"), "utf8"));
  }

  async writeState(job) {
    const file = path.join(this.jobDir(job.id), "state.json");
    const temp = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    job.updatedAt = new Date().toISOString();
    await writeFile(temp, `${JSON.stringify(job, null, 2)}\n`);
    await rename(temp, file);
    return job;
  }

  async appendEvent(id, event) {
    const enriched = { at: new Date().toISOString(), ...event };
    await appendFile(path.join(this.jobDir(id), "events.jsonl"), `${JSON.stringify(enriched)}\n`);
    return enriched;
  }

  async events(id, limit = 160) {
    try {
      const lines = (await readFile(path.join(this.jobDir(id), "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean);
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async list() {
    let entries = [];
    try {
      entries = await readdir(this.jobsRoot(), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const jobs = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
          return await this.read(entry.name);
        } catch {
          return null;
        }
      }),
    );
    return jobs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recoverInterrupted() {
    const jobs = await this.list();
    const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
    for (const job of jobs) {
      if (!terminal.has(job.state)) {
        job.failedState = job.state;
        job.state = "interrupted";
        job.stage = "Interrupted by restart";
        job.error = { code: "process_restarted", message: "The factory stopped during this run. Its files are preserved and can be resumed." };
        await this.writeState(job);
        await this.appendEvent(job.id, { type: "job.interrupted", state: job.state, message: job.error.message });
      }
    }
  }

  async artifact(id, name) {
    const map = {
      prd: ".factory/PRD.md",
      plan: ".factory/PLAN.md",
      acceptance: ".factory/ACCEPTANCE.md",
      requirements: ".factory/requirements.json",
      slices: ".factory/slices.json",
      manifest: "factory.json",
    };
    const relative = map[name];
    if (!relative) throw new Error("Unknown artifact.");
    this.jobDir(id); // validates the id even though artifacts are project-level now
    const file = path.join(this.appDir(), relative);
    await stat(file);
    return { file, content: await readFile(file, "utf8") };
  }
}
