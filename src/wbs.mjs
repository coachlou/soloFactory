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

const text = (value, min) => typeof value === "string" && value.trim().length >= min;

export function validateFeaturePlan(raw, { jobId, contractDigest, checks }) {
  if (!raw || typeof raw !== "object" || raw.version !== 2) throw new Error("slices.json must be a version 2 feature plan.");
  if (raw.jobId !== jobId || raw.contractDigest !== contractDigest) throw new Error("Feature plan does not match this run and its frozen contract.");
  if (!Array.isArray(raw.slices) || raw.slices.length === 0) throw new Error("slices.json must contain at least one feature.");
  if (raw.slices.length > MAX_FEATURES) throw new Error(`Feature plan has ${raw.slices.length} features; the limit is ${MAX_FEATURES}. Park and split the brief rather than merging or dropping scope.`);
  const registry = new Map(checks.map((check) => [check.id, check.text]));
  if (!registry.size) throw new Error("Feature planning requires at least one original requirement or acceptance scenario.");

  for (const item of raw.compatibility ?? []) {
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
      if (!Array.isArray(item.refs) || item.refs.some((ref) => !registry.has(ref))) throw new Error(`Obligation ${item.id} references unknown original checks.`);
      const command = item.proof?.command;
      try { assertAllowedCommand(command); if (command.length < 2) throw new Error("needs arguments"); }
      catch (error) { throw new Error(`Obligation ${item.id} needs an executable proof command as an npm/node/npx argument array (${error.message})`); }
      if (!text(item.proof.expect, 3)) throw new Error(`Obligation ${item.id} needs an expected proof result.`);
      return { id: item.id, behavior: item.behavior.trim(), refs: [...item.refs], proof: { command: [...command], expect: item.proof.expect.trim() } };
    });
    for (const id of slice.closes) {
      if (!acceptance.some((item) => item.refs.includes(id))) throw new Error(`${where} closes ${id} but no obligation in it proves ${id}.`);
    }
    return { id: slice.id, title: slice.title.trim(), objective: slice.objective.trim(), demo: slice.demo.trim(), dependsOn: [...dependsOn], closes: [...slice.closes], acceptance };
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
