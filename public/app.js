// SoloFactory hub, design A. The page is design A's own markup (the template in index.html) and its own
// component logic, drawn by the small engine below and wired to the factory API by the Live class at the end.

// ---- Template engine: parses the {{path}} / sc-if / sc-for template once, renders it to HTML, morphs the DOM.
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
function parseTpl(src) {
  const root = { kids: [] }, stack = [root];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1]) { const tag = m[1].toLowerCase(); for (let i = stack.length - 1; i > 0; i -= 1) if (stack[i].tag === tag) { stack.length = i; break; } continue; }
    if (m[5] !== undefined) { top.kids.push({ t: "text", v: m[5] }); continue; }
    const tag = m[2].toLowerCase(), attrs = [];
    const ar = /([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? null]);
    const node = { t: "el", tag, attrs, kids: [] };
    top.kids.push(node);
    if (!m[4] && !VOID.has(tag)) stack.push(node);
  }
  return root.kids;
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function look(sc, path) {
  const parts = path.split(".");
  let v = sc[parts[0]];
  for (let i = 1; i < parts.length; i += 1) v = v == null ? undefined : v[parts[i]];
  return v;
}
const shown = (v) => (v == null || typeof v === "function" || typeof v === "object" ? "" : String(v));
const fill = (str, sc) => str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => shown(look(sc, p)));
const raw = (str, sc) => { const m = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(str ?? ""); return m ? look(sc, m[1]) : str; };
const attrOf = (node, name) => (node.attrs.find((a) => a[0] === name) || [])[1];
function draw(nodes, sc, H) {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") { out += esc(fill(n.v, sc)); continue; }
    if (n.tag === "sc-if") { if (raw(attrOf(n, "value"), sc)) out += draw(n.kids, sc, H); continue; }
    if (n.tag === "sc-for") {
      const as = attrOf(n, "as");
      for (const item of raw(attrOf(n, "list"), sc) || []) { const inner = Object.create(sc); inner[as] = item; out += draw(n.kids, inner, H); }
      continue;
    }
    const type = String(raw(attrOf(n, "type"), sc) ?? "");
    let attrs = "";
    for (const [k, v] of n.attrs) {
      if (k.startsWith("hint-")) continue;
      if (/^on[A-Z]/.test(k)) {
        const fn = raw(v, sc);
        if (typeof fn !== "function") continue;
        const evt = k === "onChange" ? (n.tag === "select" || type === "checkbox" ? "change" : "input") : k === "onBlur" ? "focusout" : k.slice(2).toLowerCase();
        attrs += ` data-on-${evt}="${H.push(fn) - 1}"`;
        continue;
      }
      if (k === "checked" || k === "disabled" || k === "selected") { const val = v === null ? true : raw(v, sc); if (val && val !== "false") attrs += ` ${k}`; continue; }
      if (k === "value" && (n.tag === "input" || n.tag === "textarea" || n.tag === "select")) { attrs += ` data-v="${esc(fill(v ?? "", sc))}"`; continue; }
      attrs += v === null ? ` ${k}` : ` ${k}="${esc(fill(v, sc))}"`;
    }
    out += `<${n.tag}${attrs}>`;
    if (!VOID.has(n.tag)) out += `${draw(n.kids, sc, H)}</${n.tag}>`;
  }
  return out;
}
// Index-wise morph keeps focus, caret and scroll across re-renders.
function morph(live, next) {
  const a = live.childNodes, b = Array.from(next.childNodes);
  b.forEach((n, i) => {
    const o = a[i];
    if (!o) return live.appendChild(n);
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return live.replaceChild(n, o);
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; }
    for (const at of Array.from(o.attributes)) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
    for (const at of Array.from(n.attributes)) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
    morph(o, n);
  });
  while (a.length > b.length) live.removeChild(live.lastChild);
}

// ---- The DCLogic contract design A's component is written against: state, setState, renderVals, lifecycle.
class DCLogic {
  constructor() { this.props = {}; }
  setState(patch) {
    const prev = this.state;
    this.state = { ...prev, ...(typeof patch === "function" ? patch(prev, this.props) : patch) };
    this.paint();
    this.componentDidUpdate?.(this.props, prev);
  }
  mount(el) {
    this.el = el;
    this.tpl = parseTpl(document.getElementById("tpl").textContent);
    for (const type of ["click", "input", "change", "keydown", "focusout"]) {
      el.addEventListener(type, (ev) => {
        // Events the morph itself fires (focusout from a field it removes) carry handler indexes from the
        // previous paint, which now point at other functions. They are never user input, so skip them.
        if (this.painting || !el.contains(ev.target)) return;
        const fns = [];
        for (let node = ev.target; node && node !== el.parentNode; node = node.parentNode) {
          const i = node.getAttribute?.(`data-on-${type}`);
          if (i != null) fns.push(this.H[i]);
        }
        for (const fn of fns) { if (ev.cancelBubble) break; try { fn(ev); } catch (error) { showError(error); } }
      });
    }
    this.paint();
    this.componentDidMount?.();
  }
  paint() {
    if (!this.el) return;
    if (this.painting) { this.again = true; return; }
    this.painting = true;
    try {
      do {
        this.again = false;
        const H = [], t = document.createElement("template");
        t.innerHTML = draw(this.tpl, this.renderVals(), H);
        this.H = H;
        morph(this.el, t.content);
        for (const f of this.el.querySelectorAll("[data-v]")) if (f.value !== f.dataset.v) f.value = f.dataset.v;
        for (const f of this.el.querySelectorAll("input[type=checkbox]")) f.checked = f.hasAttribute("checked");
      } while (this.again);
    } finally { this.painting = false; }
  }
}

// ---- Shared factory state and helpers (kept from the previous hub; tests read some of these lines).
const state = { job: null, project: null, amendment: null, messages: [], guide: null, revises: null, replaces: null, provider: null, projects: [], jobs: [], board: null, config: null };
const stageOrder = ["specifying", "building", "verifying", "reviewing", "deploying", "completed"];
const NEEDS_YOU = ["failed", "interrupted", "paused"];
function runsNeedingYou(projects, viewingId) {
  return projects.filter((project) => NEEDS_YOU.includes(project.lastRun?.state) && project.lastRun.id !== viewingId)
    .map((project) => ({ projectId: project.id, jobId: project.lastRun.id, name: project.lastRun.workingName || project.name, state: project.lastRun.state }));
}
const BRIEF_SECTIONS = [
  ["promise", "Promise", "promise"],
  ["primaryUser", "Primary user", "user"],
  ["problem", "Problem", "problem"],
  ["coreWorkflow", "Core workflow", "workflow", true],
  ["mustHaves", "Must-haves", "mustHaves", true],
  ["nonGoals", "Non-goals", "nonGoals", true],
  ["dataAndAccess", "Data & access", "dataAndAccess", true],
  ["integrations", "Integrations", "integrations", true],
  ["businessModel", "Business model", "business"],
  ["acceptanceScenarios", "Acceptance scenarios", "acceptance", true],
  ["visualDirection", "Visual direction", "visual"],
  ["deployment", "Deployment", "deployment"],
  ["constraints", "Constraints", "constraints", true],
  ["manualChecks", "Checked by hand after install", null, true],
];
const sameValue = (a, b) => JSON.stringify(a ?? (Array.isArray(b) ? [] : "")) === JSON.stringify(b ?? (Array.isArray(a) ? [] : ""));
// Per key, so a key the review only filled with its empty default (a brief from before 0.11 has no
// manualChecks) is not a change; a whole-object compare told the owner "adjusted" after every review.
const briefChanged = (a, b) => Object.keys({ ...a, ...b }).some((key) => !sameValue(a?.[key], b?.[key]));
function railMarks(progressState) {
  const active = progressState === "repairing" ? "verifying" : progressState;
  const at = active === "completed" ? stageOrder.length : stageOrder.indexOf(active);
  return { active, done: stageOrder.slice(0, Math.max(0, at)) };
}
const MAX_AMENDED_PLAN_BYTES = 4_000_000;
function previousReleaseNote(job) {
  const prior = job.previousRelease;
  if (!prior) return null;
  if (prior.live) return { text: `Previous release still running at ${prior.url}.`, relaunch: null };
  if (prior.relaunchable) return { text: `The previous release (${prior.name}) is not running. Dismiss puts its files back; Relaunch then starts it.`, relaunch: prior.jobId, label: `Dismiss, then Relaunch ${prior.name}` };
  return { text: `The previous release (${prior.name}) is not running. It can be relaunched once every newer run is dismissed with a rollback point.`, relaunch: null };
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
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !options.allow?.includes(response.status)) throw Object.assign(new Error(body.error || `Request failed with HTTP ${response.status}.`), { body });
  return body;
}
// Every error the owner sees also lands in the factory's error log. Fire-and-forget: a failed report stays silent.
function reportError(error, action = "notice") {
  fetch("/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "browser", action, message: [error?.message ?? String(error), error?.stack].filter(Boolean).join("\n"), jobId: state.job?.id, project: state.project }),
  }).catch(() => {});
}
window.addEventListener("error", (event) => reportError(event.error ?? event.message, "uncaught"));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason, "unhandled rejection"));

class Component extends DCLogic {
  state = {
    pid: 'nm', panel: 'run', docName: '', draft: '', nextId: 100,
    themeMode: 'auto', themeOpen: false, groupsOpen: { needs: true, running: true, queued: true, done: false }, selRun: 0, pmOpen: false, navOpen: false, rowMenu: 0, info: null, np: null, cfgOpen: false, cfgVals: {}, cfgTouched: false, extra: [], provider: {},
    viewer: '', viewerEdit: false, vdraft: '', activeSec: -1, secDraft: '', docEdits: {}, docAdds: {}, docChat: {},
    runs: [
      { id: 1, pid: 'nm', kind: 'feature', title: 'Batch re-run report', state: 'building', idx: 2, trap: true, repairs: 0 },
      { id: 11, pid: 'nm', kind: 'fix', title: 'Pattern counts round off the last decimal', state: 'queued', idx: 0, repairs: 0 },
      { id: 13, pid: 'nm', kind: 'feature', title: 'CSV export of the results table', state: 'queued', idx: 0, repairs: 0 },
      { id: 15, pid: 'nm', kind: 'feature', title: 'Tag transcripts by coaching client', state: 'queued', idx: 0, repairs: 0 }
    ],
    threads: {
      nm: [
        { id: 1, type: 'user', text: 'Add a batch re-run report so I can see which transcripts changed between runs.' },
        { id: 2, type: 'pick', kind: 'feature', sent: true, ask: 'Batch re-run report', runId: 1 },
        { id: 3, type: 'run', runId: 1 },
        { id: 4, type: 'guide', text: 'It is with the factory. When the gates pass I will add the report to FEATURES.md and its checks to ACCEPTANCE.md. Keep going here or switch projects. Nothing stops.' },
        { id: 10, type: 'user', text: 'Pattern counts round off the last decimal.' },
        { id: 11, type: 'pick', kind: 'fix', sent: true, ask: 'Pattern counts round off the last decimal', runId: 11 },
        { id: 12, type: 'run', runId: 11 },
        { id: 13, type: 'user', text: 'Add CSV export of the results table.' },
        { id: 14, type: 'pick', kind: 'feature', sent: true, ask: 'CSV export of the results table', runId: 13 },
        { id: 15, type: 'run', runId: 13 },
        { id: 16, type: 'user', text: 'Let me tag transcripts by coaching client.' },
        { id: 17, type: 'pick', kind: 'feature', sent: true, ask: 'Tag transcripts by coaching client', runId: 15 },
        { id: 18, type: 'run', runId: 15 },
        { id: 19, type: 'guide', text: 'Three runs are queued behind the batch report, in the order you sent them. Each starts by itself when the one before it ships, so each builds on the last. Reorder or remove them in the Run panel.' }
      ],
      al: [
        { id: 5, type: 'user', text: 'The search box drops the last word when I paste a long title.' },
        { id: 6, type: 'pick', kind: 'fix', sent: false, ask: 'Search drops the last word of a pasted title' }
      ],
      mp: [
        { id: 7, type: 'guide', text: 'Member Portal has no documents yet. Tell me what you want to build and I will start a full brief. If the app already exists in a folder, say so and I will adopt it and write the baseline from the code.' }
      ]
    }
  };

  componentDidMount() { this.timer = setInterval(() => this.tick(), 3500); }
  componentWillUnmount() { clearInterval(this.timer); }
  componentDidUpdate(prevProps, prevState) {
    if (this.state.activeSec >= 0 && (!prevState || prevState.activeSec !== this.state.activeSec)) {
      try { const el = document.getElementById('sec-edit'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } catch (e) {}
    }
  }

  projectList() {
    return [
      { id: 'nm', name: 'Nugget Mining', live: 'Live at 127.0.0.1:4310 · release 12', hasDocs: true, url: 'http://127.0.0.1:4310', release: 'release 12' },
      { id: 'al', name: 'Ambient Library', live: 'Live at 127.0.0.1:4322 · release 4', hasDocs: true, url: 'http://127.0.0.1:4322', release: 'release 4' },
      { id: 'mp', name: 'Member Portal', live: 'Not built yet', hasDocs: false }
    ].concat((this.state && this.state.extra) || []);
  }

  kinds() {
    return {
      fix: { label: 'Quick fix', chipBg: 'var(--raise)', chipFg: 'var(--text2)', cta: 'Send to the factory', steps: ['Fix note', 'Build', 'Gates', 'Deploy', 'Update docs'] },
      feature: { label: 'Feature', chipBg: 'var(--raise2)', chipFg: 'var(--fg)', cta: 'Send to the factory', steps: ['Feature spec', 'Plan', 'Build', 'Gates', 'Review', 'Deploy', 'Update docs'] },
      prd: { label: 'Full brief', chipBg: 'var(--raise)', chipFg: 'var(--text2)', cta: 'Start the interview', steps: ['Interview', 'PRD and plan', 'Planned features', 'Gates', 'Review', 'Deploy', 'Update docs'] }
    };
  }

  why(kind, proj) {
    if (!proj.hasDocs) return 'This project has no PRD.md, so there is no baseline to build on. One interview writes it. After that, small requests stay small.';
    if (kind === 'fix') return 'FEATURES.md already describes this behavior, so it is a correction, not new scope. One rule changes. No new data, screen or flow. No interview needed.';
    if (kind === 'feature') return 'PRD.md covers the product and its users. This adds one capability beside the existing ones, so a short feature spec is enough. I will ask only what the documents do not answer.';
    return 'This changes what the product is for or how its data is shaped, so PRD.md itself has to change before anything is built.';
  }

  sizeUp(text, proj) {
    if (!proj.hasDocs) return 'prd';
    const t = text.toLowerCase();
    if (/(fix|bug|typo|broken|wrong|crash|drops|error|fails)/.test(t)) return 'fix';
    if (/(rebuild|redesign|from scratch|new app|version 2|v2|rewrite|multi-user|new prd)/.test(t)) return 'prd';
    return 'feature';
  }

  slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 26);
  }

  short(text) {
    return text.length > 60 ? text.slice(0, 57) + '...' : text;
  }

  activeIn(runs, pid) {
    return runs.find((r) => r.pid === pid && ['building', 'pausing', 'paused', 'stuck', 'revising'].indexOf(r.state) >= 0) || null;
  }

  startNext(runs) {
    const out = runs.slice();
    out.forEach((r, i) => {
      if (r.state !== 'queued') return;
      const slots = out.filter((x) => x.state === 'building' || x.state === 'pausing').length;
      if (slots < 2 && !this.activeIn(out, r.pid)) out[i] = { ...r, state: 'building', idx: 0 };
    });
    return out;
  }

  tick() {
    const s = this.state;
    const K = this.kinds();
    const notes = [];
    let runs = s.runs.map((r) => {
      const steps = K[r.kind].steps;
      if (r.state === 'pausing') {
        if (r.idx + 1 >= steps.length) { notes.push([r.pid, 'Shipped. The new release is live, and I updated the documents to match what was built.']); return { ...r, state: 'shipped', idx: steps.length }; }
        notes.push([r.pid, 'Paused before ' + steps[r.idx + 1] + '. The work so far is committed and passing. Resume, restart from an earlier step, or cancel from the run panel.']);
        return { ...r, state: 'paused', idx: r.idx + 1 };
      }
      if (r.state !== 'building') return r;
      if (r.trap && steps[r.idx] === 'Gates') {
        notes.push([r.pid, 'I parked the run. One check failed twice, even after a repair, so I stopped instead of burning more turns. Open the run to let me plan a different repair, restart from an earlier step, or cancel. Queued work in this project waits for your call.']);
        return { ...r, state: 'stuck', trap: false };
      }
      if (r.idx + 1 >= steps.length) { notes.push([r.pid, 'Shipped. The new release is live, and I updated FEATURES.md and ACCEPTANCE.md to match what was built.']); return { ...r, state: 'shipped', idx: steps.length }; }
      return { ...r, idx: r.idx + 1 };
    });
    runs = this.startNext(runs);
    const threads = { ...s.threads };
    let id = s.nextId;
    notes.forEach((n) => { threads[n[0]] = threads[n[0]].concat([{ id: id++, type: 'guide', text: n[1] }]); });
    this.setState({ runs: runs, threads: threads, nextId: id });
  }

  patchRun(id, patch) {
    const runs = this.state.runs.map((r) => (r.id === id ? { ...r, ...patch } : r));
    this.setState({ runs: this.startNext(runs) });
  }

  runLine(r, runs) {
    const steps = this.kinds()[r.kind].steps;
    const at = steps[Math.min(r.idx, steps.length - 1)];
    if (r.state === 'queued') return this.activeIn(runs, r.pid) ? 'Queued · starts when the current run in this project finishes' : 'Queued · waiting for a free build slot';
    if (r.state === 'building') return 'Step ' + (r.idx + 1) + ' of ' + steps.length + ' · ' + at + (r.repairs ? ' · repair in progress' : '');
    if (r.state === 'pausing') return 'Pausing as soon as ' + at + ' finishes';
    if (r.state === 'paused') return 'Paused before ' + at + ' · work so far is committed';
    if (r.state === 'stuck') return 'Parked at ' + at + ' · the same check failed twice';
    if (r.state === 'shipped') return 'Shipped · live · documents updated';
    if (r.state === 'revising') return 'Revising the spec · nothing is building';
    return 'Cancelled · nothing was deployed · the spec is kept';
  }

  alertOf(r) {
    if (!r) return '';
    if (r.state === 'stuck') return 'var(--red)';
    if (r.state === 'paused') return 'var(--amber)';
    return '';
  }

  runSegs(r) {
    return this.kinds()[r.kind].steps.map((x, i) => ({
      bg: r.state === 'shipped' ? 'var(--dim)' : r.state === 'cancelled' || r.state === 'queued' || r.state === 'revising' ? 'var(--track)' : i < r.idx ? 'var(--dim)' : i > r.idx ? 'var(--track)' : (this.alertOf(r) || 'var(--inv)')
    }));
  }

  runCtrls(r) {
    const plain = { bg: 'transparent', fg: 'var(--fg)', border: 'var(--line3)' };
    const main = { bg: 'var(--inv)', fg: 'var(--inv-fg)', border: 'var(--inv)' };
    const risk = { bg: 'transparent', fg: 'var(--fg)', border: 'var(--line2)' };
    const cancel = { label: 'Cancel run', act: () => this.patchRun(r.id, { state: 'cancelled' }), ...risk };
    const revise = { label: 'Revise the spec', act: () => this.revise(r), ...plain };
    if (r.state === 'queued') return [{ label: 'Remove from queue', act: () => this.patchRun(r.id, { state: 'cancelled' }), ...risk }];
    if (r.state === 'building') return [{ label: 'Pause after this step', act: () => this.patchRun(r.id, { state: 'pausing' }), ...plain }, cancel];
    if (r.state === 'paused') return [{ label: 'Resume', act: () => this.patchRun(r.id, { state: 'building' }), ...main }, revise, cancel];
    if (r.state === 'stuck') return [{ label: 'Let the Guide plan a repair', act: () => this.patchRun(r.id, { state: 'building', repairs: r.repairs + 1 }), ...main }, revise, cancel];
    if (r.state === 'cancelled') return [{ ...revise, label: 'Revise and resubmit' }];
    if (r.state === 'revising') return [{ label: 'Resubmit to the factory', act: () => this.patchRun(r.id, { state: 'queued', idx: 0, trap: false, rev: (r.rev || 1) + 1 }), ...main }, { label: 'Discard changes', act: () => this.discard(r), ...risk }];
    return [];
  }

  showInfo(title, text) {
    this.setState({ info: { title: title, text: text } });
  }

  moreCtrls(r) {
    const out = [];
    if (r.state === 'stuck' || r.state === 'paused') {
      out.push({ label: 'Copy recovery packet', act: () => this.showInfo('Copy recovery packet', 'Copies a summary of the parked run, with its stage, error, last check output and changed files, to paste into Claude Code or Codex for help.') });
    }
    if (r.state === 'stuck' || r.state === 'cancelled') {
      out.push({ label: 'Start over from scratch', act: () => {
        const st = this.state;
        const runs = st.runs.map((x) => (x.id === r.id ? { ...x, state: 'dismissed' } : x)).concat([{ id: st.nextId, pid: r.pid, kind: r.kind, title: r.title, state: 'queued', idx: 0, repairs: 0 }]);
        const th = st.threads[r.pid].map((m) => (m.runId === r.id ? { ...m, runId: st.nextId } : m));
        this.setState({ nextId: st.nextId + 1, runs: this.startNext(runs), selRun: st.nextId, threads: { ...st.threads, [r.pid]: th } });
      } });
    }
    if (r.state === 'stuck' || r.state === 'paused' || r.state === 'cancelled') {
      out.push({ label: 'Report this run', act: () => this.showInfo('Report this run', 'Opens the Feedback form with this run\'s diagnostics: version, platform, error code, failed stage, check, counts and recent event types. Never your brief, transcript, agent output or file paths. Nothing is sent until you send it.') });
    }
    if (r.state === 'cancelled') {
      out.push({ label: 'Dismiss', act: () => this.patchRun(r.id, { state: 'dismissed' }) });
    }
    return out;
  }

  settingsDefs() {
    const lv = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
    return [
      { title: 'AI and models', fields: [
        { key: 'provider', label: 'Builds with', type: 'select', def: 'Claude Code', options: [['Claude Code', 'Claude Code'], ['Codex', 'Codex']], help: 'For new requests. You can switch one project from the Guide box.' },
        { key: 'claudeModel', label: 'Claude: coding model', type: 'select', def: 'sonnet', options: [['sonnet', 'sonnet'], ['opus', 'opus'], ['haiku', 'haiku']], env: 'SOLOFACTORY_CLAUDE_MODEL', help: 'Writes and repairs the code.' },
        { key: 'claudeEffort', label: 'Claude: coding effort', type: 'select', def: 'medium', options: lv, env: 'SOLOFACTORY_CLAUDE_EFFORT', help: 'More effort is slower and uses more of your subscription.' },
        { key: 'claudeReason', label: 'Claude: planning and review model', type: 'select', def: 'opus', options: [['opus', 'opus'], ['sonnet', 'sonnet']], env: 'SOLOFACTORY_CLAUDE_REASONING_MODEL', help: 'Specification, feature plan, plan review and final review.' },
        { key: 'claudeReasonEffort', label: 'Claude: planning and review effort', type: 'select', def: 'low', options: lv, env: 'SOLOFACTORY_CLAUDE_REASONING_EFFORT', help: '' },
        { key: 'guideModel', label: 'Claude: Guide model', type: 'select', def: 'opus', options: [['opus', 'opus'], ['sonnet', 'sonnet']], env: 'SOLOFACTORY_CLAUDE_GUIDE_MODEL', help: 'Runs the conversation with you.' },
        { key: 'guideEffort', label: 'Claude: Guide effort', type: 'select', def: 'medium', options: lv, env: 'SOLOFACTORY_CLAUDE_GUIDE_EFFORT', help: '' },
        { key: 'guideAdvisor', label: 'Claude: Guide advisor', type: 'toggle', def: true, env: 'SOLOFACTORY_CLAUDE_GUIDE_ADVISOR', help: 'A second opus opinion on the Guide\'s answers. Off uses less of your subscription.' },
        { key: 'codexModel', label: 'Codex: model', type: 'text', def: 'gpt-6.1-sol', env: 'SOLOFACTORY_CODEX_MODEL', locked: true, help: 'Used for every Codex stage.' },
        { key: 'codexEffort', label: 'Codex: reasoning effort', type: 'select', def: 'medium', options: lv, env: 'SOLOFACTORY_CODEX_REASONING_EFFORT', help: '' }
      ] },
      { title: 'Capacity', fields: [
        { key: 'maxActive', label: 'Runs building at once', type: 'number', def: '1', min: '1', max: '8', env: 'SOLOFACTORY_MAX_ACTIVE_RUNS', help: 'Across different projects. Runs in one project always go one after another. More runs at once reach your subscription limits sooner.' },
        { key: 'featureReview', label: 'Feature review', type: 'select', def: 'all', options: [['all', 'Every feature'], ['risky', 'Risky features only']], env: 'SOLOFACTORY_FEATURE_REVIEW', help: 'Reviewing every feature is safer and slower.' }
      ] },
      { title: 'Run safeguards', fields: [
        { key: 'maxRepairs', label: 'Repairs per failed check', type: 'number', def: '2', min: '0', max: '10', env: 'SOLOFACTORY_MAX_REPAIRS', help: 'Repair attempts before a feature parks and asks you.' },
        { key: 'loop', label: 'Stop after identical failures', type: 'number', def: '3', min: '2', max: '10', env: 'SOLOFACTORY_LOOP_THRESHOLD', help: 'Parks a run when the same failure repeats on unchanged code.' },
        { key: 'workers', label: 'Agent turns per run', type: 'number', def: '150', min: '0', max: '', env: 'SOLOFACTORY_MAX_RUN_WORKERS', help: '0 turns this cap off. A parked run can be granted more.' },
        { key: 'tokens', label: 'Tokens per run', type: 'number', def: '40000000', min: '0', max: '', env: 'SOLOFACTORY_MAX_RUN_TOKENS', help: 'Reported tokens, cached input included. 0 turns this cap off.' },
        { key: 'cost', label: 'Cost per run', type: 'number', def: '30', min: '0', max: '', unit: 'USD', env: 'SOLOFACTORY_MAX_RUN_COST_USD', help: 'Reported cost. 0 turns this cap off.' },
        { key: 'progress', label: 'Progress warning', type: 'number', def: '20', min: '0', max: '240', unit: 'min', env: 'SOLOFACTORY_PROGRESS_MINUTES', help: 'Warns when no feature or plan lands for this long. It never stops a run.' },
        { key: 'gate', label: 'Check time limit', type: 'number', def: '5', min: '1', max: '60', unit: 'min', env: 'SOLOFACTORY_GATE_MINUTES', help: 'A test or proof check that runs longer is stopped. Install gets 10 minutes.' },
        { key: 'idle', label: 'Agent silence limit', type: 'number', def: '6', min: '1', max: '', unit: 'min', env: 'SOLOFACTORY_AGENT_IDLE_MINUTES', help: 'An agent turn with no output for this long is stopped.' },
        { key: 'hard', label: 'Agent turn limit', type: 'number', def: '45', min: '1', max: '', unit: 'min', env: 'SOLOFACTORY_AGENT_HARD_MINUTES', help: 'The longest any one agent turn may run.' }
      ] },
      { title: 'Updates and feedback', fields: [
        { key: 'updateCheck', label: 'Check for updates', type: 'toggle', def: true, env: 'SOLOFACTORY_UPDATE_CHECK', help: 'One small request on start and when you ask. No background polling. It never updates by itself.' },
        { key: 'issues', label: 'Issue tracker', type: 'text', def: '', env: 'SOLOFACTORY_ISSUES_URL', help: 'A GitHub issues page, such as https://github.com/owner/repo/issues. Turns on Search existing issues and Open GitHub in Feedback.' }
      ] },
      { title: 'Folders and network', restart: true, fields: [
        { key: 'root', label: 'Projects folder', type: 'text', def: '.solofactory/', env: 'SOLOFACTORY_ROOT', help: 'Projects live in projects/ under this folder.' },
        { key: 'home', label: 'Factory home', type: 'text', def: '.solofactory/', env: 'SOLOFACTORY_HOME', help: 'Holds the active project, the error log and factory state.' },
        { key: 'port', label: 'Port', type: 'number', def: '4173', min: '1024', max: '65535', env: 'PORT', help: 'Where this page is served.' },
        { key: 'host', label: 'Address', type: 'text', def: '127.0.0.1', env: 'HOST', help: 'Loopback addresses only. Anything else is refused, because the factory has no sign-in.' }
      ] }
    ];
  }

  specName(r) {
    return (r.kind === 'fix' ? 'fixes/' : 'specs/') + this.slug(r.title) + '.md';
  }

  discard(r) {
    const st = this.state;
    const key = r.pid + '|' + this.specName(r);
    const edits = { ...st.docEdits }; delete edits[key];
    const adds = { ...st.docAdds }; delete adds[key];
    const runs = st.runs.map((x) => (x.id === r.id ? { ...x, state: r.from, change: '' } : x));
    this.setState({ runs: this.startNext(runs), docEdits: edits, docAdds: adds, activeSec: -1, secDraft: '', viewerEdit: false });
  }

  revise(r) {
    const runs = this.state.runs.map((x) => (x.id === r.id ? { ...x, state: 'revising', from: r.state, change: '' } : x));
    this.setState({ runs: this.startNext(runs), viewer: this.specName(r), viewerEdit: true });
  }

  submit(text) {
    const t = (text || '').trim();
    if (!t) return;
    const s = this.state;
    const pid = s.pid;
    const proj = this.projectList().find((p) => p.id === pid);
    const kind = this.sizeUp(t, proj);
    const msgs = s.threads[pid].concat([
      { id: s.nextId, type: 'user', text: t },
      { id: s.nextId + 1, type: 'pick', kind: kind, sent: false, ask: this.short(t) }
    ]);
    this.setState({ draft: '', nextId: s.nextId + 2, threads: { ...s.threads, [pid]: msgs } });
  }

  setKind(pid, id, kind) {
    const s = this.state;
    const msgs = s.threads[pid].map((m) => (m.id === id ? { ...m, kind: kind } : m));
    this.setState({ threads: { ...s.threads, [pid]: msgs } });
  }

  sendPick(pid, id) {
    const s = this.state;
    const pick = s.threads[pid].find((m) => m.id === id);
    if (pick.kind === 'prd') {
      const msgs = s.threads[pid].map((m) => (m.id === id ? { ...m, sent: true } : m)).concat([{ id: s.nextId, type: 'guide', text: 'Interview started. First question: who uses this, and what should they be able to do on day one? I will skip any topic your documents already answer, and you can leave and come back; the brief saves as we go.' }]);
      this.setState({ nextId: s.nextId + 1, threads: { ...s.threads, [pid]: msgs } });
      return;
    }
    const runId = s.nextId;
    const runs = this.startNext(s.runs.concat([{ id: runId, pid: pid, kind: pick.kind, title: pick.ask, state: 'queued', idx: 0, repairs: 0 }]));
    const started = runs.find((r) => r.id === runId).state === 'building';
    const msgs = s.threads[pid].map((m) => (m.id === id ? { ...m, sent: true, runId: runId } : m)).concat([
      { id: s.nextId + 1, type: 'run', runId: runId },
      { id: s.nextId + 2, type: 'guide', text: started ? 'It is with the factory. This card stays live, so you can watch or manage the run from here. Switch projects and send the next thing whenever you like.' : 'Queued. Runs in one project go one after another, so each builds on the last. It starts by itself when the way is clear.' }
    ]);
    this.setState({ nextId: s.nextId + 3, runs: runs, panel: 'run', threads: { ...s.threads, [pid]: msgs } });
  }

  baseDocs(pid) {
    const proj = this.projectList().find((x) => x.id === pid);
    if (!proj || !proj.hasDocs) return [];
    const who = pid === 'nm' ? 'People mining coaching transcripts for reusable insights.' : 'One reader keeping a personal library of ambient recordings.';
    return [
      { name: 'PRD.md', tag: 'Product', note: 'Baseline · rewritten as built after the last release', sections: [{ h: 'Who it is for', t: who }, { h: 'What it does today', t: 'Every shipped capability, in plain language. The Guide treats this as settled and does not ask about it again.' }, { h: 'Not in scope', t: 'Things you already ruled out, so a request that crosses this line is flagged as a product change.' }] },
      { name: 'FEATURES.md', tag: 'Feature map', note: 'One entry per capability, with screens and files', sections: [{ h: 'Purpose', t: 'The map the Guide uses to tell a fix from a feature. If a request lands inside an entry, it is a fix. If it lands beside the entries, it is a feature.' }, { h: 'Entries', t: 'Ingest · Patterns · Search · Dashboard · Re-run' }] },
      { name: 'ACCEPTANCE.md', tag: 'Checks', note: 'Every check the gates prove on each run', sections: [{ h: 'Purpose', t: 'One observable scenario per capability. A fix adds or corrects one check. A feature adds a few. A full brief rewrites the set.' }] },
      { name: '.aai/context.md', tag: 'Context', note: 'Yours to edit · read on every turn', sections: [{ h: 'Purpose', t: 'Standing rules and preferences for this project, so you never repeat them in a request.' }] }
    ];
  }

  docsFor(pid) {
    const K = this.kinds();
    const extra = this.state.threads[pid]
      .filter((m) => m.type === 'pick' && m.sent && m.kind !== 'prd')
      .map((m) => ({
        name: (m.kind === 'fix' ? 'fixes/' : 'specs/') + this.slug(m.ask) + '.md',
        tag: m.kind === 'fix' ? 'Fix note' : 'Feature spec',
        note: 'Written by the Guide from this conversation',
        sections: [
          { h: 'Request', t: m.ask },
          { h: 'Size', t: K[m.kind].label + '. Steps: ' + K[m.kind].steps.join(', ') + '.' },
          { h: 'Builds on', t: 'PRD.md and FEATURES.md as they stand. Nothing already decided there was asked again.' },
          { h: 'After the run', t: 'FEATURES.md and ACCEPTANCE.md are updated to the behavior that actually shipped.' }
        ]
      }));
    return extra.reverse().concat(this.baseDocs(pid));
  }

  renderVals() {
    const s = this.state;
    const K = this.kinds();
    const list = this.projectList();
    const current = list.find((p) => p.id === s.pid);
    const tones = { run: 'var(--fg)', ask: 'var(--text2)', idle: 'var(--muted2)' };
    const shownRun = (pid) => {
      const mine = s.runs.filter((r) => r.pid === pid && r.state !== 'dismissed');
      return this.activeIn(s.runs, pid) || mine[mine.length - 1] || null;
    };
    const statusOf = (p) => {
      const act = this.activeIn(s.runs, p.id);
      const th = s.threads[p.id] || [];
      if (act && act.state === 'stuck') return { t: 'Needs you · run parked', tone: 'ask' };
      if (act && act.state === 'paused') return { t: 'Paused · waiting for you', tone: 'ask' };
      if (act && act.state === 'revising') return { t: 'Revising a spec', tone: 'ask' };
      if (th.some((m) => m.type === 'pick' && !m.sent)) return { t: 'Needs you · confirm the plan', tone: 'ask' };
      if (th.some((m) => m.type === 'pick' && m.sent && m.kind === 'prd')) return { t: 'Needs you · interview in progress', tone: 'ask' };
      if (act) return { t: 'Building · step ' + (act.idx + 1) + ' of ' + K[act.kind].steps.length, tone: 'run' };
      return { t: p.hasDocs ? 'Idle · live' : 'New · no documents yet', tone: 'idle' };
    };
    const building = s.runs.filter((r) => r.state === 'building' || r.state === 'pausing').length;

    const projects = list.map((p) => {
      const on = p.id === s.pid;
      const run = this.activeIn(s.runs, p.id);
      const st0 = statusOf(p);
      const waiting = s.runs.filter((x) => x.pid === p.id && x.state === 'queued').length;
      const st = waiting ? { ...st0, t: st0.t + ' · ' + waiting + ' queued' } : st0;
      const n = this.docsFor(p.id).length;
      return {
        name: p.name, status: st.t, dot: tones[st.tone],
        pressed: on ? 'true' : 'false',
        bg: on ? 'var(--raise)' : 'transparent', border: on ? 'var(--line2)' : 'transparent',
        border2: on ? 'var(--line3)' : 'var(--line)',
        goLabel: on ? 'You are here' : 'Open',
        go: () => this.setState({ pid: p.id, docName: '', viewer: '', selRun: 0, pmOpen: false, rowMenu: 0 }),
        weight: on ? '700' : '500',
        hasRun: !!run && run.state !== 'revising',
        segs: run ? this.runSegs(run) : [],
        docsLine: n ? n + ' documents the Guide reads before it answers' : 'No documents yet · the first brief writes them'
      };
    });

    const stateWord = { queued: 'Queued', building: 'Building', pausing: 'Pausing', paused: 'Paused', stuck: 'Parked · needs you', revising: 'Revising the spec', shipped: 'Shipped', cancelled: 'Cancelled' };
    const qList = s.runs.filter((x) => x.pid === s.pid && x.state === 'queued').map((x) => x.id);
    const ordinal = (k) => k + (k === 1 ? 'st' : k === 2 ? 'nd' : k === 3 ? 'rd' : 'th');
    const work = s.threads[s.pid].filter((m) => m.type === 'pick').map((m) => {
      const run = s.runs.find((r) => r.id === m.runId);
      return {
        title: m.ask, kind: K[m.kind].label, chipBg: K[m.kind].chipBg, chipFg: K[m.kind].chipFg,
        state: !m.sent ? 'Draft · waiting for you' : m.kind === 'prd' ? 'Interview' : run && run.state === 'queued' ? 'Queued · ' + ordinal(qList.indexOf(run.id) + 1) + ' in line' : run ? stateWord[run.state] : 'Sent'
      };
    }).reverse();

    const messages = s.threads[s.pid].map((m) => {
      const run = m.type === 'run' ? s.runs.find((r) => r.id === m.runId) : null;
      const kind = run ? run.kind : m.kind;
      const k = kind ? K[kind] : null;
      const v = { isUser: m.type === 'user', isGuide: m.type === 'guide', isPick: m.type === 'pick', isRun: m.type === 'run', text: m.text };
      if (k) { v.kindLabel = k.label; v.chipBg = k.chipBg; v.chipFg = k.chipFg; }
      if (m.type === 'pick') {
        v.read = current.hasDocs ? ['PRD.md', 'FEATURES.md', 'ACCEPTANCE.md'] : ['no documents found'];
        v.why = this.why(m.kind, current);
        v.steps = k.steps.map((label, i) => ({ n: i + 1, label: label }));
        v.cta = k.cta;
        v.open = !m.sent; v.sent = m.sent;
        v.sentLine = m.kind === 'prd' ? 'Confirmed as a full brief. The interview continues below.' : 'Sent to the factory as a ' + k.label.toLowerCase() + '.';
        v.send = () => this.sendPick(s.pid, m.id);
        v.alts = Object.keys(K).filter((key) => key !== m.kind).map((key) => ({ label: 'Make it a ' + K[key].label.toLowerCase(), set: () => this.setKind(s.pid, m.id, key) }));
      }
      if (run) {
        v.title = run.title; v.line = this.runLine(run, s.runs);
        const al = this.alertOf(run);
        v.cardBorder = run.state === 'stuck' ? 'var(--red-line)' : run.state === 'paused' ? 'var(--amber-line)' : 'var(--line)';
        v.lineColor = al || 'var(--text2)'; v.lineWeight = al ? '600' : '400';
        v.segs = this.runSegs(run);
        v.ctrls = this.runCtrls(run);
        v.openRun = () => this.setState({ panel: 'run' });
        v.openSpec = () => this.setState({ viewer: this.specName(run), viewerEdit: false });
      }
      return v;
    }).reverse();

    const tab = (id, label) => {
      const on = s.panel === id;
      return { label: label, pressed: on ? 'true' : 'false', bg: on ? 'var(--raise2)' : 'transparent', fg: on ? 'var(--fg)' : 'var(--fg)', border: on ? 'var(--line3)' : 'var(--line)', toggle: () => this.setState({ panel: on ? '' : id }) };
    };

    const docsRaw = this.docsFor(s.pid);
    const docs = docsRaw.map((d) => {
      const on = d.name === s.docName;
      return { name: d.name, tag: d.tag, note: d.note, pressed: on ? 'true' : 'false', bg: on ? 'var(--raise)' : 'var(--card)', border: on ? 'var(--line3)' : 'var(--line)', open: () => this.setState({ viewer: d.name, viewerEdit: false }) };
    });
    const doc = null;
    const key = s.pid + '|' + s.viewer;
    const vRaw = s.viewer ? docsRaw.find((d) => d.name === s.viewer) || null : null;
    const vRun = vRaw ? s.runs.filter((x) => x.pid === s.pid && this.specName(x) === vRaw.name).pop() || null : null;
    const canEdit = !!vRaw && (!vRun || vRun.state === 'revising' || vRun.state === 'shipped');
    const editing = canEdit && (s.viewerEdit || (!!vRun && vRun.state === 'revising'));
    const edits = s.docEdits[key] || {};
    const vAdds = s.docAdds[key] || {};
    const reword = (t) => {
      let r = t.trim().replace(/^(please|can you|could you|i want to|i would like to|i'd like to|let's|lets|we should|it should)\s+/i, '').replace(/[.!?]+$/, '');
      r = r.charAt(0).toUpperCase() + r.slice(1);
      return r + '.';
    };
    const pickSec = (t) => {
      const hs = vRaw.sections.map((x) => x.h.toLowerCase());
      const want = /(check|test|prove|proof|accept|gate)/i.test(t) ? ['proof', 'after the run', 'purpose'] : ['request', 'what changes', 'what it does today', 'purpose'];
      for (let w = 0; w < want.length; w++) { const at = hs.indexOf(want[w]); if (at >= 0) return at; }
      return 0;
    };
    const vsend = () => {
      const t = (this.state.vdraft || '').trim();
      if (!t || !vRaw) return;
      const st = this.state;
      const chat = (st.docChat[key] || []).concat([{ who: 'you', text: t }]);
      const locked = vRun && ['building', 'pausing', 'queued'].indexOf(vRun.state) >= 0;
      if (locked) {
        this.setState({ vdraft: '', docChat: { ...st.docChat, [key]: chat.concat([{ who: 'guide', text: 'This spec is with the factory right now, so I will not change it under the run. Pause or cancel the run and I will reopen it, or send this as a new request and I will queue it as a follow-up.' }]) } });
        return;
      }
      const at = pickSec(t);
      const where = '"' + vRaw.sections[at].h + '"';
      const mine = st.docAdds[key] || {};
      const next = { vdraft: '', activeSec: -1, secDraft: '', docAdds: { ...st.docAdds, [key]: { ...mine, [at]: (mine[at] || []).concat([reword(t)]) } } };
      let reply = 'Done. I rewrote ' + where + ' to cover that. My change is highlighted. Click the section to adjust my wording.';
      if (vRun && vRun.state !== 'revising' && vRun.state !== 'shipped') {
        next.runs = this.startNext(st.runs.map((x) => (x.id === vRun.id ? { ...x, state: 'revising', from: vRun.state, change: '' } : x)));
        next.viewerEdit = true;
        reply = 'I reopened the spec as a draft of the next revision and rewrote ' + where + ' to cover that. My change is highlighted. Nothing is building. Resubmit when it reads right.';
      } else if (vRun && vRun.state === 'revising') {
        reply = 'Done. I rewrote ' + where + ' to cover that. My change is highlighted. Click the section to adjust my wording, then resubmit.';
      }
      next.docChat = { ...st.docChat, [key]: chat.concat([{ who: 'guide', text: reply }]) };
      this.setState(next);
    };
    const vw = vRaw ? {
      open: true, name: vRaw.name, tag: vRaw.tag,
      hasLine: !!vRun, line: vRun ? 'Run: ' + this.runLine(vRun, s.runs) : '',
      revising: !!vRun && vRun.state === 'revising',
      revTitle: vRun ? 'Draft of revision ' + ((vRun.rev || 1) + 1) + ' · nothing is building' : '',
      ctrls: vRun ? this.runCtrls(vRun).filter((c) => /Revis|Resubmit|Discard/.test(c.label)) : [],
      modes: canEdit && !(vRun && vRun.state === 'revising') ? [['Read', false], ['Edit', true]].map((m) => {
        const on = editing === m[1];
        return { label: m[0], pressed: on ? 'true' : 'false', bg: on ? 'var(--raise2)' : 'transparent', fg: on ? 'var(--fg)' : 'var(--fg)', border: on ? 'var(--line3)' : 'var(--line)', set: () => this.setState({ viewerEdit: m[1] }) };
      }) : [],
      hasNotes: false, notes: [],
      sections: vRaw.sections.map((x, n) => {
        const text = edits[n] !== undefined ? edits[n] : x.t;
        const added = (vAdds[n] || []).join(' ');
        const whole = added ? text + ' ' + added : text;
        const active = editing && s.activeSec === n;
        const keep = () => {
          const st = this.state;
          if (st.activeSec !== n) return;
          const next = { activeSec: -1, secDraft: '' };
          if (st.secDraft.trim() && st.secDraft !== whole) {
            next.docEdits = { ...st.docEdits, [key]: { ...(st.docEdits[key] || {}), [n]: st.secDraft } };
            next.docAdds = { ...st.docAdds, [key]: { ...(st.docAdds[key] || {}), [n]: [] } };
          }
          this.setState(next);
        };
        return {
          h: x.h + (added ? ' · changed by the Guide' : edits[n] !== undefined ? ' · edited' : ''), label: 'Edit ' + x.h, t: text, added: added, hasAdd: !!added,
          view: !editing, click: editing && !active, edit: active, draft: s.secDraft,
          start: () => this.setState({ activeSec: n, secDraft: whole }),
          onChange: (e) => this.setState({ secDraft: e.target.value }),
          keep: keep,
          onKey: (e) => {
            if (e.key === 'Escape') { e.preventDefault(); this.setState({ activeSec: -1, secDraft: '' }); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); keep(); }
          }
        };
      }),
      footer: editing ? 'Click any section to edit it. Click away or press Cmd/Ctrl+Enter to keep the edit. Escape cancels. Each edit saves at once, and the Guide checks it before anything is built.' : canEdit ? 'Read only. Press Edit to change it, or ask the Guide.' : 'Read only while the run is active. Use Revise the spec on a parked or cancelled run, or ask the Guide.',
      chat: [{ mine: false, guide: true, text: 'I have ' + vRaw.name + ' open with you. Tell me what to change and I will edit it, or edit it yourself and I will check your changes against the rest of the project documents.' }]
        .concat((s.docChat[key] || []).map((m) => ({ mine: m.who === 'you', guide: m.who === 'guide', text: m.text }))).reverse(),
      draft: s.vdraft,
      onDraft: (e) => this.setState({ vdraft: e.target.value }),
      onKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); vsend(); } },
      send: vsend,
      close: () => this.setState({ viewer: '', viewerEdit: false, activeSec: -1, secDraft: '' })
    } : { open: false, name: '', tag: '', hasLine: false, line: '', revising: false, revTitle: '', ctrls: [], modes: [], hasNotes: false, notes: [], sections: [], footer: '', chat: [], draft: '' };

    const r = s.runs.find((x) => x.id === s.selRun && x.pid === s.pid && x.state !== 'dismissed') || shownRun(s.pid);
    const parked = r && (r.state === 'paused' || r.state === 'stuck');
    const run = r ? {
      title: r.title, line: this.runLine(r, s.runs), kindLabel: K[r.kind].label, chipBg: K[r.kind].chipBg, chipFg: K[r.kind].chipFg,
      ctrls: this.runCtrls(r), stuck: r.state === 'stuck', lineColor: this.alertOf(r) || 'var(--muted)', lineWeight: this.alertOf(r) ? '600' : '400',
      openSpec: () => this.setState({ viewer: this.specName(r), viewerEdit: false }),
      more: this.moreCtrls(r), hasMore: this.moreCtrls(r).length > 0,
      revising: r.state === 'revising', change: r.change || '', fieldId: 'revise-a', revTitle: 'Spec reopened · draft of revision ' + ((r.rev || 1) + 1),
      onChange: (e) => this.patchRun(r.id, { change: e.target.value }),
      note: parked ? 'A parked run keeps everything that already passed. Use Restart from here on any finished step to redo the work from that point.' : 'The last stop rewrites the project documents to match what was built, so the next request starts from the truth.',
      stops: K[r.kind].steps.map((label, i) => {
        const idle = ['queued', 'cancelled', 'revising'].indexOf(r.state) >= 0;
        const done = r.state === 'shipped' || (!idle && i < r.idx);
        const now = !done && !idle && i === r.idx;
        const bad = now && r.state === 'stuck';
        const held = now && r.state === 'paused';
        return {
          n: i + 1, label: label,
          state: done ? 'Done' : bad ? 'Failed twice' : held ? 'Paused here' : now ? 'Now' : 'To do',
          bg: done ? 'var(--raise2)' : bad ? 'var(--red)' : held ? 'var(--amber)' : now ? 'var(--inv)' : 'transparent',
          fg: done ? 'var(--fg)' : now ? 'var(--inv-fg)' : 'var(--muted)',
          ring: bad ? 'var(--red)' : held ? 'var(--amber)' : done ? 'var(--fg)' : now ? 'var(--inv)' : 'var(--line2)',
          text: done || now ? 'var(--fg)' : 'var(--muted)',
          canRestart: parked && i < r.idx,
          restart: () => this.patchRun(r.id, { state: 'building', idx: i })
        };
      })
    } : null;
    const qRuns = s.runs.filter((q) => q.pid === s.pid && q.state === 'queued');
    const queue = qRuns.map((q, k) => ({
      pos: k + 1, title: q.title, kindLabel: K[q.kind].label, chipBg: K[q.kind].chipBg, chipFg: K[q.kind].chipFg,
      canUp: k > 0, upLabel: 'Move ' + q.title + ' up',
      up: () => {
        const prev = qRuns[k - 1];
        const arr = this.state.runs.slice();
        const a = arr.findIndex((x) => x.id === prev.id);
        const b = arr.findIndex((x) => x.id === q.id);
        arr[a] = q; arr[b] = prev;
        this.setState({ runs: arr });
      },
      remove: () => this.patchRun(q.id, { state: 'cancelled' })
    }));
    const blocked = r && (r.state === 'stuck' || r.state === 'paused' || r.state === 'revising');

    const suggestions = (current.hasDocs
      ? ['Fix the date format on the dashboard', 'Add CSV export to the results table', 'Rebuild it for multi-user sign in']
      : ['Build a portal where members see their coaching notes', 'Adopt the app in my existing folder']
    ).map((text) => ({ text: text, use: () => this.setState({ draft: text }) }));

    const pickRows = s.threads[s.pid].filter((m) => m.type === 'pick').map((m) => {
      const rr = s.runs.find((x) => x.id === m.runId);
      if (rr && rr.state === 'dismissed') return null;
      let g = 'done';
      let st = 'Sent';
      let order = 0;
      if (!m.sent) { g = 'needs'; st = 'Plan waiting for you in the chat'; }
      else if (m.kind === 'prd') { g = 'needs'; st = 'Interview in progress'; }
      else if (rr && ['paused', 'stuck', 'revising'].indexOf(rr.state) >= 0) { g = 'needs'; st = stateWord[rr.state]; }
      else if (rr && (rr.state === 'building' || rr.state === 'pausing')) { g = 'running'; st = this.runLine(rr, s.runs); order = -1; }
      else if (rr && rr.state === 'queued') { g = 'queued'; order = qList.indexOf(rr.id); const act = this.activeIn(s.runs, s.pid); st = ordinal(order + 1) + ' in line' + (!act ? ' · waiting for a build slot' : act.state === 'building' || act.state === 'pausing' ? '' : ' · held until you resolve the run above'); }
      else if (rr) { st = stateWord[rr.state]; }
      const qi = rr ? queue.findIndex((q, k) => qRuns[k].id === rr.id) : -1;
      const picked = !!rr && !!r && rr.id === r.id && s.panel === 'run';
      const swapWith = (other) => {
        const arr = this.state.runs.slice();
        const a = arr.findIndex((x) => x.id === other.id);
        const b = arr.findIndex((x) => x.id === rr.id);
        arr[a] = rr; arr[b] = other;
        this.setState({ runs: arr });
      };
      return {
        g: g, order: order,
        title: m.ask, kind: K[m.kind].label, chipBg: K[m.kind].chipBg, chipFg: K[m.kind].chipFg, state: st,
        aria: rr ? 'Open the run: ' + m.ask : m.ask + ', in the chat',
        bg: picked ? 'var(--raise)' : 'transparent', weight: g === 'needs' ? '600' : '500',
        stColor: this.alertOf(rr) || 'var(--muted)', stWeight: this.alertOf(rr) ? '600' : '400',
        menuOpen: qi >= 0 && s.rowMenu === rr.id, menuExpanded: qi >= 0 && s.rowMenu === rr.id ? 'true' : 'false',
        menuLabel: 'Queue actions for ' + m.ask,
        toggleMenu: () => this.setState({ rowMenu: this.state.rowMenu === (rr && rr.id) ? 0 : rr.id }),
        noUp: qi <= 0, noDown: qi < 0 || qi >= qRuns.length - 1,
        upOpacity: qi > 0 ? '1' : '0.35', downOpacity: qi >= 0 && qi < qRuns.length - 1 ? '1' : '0.35',
        down: () => { if (qi >= 0 && qi < qRuns.length - 1) swapWith(qRuns[qi + 1]); },
        open: () => (rr ? this.setState({ panel: 'run', selRun: rr.id }) : this.setState({ panel: '' })),
        queued: qi >= 0, canUp: qi > 0, upLabel: qi >= 0 ? queue[qi].upLabel : '',
        up: () => { if (qi > 0) swapWith(qRuns[qi - 1]); }, remove: qi >= 0 ? () => { this.setState({ rowMenu: 0 }); queue[qi].remove(); } : null
      };
    }).filter((x) => x);
    const gdefs = [['needs', 'Needs you', 'Nothing needs you right now.'], ['running', 'Running', 'Nothing is building.'], ['queued', 'Queued', 'Nothing is waiting.'], ['done', 'Done', 'Nothing finished yet.']];
    const groups = gdefs.map((d) => {
      let items = pickRows.filter((x) => x.g === d[0]);
      if (d[0] === 'queued') items = items.slice().sort((a, b) => a.order - b.order);
      else items = items.slice().reverse();
      const open = !!s.groupsOpen[d[0]];
      const hot = d[0] === 'needs' && items.length > 0;
      return {
        label: d[1], count: items.length, items: items, open: open, empty: items.length === 0, emptyText: d[2],
        expanded: open ? 'true' : 'false', chev: open ? '▾' : '▸',
        countW: hot ? '700' : '400', countFg: hot ? 'var(--amber)' : 'var(--muted)',
        toggle: () => this.setState({ groupsOpen: { ...this.state.groupsOpen, [d[0]]: !open } })
      };
    });

    const closeNav = (fn) => () => { this.setState({ navOpen: false }); fn(); };
    const railLinks = [
      { label: '+ New project', hasBadge: false, badge: '', act: closeNav(() => this.setState({ np: { name: '', mode: 'empty', folder: '', where: 'default', repo: '' } })) },
      { label: 'Settings', hasBadge: false, badge: '', act: closeNav(() => this.setState({ cfgOpen: true })) },
      { label: 'Manual', hasBadge: false, badge: '', act: closeNav(() => this.showInfo('Manual', 'Opens the illustrated user manual, served at /manual.')) },
      { label: 'Feedback', hasBadge: false, badge: '', act: closeNav(() => this.showInfo('Feedback', 'Opens the Feedback form: Problem or Improvement, a preview of the report, Copy and open email, and optional run diagnostics. Nothing is sent until you send it.')) },
      { label: 'Updates', hasBadge: true, badge: 'Update available', act: closeNav(() => this.showInfo('Update available', 'Shows your version, the latest version, and the prompt to paste into Claude Code or Codex when you are ready. It never updates by itself.')) }
    ];

    const app = current.url ? {
      none: false, live: true, url: current.url, release: current.release,
      relaunch: () => this.showInfo('Relaunch', 'Restarts the live app on the same port, then checks its health again.'),
      stats: [{ label: 'Requests', value: '—' }, { label: 'Errors', value: '—' }, { label: 'Average response', value: '—' }, { label: 'Uptime', value: '—' }]
    } : { none: true, live: false, url: '', release: '', stats: [] };

    const provider = s.provider[s.pid] || s.cfgVals.provider || 'Claude Code';

    const npSlug = (n) => (n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '<name>';
    const npRoot = (s.cfgVals.root !== undefined ? s.cfgVals.root : '.solofactory/').replace(/\/?$/, '/');
    const npDefault = (n) => npRoot + 'projects/' + npSlug(n) + '/';
    const npv = s.np ? {
      open: true, name: s.np.name, folder: s.np.folder, adopt: s.np.mode === 'adopt',
      cta: s.np.mode === 'adopt' ? 'Adopt the app' : 'Create project',
      custom: s.np.where === 'custom', repo: s.np.repo,
      onRepo: (e) => this.setState({ np: { ...this.state.np, repo: e.target.value } }),
      repoModes: [['default', "In SoloFactory's projects folder", npDefault(s.np.name), 'ui-monospace, Menlo, monospace'], ['custom', 'Somewhere else', 'Pick any folder on this computer.', 'inherit']].map((o) => {
        const on = (s.np.where || 'default') === o[0];
        return { label: o[1], help: o[2], font: o[3], checked: on ? 'true' : 'false', bg: on ? 'var(--raise2)' : 'transparent', border: on ? 'var(--line3)' : 'var(--line)', pick: () => this.setState({ np: { ...this.state.np, where: o[0] } }) };
      }),
      onName: (e) => this.setState({ np: { ...this.state.np, name: e.target.value } }),
      onFolder: (e) => this.setState({ np: { ...this.state.np, folder: e.target.value } }),
      modes: [['empty', 'Start empty', 'The Guide starts with a full interview.'], ['adopt', 'Adopt an existing app', 'Copies a folder in, never touching the original, and writes the baseline documents from its code.']].map((o) => {
        const on = s.np.mode === o[0];
        return { label: o[1], help: o[2], checked: on ? 'true' : 'false', bg: on ? 'var(--raise2)' : 'transparent', border: on ? 'var(--line3)' : 'var(--line)', pick: () => this.setState({ np: { ...this.state.np, mode: o[0] } }) };
      }),
      close: () => this.setState({ np: null }),
      create: () => {
        const st = this.state;
        const name = (st.np.name || '').trim();
        if (!name) return;
        const id = 'x' + st.nextId;
        const adopt = st.np.mode === 'adopt';
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const custom = st.np.where === 'custom' && (st.np.repo || '').trim();
        const repo = custom ? st.np.repo.trim().replace(/\/?$/, '/') : npDefault(name);
        const text = adopt
          ? 'I will copy ' + (st.np.folder || 'that folder') + ' into ' + repo + ', never touching the original. Then I read the code and tests and write PRD.md, FEATURES.md and ACCEPTANCE.md from what is there. You review that baseline before anything new is built.'
          : name + ' lives in ' + repo + ' and has no documents yet. Tell me what you want to build and I will start a full brief.';
        this.setState({
          nextId: st.nextId + 1, pid: id, np: null, viewer: '', selRun: 0,
          extra: (st.extra || []).concat([{ id: id, name: name, repo: repo, live: adopt ? 'Adopting · not built here yet' : 'Not built yet', hasDocs: false }]),
          threads: { ...st.threads, [id]: [{ id: st.nextId, type: 'guide', text: text }] }
        });
      }
    } : { open: false, name: '', folder: '', adopt: false, cta: '', modes: [], custom: false, repo: '', repoModes: [] };

    const defs = this.settingsDefs();
    const valOf = (fd) => (s.cfgVals[fd.key] !== undefined ? s.cfgVals[fd.key] : fd.def);
    const setVal = (key, v) => this.setState({ cfgVals: { ...this.state.cfgVals, [key]: v }, cfgTouched: true });
    const cfg = {
      open: s.cfgOpen,
      status: s.cfgTouched ? 'All changes saved' : 'Showing the defaults',
      close: () => this.setState({ cfgOpen: false }),
      sections: defs.map((sec) => {
        const changed = sec.restart && sec.fields.some((fd) => s.cfgVals[fd.key] !== undefined && String(s.cfgVals[fd.key]) !== String(fd.def));
        return {
          title: sec.title + (sec.restart ? ' (applies after a restart)' : ''),
          hasNote: !!changed, note: 'Restart the factory to apply these changes. Pause active runs first; they resume where they stopped.',
          fields: sec.fields.map((fd) => {
            const v = valOf(fd);
            return {
              id: 'cfg-' + fd.key, label: fd.label, help: fd.help,
              envLine: fd.locked ? 'Set by ' + fd.env + ' in your environment' : (fd.env || ''),
              envColor: fd.locked ? 'var(--text2)' : 'var(--muted)',
              locked: !!fd.locked,
              isSelect: fd.type === 'select', isInput: fd.type === 'number' || fd.type === 'text', isToggle: fd.type === 'toggle',
              inputType: fd.type === 'number' ? 'number' : 'text', min: fd.min || '', max: fd.max || '',
              hasUnit: !!fd.unit, unit: fd.unit || '',
              value: String(v), on: !!v, toggleText: v ? 'On' : 'Off',
              options: (fd.options || []).map((o) => ({ v: o[0], label: o[1] })),
              onChange: (e) => setVal(fd.key, e.target.value),
              onToggle: (e) => setVal(fd.key, !!e.target.checked)
            };
          })
        };
      })
    };

    const titles = { app: 'Live app · ' + current.name, docs: 'Documents · ' + current.name, run: 'Run · ' + current.name };

    return {
      projects: projects, current: current, work: work, noWork: work.length === 0,
      slots: building + ' of 2 build slots in use',
      messages: messages, suggestions: suggestions,
      draft: s.draft,
      placeholder: 'Tell the Guide what ' + current.name + ' needs',
      onDraft: (e) => this.setState({ draft: e.target.value }),
      onKey: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.submit(this.state.draft); } },
      onSend: () => this.submit(this.state.draft),
      theme: {
        mode: s.themeMode, isAuto: s.themeMode === 'auto', isLight: s.themeMode === 'light', isDark: s.themeMode === 'dark',
        open: s.themeOpen, expanded: s.themeOpen ? 'true' : 'false',
        aria: 'Theme: ' + ({ auto: 'Auto', light: 'Light', dark: 'Dark' })[s.themeMode] + '. Change theme',
        toggle: () => this.setState({ themeOpen: !this.state.themeOpen, pmOpen: false, navOpen: false }),
        opts: [['auto', 'Auto', 'Match the system'], ['light', 'Light', ''], ['dark', 'Dark', '']].map((o) => {
          const on = s.themeMode === o[0];
          return { label: o[1], help: o[2], checked: on ? 'true' : 'false', bg: on ? 'var(--raise)' : 'transparent', weight: on ? '700' : '500', pick: () => this.setState({ themeMode: o[0], themeOpen: false }) };
        })
      },
      panelTabs: [tab('run', 'Run'), tab('docs', 'Documents'), tab('app', 'Live app')],
      panelOpen: s.panel !== '', panelTitle: titles[s.panel] || '',
      closePanel: () => this.setState({ panel: '' }),
      showDocs: s.panel === 'docs', showRun: s.panel === 'run', showApp: s.panel === 'app', app: app,
      groups: groups, railLinks: railLinks,
      nav: { open: s.navOpen, expanded: s.navOpen ? 'true' : 'false', hint: 'Update available', toggle: () => this.setState({ navOpen: !this.state.navOpen, pmOpen: false }) },
      pm: (() => {
        const others = projects.filter((p) => p.pressed === 'false' && /^Needs you|Paused|Revising/.test(p.status)).length;
        return {
          open: s.pmOpen, expanded: s.pmOpen ? 'true' : 'false', others: others > 0,
          othersText: others === 1 ? '1 other project needs you' : others + ' other projects need you',
          aria: 'Switch project. Now ' + current.name + (others ? '. ' + others + ' other projects need you.' : ''),
          toggle: () => this.setState({ pmOpen: !this.state.pmOpen, navOpen: false }),
          newProject: () => this.setState({ pmOpen: false, np: { name: '', mode: 'empty', folder: '', where: 'default', repo: '' } })
        };
      })(), np: npv, cfg: cfg,
      info: s.info ? { open: true, title: s.info.title, text: s.info.text, close: () => this.setState({ info: null }) } : { open: false, title: '', text: '' },
      provider: provider, providerAria: 'Builds with ' + provider + '. Switch the AI for this project.',
      toggleProvider: () => this.setState({ provider: { ...this.state.provider, [this.state.pid]: provider === 'Codex' ? 'Claude Code' : 'Codex' } }),
      onAttach: () => this.showInfo('Attach', 'Drops a spec or notes into the conversation (markdown, text, JSON, YAML, CSV) or lets the Guide look at a mockup or screenshot (png, jpg, gif, webp). Images are saved under the project\'s .factory/uploads/.'),
      vw: vw,
      docs: docs, noDocs: docsRaw.length === 0, hasDoc: !!doc, doc: doc || { name: '', sections: [], ctrls: [], hasLine: false, line: '', revising: false, change: '', revTitle: '' },
      closeDoc: () => this.setState({ docName: '' }),
      hasRun: !!run, noRun: !run, run: run || { more: [], hasMore: false, title: '', line: '', kindLabel: '', chipBg: 'var(--raise)', chipFg: 'var(--fg)', lineColor: 'var(--muted)', lineWeight: '400', stops: [], ctrls: [], stuck: false, note: '', revising: false, change: '', fieldId: 'revise-a', revTitle: '' },
      queue: queue, hasQueue: queue.length > 0,
      queueTitle: queue.length + ' queued behind it',
      queueNote: blocked ? 'Waiting for your call on the run above. Nothing here starts until it is resolved.' : 'They start one at a time, top first, each building on the last.'
    };
  }
}

// ---- Live layer: design A's component, fed from the factory API instead of its demo data.
// Anything design A shows that the factory cannot do from here yet answers with `later()`; the list is in
// docs/project-hub-ui-spec.md under "Left out for later".
function showError(error) { reportError(error, "action"); hub?.showInfo("Something went wrong", error?.message || String(error)); }
const later = (what) => hub.showInfo(what, "Not wired to the factory yet. It is on the left-out-for-later list.");
const JOB_STATE = { specifying: "building", planning: "building", building: "building", verifying: "building", repairing: "building", reviewing: "building", deploying: "building", failed: "stuck", interrupted: "stuck", paused: "paused", completed: "shipped", cancelled: "cancelled", dismissed: "dismissed", queued: "queued" };
const JOB_IDX = { specifying: 0, planning: 1, building: 2, verifying: 3, repairing: 3, reviewing: 4, deploying: 5, completed: 7 };
const PLAN_STEPS = ["retry-plan", "amend-plan", "revise-inputs", "prepare-plan", "approve-plan"];

class Live extends Component {
  constructor() {
    super();
    this.state = { ...this.state, runs: [], threads: { "": [] }, pid: "", nextId: 1, busy: false };
    try { this.state.themeMode = localStorage.getItem("solofactory.theme") || "auto"; } catch {}
  }

  async componentDidMount() {
    try {
      state.config = await api("/api/config");
      state.provider = state.config.providers.find((provider) => provider.authenticated)?.id ?? null;
      await this.loadDraft();
      await this.refresh();
    } catch (error) { showError(error); }
    this.timer = setInterval(() => { if (!this.polling) this.refresh().catch(() => {}); }, 2000);
  }

  componentDidUpdate(props, prev) {
    super.componentDidUpdate(props, prev);
    if (prev.themeMode !== this.state.themeMode) { try { localStorage.setItem("solofactory.theme", this.state.themeMode); } catch {} }
    if (prev.docEdits !== this.state.docEdits) this.saveEdits();
  }

  // An edited section of the brief under revision goes straight into the interview draft.
  saveEdits() {
    const run = this.state.runs.find((r) => r.state === "revising" && r.title === this.state.viewer);
    if (!run) return;
    const edits = this.state.docEdits[run.pid + "|" + run.title] || {};
    const out = {};
    for (const [n, text] of Object.entries(edits)) {
      const [key, , , isList] = BRIEF_SECTIONS[n];
      out[key] = isList ? text.split("\n").map((line) => line.trim()).filter(Boolean) : text;
    }
    if (Object.keys(out).length) api("/api/interview/draft", { method: "PATCH", body: { edits: out, provider: state.provider } }).then((saved) => { const guide = saved?.draft?.guide ?? saved?.guide; if (guide) state.guide = guide; }).catch(showError);
  }

  async loadDraft() {
    const draft = (await api("/api/interview/draft", { allow: [404] }).catch(() => null))?.draft;
    state.messages = draft?.messages ?? [];
    state.guide = draft?.guide ?? state.config.opening;
    state.revises = draft?.revises ?? null;
    state.replaces = draft?.replaces ?? null;
    if (state.config.providers.some((provider) => provider.id === draft?.provider && provider.authenticated)) state.provider = draft.provider;
    this.sync();
  }

  async refresh() {
    this.polling = true;
    try {
      const projects = await api("/api/projects");
      state.projects = projects.projects;
      state.project = projects.active;
      state.board = projects;
      state.jobs = (await api("/api/jobs")).jobs;
      this.sync();
    } finally { this.polling = false; }
  }

  // Rebuilds design A's runs and threads from the factory's jobs and the interview draft.
  sync() {
    const runs = [], threads = {};
    let id = 1;
    const runOf = (pid, job) => {
      const st = job.id === state.revises ? "revising" : job.pendingPause ? "pausing" : JOB_STATE[job.state] || "building";
      const run = { id: id++, jobId: job.id, pid, kind: "feature", title: job.brief?.workingName || job.brief?.promise || job.workingName || "Run", state: st, idx: JOB_IDX[job.state] ?? 0, repairs: 0, job };
      runs.push(run);
      threads[pid].push({ id: id++, type: "pick", kind: "feature", sent: true, ask: run.title, runId: run.id }, { id: id++, type: "run", runId: run.id });
    };
    for (const p of state.projects) {
      threads[p.id] = [];
      if (p.id === state.project) [...state.jobs].reverse().forEach((job) => runOf(p.id, job));
      else if (p.lastRun) runOf(p.id, p.lastRun);
    }
    const here = threads[state.project] ?? (threads[state.project || ""] = []);
    const talk = state.messages.length ? state.messages : [{ role: "assistant", content: state.guide?.message ?? "" }];
    for (const m of talk) here.push({ id: id++, type: m.role === "user" ? "user" : "guide", text: m.content });
    if (this.state.busy) here.push({ id: id++, type: "guide", text: "Thinking…" });
    // A revision draft resubmits from its run, so it is not also a new plan waiting in the chat.
    else if (state.guide?.status === "ready" && !state.revises) here.push({ id: id++, type: "pick", kind: "brief", sent: false, ask: state.guide.brief?.workingName || "The brief" });
    const pid = this.state.pid && threads[this.state.pid] ? this.state.pid : state.project || "";
    this.setState({ runs, threads, nextId: id, pid });
  }

  kinds() {
    const k = super.kinds();
    return { ...k, brief: { ...k.prd, label: "Full brief", cta: "Send to the factory" } };
  }

  why(kind, proj) {
    if (kind === "brief") return "The Guide has what it needs. Sending runs one last review of the brief, then queues it.";
    return super.why(kind, proj);
  }

  projectList() {
    const list = (state.projects || []).map((p) => {
      const shipped = p.id === state.project ? state.jobs.find((job) => job.state === "completed" && job.deployment?.url) : null;
      const url = shipped?.deployment?.url || "";
      return { id: p.id, name: p.name, hasDocs: p.runCount > 0, url, release: url ? "release " + p.runCount : "", live: url ? "Live at " + url : p.runCount ? "Built here" : "Not built yet" };
    });
    return list.length ? list : [{ id: "", name: "No project yet", hasDocs: false, live: "Not built yet" }];
  }

  startNext(runs) { return runs; }
  tick() {}
  specName(r) { return r.title; }

  runLine(r, runs) {
    if (r.state === "stuck") return "Parked · " + (r.job?.error?.message || "needs you").slice(0, 90);
    return super.runLine(r, runs);
  }

  docsFor(pid) {
    const runs = this.state.runs.filter((r) => r.pid === pid && r.job?.brief);
    return runs.slice().reverse().map((r) => {
      const brief = r.state === "revising" && state.guide?.brief ? state.guide.brief : r.job.brief;
      return {
        name: r.title, tag: "Brief", note: r.state === "revising" ? "Draft of the next revision" : "The brief this run was queued with",
        sections: BRIEF_SECTIONS.filter(([key]) => brief[key] != null && brief[key] !== "" && !(Array.isArray(brief[key]) && !brief[key].length))
          .map(([key, label, , isList]) => ({ h: label, t: isList ? [].concat(brief[key]).join("\n") : String(brief[key]), k: key, list: isList }))
      };
    });
  }

  post(r, action, body = {}) {
    return api(`/api/jobs/${r.jobId}/${action}`, { method: "POST", body }).then(() => this.refresh()).catch(showError);
  }

  // The server's continuation policy decides: nextAction?.action !== "resume" means Resume would not move it.
  resumeOf(r) { return r.job?.nextAction?.action !== "resume" && r.state !== "paused" ? "retry" : "resume"; }

  // Planning steps go to the Guide's repair planner; the recovery-review amendment upload is left out.
  repairOf(r) {
    const next = r.job?.nextAction;
    if (next?.action === "retry-plan" || next?.action === "amend-plan" || PLAN_STEPS.includes(next?.action)) return this.post(r, "recovery-plan", { guidance: "" });
    return this.post(r, "retry");
  }

  async reviseRun(r) {
    const draft = (await api("/api/interview/draft", { allow: [404] }).catch(() => null))?.draft;
    if (draft?.revises !== r.jobId) await api(`/api/jobs/${r.jobId}/revise`, { method: "POST", body: {} });
    await this.loadDraft();
    this.setState({ viewer: r.title, viewerEdit: true });
  }

  async discardDraft() {
    await api("/api/interview/draft", { method: "DELETE", allow: [404] });
    this.setState({ viewer: "", viewerEdit: false, docEdits: {}, docAdds: {} });
    await this.loadDraft();
  }

  // The recovery-plan-packet download is left out; the packet text goes to the clipboard.
  async copyPacket(r) {
    const response = await fetch(`/api/jobs/${r.jobId}/recovery-packet`);
    if (!response.ok) throw new Error(`Recovery packet failed with HTTP ${response.status}.`);
    await navigator.clipboard.writeText(await response.text());
    this.showInfo("Copy recovery packet", "Copied. Paste it into Claude Code or Codex for help.");
  }

  wire(c, r) {
    const acts = {
      "Remove from queue": () => this.post(r, "cancel"),
      "Cancel run": () => this.post(r, "cancel"),
      "Pause after this step": () => this.post(r, "pause"),
      "Resume": () => this.post(r, this.resumeOf(r)),
      "Let the Guide plan a repair": () => this.repairOf(r),
      "Revise the spec": () => this.reviseRun(r).catch(showError),
      "Revise and resubmit": () => this.reviseRun(r).catch(showError),
      "Resubmit to the factory": () => this.queue().catch(showError),
      "Discard changes": () => this.discardDraft().catch(showError),
      "Copy recovery packet": () => this.copyPacket(r).catch(showError),
      "Start over from scratch": () => this.post(r, "retry"),
      "Dismiss": () => this.post(r, "dismiss"),
    };
    return { ...c, act: acts[c.label] || (() => later(c.label)) };
  }
  // The server cancels only active runs; a parked one (stuck or paused) is dismissed instead, as in the old hub.
  runCtrls(r) { return super.runCtrls(r).filter((c) => !(c.label === "Cancel run" && (r.state === "stuck" || r.state === "paused"))).map((c) => this.wire(c, r)); }
  moreCtrls(r) { return super.moreCtrls(r).map((c) => this.wire(c, r)); }

  async turn(content, review = false) {
    if (!state.provider) throw new Error("Sign in to Claude Code or Codex first.");
    if (!review) state.messages.push({ role: "user", content });
    this.setState({ busy: true }); this.sync();
    try {
      const guide = await api("/api/interview/turn", { method: "POST", body: { provider: state.provider, messages: state.messages, ...(review && { review: true }) } });
      state.guide = guide;
      state.messages.push({ role: "assistant", content: guide.message });
    } catch (error) {
      if (!review) state.messages.pop();
      throw error;
    } finally { this.setState({ busy: false }); this.sync(); }
  }

  submit(text) {
    const t = (text || "").trim();
    if (!t || this.state.busy) return;
    this.setState({ draft: "" });
    const go = this.state.pid && this.state.pid !== state.project ? this.select(this.state.pid) : Promise.resolve();
    go.then(() => this.turn(t)).catch(showError);
  }

  sendPick() { this.queue().catch(showError); }

  // Same order as before: a final review turn, stop if it changed the brief, then queue.
  async queue() {
    const before = state.guide?.brief;
    // A second press on a brief the review left unchanged but unmarked queues it as shown (the old hub's Queue anyway).
    const anyway = state.queueAnyway === JSON.stringify(before);
    if (!state.guide?.reviewed && !anyway) {
      await this.turn("", true);
      if (state.guide?.status !== "ready" || briefChanged(before, state.guide.brief)) {
        this.showInfo("Check the brief", "The final review changed the brief or asked a question. Read the Guide's reply, then send again.");
        return;
      }
      if (!state.guide.reviewed) {
        state.queueAnyway = JSON.stringify(state.guide.brief);
        this.showInfo("Not fully reviewed", "The Guide's review did not confirm this brief as it stands. Press the button again to queue it as shown, or change it.");
        return;
      }
    }
    state.queueAnyway = null;
    const body = { provider: state.provider, transcript: state.messages, coverage: state.guide.coverage, brief: state.guide.brief, ...(state.revises && { revises: state.revises, replaces: state.replaces }) };
    try { await api("/api/jobs", { method: "POST", body }); }
    catch (error) {
      if (error.body?.code !== "revise_blocker_changed") throw error;
      state.replaces = error.body.replaces;
      await api("/api/jobs", { method: "POST", body: { ...body, replaces: state.replaces } });
    }
    state.amendment = null;
    this.setState({ viewer: "", viewerEdit: false, docEdits: {}, docAdds: {}, panel: "run" });
    await this.loadDraft();
    await this.refresh();
  }

  async select(id) {
    await api("/api/projects/select", { method: "POST", body: { id } });
    await this.refresh();
    await this.loadDraft();
  }

  renderVals() {
    const v = super.renderVals();
    const s = this.state;
    const list = this.projectList();
    v.projects.forEach((p, i) => {
      const id = list[i]?.id;
      const go = p.go;
      p.go = () => { go(); if (id && id !== state.project) this.select(id).catch(showError); };
    });
    if (v.np.open) {
      v.np.create = () => {
        const name = (s.np.name || "").trim();
        if (!name) return;
        if (s.np.mode === "adopt") return later("Adopt an existing app");
        if (s.np.where === "custom") return later("A project somewhere else");
        this.setState({ np: null });
        api("/api/projects", { method: "POST", body: { name } }).then(() => this.refresh()).then(() => this.loadDraft()).catch(showError);
      };
    }
    for (const sec of v.cfg.sections) for (const f of sec.fields) { f.locked = true; f.onChange = () => later("Changing settings here"); f.onToggle = f.onChange; }
    v.cfg.status = "Read only for now";
    for (const m of v.messages) m.alts = [];
    for (const q of v.queue) { q.canUp = false; q.up = () => later("Reordering the queue"); }
    for (const g of v.groups) for (const it of g.items) { it.canUp = false; it.noUp = true; it.noDown = true; it.upOpacity = "0.35"; it.downOpacity = "0.35"; it.up = it.down = () => later("Reordering the queue"); }
    if (v.run.stops) for (const stop of v.run.stops) stop.canRestart = false;
    const board = state.board;
    if (board) v.slots = (board.activeRuns?.length ?? 0) + " of " + board.maxActiveRuns + " build slots in use";
    for (const link of v.railLinks) {
      if (link.label === "Manual") link.act = () => { this.setState({ navOpen: false }); window.open("/manual", "_blank"); };
      else if (link.label === "Feedback" || link.label === "Updates") link.act = () => { this.setState({ navOpen: false }); later(link.label); };
      if (link.label === "Updates") { link.hasBadge = false; link.badge = ""; }
    }
    v.nav.hint = "";
    const live = (state.config?.providers || []).filter((provider) => provider.authenticated);
    const now = live.find((provider) => provider.id === state.provider);
    v.provider = now?.label || "No AI signed in";
    v.providerAria = "Builds with " + v.provider + ". Switch the AI.";
    v.toggleProvider = () => {
      if (live.length < 2) return this.showInfo("Builds with", live.length ? "Only " + v.provider + " is signed in." : "Sign in to Claude Code or Codex first.");
      state.provider = live[(live.indexOf(now) + 1) % live.length].id;
      this.setState({});
    };
    v.onAttach = () => { const input = document.createElement("input"); input.type = "file"; later("Attaching files"); };
    if (v.app.live) { v.app.relaunch = () => later("Relaunch"); }
    if (v.vw.open && !v.vw.revising) {
      v.vw.modes = [];
      v.vw.footer = "Read only. Revise the spec to change it.";
      for (const sec of v.vw.sections) { sec.view = true; sec.click = false; sec.edit = false; }
    }
    v.vw.send = () => {
      const t = (this.state.vdraft || "").trim();
      if (!t) return;
      if (!v.vw.revising) return later("Asking the Guide to edit a document");
      this.setState({ vdraft: "" });
      this.turn(t).catch(showError);
    };
    v.vw.onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); v.vw.send(); } };
    v.suggestions = [];
    if (v.run.stops) for (const stop of v.run.stops) if (stop.state === "Failed twice") stop.state = "Failed";
    const job = (s.runs.find((r) => r.id === s.selRun && r.pid === s.pid && r.state === "stuck") || s.runs.find((r) => r.pid === s.pid && r.state === "stuck"))?.job;
    v.run.stuckText = [job?.error?.message, job?.nextAction?.reason].filter(Boolean).join(" ") || "The factory stopped this run. Nothing was deployed and the last release is still live.";
    if (typeof v.run.note === "string" && v.run.note.startsWith("A parked run")) v.run.note = "A parked run keeps everything that already passed.";
    return v;
  }
}

const hub = new Live();
hub.mount(document.getElementById("app"));
