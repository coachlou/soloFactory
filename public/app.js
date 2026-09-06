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
const state = { config: null, provider: null, messages: [], guide: null, job: null, events: [], telemetry: null, poller: null };
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
  const health = await api("/api/health");
  $("#system-status").textContent = health.busyJobId ? "Factory running" : "Factory ready";
  const listing = await api("/api/jobs");
  const savedId = localStorage.getItem("solofactory.currentJob");
  const candidate = listing.jobs.find((job) => job.id === savedId)
    ?? listing.jobs.find((job) => ["failed", "interrupted"].includes(job.state));
  if (candidate) {
    const result = await api(`/api/jobs/${candidate.id}`);
    state.job = result.job;
    state.events = result.events;
    state.provider = state.job.provider;
    localStorage.setItem("solofactory.currentJob", state.job.id);
    showRun();
    await poll();
    if (!["completed", "failed", "cancelled", "interrupted"].includes(state.job.state)) startPolling();
  }
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
    const { job } = await api("/api/jobs", {
      method: "POST",
      body: { provider: state.provider, transcript: state.messages, coverage: state.guide.coverage, brief: state.guide.brief, sdlc: $("#sdlc-select").value },
    });
    state.job = job;
    localStorage.setItem("solofactory.currentJob", job.id);
    showRun();
    poll();
    startPolling();
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
      clearInterval(state.poller);
      state.poller = null;
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
    await api(`/api/jobs/${state.job.id}/resume`, { method: "POST", body: {} });
    await poll();
    startPolling();
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
  const { job } = await api(`/api/jobs/${state.job.id}/retry`, { method: "POST", body: {} });
  state.job = job;
  state.events = [];
  state.telemetry = null;
  localStorage.setItem("solofactory.currentJob", job.id);
  renderJob();
  poll();
  startPolling();
});

function startPolling() {
  if (state.poller) clearInterval(state.poller);
  state.poller = setInterval(poll, 1500);
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
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
  return body;
}

function showError(error) {
  $("#notice").textContent = error.message || String(error);
  $("#notice").classList.remove("hidden");
}

function clearError() { $("#notice").classList.add("hidden"); }
