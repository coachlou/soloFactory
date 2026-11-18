// Update now: the page's button hands the INSTALL update step (U2) to Claude or Codex, unattended.
// The server owns the safety (nothing building, nothing queued, no runs start meanwhile) and the
// restart; the agent only runs the update command. Nothing from the request reaches the prompt.
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { runProcess } from "./process.mjs";

export function headlessUpdatePrompt(folder) {
  return `Update the SoloFactory install in this folder (${folder}) to the latest version. You are running unattended: nobody can answer questions.

SoloFactory is running right now and has already checked that nothing is building. It restarts itself when you finish, so never stop, start or restart SoloFactory, never open a web address, and never touch the projects/ folder.

1. Read the update steps: gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md
2. Run only its U2 command, with "${folder}" as the folder. Ignore U1 and U3.
3. If a line starts with warn, follow that runbook's fix only when it needs no one's help; otherwise report it.
4. Print the line from: grep -m1 'app:' "${folder}/.ailib/manifest.yaml"
End with one short plain sentence saying whether the update worked, then list, in plain words, the runbook's "If they were below ..." notes that apply to someone coming from the version you started on.`;
}

// Claude's text answer is its stdout; Codex writes its last message to a file.
async function runAgent({ provider, prompt, cwd, logPath }) {
  const last = path.join(path.dirname(logPath), "update-last-message.txt");
  const claude = ["-p", "--model", "sonnet", "--allowedTools", "Bash", "Read", "--setting-sources", "project,local", "--strict-mcp-config", "--output-format", "text"];
  const codex = ["exec", "--skip-git-repo-check", "--approve-for-me", "--color", "never", "--output-last-message", last, "-C", cwd, "-"];
  const result = await runProcess({ executable: provider, args: provider === "codex" ? codex : claude, cwd, stdin: prompt, logPath, timeoutMs: 15 * 60_000 });
  const message = provider === "codex" ? await readFile(last, "utf8").catch(() => "") : result.output;
  return { code: result.code, message: message.trim().slice(-4000) };
}

export function createUpdateRunner({ root, home, appRoot, current, busy, newer, agent = runAgent, onUpdated = () => {} }) {
  const file = path.join(home, "update.json");
  const logPath = path.join(home, "update.log");
  const available = existsSync(path.join(root, ".ailib", "manifest.yaml"));
  let running = false;
  // The background agent run's promise, so a caller (the tests, a shutdown) can wait for its
  // outcome instead of guessing how long it takes.
  let finishing = Promise.resolve();
  // Written to a temp file and renamed into place, so status() never reads a half-written update.json
  // (a plain writeFile truncates first: a read in that window got "Unexpected end of JSON input").
  let saves = 0;
  const save = async (state) => {
    await mkdir(home, { recursive: true });
    const tmp = `${file}.${process.pid}.${saves += 1}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  };

  async function status() {
    const last = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
    return { available, running, current, last };
  }

  async function start(provider) {
    if (!available) return { status: 409, error: "Update now works only in an installed SoloFactory folder. Use the copy prompt instead." };
    if (running) return { status: 409, error: "An update is already running." };
    if (!["claude", "codex"].includes(provider)) return { status: 400, error: "Choose Claude or Codex to run the update." };
    const reason = busy();
    if (reason) return { status: 409, error: reason };
    running = true; // before any await, so a second click or a new run can't slip in meanwhile
    let record;
    try {
      const latest = await newer();
      if (!latest) { running = false; return { status: 409, error: "No newer version is available." }; }
      record = { from: current, to: latest, provider, state: "running", startedAt: new Date().toISOString(), logPath };
      await save(record);
    } catch (error) {
      running = false;
      throw error;
    }
    const installed = () => readFile(path.join(appRoot, "package.json"), "utf8").then((t) => JSON.parse(t).version, () => current);
    finishing = (async () => {
      let code = null, message = "";
      try { ({ code, message } = await agent({ provider, prompt: headlessUpdatePrompt(root), cwd: root, logPath })); }
      catch (error) { message = error.message; }
      // Read the version even when the agent failed: U2 may have swapped the app before it stopped.
      const now = await installed();
      const outcome = now !== current
        ? { state: "restarting", to: now, message }
        : { state: "failed", message: message || `The update agent stopped (exit ${code}) and the version did not change.` };
      await save({ ...record, ...outcome, endedAt: new Date().toISOString() }).catch(() => {});
      running = false;
      if (outcome.state === "restarting") onUpdated();
    })();
    return { status: 202, update: record };
  }

  // settled(): resolves once the latest started update has saved its outcome and called onUpdated.
  return { status, start, settled: () => finishing, get running() { return running; } };
}
