// Vertical-slice plan engine for SoloFactory's slice-mode SDLC strategy.
//
// Pure and synchronous on purpose: no filesystem, no agents, no time. The
// controller (factory.mjs) owns reading/writing .factory/slices.json and
// persisting progress; this module validates a plan, enforces the quality
// gates that keep decompositions honest, and answers "what executes next".
//
// Quality gates beyond structure:
// - every criterion must be unique across the whole plan (duplicated criteria
//   mean one slice re-implements another — the top waste in slice builds);
// - when the frozen brief has N acceptance scenarios, each one must be tagged
//   "[SC-n]" on at least one slice criterion, so the plan provably covers the
//   contract instead of merely being plausible.

import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { assertAllowedCommand } from "./process.mjs";

export const SLICE_ID_RE = /^[A-Z][A-Z0-9-]{0,63}$/;
const SCENARIO_TAG_RE = /\bSC-(\d{1,3})\b/g;

/**
 * Validate and normalize a slice plan.
 *
 * Options:
 * - scenarioCount: number of frozen acceptance scenarios (brief.acceptanceScenarios).
 *   When > 0 every scenario 1..scenarioCount must be referenced by an "[SC-n]" tag in
 *   at least one slice criterion; a missing scenario is a decomposition gap, not a lint.
 *
 * Contract:
 * - plan.slices is a non-empty array.
 * - every slice has a unique id, non-empty title and objective, and at least one
 *   concrete acceptance criterion (trimmed length >= 3).
 * - dependsOn (optional) lists ids of OTHER slices; every reference must exist and
 *   appear EARLIER in the array, and slice 1 (the walking skeleton) must not depend
 *   on anything.
 * - demo (optional) is a sentence long enough to act on.
 *
 * Throws an Error describing the first problem found. Returns a normalized copy of
 * the plan (dependsOn defaulted to [], demo trimmed) on success.
 */
export function validateSlicePlan(plan, { scenarioCount = 0 } = {}) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.slices)) {
    throw new Error("slices.json must be an object with a slices array.");
  }
  if (plan.slices.length === 0) {
    throw new Error("slices.json must contain at least one slice.");
  }

  // First pass: ids, duplicates, and positions in declared order.
  const position = new Map();
  for (const [index, slice] of plan.slices.entries()) {
    if (!slice || typeof slice !== "object") {
      throw new Error(`slices[${index}] is not an object.`);
    }
    if (typeof slice.id !== "string" || !SLICE_ID_RE.test(slice.id)) {
      throw new Error(`slices[${index}].id must match ${SLICE_ID_RE} (got ${JSON.stringify(slice.id)}).`);
    }
    if (position.has(slice.id)) {
      throw new Error(`Duplicate slice id: ${slice.id}.`);
    }
    position.set(slice.id, index);
  }

  // Second pass: structural validation and dependency order.
  const normalized = {
    ...plan,
    slices: plan.slices.map((slice) => {
      if (typeof slice.title !== "string" || !slice.title.trim()) {
        throw new Error(`Slice ${slice.id} needs a non-empty title.`);
      }
      if (typeof slice.objective !== "string" || !slice.objective.trim()) {
        throw new Error(`Slice ${slice.id} needs a non-empty objective.`);
      }
      if (
        !Array.isArray(slice.acceptance) ||
        slice.acceptance.length === 0 ||
        !slice.acceptance.every((item) => typeof item === "string" && item.trim().length >= 3)
      ) {
        throw new Error(`Slice ${slice.id} needs at least one concrete acceptance criterion.`);
      }
      if (slice.demo !== undefined && (typeof slice.demo !== "string" || slice.demo.trim().length < 8)) {
        throw new Error(`Slice ${slice.id} has a demo that is too thin to act on.`);
      }
      const dependsOn = Array.isArray(slice.dependsOn) ? slice.dependsOn : [];
      if (!dependsOn.every((dep) => typeof dep === "string" && dep.length > 0)) {
        throw new Error(`Slice ${slice.id} has a malformed dependsOn entry.`);
      }
      for (const dep of dependsOn) {
        const depIndex = position.get(dep);
        const index = position.get(slice.id);
        if (depIndex === undefined) {
          throw new Error(`Slice ${slice.id} depends on unknown slice ${dep}.`);
        }
        if (depIndex >= index) {
          throw new Error(`Slice ${slice.id} depends on ${dep}, which is not an earlier slice. Dependencies must reference completed earlier slices.`);
        }
      }
      if (position.get(slice.id) === 0 && dependsOn.length > 0) {
        throw new Error(`Slice ${slice.id} is the walking skeleton and must not depend on other slices.`);
      }
      return {
        id: slice.id,
        title: slice.title.trim(),
        objective: slice.objective.trim(),
        acceptance: slice.acceptance.map((item) => item.trim()),
        demo: slice.demo === undefined ? undefined : slice.demo.trim(),
        dependsOn: [...dependsOn],
      };
    }),
  };

  // Quality gate: no criterion may appear in more than one slice.
  const seen = new Map();
  for (const slice of normalized.slices) {
    for (const criterion of slice.acceptance) {
      const key = criterion.toLowerCase();
      const firstIn = seen.get(key);
      if (firstIn !== undefined) {
        throw new Error(
          `Slices ${firstIn} and ${slice.id} share the same acceptance criterion ("${criterion.slice(0, 90)}"). One of them re-implements the other — merge or redraw the boundary.`,
        );
      }
      seen.set(key, slice.id);
    }
  }

  // Quality gate: every frozen scenario must be referenced by the plan.
  if (Number.isInteger(scenarioCount) && scenarioCount > 0) {
    const covered = new Set();
    for (const slice of normalized.slices) {
      for (const criterion of slice.acceptance) {
        for (const match of criterion.matchAll(SCENARIO_TAG_RE)) {
          const number = Number(match[1]);
          if (number >= 1 && number <= scenarioCount) covered.add(number);
        }
      }
    }
    const missing = [];
    for (let number = 1; number <= scenarioCount; number += 1) {
      if (!covered.has(number)) missing.push(`SC-${number}`);
    }
    if (missing.length > 0) {
      throw new Error(
        `The slice plan does not cover frozen acceptance scenario${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. Reference each scenario (SC-1..SC-${scenarioCount}) with an "[SC-n]" tag on at least one slice criterion, or the brief is not fully decomposable as planned.`,
      );
    }
  }

  return normalized;
}

/**
 * Return the slices in execution order.
 *
 * Validation guarantees dependencies only reference earlier slices, so the
 * declared order already satisfies every dependency. This function exists to
 * give callers a single place that would also own a future topological sort
 * if the forward-only rule is ever relaxed.
 */
export function orderSlices(plan) {
  const normalized = validateSlicePlan(plan);
  return normalized.slices;
}

/**
 * First not-yet-done slice whose dependencies are all done, or null when no
 * slice remains executable (all done, or remaining slices wait on work that
 * is not done).
 */
export function nextExecutable(doneIds, plan) {
  const slices = orderSlices(plan);
  const done = new Set(doneIds ?? []);
  for (const slice of slices) {
    if (done.has(slice.id)) continue;
    if (slice.dependsOn.every((dep) => done.has(dep))) return slice;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version-2 feature plans: every new run decomposes the frozen contract into
// typed, dependency-ordered features before the first implementation turn.
//
// `checks` is the original-check registry from review.mjs originalChecks(),
// so plan ownership and full review share one MH-n/SC-n numbering. Pure: the
// caller supplies identity and digest; proof files may not exist yet.

export const MAX_FEATURES = 30;

// Obligations whose proof can only run on the integrated app. They run before the final review.
export const pendingObligations = (plan) => (plan?.slices ?? []).flatMap((slice) => (slice.acceptance ?? []).filter((item) => item.proof?.pending === "integration"));

// Outstanding proofs: pending obligations recorded on the job when their feature was verified. Each
// is keyed by its plan, feature and obligation, so plans sharing obligation ids never collide, and it
// stays on the run across repair plans until it passes or its feature is explicitly reopened.
export const proofKey = (planDigest, slice, item) => `${planDigest}:${slice.id}/${item.id}`;
export const integrationProofs = (job) => (job.outstandingProofs ?? []).filter((entry) => entry.status !== "superseded");
export const pendingProofs = (job) => (job.outstandingProofs ?? []).filter((entry) => entry.status === "pending");
export function recordPendingProofs(job, planDigest, slice) {
  job.outstandingProofs ??= [];
  for (const item of (slice.acceptance ?? []).filter((item) => item.proof?.pending === "integration")) {
    const key = proofKey(planDigest, slice, item);
    const entry = { key, gate: `proof-${planDigest}.${slice.id}.${item.id}`, planDigest, feature: slice.id, obligation: item, refs: [...(item.refs ?? [])], status: "pending" };
    const at = job.outstandingProofs.findIndex((existing) => existing.key === key);
    if (at >= 0) job.outstandingProofs[at] = entry; else job.outstandingProofs.push(entry);
  }
}

// Build-time proofs of every verified feature. No longer rerun at final integration (Lou, 2026-10-16); they
// still key integrationSet, so a changed proof set voids a recorded integration pass. A recovery run also counts
// the original plan's built features; a repair feature with the same id replaces the original.
// ponytail: features built by earlier recovery phases are not carried; add them if regressions slip there.
export function featureProofs(job) {
  const builtOf = (plan, done) => (plan?.slices ?? []).filter((slice) => done.includes(slice.id));
  const original = builtOf(job.approvedPlan?.plan, job.sliceDone ?? []);
  const phase = job.recoveryPhase;
  const repaired = phase?.done?.length ? builtOf(phase.plan, phase.done) : [];
  const ids = new Set(repaired.map((slice) => slice.id));
  const built = [...original.filter((slice) => !ids.has(slice.id)), ...repaired];
  // A stage obligation (e.g. "the seed script fails until the summary exists") is retired once a built
  // feature's case supersedes it; demanding its test at integration would be unrepairable.
  return proofsOf(built);
}

// Runnable proofs of `selected`, minus stage obligations any built feature's case retired.
export function proofsOf(selected, built = selected) {
  const retired = new Set(built.flatMap((slice) => (slice.acceptance ?? []).flatMap((item) => (item.cases ?? []).flatMap((entry) => entry.supersedes ?? []))));
  return selected.flatMap((slice) => (slice.acceptance ?? [])
    .filter((item) => item?.proof?.command && !item.proof.pending && !retired.has(item.id))
    .map((item) => ({ id: `${slice.id}.${item.id}`, proof: item.proof, cases: item.cases })));
}

// Commands can serve multiple obligations, including a manifest gate. Preserve every target.
export function failedIntegrationProofs(job) {
  if (job.error?.code !== "quality_gate_failed") return [];
  const { gate, command, proofKeys } = job.error.details ?? {};
  return integrationProofs(job).filter(entry => Array.isArray(proofKeys) ? proofKeys.includes(entry.key)
    : command ? JSON.stringify(entry.obligation.proof.command) === JSON.stringify(command) : entry.gate === gate);
}
export const pendingProofFailure = job => failedIntegrationProofs(job)[0] ?? null;

// A check a feature closes stays unverified while any obligation that supports it, in any feature of
// the plan or outstanding from an earlier plan, still waits for its integration proof.
export function pendingChecks(slice, { plan = null, outstanding = [] } = {}) {
  const planDigest = plan ? createHash("sha256").update(JSON.stringify(plan)).digest("hex") : null;
  const planned = pendingObligations(plan ?? { slices: [slice] }).filter(item =>
    !outstanding.some(entry => entry.obligation?.id === item.id && entry.status !== "pending" && (!planDigest || entry.planDigest === planDigest) &&
      (plan?.slices ?? [slice]).some(feature => feature.id === entry.feature && feature.acceptance?.includes(item))));
  const refs = new Set([...planned, ...outstanding.filter((entry) => entry.status === "pending")].flatMap((item) => item.refs ?? []));
  return (slice.closes ?? []).filter((id) => refs.has(id));
}

// A plan that fails the schema check gets its own small fix budget before it may spend a correction:
// those failures are bookkeeping, and they cost real plans half their corrections (2026-10-11).
// Fixed rather than tied to SOLOFACTORY_MAX_REPAIRS, so a zero repair budget still allows schema fixes.
export const PLAN_SCHEMA_FIXES = 3;
const text = (value, min) => typeof value === "string" && value.trim().length >= min;
const normalSource = (ref) => ({ path: ref.path, locator: ref.locator.trim() });
const sourceKey = (ref) => `${ref.path}\u0000${ref.locator.trim()}`;

export const CASE_SURFACES = ["api", "browser", "cli", "unit", "integration"];

// A requirement that consolidates overlapping obligations keeps each one as an explicit case: its own
// surface, action, field/boundary and expected result (failure condition included). Together the cases
// cite exactly the requirement's checks and sources, so consolidation cannot drop a citation.
function validateCases(item, { registry: known, sources, ids, claimed }) {
  const where = `Requirement ${item.id}`;
  if (!Array.isArray(item.cases) || !item.cases.length) throw new Error(`${where} has a malformed cases table; omit it or list at least one case.`);
  const refs = new Set();
  const problems = [];
  const cases = item.cases.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !SLICE_ID_RE.test(entry.id) || ids.has(entry.id)) throw new Error(`${where} has a missing or duplicate case id.`);
    ids.add(entry.id);
    const at = `Case ${entry.id}`;
    if (!CASE_SURFACES.includes(entry.surface)) throw new Error(`${at} needs a surface (one of ${CASE_SURFACES.join(", ")}).`);
    if (!text(entry.action, 1) || !text(entry.expect, 1)) throw new Error(`${at} needs the action it performs and its expected result.`);
    for (const field of ["field", "boundary"]) if (entry[field] !== undefined && !text(entry[field], 1)) throw new Error(`${at} has an empty ${field}.`);
    // A case may cite no check (a constraint case); the cases together must still cover every ref below.
    if (!Array.isArray(entry.refs)) problems.push(`${at} needs a refs array (it may be empty).`);
    else {
      const foreign = entry.refs.filter((ref) => !item.refs.includes(ref));
      if (foreign.length) problems.push(`${at} cites ${foreign.join(", ")}, which ${item.id} does not (allowed: ${item.refs.join(", ") || "none"}).`);
      entry.refs.forEach((ref) => refs.add(ref));
    }
    if (sources) {
      // Locators are free text that planners reword between corrections, so a case matches its requirement's
      // sources by file and keeps its own locator; exact locator matching blocked real plans on wording alone.
      const own = [...new Set(item.sources.map((ref) => ref.path))];
      if (!Array.isArray(entry.sources) || !entry.sources.length) problems.push(`${at} must cite sources [{path, locator}] from ${item.id}'s files (allowed: ${own.join(", ")}).`);
      else {
        const foreign = entry.sources.filter((ref) => !text(ref?.locator, 2) || !own.includes(ref.path));
        if (foreign.length) problems.push(`${at} cites ${foreign.map((ref) => `${ref?.path} ${ref?.locator ?? "(no locator)"}`).join("; ")}, which ${item.id} does not; cite a section of one of its files with a locator, or add the file to ${item.id}'s sources (allowed: ${own.join(", ")}).`);
      }
    }
    const supersedes = entry.supersedes ?? [];
    if (!Array.isArray(supersedes) || supersedes.some((id) => typeof id !== "string" || !SLICE_ID_RE.test(id) || claimed.has(id))) throw new Error(`${at} has a malformed or repeated supersedes id.`);
    supersedes.forEach((id) => claimed.add(id));
    return { id: entry.id, surface: entry.surface, action: entry.action.trim(), ...(entry.field ? { field: entry.field.trim() } : {}), ...(entry.boundary ? { boundary: entry.boundary.trim() } : {}),
      expect: entry.expect.trim(), refs: [...entry.refs], ...(sources ? { sources: entry.sources.map(normalSource) } : {}), ...(entry.supersedes ? { supersedes: [...supersedes] } : {}) };
  });
  const uncovered = item.refs.filter((ref) => !refs.has(ref));
  if (uncovered.length) problems.push(`${where} cites ${uncovered.join(", ")} but none of its cases does.`);
  // ponytail: no case-side source coverage. Both lists are planner-authored, so the rule only made planners
  // edit citations; it ate corrections in three real runs (2026-10-11). Source fidelity against a reviewed plan
  // is assertConsolidation's job.
  // Report every citation problem together so one planner correction can fix them all.
  if (problems.length) throw new Error(problems.join(" "));
  return cases;
}

// A replacement for a reviewed plan must account for every obligation that plan held: kept under its id, or
// superseded by exactly one case, each without losing a check, a source citation or its integration timing.
export function assertConsolidation(plan, base) {
  const kept = new Map();
  const claims = new Map();
  for (const slice of plan.slices) for (const item of slice.acceptance) {
    kept.set(item.id, item);
    for (const entry of item.cases ?? []) for (const id of entry.supersedes ?? []) claims.set(id, { item, entry });
  }
  const problems = [];
  const baseIds = new Set();
  for (const slice of base.slices) for (const old of slice.acceptance) {
    baseIds.add(old.id);
    const item = kept.get(old.id);
    const claim = claims.get(old.id);
    if (item && claim) { problems.push(`${old.id} is kept and also superseded by case ${claim.entry.id}`); continue; }
    if (!item && !claim) { problems.push(`${old.id} (${slice.id}) is neither kept nor superseded by a case`); continue; }
    const target = item ?? claim.entry;
    const owner = item ?? claim.item;
    const at = item ? `kept ${old.id}` : `case ${claim.entry.id}`;
    const lostRefs = old.refs.filter((ref) => !target.refs.includes(ref));
    if (lostRefs.length) problems.push(`${at} drops ${old.id}'s checks ${lostRefs.join(", ")}`);
    const lostSources = (old.sources ?? []).filter((ref) => !(target.sources ?? []).some((own) => sourceKey(own) === sourceKey(ref)));
    if (lostSources.length) problems.push(`${at} drops ${old.id}'s source ${lostSources.map((ref) => `${ref.path} ${ref.locator}`).join("; ")}`);
    if ((old.proof.pending ?? null) !== (owner.proof.pending ?? null)) problems.push(`${at} changes when ${old.id} is proved (${old.proof.pending ?? "at build"} → ${owner.proof.pending ?? "at build"})`);
    // A kept id keeps its meaning; changing what it asserts goes through a superseding case the reviewer judges.
    if (item) {
      const changed = [["behavior", old.behavior, item.behavior], ["expected result", old.proof.expect, item.proof.expect], ["proof command", old.proof.command, item.proof.command]]
        .filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after)).map(([field]) => field);
      const caseKey = (entry) => JSON.stringify([entry.surface, entry.action, entry.field ?? null, entry.boundary ?? null, entry.expect]);
      const cases = new Map((item.cases ?? []).map((entry) => [entry.id, caseKey(entry)]));
      const lostCases = (old.cases ?? []).filter((entry) => cases.get(entry.id) !== caseKey(entry)).map((entry) => entry.id);
      if (changed.length) problems.push(`${at} changes its ${changed.join(", ")}; supersede it with a case instead`);
      if (lostCases.length) problems.push(`${at} drops or changes cases ${lostCases.join(", ")}`);
    }
  }
  for (const [id, { entry }] of claims) if (!baseIds.has(id)) problems.push(`case ${entry.id} supersedes ${id}, which the reviewed plan does not contain`);
  if (problems.length) throw new Error(`The consolidation does not preserve the reviewed plan (${problems.length} problem${problems.length > 1 ? "s" : ""}): ${problems.slice(0, 10).join("; ")}${problems.length > 10 ? "; …" : ""}.`);
}

// Per-case proof evidence from the factory's node:test reporter: a case passes only when a test naming
// [CASE-ID] passed and none naming it failed, was skipped or was todo. One passing case proves only itself.
export function caseResults(cases, events) {
  const seen = new Map(cases.map((entry) => [entry.id, { pass: 0, fail: 0, skip: 0 }]));
  for (const line of events.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const [, id] of String(event.name ?? "").matchAll(/\[([A-Z][A-Z0-9-]*)\]/g)) {
      const tally = seen.get(id);
      if (!tally) continue;
      if (event.type === "test:fail") tally.fail += 1;
      else if (event.skip || event.todo) tally.skip += 1;
      else if (event.type === "test:pass") tally.pass += 1;
    }
  }
  return Object.fromEntries(cases.map((entry) => {
    const tally = seen.get(entry.id);
    return [entry.id, { requirement: entry.requirement, status: tally.fail ? "failed" : tally.skip ? "skipped" : tally.pass ? "passed" : "missing" }];
  }));
}

// sources (paths), when given, makes every obligation cite the authoritative input it implements.
// Bare "npm", "npm CLI (…)", "Node.js": no version digits or version words, so not a feature needing a different toolchain.
const CONTROLLER_TOOLCHAIN_RE = /^(node(\.js)?|npm)(\s+cli)?(\s*\((?![^()]*\b(version|lts|latest|requires?|required|minimum|newer|older|least)\b)[^()\d]*\))?$/i;

// ownership: also require test ownership across features (assertProofOwnership); off for re-validating approved plans.
export function validateFeaturePlan(raw, { jobId, contractDigest, checks, sources = null, ownership = false, closedChecks = [] }) {
  if (!raw || typeof raw !== "object" || raw.version !== 2) throw new Error("slices.json must be a version 2 feature plan.");
  if (raw.jobId !== jobId || raw.contractDigest !== contractDigest) throw new Error("Feature plan does not match this run and its frozen contract.");
  if (!Array.isArray(raw.slices) || raw.slices.length === 0) throw new Error("slices.json must contain at least one feature.");
  if (raw.slices.length > MAX_FEATURES) throw new Error(`Feature plan has ${raw.slices.length} features; the limit is ${MAX_FEATURES}. Park and split the brief rather than merging or dropping scope.`);
  const registry = new Map(checks.map((check) => [check.id, check.text]));
  // Built features closed these; obligations may still cite them, but they need no new owner.
  const known = new Map([...closedChecks.map((check) => [check.id, check.text]), ...registry]);
  if (!registry.size) throw new Error("Feature planning requires at least one original requirement or acceptance scenario.");

  for (const item of raw.compatibility ?? []) {
    // The controller's own Node and npm run every gate; planners still list them as "blocked" despite the prompt.
    if (CONTROLLER_TOOLCHAIN_RE.test(item?.subject ?? "")) continue;
    if (item?.status !== "verified") throw new Error(`Unresolved compatibility: ${item?.subject ?? JSON.stringify(item)}. Resolve it read-only before planning work that depends on it.`);
  }

  const position = new Map();
  raw.slices.forEach((slice, index) => {
    if (!slice || typeof slice !== "object" || typeof slice.id !== "string" || !SLICE_ID_RE.test(slice.id)) throw new Error(`slices[${index}].id must match ${SLICE_ID_RE}.`);
    if (position.has(slice.id)) throw new Error(`Duplicate slice id: ${slice.id}.`);
    position.set(slice.id, index);
  });

  const owner = new Map();
  const behaviors = new Map();
  const obligationIds = new Set();
  const claimed = new Set();
  const slices = raw.slices.map((slice, index) => {
    const where = `Feature ${slice.id}`;
    if (!text(slice.title, 3) || !text(slice.objective, 3)) throw new Error(`${where} needs a title and an observable objective.`);
    if (!text(slice.demo, 8)) throw new Error(`${where} needs a demo concrete enough to act on.`);
    const dependsOn = slice.dependsOn ?? [];
    if (!Array.isArray(dependsOn)) throw new Error(`${where} has a malformed dependsOn.`);
    for (const dep of dependsOn) {
      if (!position.has(dep)) throw new Error(`${where} depends on unknown slice ${dep}.`);
      if (position.get(dep) >= index) throw new Error(`${where} depends on ${dep}, which is not an earlier slice.`);
    }
    if (!Array.isArray(slice.closes)) throw new Error(`${where} needs a closes array (empty only for a named prerequisite).`);
    for (const id of slice.closes) {
      if (!registry.has(id)) throw new Error(`${where} closes unknown check ${id}.`);
      if (owner.has(id)) throw new Error(`${id} has two closing owners: ${owner.get(id)} and ${slice.id}.`);
      owner.set(id, slice.id);
    }
    if (!Array.isArray(slice.acceptance) || slice.acceptance.length === 0) throw new Error(`${where} needs at least one acceptance obligation.`);
    const acceptance = slice.acceptance.map((item) => {
      if (!item || typeof item.id !== "string" || !SLICE_ID_RE.test(item.id) || obligationIds.has(item.id)) throw new Error(`${where} has a missing or duplicate obligation id.`);
      obligationIds.add(item.id);
      if (!text(item.behavior, 12)) throw new Error(`Obligation ${item.id} needs a concrete expected behavior.`);
      const key = item.behavior.trim().toLowerCase();
      if (behaviors.has(key)) throw new Error(`Features ${behaviors.get(key)} and ${slice.id} share the behavior "${item.behavior.slice(0, 90)}". Merge or redraw the boundary.`);
      behaviors.set(key, slice.id);
      if (!Array.isArray(item.refs) || item.refs.some((ref) => !known.has(ref))) throw new Error(`Obligation ${item.id} references unknown original checks.`);
      const command = item.proof?.command;
      try { assertAllowedCommand(command); if (command.length < 2) throw new Error("needs arguments"); }
      catch (error) { throw new Error(`Obligation ${item.id} needs an executable proof command as an npm/node/npx argument array (${error.message})`); }
      if (!text(item.proof.expect, 3)) throw new Error(`Obligation ${item.id} needs an expected proof result.`);
      if (item.proof.pending !== undefined && item.proof.pending !== "integration") throw new Error(`Obligation ${item.id} proof.pending may only be "integration".`);
      if (sources && (!Array.isArray(item.sources) || !item.sources.length || item.sources.some((ref) => !sources.includes(ref?.path) || !text(ref.locator, 2)))) {
        throw new Error(`Obligation ${item.id} needs sources [{path, locator}] citing the authoritative input it implements (one of ${sources.join(", ")}).`);
      }
      const cases = item.cases === undefined ? null : validateCases(item, { registry, sources, ids: obligationIds, claimed });
      return { id: item.id, behavior: item.behavior.trim(), refs: [...item.refs], proof: { command: [...command], expect: item.proof.expect.trim(), ...(item.proof.pending ? { pending: "integration" } : {}) },
        ...(sources ? { sources: item.sources.map(normalSource) } : {}), ...(cases ? { cases } : {}) };
    });
    for (const id of slice.closes) {
      if (!acceptance.some((item) => item.refs.includes(id))) throw new Error(`${where} closes ${id} but no obligation in it proves ${id}.`);
    }
    if (acceptance.every((item) => item.proof.pending)) throw new Error(`${where} needs at least one obligation provable when the feature is built; only part of its proof may wait for integration.`);
    const writes = slice.writes === undefined ? null : validateWrites(slice, dependsOn);
    return { id: slice.id, title: slice.title.trim(), objective: slice.objective.trim(), demo: slice.demo.trim(), dependsOn: [...dependsOn], closes: [...slice.closes], acceptance, ...(writes ? { writes } : {}) };
  });
  assertDisjointWrites(slices);
  if (ownership) assertProofOwnership(slices);

  // A case may retire an obligation of an earlier feature (a stage gate that stops being true once this
  // feature exists). Ids outside this plan are a replacement plan's base obligations, judged by assertConsolidation.
  const featureOf = new Map(slices.flatMap((slice, index) => slice.acceptance.map((item) => [item.id, index])));
  slices.forEach((slice, index) => {
    for (const item of slice.acceptance) for (const entry of item.cases ?? []) for (const id of entry.supersedes ?? []) {
      if (featureOf.has(id) && featureOf.get(id) >= index) throw new Error(`${id} is kept and also superseded by case ${entry.id}; a case may supersede only an earlier feature's obligation.`);
    }
  });

  const missing = [...registry.keys()].filter((id) => !owner.has(id));
  if (missing.length) throw new Error(`Feature plan has no closing owner for ${missing.map((id) => `${id} (${registry.get(id).slice(0, 80)})`).join(", ")}.`);

  // A prerequisite must feed a later closing feature, directly or transitively.
  const feedsCloser = new Set();
  for (let index = slices.length - 1; index >= 0; index -= 1) {
    const slice = slices[index];
    if (slice.closes.length || feedsCloser.has(slice.id)) slice.dependsOn.forEach((dep) => feedsCloser.add(dep));
  }
  for (const slice of slices) {
    if (!slice.closes.length && !feedsCloser.has(slice.id)) throw new Error(`Feature ${slice.id} is an orphan prerequisite: no later feature that closes a check depends on it.`);
  }

  return { version: 2, jobId, contractDigest, compatibility: [...(raw.compatibility ?? [])], slices };
}

// ---------------------------------------------------------------------------
// Declared writes: each feature lists the paths or globs it may change, so the controller can enforce
// ownership after every turn and later rerun only the proofs a change can reach. Optional per feature:
// plans from before 2026-10-12 have none, and a feature without a list is not enforced.

// Files every feature builds on. Only a foundation feature (one with no dependsOn) may own them.
export const SHARED_FILES = ["package.json", "factory.json"];
// Changed by the controller, npm or the last feature's README pass, never owned by one feature.
const ALWAYS_WRITABLE = [".factory/**", "package-lock.json", "README.md", ".gitignore"];
const GLOB_RE = /[*?[\]{}]/;
const dirOf = (pattern) => pattern.replace(/\/+$/, "") + "/";
// The literal directory a pattern stays inside: "src/routes/*.js" → "src/routes/", "**/x" → "".
const stem = (pattern) => { const head = pattern.split(GLOB_RE)[0]; return head.slice(0, head.lastIndexOf("/") + 1); };

// A literal entry covers itself and, as a directory, everything under it.
export const writesCover = (patterns, file) => patterns.some((pattern) => matchesGlob(file, pattern) || (!GLOB_RE.test(pattern) && (file === pattern || file.startsWith(dirOf(pattern)))));
export const outsideWrites = (files, writes) => files.filter((file) => !writesCover([...writes, ...ALWAYS_WRITABLE], file));

// Built features a change can break: those whose own or dependencies' writes cover a changed file.
// null when any built feature has no writes list (an older plan), so callers keep their old scope.
// ponytail: assumes a feature reads only its own and its dependencies' files; a declared reads list is the upgrade.
export function impactedFeatures(slices, done, changed) {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const built = done.map((id) => byId.get(id)).filter(Boolean);
  if (built.some((slice) => !slice.writes)) return null;
  const reach = (slice) => [slice, ...slice.dependsOn.flatMap((id) => reach(byId.get(id)))];
  return built.filter((slice) => changed.some((file) => reach(slice).some((owner) => writesCover(owner.writes, file)))).map((slice) => slice.id);
}

// ponytail: two globs overlap when one's literal directory contains the other's, so "src/*.js" and
// "src/*.css" count as overlapping. Exact glob intersection if planners hit false rejections.
function overlaps(a, b) {
  const literalA = !GLOB_RE.test(a);
  const literalB = !GLOB_RE.test(b);
  if (literalA && literalB) return writesCover([a], b) || writesCover([b], a);
  if (literalB) return writesCover([a], b) || stem(a).startsWith(dirOf(b));
  if (literalA) return writesCover([b], a) || stem(b).startsWith(dirOf(a));
  return stem(a).startsWith(stem(b)) || stem(b).startsWith(stem(a));
}

function validateWrites(slice, dependsOn) {
  const where = `Feature ${slice.id}`;
  if (!Array.isArray(slice.writes) || !slice.writes.length || slice.writes.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`${where} has a malformed writes list; list the paths or globs it creates or edits.`);
  const writes = slice.writes.map((entry) => entry.trim().replace(/^\.\//, ""));
  const bad = writes.find((entry) => entry.startsWith("/") || entry.split("/").includes(".."));
  if (bad) throw new Error(`${where} writes ${bad}, which is outside the app; use paths relative to the app folder.`);
  const shared = dependsOn.length ? SHARED_FILES.filter((file) => writesCover(writes, file)) : [];
  if (shared.length) throw new Error(`${where} depends on other features but writes ${shared.join(", ")}. Shared files belong to a foundation feature (one with no dependsOn).`);
  return writes;
}

// A later feature that edits an earlier feature's code reruns that feature's proofs, but its repairs may only change
// its own writes. Without the earlier proof tests in those writes, a deliberate change (a renamed selector) leaves a
// failing proof nobody may fix: run 2026-10-07-4f2dd1cf lost drafts #10 and #11 to PEOPLE-LINKS this way.
// Overlap implies a dependency path, since assertDisjointWrites already rejected overlapping independent features.
// ponytail: a feature's proof tests are proof-command file arguments inside its own writes; a test it doesn't declare
// (or one under the same glob as its code) is skipped here and left to the plan reviewer.
function assertProofOwnership(slices) {
  const problems = [];
  slices.forEach((a, index) => {
    if (!a.writes) return;
    const tests = [...new Set(a.acceptance.flatMap((item) => item.proof.command.slice(1).map((arg) => arg.replace(/^\.\//, ""))).filter((arg) => !arg.startsWith("-") && /\.\w+$/.test(arg) && writesCover(a.writes, arg)))];
    const code = a.writes.filter((entry) => !tests.some((file) => writesCover([entry], file)));
    if (!tests.length || !code.length) return;
    for (const b of slices.slice(index + 1)) {
      if (!b.writes) continue;
      const shared = code.filter((x) => b.writes.some((y) => overlaps(x, y)));
      const missing = tests.filter((file) => !writesCover(b.writes, file));
      if (shared.length && missing.length) problems.push(`${b.id} edits ${shared.join(", ")} of ${a.id} without ${missing.join(", ")}`);
    }
  });
  if (problems.length) throw new Error(`A feature that edits an earlier feature's files reruns its proofs and must be able to update them: ${problems.join("; ")}. Add those proof tests to the later feature's writes, or move the shared edit into the earlier feature.`);
}

// Features with no dependency path between them may be built in either order, so they must not share files.
function assertDisjointWrites(slices) {
  const before = new Map();
  for (const slice of slices) before.set(slice.id, new Set(slice.dependsOn.flatMap((dep) => [dep, ...before.get(dep)])));
  const problems = [];
  slices.forEach((a, index) => {
    for (const b of slices.slice(index + 1)) {
      if (!a.writes || !b.writes || before.get(b.id).has(a.id)) continue;
      const pair = a.writes.flatMap((x) => b.writes.filter((y) => overlaps(x, y)).map((y) => x === y ? x : `${x} / ${y}`));
      if (pair.length) problems.push(`${a.id} and ${b.id} both write ${pair.join(", ")}`);
    }
  });
  if (problems.length) throw new Error(`Features with no dependency between them must write different files: ${problems.join("; ")}. Split the files, or add the dependsOn the work really needs.`);
}
