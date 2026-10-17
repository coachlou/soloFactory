const labels = {
  promise: "Product promise",
  user: "Primary user",
  problem: "Triggering problem",
  workflow: "Core workflow",
  mustHaves: "Must-haves",
  nonGoals: "Non-goals",
  dataAndAccess: "Data & access",
  integrations: "Integrations",
  business: "Business model",
  visual: "Visual direction",
  deployment: "Deployment",
  acceptance: "Acceptance proof",
  constraints: "Constraints",
};

const stageOrder = ["specifying", "building", "verifying", "reviewing", "deploying", "completed"];
const state = { config: null, provider: null, messages: [], guide: null, job: null, events: [], telemetry: null, poller: null, jobs: [], busyJobId: null, projects: [], project: null };
const $ = (selector) => document.querySelector(selector);
const NO_PROVIDER = "No subscription is signed in yet. Follow the note under Claude Code above, then reload this page.";

boot().catch(showError);

async function boot() {
  state.config = await api("/api/config");
  const first = state.config.providers.find((provider) => provider.authenticated);
  // No fallback to a signed-out provider: it looked selected but every request failed with its detail.
  state.provider = first?.id ?? null;
  state.guide = state.config.opening;
  state.messages = [{ role: "assistant", content: state.guide.message }];
  renderProviders();
  if (!first) showError(new Error(NO_PROVIDER));
  renderMessages();
  renderCoverage();
  await refreshProjects();
  const savedId = localStorage.getItem("solofactory.currentJob");
  const candidate = state.jobs.find((job) => job.id === savedId)
    ?? state.jobs.find((job) => PARKED.includes(job.state));
  if (candidate) await selectRun(candidate.id);
  // ponytail: /api/projects reads every run's state.json; fine for a handful of projects, paginate if it ever isn't
  setInterval(() => refreshProjects().catch(() => {}), 5000);
}

async function refreshProjects() {
  const [projects, listing] = await Promise.all([api("/api/projects"), api("/api/jobs")]);
  state.projects = projects.projects;
  state.project = projects.active;
  state.jobs = listing.jobs;
  state.busyJobId = listing.busyJobId;
  const active = listing.activeRuns?.length ?? 0;
  $("#system-status").textContent = active ? `Factory running${active > 1 ? ` (${active})` : ""}` : "Factory ready";
  renderProjects();
  renderRuns();
  renderBackgroundBanner();
  renderAttention();
  if (!$("#board-view").classList.contains("hidden")) renderBoard(await api("/api/board"));
}

// Factory board: one column per state, a card per run, click to open it.
const PARKED = ["failed", "cancelled", "interrupted", "paused"];
const BOARD_COLUMNS = ["queued", "specifying", "building", "reviewing", "deploying", "parked", "completed"];
$("#board-button").addEventListener("click", () => {
  if ($("#board-view").classList.contains("hidden")) showBoard().catch(showError);
  else showInterview();
});

async function showBoard() {
  clearError();
  stopPolling();
  for (const id of ["interview-view", "review-view", "run-view"]) $(`#${id}`).classList.add("hidden");
  $("#board-view").classList.remove("hidden");
  $("#board-button").setAttribute("aria-pressed", "true");
  renderBoard(await api("/api/board"));
}

function hideBoard() {
  $("#board-view").classList.add("hidden");
  $("#board-button").setAttribute("aria-pressed", "false");
}

function renderBoard(board) {
  $("#board-capacity").textContent = `${board.active} of ${board.maxActiveRuns} active run${board.maxActiveRuns === 1 ? "" : "s"}`;
  $("#board-columns").replaceChildren(...BOARD_COLUMNS.map((name) => {
    const column = document.createElement("div");
    column.className = "board-column";
    const heading = document.createElement("h3");
    heading.append(name, Object.assign(document.createElement("span"), { textContent: String(board.columns[name].length) }));
    column.append(heading, ...board.columns[name].map(boardCard));
    return column;
  }));
}

function boardCard(card) {
  const button = document.createElement("button");
  button.className = "board-card";
  button.type = "button";
  const title = Object.assign(document.createElement("strong"), { textContent: card.promise || card.jobId });
  const meta = Object.assign(document.createElement("small"), { textContent: `${card.project} · ${card.stage || card.state}${card.startedAt ? ` · ${formatDuration(card.elapsedMs)}` : ""}` });
  button.append(title, meta);
  if (card.slices) {
    const bar = document.createElement("div");
    bar.className = "slice-bar";
    for (let i = 0; i < card.slices.total; i += 1) {
      const seg = document.createElement("i");
      if (i < card.slices.done) seg.classList.add("done");
      else if (i === card.slices.done && !["completed", ...PARKED].includes(card.state)) seg.classList.add("current");
      bar.append(seg);
    }
    if (card.slices.repairs && bar.lastChild) bar.children[Math.max(0, card.slices.done - 1)].classList.add("repaired");
    // Feature status: verified, then the cursor's substage (or blocked when parked), then planned.
    const status = card.slices.current ? ` · ${card.slices.current} ${PARKED.includes(card.state) ? "blocked" : card.slices.substage ?? "planned"}` : "";
    bar.title = `${card.slices.done}/${card.slices.total} features verified${status}${card.slices.repairs ? ` · ${card.slices.repairs} repair${card.slices.repairs === 1 ? "" : "s"}` : ""}${card.slices.remainingRepairs != null ? ` · ${card.slices.remainingRepairs} repair${card.slices.remainingRepairs === 1 ? "" : "s"} left` : ""}`;
    button.append(bar);
  }
  if (card.blockedBy) button.append(Object.assign(document.createElement("small"), { className: "blocked", textContent: `waiting on recovery of ${card.blockedBy}` }));
  button.addEventListener("click", () => openFromBoard(card).catch(showError));
  return button;
}

async function openFromBoard(card) {
  if (card.projectId !== state.project) {
    await api("/api/projects/select", { method: "POST", body: { id: card.projectId } });
    await refreshProjects();
  }
  await selectRun(card.jobId);
}

function projectName(job) {
  return job?.brief?.workingName || job?.id || "Untitled";
}

function option(value, text) {
  return Object.assign(document.createElement("option"), { value, textContent: text });
}

function renderProjects() {
  const select = $("#project-select");
  select.replaceChildren(option("new", "+ New project…"), ...state.projects.map((project) => {
    const marker = project.activeJobId ? "● " : "";
    const last = project.lastRun ? `${project.lastRun.state} · ${project.runCount} run${project.runCount === 1 ? "" : "s"}` : "no runs";
    const queued = project.queued ? ` · ${project.queued} queued` : "";
    return option(project.id, `${marker}${project.name} · ${last}${queued}`);
  }));
  select.value = state.project;
  renderQueueHint();
}

// Runs in one project share a tree, so they serialize whatever the active-run limit says;
// say so at the moment a second brief is about to be queued instead of after it waits.
function renderQueueHint() {
  const project = state.projects.find((entry) => entry.id === state.project);
  const parked = Boolean(project?.lastRun && PARKED.includes(project.lastRun.state) && !project.activeJobId);
  const ahead = (project?.activeJobId ? 1 : 0) + (project?.queued ?? 0) + (parked ? 1 : 0);
  $("#queue-hint").classList.toggle("hidden", !ahead);
  if (!ahead) return;
  const holding = parked
    ? `a parked run, which holds the queue until you resume, restart, or dismiss it${ahead > 1 ? `, plus ${ahead - 1} queued` : ""}`
    : `${ahead} run${ahead === 1 ? "" : "s"} ${project.activeJobId ? "active or " : ""}queued`;
  $("#queue-hint").textContent = `${project.name} already has ${holding}. Runs in one project go one after another, each on the tree the last one leaves, so this brief waits for them whatever the active-run limit is. Independent fixes for the same app are cheaper as one brief with a must-have and an acceptance scenario each.`;
}

function renderRuns() {
  const select = $("#run-select");
  select.replaceChildren(option("new", "+ New run"), ...state.jobs.map((job) => {
    const marker = job.id === state.busyJobId ? "● " : job.queuePosition ? `#${job.queuePosition} ` : "";
    return option(job.id, `${marker}${projectName(job)} · ${job.state} · ${job.createdAt.slice(0, 10)}`);
  }));
  select.value = state.job?.id ?? "new";
}

// A parked latest run blocks its project until the owner acts, so it is announced on every screen
// and in the tab title, whichever run or project is open. Cancelled runs are the owner's own choice.
const NEEDS_YOU = ["failed", "interrupted", "paused"];
function runsNeedingYou(projects, viewingId) {
  return projects.filter((project) => NEEDS_YOU.includes(project.lastRun?.state) && project.lastRun.id !== viewingId)
    .map((project) => ({ projectId: project.id, jobId: project.lastRun.id, name: project.lastRun.workingName || project.name, state: project.lastRun.state }));
}

function renderAttention() {
  const waiting = runsNeedingYou(state.projects, state.job?.id);
  const all = state.projects.filter((project) => NEEDS_YOU.includes(project.lastRun?.state)).length;
  document.title = all ? `(${all}) needs you · SoloFactory` : "SoloFactory";
  $("#attention-banner").classList.toggle("hidden", !waiting.length);
  if (!waiting.length) return;
  const [first] = waiting;
  $("#attention-text").textContent = waiting.length > 1 ? `${waiting.length} runs are stopped or paused and need you.`
    : `“${first.name}” is ${first.state === "paused" ? "paused" : "stopped"} and needs you.`;
  $("#attention-view-button").onclick = async () => {
    try {
      if (first.projectId !== state.project) await switchProject(first.projectId);
      await selectRun(first.jobId);
    } catch (error) { showError(error); }
  };
}

function renderBackgroundBanner() {
  const busy = state.busyJobId && state.busyJobId !== state.job?.id ? state.jobs.find((job) => job.id === state.busyJobId) : null;
  const queued = state.jobs.filter((job) => job.queuePosition).length;
  $("#background-banner").classList.toggle("hidden", !busy);
  if (busy) $("#background-text").textContent = `“${projectName(busy)}” is ${busy.state} in the background${queued ? ` · ${queued} queued` : ""}.`;
}

$("#project-select").addEventListener("change", (event) => switchProject(event.target.value).catch(showError));
$("#run-select").addEventListener("change", (event) => selectRun(event.target.value).catch(showError));
$("#background-view-button").addEventListener("click", () => selectRun(state.busyJobId).catch(showError));

// window.prompt is blocked in embedded browsers (the Claude desktop pane), so
// the project name comes from a native <dialog> instead.
const projectDialog = $("#project-dialog");
$("#project-close-button").addEventListener("click", () => projectDialog.close());
function askProjectName() {
  return new Promise((resolve) => {
    const input = $("#project-name");
    input.value = "";
    projectDialog.addEventListener("close", () => resolve(projectDialog.returnValue === "submit" ? input.value.trim() : ""), { once: true });
    projectDialog.showModal();
  });
}
$("#project-form").addEventListener("submit", () => projectDialog.close("submit"));

// Switching projects only changes the view; runs in other projects keep going.
async function switchProject(id) {
  clearError();
  const create = id === "new";
  const body = create ? { name: await askProjectName() } : { id };
  if (create && !body.name) return renderProjects();
  const url = create ? "/api/projects" : "/api/projects/select";
  await api(url, { method: "POST", body });
  stopPolling();
  await refreshProjects();
  return state.jobs[0] ? selectRun(state.jobs[0].id) : showInterview();
}

async function selectRun(id) {
  clearError();
  if (id === "new") return showInterview();
  const result = await api(`/api/jobs/${id}`);
  state.job = result.job;
  state.events = result.events;
  state.telemetry = null;
  state.provider = state.job.provider;
  localStorage.setItem("solofactory.currentJob", state.job.id);
  resetRunPanels();
  showRun();
  renderRuns();
  renderBackgroundBanner();
  await poll();
  if (["completed", ...PARKED].includes(state.job.state)) stopPolling();
  else startPolling();
}

function showInterview() {
  stopPolling();
  state.job = null;
  state.events = [];
  state.telemetry = null;
  state.guide = state.config.opening;
  state.messages = [{ role: "assistant", content: state.guide.message }];
  localStorage.removeItem("solofactory.currentJob");
  hideBoard();
  $("#run-view").classList.add("hidden");
  $("#review-view").classList.add("hidden");
  $("#interview-view").classList.remove("hidden");
  document.querySelectorAll(".stages li").forEach((item) => item.classList.remove("active", "done"));
  document.querySelector('[data-stage="interview"]').classList.add("active");
  $("#start-button").disabled = false;
  renderProviders();
  renderMessages();
  renderCoverage();
  renderRuns();
  renderBackgroundBanner();
}

function resetRunPanels() {
  for (const id of ["request-total", "error-total", "latency-average", "app-uptime"]) $(`#${id}`).textContent = "—";
  $("#route-list").replaceChildren(Object.assign(document.createElement("p"), { textContent: "No app traffic yet." }));
  $("#app-live").textContent = "Waiting";
  $("#app-live").classList.add("muted");
  $("#open-app").classList.add("hidden");
  $("#relaunch-button").classList.add("hidden");
  $("#app-url").classList.add("hidden");
  $("#artifacts").replaceChildren(Object.assign(document.createElement("p"), { textContent: "Artifacts appear after specification." }));
}

function renderProviders() {
  $("#provider-picker").replaceChildren(...state.config.providers.map((provider) => {
    const button = document.createElement("button");
    button.className = `provider ${state.provider === provider.id ? "selected" : ""}`;
    button.disabled = !provider.authenticated || state.messages.length > 1;
    const strong = document.createElement("strong");
    strong.textContent = provider.label;
    const small = document.createElement("small");
    small.textContent = provider.detail;
    button.append(strong, small);
    button.addEventListener("click", () => { state.provider = provider.id; renderProviders(); });
    return button;
  }));
}

function renderMessages(thinking = false) {
  const container = $("#messages");
  container.replaceChildren(...state.messages.map((message) => {
    const item = document.createElement("div");
    item.className = `message ${message.role}`;
    item.textContent = message.content;
    for (const src of message.images ?? []) {
      const img = document.createElement("img");
      img.src = src; img.alt = "Attached image"; img.className = "attachment-image";
      item.append(img);
    }
    // Long user turns (pasted specs) collapse so the transcript stays readable.
    if (message.role === "user" && message.content.length > 1_500) {
      item.classList.add("long");
      const toggle = document.createElement("a");
      toggle.className = "expand";
      toggle.textContent = "Show full message";
      toggle.addEventListener("click", () => {
        const open = item.classList.toggle("open");
        toggle.textContent = open ? "Collapse" : "Show full message";
      });
      item.prepend(toggle);
    }
    return item;
  }));
  if (thinking) {
    const item = document.createElement("div");
    item.className = "message assistant thinking";
    item.innerHTML = 'Thinking <span class="dots"><span>•</span><span>•</span><span>•</span></span>';
    container.append(item);
  }
  container.scrollTop = container.scrollHeight;
}

function sdlcOption(id) {
  const options = state.config?.sdlcOptions ?? [];
  return options.find((option) => option.id === id) ?? { id: id ?? "single", label: "Single build" };
}

function renderCoverage() {
  const coverage = state.guide.coverage;
  const values = Object.values(coverage);
  const score = Math.round(values.reduce((sum, value) => sum + (value === "complete" ? 1 : value === "partial" ? .5 : 0), 0) / values.length * 100);
  $("#coverage-score").textContent = `${score}%`;
  $("#coverage-ring").style.setProperty("--value", score);
  $("#coverage-list").replaceChildren(...Object.entries(coverage).map(([key, value]) => {
    const row = document.createElement("div");
    row.className = `coverage-item ${value}`;
    const text = document.createElement("span"); text.textContent = labels[key] ?? key;
    const dot = document.createElement("i"); dot.title = value;
    row.append(text, dot);
    return row;
  }));
}

// Attached documents ride inside the user turn: the Guide reads inline text
// without a tool call, and nothing is stored server-side.
const pending = [];
$("#attach-input").addEventListener("change", async (event) => {
  clearError();
  for (const file of event.target.files) {
    try {
      if (file.type.startsWith("image/")) {
        const response = await fetch(`/api/interview/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Upload failed with HTTP ${response.status}.`);
        pending.push({ name: file.name, path: body.path, url: URL.createObjectURL(file) });
      } else {
        pending.push({ name: file.name, text: await file.text() });
      }
    } catch (error) {
      showError(new Error(`Could not read ${file.name}: ${error.message}`));
    }
  }
  event.target.value = "";
  renderAttachments();
});

function renderAttachments() {
  $("#attachments").replaceChildren(...pending.map((file, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = file.path ? `${file.name} · image` : `${file.name} · ${Math.ceil(file.text.length / 1000)}k chars`;
    const remove = document.createElement("button");
    remove.type = "button"; remove.title = "Remove"; remove.textContent = "×";
    remove.addEventListener("click", () => { pending.splice(index, 1); renderAttachments(); });
    chip.append(remove);
    return chip;
  }));
  $("#message-input").required = pending.length === 0;
}

function composeMessage(typed) {
  const parts = typed ? [typed] : [];
  for (const file of pending) {
    if (file.path) parts.push(`Attached image: ${file.path} (open this file to view it before answering)`);
    else parts.push(`--- Attached document: ${file.name} ---\n${file.text.trim()}\n--- End of ${file.name} ---`);
  }
  return parts.join("\n\n");
}

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const content = composeMessage(input.value.trim());
  if (!content) return;
  if (!state.provider) return showError(new Error(NO_PROVIDER));
  clearError();
  state.messages.push({ role: "user", content, images: pending.filter((file) => file.url).map((file) => file.url) });
  input.value = "";
  pending.length = 0;
  renderAttachments();
  renderMessages(true);
  setInterviewBusy(true);
  try {
    const guide = await api("/api/interview/turn", { method: "POST", body: { provider: state.provider, messages: state.messages } });
    state.guide = guide;
    state.messages.push({ role: "assistant", content: guide.message });
    renderMessages();
    renderCoverage();
    renderProviders();
    if (guide.status === "ready") showReview();
  } catch (error) {
    renderMessages();
    showError(error);
  } finally {
    setInterviewBusy(false);
  }
});

function setInterviewBusy(value) {
  $("#send-button").disabled = value;
  $("#message-input").disabled = value;
  $("#send-button").firstChild.textContent = value ? "Guide is thinking " : "Send answer ";
}

function showReview() {
  $("#interview-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");
  renderBrief(state.guide.brief);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("#back-button").addEventListener("click", () => {
  $("#review-view").classList.add("hidden");
  $("#interview-view").classList.remove("hidden");
});

function renderBrief(brief) {
  const sections = [
    ["Promise", brief.promise, true],
    ["Primary user", brief.primaryUser],
    ["Problem", brief.problem],
    ["Core workflow", brief.coreWorkflow],
    ["Must-haves", brief.mustHaves],
    ["Non-goals", brief.nonGoals],
    ["Data & access", brief.dataAndAccess],
    ["Acceptance scenarios", brief.acceptanceScenarios, true],
    ["Visual direction", brief.visualDirection],
    ["Deployment", brief.deployment],
    ["Constraints", brief.constraints, true],
  ];
  $("#brief").replaceChildren(...sections.map(([title, value, wide]) => {
    const section = document.createElement("section");
    if (wide) section.className = "wide";
    const heading = document.createElement("h3"); heading.textContent = title;
    section.append(heading);
    if (Array.isArray(value)) {
      const list = document.createElement("ul");
      for (const entry of value) { const item = document.createElement("li"); item.textContent = entry; list.append(item); }
      section.append(list);
    } else {
      const paragraph = document.createElement("p"); paragraph.textContent = value || "Not specified"; section.append(paragraph);
    }
    return section;
  }));
}

$("#start-button").addEventListener("click", async () => {
  clearError();
  $("#start-button").disabled = true;
  try {
    const { job } = await api("/api/jobs", {
      method: "POST",
      body: { provider: state.provider, transcript: state.messages, coverage: state.guide.coverage, brief: state.guide.brief },
    });
    // Submitted briefs queue; the owner goes straight back to shaping the next release.
    showInterview();
    await refreshProjects();
    renderBackgroundBanner();
    if (job.queuePosition) $("#system-status").textContent = `Brief queued #${job.queuePosition}`;
  } catch (error) {
    showError(error);
    $("#start-button").disabled = false;
  }
});

function showRun() {
  hideBoard();
  $("#review-view").classList.add("hidden");
  $("#interview-view").classList.add("hidden");
  $("#run-view").classList.remove("hidden");
  document.querySelector('[data-stage="interview"]').classList.add("done");
  $("#run-id").textContent = state.job.id;
  $("#run-title").textContent = state.job.brief.workingName || "Building your app";
  renderJob();
  renderAttention();
}

async function poll() {
  if (!state.job) return;
  try {
    const result = await api(`/api/jobs/${state.job.id}`);
    state.job = result.job;
    state.events = result.events;
    state.telemetry = await api(`/api/jobs/${state.job.id}/telemetry`);
    renderJob();
    if (PARKED.includes(state.job.state)) {
      state.pausing = false;
      $("#pause-button").disabled = false;
      stopPolling();
      refreshProjects();
    }
  } catch (error) { showError(error); }
}

// Stages before the current one are done; a completed run has every stage done and none active.
function railMarks(progressState) {
  const active = progressState === "repairing" ? "verifying" : progressState;
  const at = active === "completed" ? stageOrder.length : stageOrder.indexOf(active);
  return { active, done: stageOrder.slice(0, Math.max(0, at)) };
}

function renderJob() {
  const job = state.job;
  $("#run-subtitle").textContent = job.blockedBy
    ? `Waiting on recovery of run ${job.blockedBy}: resume it, start it over, or dismiss it.`
    : job.queuePosition
      ? `Queued #${job.queuePosition}${job.queuedFor === "resume" ? " to resume" : ""}; starts when this project's current run finishes.`
      : job.error?.message || statusCopy(job.state);
  const progressState = PARKED.includes(job.state) ? job.failedState : job.state;
  const rail = railMarks(progressState);
  document.querySelectorAll(".stages li").forEach((item) => {
    item.classList.toggle("active", item.dataset.stage === rail.active);
    if (item.dataset.stage !== "interview") item.classList.toggle("done", rail.done.includes(item.dataset.stage));
  });
  renderSupervision();
  renderMap();
  renderArtifacts();
  renderAppMetrics();
  renderRecovery();
  const terminalFailure = PARKED.includes(job.state);
  $("#cancel-button").classList.toggle("hidden", terminalFailure || job.state === "completed");
  $("#cancel-button").textContent = job.state === "queued" ? "Remove from queue" : "Cancel run";
  $("#pause-button").classList.toggle("hidden", !["specifying", "building", "repairing", "reviewing"].includes(job.state));
  // The server's pendingPause survives a reload; state.pausing covers the gap until the next poll.
  if (job.pendingPause) { $("#pause-button").textContent = `Pausing after ${job.stage}…`; $("#pause-button").disabled = true; }
  else if (!state.pausing) $("#pause-button").textContent = "Pause";
  $("#resume-button").textContent = job.nextAction?.action === "resume" ? job.nextAction.label : job.state === "paused" ? "Resume" : "Resume current run";
  $("#dismiss-button").classList.toggle("hidden", !terminalFailure || Boolean(job.dismissed));
  // nextAction is derived by the server's continuation policy; a saved banner's canResume can be stale.
  $("#resume-button").classList.toggle("hidden", job.nextAction?.action !== "resume" || !terminalFailure);
  $("#copy-recovery-button").classList.toggle("hidden", !job.recovery || !terminalFailure);
  $("#start-over-button").classList.toggle("hidden", !terminalFailure);
  $("#report-run-button").classList.toggle("hidden", !terminalFailure);
  const url = $("#app-url");
  url.classList.toggle("hidden", !job.deployment?.url);
  url.textContent = job.deployment?.url ? `${job.deployment.url}${job.deployment.status === "live" ? "" : " · not running"}` : "";
  $("#relaunch-button").classList.toggle("hidden", !(job.state === "completed" && job.deployment && job.deployment.status !== "live"));
  if (job.state === "completed" && job.deployment?.status === "live") {
    $("#open-app").href = job.deployment.url;
    $("#open-app").classList.remove("hidden");
    $("#app-live").textContent = job.waivedProofs?.length ? `Live · owner waived ${job.waivedProofs.map((bug) => bug.id).join(", ")}` : "Live";
    $("#app-live").classList.remove("muted");
  } else if (job.state === "completed") {
    $("#app-live").textContent = "Stopped";
    $("#app-live").classList.add("muted");
  }
}

// Supervision is shown beside the lifecycle state, never instead of it.
function renderSupervision() {
  const watch = state.job.supervision;
  let line = $("#supervision");
  if (!line) {
    line = document.createElement("p"); line.id = "supervision"; line.className = "muted";
    $("#run-subtitle").after(line);
  }
  line.classList.toggle("hidden", !watch);
  if (!watch) return;
  const when = (iso) => iso ? `${formatDuration(Date.now() - new Date(iso).getTime())} ago` : "none yet";
  const worker = watch.worker;
  const waiting = worker?.kind === "command" ? ` · waiting on ${worker.gate ?? "command"} for ${formatDuration(worker.ageMs)}${worker.hardLimitMs ? ` of ${formatDuration(worker.hardLimitMs)}` : ""}` : "";
  const used = state.job.watch?.continuations ? Object.values(state.job.watch.continuations).reduce((sum, n) => sum + n, 0) : 0;
  line.textContent = `Supervision: ${watch.status}${watch.stage ? ` · ${watch.stage}` : ""}${waiting} · last activity ${when(watch.lastActivityAt)} · last confirmed progress ${when(watch.lastProgressAt)}`
    + ` · ${state.job.attempt ?? 0} repairs, ${used} automatic continuation${used === 1 ? "" : "s"} used · ${watch.monitoring ? "monitored while the factory server runs" : "not monitored while parked"}`;
}

// job.attempt counts every repair since the run began; recovery limits are points on that counter.
// Per feature: cursor.attemptBefore is where the feature started (src/feature-recovery.mjs). Per plan:
// totalRepairLimit = start + maxRepairs × (features + 1), and maxRepairs is the feature's own window.
// ponytail: the derived plan cap is low if the plan limit clipped the last feature's window; send maxRepairs if that matters.
const repairUsage = (job) => {
  const phase = job.recoveryPhase, start = phase?.cursor?.attemptBefore;
  if (phase?.totalRepairLimit === undefined || start === undefined || job.repairBudgetLimit == null) return null;
  const perFeature = job.repairBudgetLimit - start, planCap = perFeature * (phase.plan.slices.length + 1);
  return { feature: [job.attempt - start, perFeature], plan: [Math.max(0, planCap - (phase.totalRepairLimit - job.attempt)), planCap] };
};
// Mirrors pendingProofs in src/wbs.mjs.
const pendingProofs = (job) => (job.outstandingProofs ?? []).filter((entry) => entry.status === "pending");

// Bounded like MAX_AMENDED_PLAN_BYTES in src/factory.mjs; the server repeats every check.
const MAX_AMENDED_PLAN_BYTES = 4_000_000;

// Exhausted plan corrections: explain, offer the help packet, and take a corrected plan from a file.
// A ready plan offers the same packet and upload as an alternative to approval, for writing a replacement.
// The selection lives in state so polling re-renders and server errors never erase it.
function renderAmendment(features, next, phase, action) {
  const blocked = next.action === "amend-plan";
  const pending = state.amendment?.jobId === state.job.id && state.amendment.phaseId === phase.id ? state.amendment : null;
  if (!pending) state.amendment = null;
  const note = document.createElement("p"); note.textContent = blocked ? `${next.reason} ${phase.corrections ?? 0} automatic correction${phase.corrections === 1 ? "" : "s"} used; no repairs have started.` : next.alternatives.find((item) => item.action === "amend-plan").reason;
  const packet = document.createElement("a"); packet.href = `/api/jobs/${state.job.id}/recovery-plan-packet`; packet.download = ""; packet.className = "button"; packet.textContent = "Download plan help packet";
  const details = document.createElement("details"); details.open = Boolean(pending); details.addEventListener("toggle", () => { state.amendmentOpen = details.open; });
  if (state.amendmentOpen) details.open = true;
  const summary = document.createElement("summary"); summary.textContent = "Advanced: submit corrected plan for review";
  const label = document.createElement("label"); label.htmlFor = "amendment-file"; label.textContent = "Corrected plan file (.json)";
  const file = document.createElement("input"); file.type = "file"; file.id = "amendment-file"; file.accept = ".json,application/json";
  const status = document.createElement("p"); status.id = "amendment-status";
  const submit = document.createElement("button"); submit.type = "button"; submit.textContent = "Submit corrected plan for review"; submit.disabled = !pending?.plan;
  const show = () => {
    status.textContent = pending ? (pending.error ? pending.error : `${pending.name} (${pending.size.toLocaleString()} bytes) will be reviewed once, for recovery phase ${phase.id}.`) : "No file selected.";
    status.className = pending?.error ? "error" : "muted"; submit.disabled = !pending?.plan;
  };
  file.addEventListener("change", async () => {
    const chosen = file.files[0]; if (!chosen) return;
    const entry = state.amendment = { jobId: state.job.id, phaseId: phase.id, name: chosen.name, size: chosen.size, plan: null, error: null };
    if (chosen.size > MAX_AMENDED_PLAN_BYTES) entry.error = `${chosen.name} is larger than ${MAX_AMENDED_PLAN_BYTES.toLocaleString()} bytes.`;
    else {
      try { const plan = JSON.parse(await chosen.text()); if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("not an object"); entry.plan = plan; }
      catch { entry.error = `${chosen.name} is not a JSON repair plan.`; }
    }
    renderRecovery();
  });
  submit.addEventListener("click", async () => {
    if (!pending?.plan) return;
    submit.disabled = true; clearError();
    try { await api(`/api/jobs/${state.job.id}/recovery-review`, { method: "POST", body: { phaseId: pending.phaseId, plan: pending.plan } }); state.amendment = null; await poll(); startPolling(); }
    catch (error) { pending.error = error.message; showError(error); show(); }
  });
  show();
  // A ready plan's replacement is the advanced path, so its explanation and packet sit inside the
  // disclosure; loose, they rendered under "Prepare repair plan" and read as that button's description.
  if (blocked) { details.append(summary, label, file, status, submit); features.append(note, packet, details); }
  else { packet.textContent = "Download plan packet for a replacement"; details.append(summary, note, packet, label, file, status, submit); features.append(details); }
  const alternative = blocked && next.alternatives?.[0];
  if (alternative) { const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = alternative.reason; features.append(hint); action(alternative.label, "recovery-plan"); }
}

function renderRecovery() {
  const phase = state.job.recoveryPhase;
  const recovery = state.job.recovery ?? (phase ? { title: phase.status === "planning" ? "Preparing repair plan" : "Repairs", summary: phase.status === "planning" ? "Planning repair features from the review findings and every spec and prototype input." : `${phase.done.length}/${phase.plan?.slices.length ?? 0} recovery features verified`, actions: [], workspace: "Preserved project workspace", automaticRetry: "Each feature has bounded repairs; final deployment requires the full original review." } : null);
  const visible = recovery && (PARKED.includes(state.job.state) || phase);
  $("#recovery-card").classList.toggle("hidden", !visible);
  if (!visible) return;
  let features = $("#feature-recovery-controls");
  if (!features) {
    features = document.createElement("section"); features.id = "feature-recovery-controls";
    $("#recovery-card").append(features);
  }
  features.replaceChildren();
  const action = (label, endpoint, body = {}) => {
    const button = document.createElement("button"); button.textContent = label; button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true; clearError();
      try { await api(`/api/jobs/${state.job.id}/${endpoint}`, { method: "POST", body: endpoint === "recovery-plan" ? { ...body, guidance: $("#recovery-plan-feedback")?.value ?? "" } : endpoint === "waive-proof" ? { ...body, reason: $("#recovery-plan-feedback")?.value ?? "" } : body }); await poll(); startPolling(); }
      catch (error) { showError(error); button.disabled = false; }
    }); features.append(button);
  };
  const next = state.job.nextAction;
  if (next?.action === "amend-plan" && phase) renderAmendment(features, next, phase, action);
  else if (next?.action === "retry-plan" || next?.action === "revise-inputs") action(next.label, "recovery-plan");
  // The same admission the server applies: only the policy's planning steps (and revising a ready plan) offer the planner.
  else if (next?.action === "prepare-plan" || next?.action === "approve-plan") action("Prepare repair plan", "recovery-plan");
  if (next?.action === "approve-plan" && phase && next.alternatives?.some((item) => item.action === "amend-plan")) renderAmendment(features, next, phase, action);
  // The reviewer's own test is faulty: the owner's note in the box above becomes the recorded reason.
  for (const item of next?.alternatives?.filter((entry) => entry.action === "waive-proof") ?? []) { const hint = document.createElement("p"); hint.className = "muted"; hint.textContent = item.reason; features.append(hint); if (item.repairerNote) { const note = document.createElement("pre"); note.style.whiteSpace = "pre-wrap"; note.textContent = `Last repair turn said:\n${item.repairerNote}`; features.append(note); } action(item.label, "waive-proof", { proof: item.proof }); }
  // Owner-added specs join the run's inputs; the next plan, review or Resume sees them.
  if (next && !["none", "factory-fix"].includes(next.action)) {
    const label = document.createElement("label"); label.htmlFor = "input-file"; label.textContent = "Add a spec or prototype file";
    const file = document.createElement("input"); file.type = "file"; file.id = "input-file";
    file.addEventListener("change", async () => {
      clearError();
      for (const chosen of file.files) {
        const response = await fetch(`/api/jobs/${state.job.id}/inputs?name=${encodeURIComponent(chosen.name)}`, { method: "POST", body: chosen });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { showError(new Error(body.error || `Upload failed with HTTP ${response.status}.`)); break; }
      }
      await poll();
    });
    features.append(label, file);
  }
  // Reference lists fold to one counted row and always start collapsed.
  // Polling redraws this card, so the owner's open/closed choice is kept per title.
  state.recoveryFolds ??= {};
  const fold = (title) => {
    const details = document.createElement("details"); details.className = "recovery-fold";
    details.open = state.recoveryFolds[title] ?? false;
    details.addEventListener("toggle", () => { state.recoveryFolds[title] = details.open; });
    return details;
  };
  const list = (title, rows, folded = false) => {
    if (!rows.length) return;
    const items = document.createElement("ol");
    items.append(...rows.map((text) => { const row = document.createElement("li"); row.textContent = text; return row; }));
    if (!folded) { const heading = document.createElement("h3"); heading.textContent = title; features.append(heading, items); return; }
    const details = fold(title);
    const summary = document.createElement("summary"); summary.textContent = `${title} `;
    summary.append(Object.assign(document.createElement("span"), { textContent: rows.length }));
    details.append(summary, items); features.append(details);
    items.scrollTop = state.recoveryFolds[`${title}:scroll`] ?? 0;
    items.addEventListener("scroll", () => { state.recoveryFolds[`${title}:scroll`] = items.scrollTop; });
  };
  const incident = state.job.watch?.incident;
  if (incident && PARKED.includes(state.job.state)) list("Incident", [`Observed: ${incident.observed}`, `Uncertain: ${incident.uncertain}`, `Tried: ${incident.tried}`, `Preserved: ${incident.preserved}`, `Next: ${state.job.nextAction?.label ?? state.job.nextAction?.reason ?? incident.nextAction}`, ...incident.logs.map((log) => `Log: ${log}`)]);
  if (phase?.status === "plan_failed") list("Plan review blockers", phase.planBlockers ?? []);
  if (phase?.plan) {
    list("Remaining gaps", (phase.request?.checks ?? []).map((check) => `${check.id}: ${check.text}${check.reason ? ` — ${check.reason}` : ""}`), true);
    // Mirrors pendingChecks in src/wbs.mjs: a check is not verified with its feature while any pending
    // obligation in this plan, or outstanding from an earlier one, still supports it.
    const refs = new Set([...phase.plan.slices.flatMap((slice) => slice.acceptance.filter((item) => item.proof?.pending && !(state.job.outstandingProofs ?? []).some(entry => entry.planDigest === phase.planDigest && entry.feature === slice.id && entry.obligation.id === item.id && entry.status !== "pending"))), ...pendingProofs(state.job).map((entry) => entry.obligation)].flatMap((item) => item.refs ?? []));
    const awaiting = (slice) => (slice.closes ?? []).filter((id) => refs.has(id));
    list("Features", phase.plan.slices.map((slice) => `${phase.done.includes(slice.id) ? "Verified" : phase.current === slice.id ? "Current" : "Pending"}: ${slice.title} (${(slice.closes ?? slice.checks).join(", ")})${awaiting(slice).length ? `; ${awaiting(slice).join(", ")} pending integration proof` : ""}`), true);
    list("Outstanding integration proofs", pendingProofs(state.job).map((entry) => `${entry.key}: ${entry.obligation.behavior} — ${entry.obligation.proof.command.join(" ")}`));
    list("Verification checks", phase.plan.slices.flatMap((slice) => slice.acceptance.map((item) => typeof item === "string" ? item : `${item.id}: ${item.behavior} — ${item.proof.command.join(" ")}${item.proof.pending ? " (runs at integration)" : ""}`)), true);
    if (phase.status === "ready") { const allowance = document.createElement("p"); allowance.textContent = `Repair allowance: up to ${2 * (phase.plan.slices.length + 1)} attempts (2 per feature plus 2 for the full final review).`; features.append(allowance); }
    const details = fold("Full plan"); const summary = document.createElement("summary"); summary.textContent = "Full plan with sources and dependencies";
    const pre = document.createElement("pre"); pre.style.whiteSpace = "pre-wrap"; pre.textContent = JSON.stringify(phase.plan, null, 2); details.append(summary, pre); features.append(details);
    pre.scrollTop = state.recoveryFolds["Full plan:scroll"] ?? 0; pre.addEventListener("scroll", () => { state.recoveryFolds["Full plan:scroll"] = pre.scrollTop; });
    if (phase.status === "ready") {
      const label = document.createElement("label"); label.htmlFor = "recovery-plan-feedback"; label.textContent = "Changes for the repair plan (optional)";
      const feedback = document.createElement("textarea"); feedback.id = "recovery-plan-feedback"; feedback.maxLength = 6000; feedback.value = state.recoveryPlanFeedback ?? "";
      feedback.addEventListener("input", () => { state.recoveryPlanFeedback = feedback.value; }); features.append(label, feedback);
    }
    if (phase.status === "ready") action("Approve and continue repairs", "recovery-start", { planDigest: phase.planDigest });
    const usage = repairUsage(state.job);
    if (usage) { const budget = document.createElement("p"); budget.textContent = `Repair attempts used: This feature: ${usage.feature[0]} of ${usage.feature[1]} · Plan: ${usage.plan[0]} of ${usage.plan[1]}`; features.append(budget); }
  }
  $("#recovery-title").textContent = recovery.title;
  $("#recovery-summary").textContent = recovery.summary;
  $("#recovery-actions").replaceChildren(...recovery.actions.map((action) => {
    const item = document.createElement("li");
    item.textContent = action;
    return item;
  }));
  // Static reassurance only matters once the run has stopped.
  $(".recovery-meta").classList.toggle("hidden", !PARKED.includes(state.job.state));
  $("#recovery-workspace").textContent = recovery.workspace;
  $("#recovery-retry").textContent = recovery.automaticRetry;
  const restartable = (state.job.sliceDone ?? []).slice(1);
  $("#recovery-restart").classList.toggle("hidden", restartable.length === 0);
  $("#recovery-restart-buttons").replaceChildren(...restartable.map((sliceId) => {
    const button = document.createElement("button");
    button.className = "button ghost small";
    button.type = "button";
    button.textContent = sliceId;
    button.title = `Rewind the tree to just before ${sliceId} and rebuild from there`;
    button.addEventListener("click", () => restartFromSlice(sliceId));
    return button;
  }));
}

async function restartFromSlice(sliceId) {
  clearError();
  try {
    await api(`/api/jobs/${state.job.id}/restart`, { method: "POST", body: { fromSlice: sliceId } });
    await poll();
    startPolling();
    refreshProjects();
  } catch (error) {
    showError(error);
  }
}

// The run map: the plan as a metro line, the selected stop, four status answers and the activity
// stream. Everything is read from the job record and its event log; nothing here is a second source of truth.
const PIPELINE_STOPS = [["specifying", "SPEC", "Write the PRD, plan and acceptance contract"], ["building", "BUILD", "Build the application"], ["verifying", "GATES", "Run the deterministic quality gates"], ["reviewing", "REVIEW", "Review against the frozen contract"], ["deploying", "DEPLOY", "Launch and check the application"]];
const MAP_KINDS = { all: "All", agent: "Agent", file: "Files", gate: "Gates", stage: "Stages" };
const QUIET_WARN_MS = 10 * 60_000, QUIET_BAD_MS = 30 * 60_000;
const minutesLabel = (ms) => { const m = Math.floor(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function mapPlan(job) {
  const phase = job.recoveryPhase, approved = job.approvedPlan;
  if (phase?.plan?.slices) return { label: "Repair plan", slices: phase.plan.slices, done: phase.done ?? [], current: phase.current, stats: phase.stats ?? {}, start: phase.approvedAt };
  if (approved?.plan?.slices) {
    const slices = approved.plan.slices;
    return { label: "Feature plan", slices, done: job.sliceDone ?? [], current: job.featureCursor?.id ?? slices[job.sliceIndex ?? 0]?.id, stats: job.sliceStats ?? {}, start: approved.approvedAt };
  }
  return null;
}

function mapStops(job) {
  const parked = PARKED.includes(job.state), finished = job.state === "completed";
  const live = (on) => !on ? "queued" : parked ? "blocked" : "current";
  const plan = mapPlan(job);
  if (!plan) {
    const at = PIPELINE_STOPS.findIndex(([stage]) => stage === (parked ? job.failedState : job.state === "repairing" ? "verifying" : job.state));
    const spent = stateRunningMs(job);
    return { label: `${sdlcOption(job.sdlc).label} · ${job.provider}`, stops: PIPELINE_STOPS.map(([stage, id, title], index) => ({ id, title, deps: [], ms: spent[stage] ?? 0, status: finished || (at >= 0 && index < at) ? "done" : live(index === at) })) };
  }
  let last = Date.parse(plan.start) || null;
  const stops = plan.slices.map((slice) => {
    const stat = plan.stats[slice.id] ?? {}, done = plan.done.includes(slice.id), current = !done && !finished && slice.id === plan.current;
    // Running time since the previous feature was verified: pauses, stops and long silences (job.idleGaps) are subtracted.
    const ended = done ? Date.parse(stat.verifiedAt) : current ? (parked ? Date.parse(job.updatedAt) : Date.now()) : null;
    const ms = ended && last ? runningMs(last, ended, job.idleGaps) : 0;
    if (done && stat.verifiedAt) last = Date.parse(stat.verifiedAt);
    return { id: slice.id, title: slice.title, deps: (slice.dependsOn ?? []).map((dep) => plan.slices.findIndex((other) => other.id === dep)).filter((index) => index >= 0), ms, reviews: stat.reviews ?? 0, repairs: stat.repairs ?? 0, status: done ? "done" : live(current) };
  });
  return { label: `${plan.label} · ${plural(stops.length, "feature")} · ${job.provider}`, stops, features: true };
}

// Health watches activity, not the event log alone: the agent's streamed tool use and the workspace
// commands it runs both count, so a long silent stretch means nothing is happening at all.
function mapHealth(job) {
  if (job.state === "completed") return { tone: "ok", text: "Finished" };
  if (job.state === "queued") return { tone: "idle", text: "Queued" };
  if (job.state === "paused") return { tone: "warn", text: "Paused · needs you" };
  if (PARKED.includes(job.state)) return { tone: "bad", text: "Stopped · needs you" };
  const worker = job.supervision?.worker;
  if (worker?.kind === "command") return { tone: "ok", text: `Running ${worker.gate ?? "a check"} · ${formatSpan(worker.ageMs)}` };
  const quiet = lastActivityAge(job);
  if (quiet == null) return { tone: "warn", text: "No activity seen yet" };
  const tone = quiet < QUIET_WARN_MS ? "ok" : quiet < QUIET_BAD_MS ? "warn" : "bad";
  return { tone, text: `${tone === "ok" ? "Alive" : "Quiet"} · last activity ${formatSpan(quiet)} ago` };
}

function lastActivityAge(job) {
  const at = Math.max(Date.parse(job.supervision?.lastActivityAt ?? "") || 0, Date.parse(state.events.at(-1)?.at ?? "") || 0);
  return at ? Date.now() - at : null;
}

const eventKind = (entry) => entry.type.startsWith("gate.") ? "gate"
  : /^(agent|item|turn|thread|supervision)\./.test(entry.type) ? (/Completed (Write|Edit|MultiEdit|NotebookEdit)\b/.test(entry.message ?? "") ? "file" : "agent")
  : "stage";
// The newest `cap` rows of each kind, newest first: thousands of tool events must not push the rare
// stage and gate rows out of "All". ponytail: older rows are dropped; page back if the owner needs them.
function streamRows(events, filter, cap = 300) {
  const counts = {}, rows = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const kind = eventKind(events[i]);
    if ((filter === "all" || kind === filter) && (counts[kind] = (counts[kind] ?? 0) + 1) <= cap) rows.push(events[i]);
  }
  return rows;
}

function renderMap() {
  const job = state.job, { label, stops, features } = mapStops(job);
  const live = stops.findIndex((stop) => stop.status === "current" || stop.status === "blocked");
  const picked = state.mapPick?.job === job.id ? state.mapPick.stop : null;
  const chosen = stops.findIndex((stop) => stop.id === picked);
  const selected = picked === "health" ? -1 : chosen >= 0 ? chosen : live >= 0 ? live : Math.max(0, stops.map((stop) => stop.status).lastIndexOf("done"));
  $("#map-title").textContent = label;
  const health = mapHealth(job);
  $("#health").className = `health-pill ${health.tone}`;
  $("#health").setAttribute("aria-pressed", String(picked === "health"));
  $("#health-text").textContent = health.text;
  renderMetro(stops, selected, live);
  renderStop(stops, selected, picked === "health", health);
  renderAnswers(stops, live, features);
  renderStream();
}

function renderMetro(stops, selected, live) {
  const svg = $("#metro"), narrow = svg.clientWidth > 0 && svg.clientWidth < 520, width = narrow ? 340 : 680;
  const perRow = Math.min(stops.length, narrow ? 5 : 9), rows = Math.ceil(stops.length / perRow), step = perRow > 1 ? (width - 100) / (perRow - 1) : 0;
  const train = live >= 0 ? minutesLabel(stops[live].ms) : "";
  // Rebuilt only when something visible changes, so the train's animation and keyboard focus survive polling.
  const signature = `${perRow}|${state.job.id}|${stops.map((stop) => stop.status).join()}|${selected}|${train}`;
  if (svg.dataset.signature === signature) return;
  svg.dataset.signature = signature;
  const focused = svg.contains(document.activeElement) ? document.activeElement.dataset.index : null;
  const at = (index) => { const row = Math.floor(index / perRow), col = index % perRow; return [row % 2 ? width - 50 - col * step : 50 + col * step, 44 + row * 80]; };
  const node = (parent, tag, attrs, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    if (text != null) element.textContent = text;
    parent.append(element); return element;
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${44 + (rows - 1) * 80 + 40}`);
  svg.replaceChildren();
  const spurs = node(svg, "g", {}), line = node(svg, "g", {});
  stops.slice(0, -1).forEach((stop, index) => {
    const [x0, y0] = at(index), [x1, y1] = at(index + 1), dx = x0 > width / 2 ? 56 : -56;
    node(line, "path", { class: `track${stop.status === "done" && stops[index + 1].status !== "queued" ? " done" : ""}`, d: y0 === y1 ? `M${x0} ${y0} L${x1} ${y1}` : `M${x0} ${y0} C${x0 + dx} ${y0} ${x1 + dx} ${y1} ${x1} ${y1}` });
  });
  const deps = new Set(stops[selected]?.deps ?? []);
  for (const dep of deps) {
    const [x, y] = at(selected), [dx, dy] = at(dep);
    node(spurs, "path", { class: "spur", d: `M${x} ${y} Q${(x + dx) / 2} ${y === dy ? y + 40 : (y + dy) / 2} ${dx} ${dy}` });
  }
  stops.forEach((stop, index) => {
    const [x, y] = at(index);
    const group = node(line, "g", { class: `stop ${stop.status}${index === selected ? " selected" : ""}${deps.has(index) ? " dep" : ""}`, tabindex: 0, role: "button", "data-index": index, "aria-pressed": String(index === selected), "aria-label": `${index + 1}. ${stop.id}, ${stop.status === "done" ? "verified" : stop.status}` });
    node(group, "circle", { cx: x, cy: y, r: 12 });
    node(group, "text", { x, y: y + 4 }, index + 1);
    const pick = () => { state.mapPick = { job: state.job.id, stop: stop.id }; renderMap(); };
    group.addEventListener("click", pick);
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); } });
  });
  if (live >= 0) {
    const [x, y] = at(live), status = stops[live].status;
    node(line, "text", { class: `stop-name ${status}`, x, y: y - 20 }, stops[live].id);
    const car = node(line, "g", { class: `train ${status}` });
    node(car, "rect", { x: x + 16, y: y - 9, width: 34, height: 18, rx: 6 });
    node(car, "text", { x: x + 33, y: y + 4 }, train);
  }
  if (focused != null) svg.querySelector(`[data-index="${focused}"]`)?.focus();
}

function renderStop(stops, selected, showHealth, health) {
  const job = state.job;
  const title = document.createElement("strong"), about = document.createElement("p"), status = document.createElement("p");
  status.className = "stop-status";
  if (showHealth) {
    title.textContent = "Health";
    about.textContent = "Watches the agent's streamed tool use, the commands it runs and the controller's events.";
    const quiet = lastActivityAge(job);
    status.textContent = `${health.text}${job.supervision ? ` · supervision: ${job.supervision.status}` : ""}${quiet != null ? ` · quiet ${formatSpan(quiet)}` : ""} · green under ${QUIET_WARN_MS / 60_000} minutes quiet, amber to ${QUIET_BAD_MS / 60_000}, red past that or when the run stops.`;
    patchChildren($("#stop"), [title, about, status]);
    return;
  }
  const stop = stops[selected];
  if (!stop) { patchChildren($("#stop"), []); return; }
  title.textContent = `${selected + 1} · ${stop.id}`;
  about.textContent = stop.title;
  const tone = document.createElement("span");
  const usage = repairUsage(job);
  if (stop.status === "done") {
    tone.className = "ok"; tone.textContent = "Verified";
    status.append(tone, stop.reviews || stop.repairs || stop.ms ? ` · ${formatSpan(stop.ms)} · ${stop.repairs ? plural(stop.repairs, "repair") : "no repairs"}${stop.reviews ? ` · review passed ${stop.reviews <= 1 ? "first try" : `on pass ${stop.reviews}`}` : ""}` : "");
  } else if (stop.status === "current") {
    tone.className = "warn"; tone.textContent = job.stage.split(" — ")[0];
    status.append(tone, ` · ${minutesLabel(stop.ms)} so far${usage ? ` · ${usage.feature[0]} of ${usage.feature[1]} repairs used` : ""}`);
  } else if (stop.status === "blocked") {
    tone.className = "bad"; tone.textContent = job.state === "paused" ? "Paused" : "Stopped";
    status.append(tone, ` · ${job.error?.message ?? statusCopy(job.state)}`);
  } else {
    const waiting = stop.deps.filter((dep) => stops[dep].status !== "done").map((dep) => `${dep + 1} ${stops[dep].id}`);
    tone.className = "muted"; tone.textContent = "Queued";
    status.append(tone, waiting.length ? ` · waits on ${waiting.join(", ")}` : " · ready when the line reaches it");
  }
  patchChildren($("#stop"), [title, about, status]);
}

function runningMs(from, to, gaps = []) {
  let ms = Math.max(0, to - from);
  for (const [start, end] of gaps) ms -= Math.max(0, Math.min(to, end) - Math.max(from, start));
  return Math.max(0, ms);
}

// Running time per pipeline state: pauses, stops and long silences (job.idleGaps) inside a stage don't count.
function stateRunningMs(job, now = Date.now()) {
  const spent = {};
  for (const stage of job.stageHistory ?? []) {
    spent[stage.state] = (spent[stage.state] ?? 0) + runningMs(Date.parse(stage.startedAt), stage.endedAt ? Date.parse(stage.endedAt) : now, job.idleGaps);
  }
  return spent;
}

// Time left from running time only: median per feature (one slow feature should not drag it), the underway feature
// credited for what it has already run, and a quartile range once there are enough samples.
function timeLeft(stops, live) {
  const done = stops.filter((stop) => stop.status === "done" && stop.ms > 0).map((stop) => stop.ms).sort((a, b) => a - b);
  if (!done.length) return null;
  const at = (q) => done[Math.min(done.length - 1, Math.floor(q * done.length))];
  const rest = Math.max(0, stops.filter((stop) => stop.status !== "done").length - (live >= 0 ? 1 : 0));
  const total = (per) => (live >= 0 ? Math.max(per * 0.25, per - stops[live].ms) : 0) + per * rest;
  return { median: at(0.5), mid: total(at(0.5)), range: done.length >= 4 ? [total(at(0.25)), total(at(0.75))] : null };
}

function renderAnswers(stops, live, features) {
  const job = state.job, parked = PARKED.includes(job.state), quiet = lastActivityAge(job);
  const recent = state.events.findLast((entry) => eventKind(entry) !== "stage");
  const moving = job.state === "completed" ? ["ok", "No; the run is finished."]
    : job.state === "queued" ? ["muted", "Not yet; it is waiting in the queue."]
      : parked ? ["bad", `No. ${job.state === "paused" ? "Paused on request." : job.error?.message ?? "The run stopped."}`]
        : quiet != null && quiet >= QUIET_WARN_MS ? [quiet >= QUIET_BAD_MS ? "bad" : "warn", `Quiet for ${formatSpan(quiet)}. ${job.supervision?.status ?? ""}; the safety cap still bounds this turn.`]
          : ["ok", `Yes. ${recent ? `Last activity: ${recent.message || recent.type}, ${formatSpan(Date.now() - Date.parse(recent.at))} ago.` : job.stage}`];
  // The current feature's cases only: job.caseResults keeps every case from every feature and superseded plan.
  const plan = mapPlan(job), slice = plan?.slices.find((item) => item.id === plan.current);
  const usage = repairUsage(job), cases = (slice?.acceptance ?? []).flatMap((item) => item.cases ?? []).map((item) => job.caseResults?.[item.id] ?? { status: "not run" });
  const passed = cases.filter((entry) => entry.status === "passed").length;
  // Each figure names its scope (this feature, this plan, whole run): they differ and read alike otherwise.
  const feature = [usage && `${usage.feature[0]} of ${usage.feature[1]} repairs used`, cases.length && `${passed} of ${cases.length} acceptance cases pass`].filter(Boolean);
  const repairs = [feature.length && `This feature: ${feature.join(", ")}.`, usage ? `This plan: ${usage.plan[0]} of ${usage.plan[1]} repairs used.` : `Whole run: ${plural(job.attempt ?? 0, "repair")}.`].filter(Boolean).join(" ");
  const healthy = [job.supervision?.status === "Progress needs checking" ? "warn" : usage && usage.feature[0] >= usage.feature[1] ? "warn" : "ok", repairs];
  const verified = stops.filter((stop) => stop.status === "done");
  const estimate = features ? timeLeft(stops, live) : null;
  const elapsed = runningMs(Date.parse(job.startedAt || job.createdAt), job.completedAt ? Date.parse(job.completedAt) : Date.now(), job.idleGaps);
  const far = ["", `${features ? "This plan: " : ""}${verified.length} of ${stops.length} ${features ? "features verified" : "steps done"}${live >= 0 ? `; ${features ? "feature" : "step"} ${live + 1} is ${stops[live].status === "blocked" ? "stopped" : "underway"}` : ""}.${estimate && estimate.mid > 0 ? ` About ${estimate.range ? `${formatSpan(estimate.range[0])} to ${formatSpan(estimate.range[1])}` : formatSpan(estimate.mid)} of running time left (median ${minutesLabel(estimate.median)} a feature).` : ""} Whole run${features ? " (every plan)" : ""}: ${formatSpan(elapsed)} running${usageLine(state.telemetry?.summary?.tokens?.total)}.`];
  const next = job.nextAction;
  const needs = parked && next && !["none", "factory-fix"].includes(next.action) ? ["bad", `Yes: ${next.label}${next.reason ? `. ${next.reason}` : ""}`]
    : job.recoveryPhase?.status === "ready" ? ["warn", "Yes: review and approve the repair plan above."]
      : parked ? ["bad", "Yes: the run stopped; see the recovery checkpoint above."]
        : ["ok", "No."];
  patchChildren($("#qa"), [["Moving?", moving], ["Healthy?", healthy], ["How far?", far], ["Needs you?", needs]].flatMap(([question, [tone, answer]]) => [
    Object.assign(document.createElement("dt"), { textContent: question }),
    Object.assign(document.createElement("dd"), { textContent: answer, className: tone }),
  ]));
}

// Polling redraws every 1.5s. Replacing nodes wholesale drops the browser's scroll anchor and the page
// jumps, so keep each existing element and change only the text or class that differs.
function patchChildren(parent, nodes) {
  const old = [...parent.children];
  if (old.length !== nodes.length || old.some((node, index) => node.tagName !== nodes[index].tagName)) { parent.replaceChildren(...nodes); return; }
  old.forEach((node, index) => {
    const next = nodes[index];
    if (node.className !== next.className) node.className = next.className;
    if (node.innerHTML !== next.innerHTML) node.replaceChildren(...next.childNodes);
  });
}

function renderStream() {
  state.mapFilter ??= "all";
  if (!$("#chips").childElementCount) {
    $("#chips").append(...Object.entries(MAP_KINDS).map(([kind, text]) => {
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: text, className: "button ghost small" });
      button.dataset.kind = kind;
      button.addEventListener("click", () => { state.mapFilter = kind; renderStream(); });
      return button;
    }));
  }
  for (const button of $("#chips").children) button.setAttribute("aria-pressed", String(button.dataset.kind === state.mapFilter));
  const seen = state.streamSeen?.job === state.job.id ? state.streamSeen.at : null;
  // Rebuild only when the rows would differ; an unchanged rebuild also resets the list's own scroll.
  const key = `${state.job.id}|${state.mapFilter}|${state.events.length}|${state.events.at(-1)?.at}`;
  if ($("#events").dataset.key === key) return;
  $("#events").dataset.key = key;
  const rows = streamRows(state.events, state.mapFilter);
  // Newest rows land on top, so keep the row the owner is reading at the same height; at the top, stay on top for new rows.
  const list = $("#events"), top = () => list.getBoundingClientRect().top;
  const anchor = list.scrollTop > 4 ? [...list.children].find((row) => row.getBoundingClientRect().bottom > top()) : null;
  const held = anchor && { at: anchor.dataset.at, offset: anchor.getBoundingClientRect().top - top() };
  list.replaceChildren(...rows.map((entry) => {
    const kind = eventKind(entry), failed = /failed|error/.test(entry.type);
    const row = document.createElement("div");
    row.className = `event${failed ? " fail" : ""}${seen && entry.at > seen ? " fresh" : ""}`;
    const time = document.createElement("time"); time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const badge = Object.assign(document.createElement("i"), { className: `kind ${failed ? "fail" : kind}`, textContent: MAP_KINDS[kind] });
    const text = document.createElement("span"); text.textContent = entry.message || entry.type;
    row.append(time, badge, text); row.dataset.at = entry.at;
    return row;
  }));
  const again = held && [...list.children].find((row) => row.dataset.at === held.at);
  if (again) list.scrollTop += again.getBoundingClientRect().top - top() - held.offset;
  state.streamSeen = { job: state.job.id, at: state.events.at(-1)?.at ?? seen };
}

$("#health").addEventListener("click", () => {
  if (!state.job) return;
  state.mapPick = { job: state.job.id, stop: state.mapPick?.job === state.job.id && state.mapPick.stop === "health" ? null : "health" };
  renderMap();
});

function renderArtifacts() {
  const canShow = stageOrder.indexOf(state.job.state) > 0 || ["failed", "completed"].includes(state.job.state);
  if (!canShow) return;
  const names = [["prd", "Product requirements"], ["plan", "Build plan"], ["acceptance", "Acceptance contract"], ["requirements", "Frozen input"], ["manifest", "Runtime manifest"]];
  if (state.job.sdlc === "slices") names.splice(4, 0, ["slices", "Slice plan"]);
  $("#artifacts").replaceChildren(...names.map(([name, label]) => {
    const link = document.createElement("a");
    link.className = "artifact"; link.href = `/api/jobs/${state.job.id}/artifacts/${name}`; link.target = "_blank";
    const text = document.createElement("strong"); text.textContent = label;
    const arrow = document.createElement("span"); arrow.textContent = "↗";
    link.append(text, arrow); return link;
  }));
}

// "· 398K tokens in · 14K out". No dollar figure: members run on subscriptions, and the CLI's
// list-price cost read as an API bill. Cost stays in runs.jsonl.
function usageLine(usage, short = false) {
  if (!usage) return "";
  const count = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
  return short ? ` · ${count(usage.inputTokens)} in · ${count(usage.outputTokens)} out` : ` · ${count(usage.inputTokens)} tokens in · ${count(usage.outputTokens)} out`;
}

function renderAppMetrics() {
  const app = state.telemetry?.app;
  if (!app || app.unavailable) return;
  const routes = Array.isArray(app.routes)
    ? app.routes
    : Object.entries(app.routes ?? {}).map(([path, count]) => ({ method: "", path, count }));
  $("#request-total").textContent = app.requests.total;
  $("#error-total").textContent = app.requests.errors;
  $("#latency-average").textContent = `${app.latencyMs.average} ms`;
  $("#app-uptime").textContent = formatDuration(app.uptimeSeconds * 1000);
  $("#app-live").textContent = "Live";
  $("#app-live").classList.remove("muted");
  $("#route-list").replaceChildren(...routes.slice(0, 8).map((route) => {
    const row = document.createElement("div"); row.className = "route";
    for (const value of [route.method, route.path, String(route.count)]) { const span = document.createElement("span"); span.textContent = value; row.append(span); }
    return row;
  }));
}

$("#pause-button").addEventListener("click", async () => {
  clearError();
  try {
    await api(`/api/jobs/${state.job.id}/pause`, { method: "POST", body: {} });
    state.pausing = true; // ponytail: cleared when the run parks; the run keeps polling until then
    $("#pause-button").textContent = `Pausing after ${state.job.stage}…`;
    $("#pause-button").disabled = true;
  } catch (error) {
    showError(error);
  }
});

$("#relaunch-button").addEventListener("click", async () => {
  clearError();
  $("#relaunch-button").disabled = true;
  $("#relaunch-button").textContent = "Relaunching…";
  await api(`/api/jobs/${state.job.id}/relaunch`, { method: "POST", body: {} }).catch(showError);
  $("#relaunch-button").disabled = false;
  $("#relaunch-button").textContent = "Relaunch app";
  await poll();
});

$("#cancel-button").addEventListener("click", async () => {
  await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST", body: {} }).catch(showError);
  await poll();
  refreshProjects();
});

// A parked run holds its project's queue so nothing builds on a half-repaired tree; dismiss releases it.
$("#dismiss-button").addEventListener("click", async () => {
  clearError();
  try {
    await api(`/api/jobs/${state.job.id}/dismiss`, { method: "POST", body: {} });
    await poll();
    refreshProjects();
  } catch (error) {
    showError(error);
  }
});

$("#resume-button").addEventListener("click", async () => {
  clearError();
  $("#resume-button").disabled = true;
  try {
    await api(`/api/jobs/${state.job.id}/resume`, { method: "POST", body: {} });
    await poll();
    startPolling();
    refreshProjects();
  } catch (error) {
    showError(error);
  } finally {
    $("#resume-button").disabled = false;
  }
});

$("#copy-recovery-button").addEventListener("click", async () => {
  clearError();
  try {
    const response = await fetch(`/api/jobs/${state.job.id}/recovery-packet`);
    if (!response.ok) throw new Error(`Recovery packet failed with HTTP ${response.status}.`);
    await navigator.clipboard.writeText(await response.text());
    $("#copy-recovery-button").textContent = "Copied — paste into Codex";
    setTimeout(() => { $("#copy-recovery-button").textContent = "Copy recovery packet"; }, 2500);
  } catch (error) {
    showError(error);
  }
});

$("#start-over-button").addEventListener("click", async () => {
  clearError();
  try {
    const { job } = await api(`/api/jobs/${state.job.id}/retry`, { method: "POST", body: {} });
    state.job = job;
    state.events = [];
    state.telemetry = null;
    localStorage.setItem("solofactory.currentJob", job.id);
    resetRunPanels();
    showRun();
    poll();
    startPolling();
    refreshProjects();
  } catch (error) {
    showError(error);
  }
});

// Feedback dialog. Preview is rendered server-side; the browser only shows and copies the exact markdown it received.
const feedback = { trigger: null, markdown: null, fingerprint: null, jobId: null };
const feedbackDialog = $("#feedback-dialog");

$("#feedback-button").addEventListener("click", (event) => openFeedback(event.currentTarget, { mode: "improvement" }));
$("#report-run-button").addEventListener("click", (event) => openFeedback(event.currentTarget, { mode: "problem", jobId: state.job?.id }));
$("#feedback-close-button").addEventListener("click", () => feedbackDialog.close());
feedbackDialog.addEventListener("close", () => feedback.trigger?.focus());
// Native <dialog> closes on Escape via the cancel event; some embedded browsers skip it, so close explicitly too.
feedbackDialog.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); feedbackDialog.close(); } });
for (const radio of document.querySelectorAll('#feedback-form input[name="mode"]')) radio.addEventListener("change", renderFeedbackMode);

function openFeedback(trigger, { mode, jobId = null }) {
  Object.assign(feedback, { trigger, markdown: null, fingerprint: null, jobId });
  const form = $("#feedback-form");
  form.reset();
  form.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $("#feedback-diagnostics-row").classList.toggle("hidden", !jobId);
  // Cancelled runs are reportable, but the user chose to stop, so diagnostics start unticked.
  $("#feedback-diagnostics").checked = Boolean(jobId) && state.job?.state !== "cancelled";
  const issues = state.config?.issues;
  $("#feedback-privacy").textContent = `Nothing is sent anywhere until you send the email${issues ? " or open GitHub" : ""} yourself.`;
  $("#feedback-search-button").classList.toggle("hidden", !issues);
  $("#feedback-github-button").classList.toggle("hidden", !issues);
  setFeedbackPreview(null);
  renderFeedbackMode();
  feedbackDialog.showModal();
}

function renderFeedbackMode() {
  const problem = feedbackMode() === "problem";
  // Disabled fieldsets drop out of FormData and constraint validation, so hidden required fields never block submit.
  $("#feedback-problem-fields").disabled = !problem;
  $("#feedback-problem-fields").classList.toggle("hidden", !problem);
  $("#feedback-improvement-fields").disabled = problem;
  $("#feedback-improvement-fields").classList.toggle("hidden", problem);
  setFeedbackPreview(null);
}

function feedbackMode() { return $("#feedback-form").elements.mode.value; }

function setFeedbackPreview(result) {
  feedback.markdown = result?.markdown ?? null;
  feedback.fingerprint = result?.fingerprint ?? null;
  $("#feedback-preview").textContent = feedback.markdown ?? "Choose Preview report to see exactly what will be copied.";
  $("#feedback-redacted").classList.toggle("hidden", !result?.redacted);
  for (const id of ["email", "copy", "search", "github"]) $(`#feedback-${id}-button`).disabled = !feedback.markdown;
  $("#feedback-copy-button").textContent = "Copy report";
  $("#feedback-email-button").innerHTML = "Copy &amp; open email <span>↗</span>";
}

$("#feedback-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#feedback-error").classList.add("hidden");
  if (!form.reportValidity()) return;
  const fields = Object.fromEntries([...new FormData(form)].filter(([key]) => key !== "mode"));
  $("#feedback-preview-button").disabled = true;
  try {
    const includeDiagnostics = Boolean(feedback.jobId) && $("#feedback-diagnostics").checked;
    setFeedbackPreview(await api("/api/feedback/preview", { method: "POST", body: { mode: feedbackMode(), fields, jobId: feedback.jobId, includeDiagnostics } }));
  } catch (error) {
    $("#feedback-error").textContent = error.message;
    $("#feedback-error").classList.remove("hidden");
  } finally {
    $("#feedback-preview-button").disabled = false;
  }
});

async function copyFeedback(button) {
  if (!feedback.markdown) return false;
  try {
    await navigator.clipboard.writeText(feedback.markdown);
    button.textContent = "Copied";
    return true;
  } catch {
    // Clipboard API needs a secure context; a LAN-hosted http:// page falls back to selecting the preview.
    window.getSelection().selectAllChildren($("#feedback-preview"));
    button.textContent = "Press ⌘C / Ctrl+C to copy";
    return false;
  }
}

$("#feedback-copy-button").addEventListener("click", (event) => copyFeedback(event.currentTarget));

$("#feedback-email-button").addEventListener("click", async (event) => {
  // Subject only; the body goes via the clipboard because reports can exceed mailto length limits.
  const button = event.currentTarget; // currentTarget is null after the await
  if (!(await copyFeedback(button))) return;
  button.textContent = "Copied — paste into the email";
  window.location.href = `mailto:support@coachlou.com?subject=${encodeURIComponent("SoloFactory Feedback")}`;
});

$("#feedback-search-button").addEventListener("click", () => {
  const query = feedback.fingerprint ?? $("#feedback-title").value.trim().slice(0, 100);
  window.open(`${state.config.issues.base}?q=${encodeURIComponent(`is:issue ${query}`)}`, "_blank", "noopener");
});

$("#feedback-github-button").addEventListener("click", () => {
  const problem = feedbackMode() === "problem";
  const title = `${problem ? "[Problem]" : "[Improvement]"} ${$("#feedback-title").value.trim()}`;
  // Title only. The report body travels via the clipboard, never in a URL.
  window.open(`${state.config.issues.base}/new?template=${problem ? "problem" : "improvement"}.yml&title=${encodeURIComponent(title)}`, "_blank", "noopener");
});

function startPolling() {
  stopPolling();
  state.poller = setInterval(poll, 1500);
}

function stopPolling() {
  if (state.poller) clearInterval(state.poller);
  state.poller = null;
}

function statusCopy(status) {
  return ({ queued: "The run is queued.", specifying: "Turning the interview into a build contract.", building: "The coding agent is implementing the app.", verifying: "The controller is running the real checks.", repairing: "A failed gate is being repaired, then every gate runs again.", reviewing: "The implementation is being audited against the frozen contract.", deploying: "The app is starting and its health and metrics endpoints are being checked.", completed: "The app is live and its evidence is preserved." })[status] || "Factory activity is recorded below.";
}

// Readable at any length: 45s, 12m 05s, 2h 05m, 6d 1h.
function formatSpan(milliseconds) {
  const s = Math.max(0, Math.floor(milliseconds / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const pad = (n) => String(n).padStart(2, "0");
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${pad(m % 60)}m` : m ? `${m}m ${pad(s % 60)}s` : `${s}s`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !options.allow?.includes(response.status)) throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
  return body;
}

function showError(error) {
  $("#notice").textContent = error.message || String(error);
  $("#notice").classList.remove("hidden");
  reportError(error);
}

// Every error the owner sees also lands in the factory's error log. Fire-and-forget: a failed report stays silent.
function reportError(error, action = "notice") {
  fetch("/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "browser", action, message: error?.stack || error?.message || String(error), jobId: state.job?.id, project: state.project }),
  }).catch(() => {});
}
window.addEventListener("error", (event) => reportError(event.error ?? event.message, "uncaught"));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandled rejection"));

function clearError() { $("#notice").classList.add("hidden"); }
