import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class JobStore {
  constructor(root, { jobsRoot } = {}) {
    this.root = path.resolve(root);
    // ponytail: optional override so an ambient folder can keep runs in projects/ while home holds interviews
    this._jobsRoot = jobsRoot ? path.resolve(jobsRoot) : path.join(this.root, "jobs");
  }

  async init() {
    await mkdir(this.jobsRoot(), { recursive: true });
  }

  jobsRoot() {
    return this._jobsRoot;
  }

  jobDir(id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid job id.");
    return path.join(this.jobsRoot(), id);
  }

  appDir(id) {
    return path.join(this.jobDir(id), "app");
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
    await mkdir(this.appDir(id), { recursive: true });
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
    const file = path.join(this.appDir(id), relative);
    await stat(file);
    return { file, content: await readFile(file, "utf8") };
  }
}
