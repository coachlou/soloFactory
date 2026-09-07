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

boot().catch(showError);

async function boot() {
  state.config = await api("/api/config");
  const first = state.config.providers.find((provider) => provider.authenticated);
  state.provider = first?.id ?? state.config.providers[0]?.id;
  state.guide = state.config.opening;
  state.messages = [{ role: "assistant", content: state.guide.message }];
  renderProviders();
  renderMessages();
  renderCoverage();
  renderSdlcOptions();
  await refreshProjects();
  const savedId = localStorage.getItem("solofactory.currentJob");
  const candidate = state.jobs.find((job) => job.id === savedId)
    ?? state.jobs.find((job) => ["failed", "interrupted"].includes(job.state));
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
  $("#system-status").textContent = state.busyJobId ? "Factory running" : "Factory ready";
  renderProjects();
  renderRuns();
  renderBackgroundBanner();
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
    const marker = project.id === state.project && state.busyJobId ? "● " : "";
    const last = project.lastRun ? `${project.lastRun.state} · ${project.runCount} run${project.runCount === 1 ? "" : "s"}` : "no runs";
    return option(project.id, `${marker}${project.name} · ${last}`);
  }));
  select.value = state.project;
}

function renderRuns() {
  const select = $("#run-select");
  select.replaceChildren(option("new", "+ New run"), ...state.jobs.map((job) => {
    const marker = job.id === state.busyJobId ? "● " : "";
    return option(job.id, `${marker}${projectName(job)} · ${job.state} · ${job.createdAt.slice(0, 10)}`);
  }));
  select.value = state.job?.id ?? "new";
}

function renderBackgroundBanner() {
  const busy = state.busyJobId && state.busyJobId !== state.job?.id ? state.jobs.find((job) => job.id === state.busyJobId) : null;
  $("#background-banner").classList.toggle("hidden", !busy);
  if (busy) $("#background-text").textContent = `“${projectName(busy)}” is ${busy.state} in the background.`;
}

$("#project-select").addEventListener("change", (event) => switchProject(event.target.value).catch(showError));
$("#run-select").addEventListener("change", (event) => selectRun(event.target.value).catch(showError));
$("#background-view-button").addEventListener("click", () => selectRun(state.busyJobId).catch(showError));

// Switching projects is the one view change that can interrupt a build: the server refuses
// with 409 + busyJobId until the owner confirms, then cancels and waits before switching.
async function switchProject(id) {
  clearError();
  const create = id === "new";
  const body = create ? { name: window.prompt("Project name?") ?? "" } : { id };
  if (create && !body.name.trim()) return renderProjects();
  const url = create ? "/api/projects" : "/api/projects/select";
  let result = await api(url, { method: "POST", body, allow: [409] });
  if (result.busyJobId) {
    const busy = state.jobs.find((job) => job.id === result.busyJobId);
    if (!window.confirm(`“${projectName(busy)}” is still ${busy?.state ?? "running"}. Cancel it and switch project?`)) return renderProjects();
    result = await api(url, { method: "POST", body: { ...body, cancel: true } });
  } else if (result.error) throw new Error(result.error);
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
  if (["completed", "failed", "cancelled", "interrupted"].includes(state.job.state)) stopPolling();
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
  $("#artifacts").replaceChildren(Object.assign(document.createElement("p"), { textContent: "Artifacts appear after specification." }));
}

// Option A: viewing another project never interrupts a build; acting on one does, after confirmation.
async function ensureFactoryFree() {
  await refreshProjects();
  const busy = state.busyJobId && state.busyJobId !== state.job?.id ? state.jobs.find((job) => job.id === state.busyJobId) : null;
  if (!busy) return true;
  if (!window.confirm(`“${projectName(busy)}” is still ${busy.state}. Cancel it and continue with this project?`)) return false;
  await api(`/api/jobs/${busy.id}/cancel`, { method: "POST", body: {} });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await api("/api/health");
    if (!health.busyJobId) return true;
  }
  throw new Error(`“${projectName(busy)}” did not stop in time. Try again in a moment.`);
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

function renderSdlcOptions() {
  const select = $("#sdlc-select");
  const options = state.config?.sdlcOptions?.length ? state.config.sdlcOptions : [{ id: "single", label: "Single build (v0 behavior)", detail: "" }];
  select.replaceChildren(...options.map((option) => {
    const item = document.createElement("option");
    item.value = option.id;
    item.textContent = option.label;
    return item;
  }));
  $("#sdlc-detail").textContent = options.find((option) => option.id === select.value)?.detail || "";
  select.addEventListener("change", () => {
    $("#sdlc-detail").textContent = options.find((option) => option.id === select.value)?.detail || "";
  });
}

function sdlcOption(id) {
  const options = state.config?.sdlcOptions ?? [];
  return options.find((option) => option.id === id) ?? { id: id ?? "single", label: id === "slices" ? "Vertical slices (wbs)" : "Single build" };
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

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const content = input.value.trim();
  if (!content || !state.provider) return;
  clearError();
  state.messages.push({ role: "user", content });
  input.value = "";
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
    if (!(await ensureFactoryFree())) { $("#start-button").disabled = false; return; }
    const { job } = await api("/api/jobs", {
      method: "POST",
      body: { provider: state.provider, transcript: state.messages, coverage: state.guide.coverage, brief: state.guide.brief, sdlc: $("#sdlc-select").value },
    });
    state.job = job;
    localStorage.setItem("solofactory.currentJob", job.id);
    showRun();
    poll();
    startPolling();
    refreshProjects();
  } catch (error) {
    showError(error);
    $("#start-button").disabled = false;
  }
});

function showRun() {
  $("#review-view").classList.add("hidden");
  $("#interview-view").classList.add("hidden");
  $("#run-view").classList.remove("hidden");
  document.querySelector('[data-stage="interview"]').classList.add("done");
  $("#run-id").textContent = state.job.id;
  $("#run-title").textContent = state.job.brief.workingName || "Building your app";
  $("#agent-name").textContent = state.job.provider;
  renderJob();
}

async function poll() {
  if (!state.job) return;
  try {
    const result = await api(`/api/jobs/${state.job.id}`);
    state.job = result.job;
    state.events = result.events;
    state.telemetry = await api(`/api/jobs/${state.job.id}/telemetry`);
    renderJob();
    if (["failed", "cancelled", "interrupted"].includes(state.job.state)) {
      stopPolling();
      refreshProjects();
    }
  } catch (error) { showError(error); }
}

function renderJob() {
  const job = state.job;
  $("#run-state").textContent = job.state;
  $("#current-stage").textContent = job.stage;
  $("#run-subtitle").textContent = job.error?.message || statusCopy(job.state);
  $("#repair-count").textContent = `${job.attempt} / 2`;
  $("#gate-count").textContent = String(state.events.filter((event) => event.type === "gate.passed").length);
  $("#strategy-label").textContent = sdlcOption(job.sdlc).label;
  const elapsedUntil = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
  $("#elapsed").textContent = `${formatDuration(elapsedUntil - new Date(job.startedAt || job.createdAt).getTime())} elapsed`;
  const progressState = ["failed", "cancelled", "interrupted"].includes(job.state) ? job.failedState : job.state;
  const currentIndex = Math.max(0, stageOrder.indexOf(progressState));
  $("#stage-bars").replaceChildren(...stageOrder.slice(0, -1).map((stage, index) => {
    const bar = document.createElement("span");
    bar.className = `stage-bar ${index < currentIndex || job.state === "completed" ? "done" : index === currentIndex ? "active" : ""}`;
    bar.title = stage;
    return bar;
  }));
  document.querySelectorAll(".stages li").forEach((item) => item.classList.remove("active"));
  const railStage = progressState === "repairing" ? "verifying" : progressState;
  const activeRail = document.querySelector(`[data-stage="${railStage}"]`);
  if (activeRail) activeRail.classList.add("active");
  renderEvents();
  renderArtifacts();
  renderAppMetrics();
  renderRecovery();
  const terminalFailure = ["failed", "cancelled", "interrupted"].includes(job.state);
  $("#cancel-button").classList.toggle("hidden", terminalFailure || job.state === "completed");
  $("#resume-button").classList.toggle("hidden", !job.recovery?.canResume || !terminalFailure);
  $("#copy-recovery-button").classList.toggle("hidden", !job.recovery || !terminalFailure);
  $("#start-over-button").classList.toggle("hidden", !terminalFailure);
  $("#report-run-button").classList.toggle("hidden", !terminalFailure);
  if (job.state === "completed" && job.deployment?.status === "live") {
    $("#open-app").href = job.deployment.url;
    $("#open-app").classList.remove("hidden");
    $("#app-live").textContent = "Live";
    $("#app-live").classList.remove("muted");
  } else if (job.state === "completed") {
    $("#app-live").textContent = "Stopped";
    $("#app-live").classList.add("muted");
  }
}

function renderRecovery() {
  const recovery = state.job.recovery;
  const visible = recovery && ["failed", "cancelled", "interrupted"].includes(state.job.state);
  $("#recovery-card").classList.toggle("hidden", !visible);
  if (!visible) return;
  $("#recovery-title").textContent = recovery.title;
  $("#recovery-summary").textContent = recovery.summary;
  $("#recovery-actions").replaceChildren(...recovery.actions.map((action) => {
    const item = document.createElement("li");
    item.textContent = action;
    return item;
  }));
  $("#recovery-workspace").textContent = recovery.workspace;
  $("#recovery-retry").textContent = recovery.automaticRetry;
}

function renderEvents() {
  $("#events").replaceChildren(...state.events.slice().reverse().map((entry) => {
    const row = document.createElement("div");
    row.className = `event ${/failed|error/.test(entry.type) ? "fail" : ""}`;
    const time = document.createElement("time"); time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dot = document.createElement("i");
    const text = document.createElement("span"); text.textContent = entry.message || entry.type;
    row.append(time, dot, text);
    return row;
  }));
}

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

$("#cancel-button").addEventListener("click", async () => {
  await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST", body: {} }).catch(showError);
});

$("#resume-button").addEventListener("click", async () => {
  clearError();
  $("#resume-button").disabled = true;
  try {
    if (!(await ensureFactoryFree())) return;
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
    if (!(await ensureFactoryFree())) return;
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
  $("#feedback-privacy").textContent = "Nothing is sent anywhere until you copy the report or open GitHub yourself."
    + (issues ? "" : " GitHub links are off because SOLOFACTORY_ISSUES_URL is not set.");
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
  for (const id of ["copy", "search", "github"]) $(`#feedback-${id}-button`).disabled = !feedback.markdown;
  $("#feedback-copy-button").textContent = "Copy report";
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

$("#feedback-copy-button").addEventListener("click", async () => {
  if (!feedback.markdown) return;
  try {
    await navigator.clipboard.writeText(feedback.markdown);
    $("#feedback-copy-button").textContent = "Copied";
  } catch {
    // Clipboard API needs a secure context; a LAN-hosted http:// page falls back to selecting the preview.
    window.getSelection().selectAllChildren($("#feedback-preview"));
    $("#feedback-copy-button").textContent = "Press ⌘C / Ctrl+C to copy";
  }
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
}

function clearError() { $("#notice").classList.add("hidden"); }
