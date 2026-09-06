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
