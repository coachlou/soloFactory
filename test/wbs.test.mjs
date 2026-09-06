import test from "node:test";
import assert from "node:assert/strict";
import { nextExecutable, orderSlices, validateSlicePlan } from "../src/wbs.mjs";

const validPlan = {
  slices: [
    {
      id: "SLICE-SKELETON",
      title: "Walking skeleton",
      objective: "A health-checked server with metrics and a build.",
      acceptance: ["GET /health answers ok", "Metrics stay aggregate-only"],
    },
    {
      id: "SLICE-UI",
      title: "Recording UI",
      objective: "A page to record one score a day.",
      acceptance: ["The page lets the owner record a score"],
      dependsOn: ["SLICE-SKELETON"],
    },
    {
      id: "SLICE-TREND",
      title: "Seven-day trend",
      objective: "Show the seven-day average.",
      acceptance: ["The trend shows the seven-day average"],
      dependsOn: ["SLICE-UI"],
    },
  ],
};

test("a valid plan normalizes, keeps declared order, and answers next", () => {
  const normalized = validateSlicePlan(validPlan);
  assert.equal(normalized.slices.length, 3);
  assert.deepEqual(orderSlices(validPlan).map((slice) => slice.id), ["SLICE-SKELETON", "SLICE-UI", "SLICE-TREND"]);
  assert.equal(nextExecutable([], validPlan).id, "SLICE-SKELETON");
  assert.equal(nextExecutable(["SLICE-SKELETON"], validPlan).id, "SLICE-UI");
  assert.equal(nextExecutable(["SLICE-SKELETON", "SLICE-UI"], validPlan).id, "SLICE-TREND");
  assert.equal(nextExecutable(["SLICE-SKELETON", "SLICE-UI", "SLICE-TREND"], validPlan), null);
});

test("validation does not mutate the input plan", () => {
  const before = JSON.stringify(validPlan);
  validateSlicePlan(validPlan);
  assert.equal(JSON.stringify(validPlan), before);
  assert.notEqual(validPlan.slices, validateSlicePlan(validPlan).slices);
});

test("missing dependsOn defaults to an empty array", () => {
  const plan = { slices: [{ id: "A", title: "t", objective: "o", acceptance: ["okay"], }] };
  const normalized = validateSlicePlan(plan);
  assert.deepEqual(normalized.slices[0].dependsOn, []);
});

test("rejects structural violations", () => {
  const cases = [
    [{}, /slices array/],
    [{ slices: [] }, /at least one slice/],
    [{ slices: "nope" }, /slices array/],
    [{ slices: [null] }, /is not an object/],
    [{ slices: [{ id: "a", title: "t", objective: "o", acceptance: ["okay"] }] }, /SCREAMING_SNAKE|must match/],
    [{ slices: [{ id: "A", title: "  ", objective: "o", acceptance: ["okay"] }] }, /title/],
    [{ slices: [{ id: "A", title: "t", objective: "", acceptance: ["okay"] }] }, /objective/],
    [{ slices: [{ id: "A", title: "t", objective: "o", acceptance: [] }] }, /acceptance/],
    [{ slices: [{ id: "A", title: "t", objective: "o", acceptance: ["x"] }] }, /acceptance/],
  ];
  for (const [plan, pattern] of cases) {
    assert.throws(() => validateSlicePlan(plan), pattern, JSON.stringify(plan));
  }
});

test("rejects duplicate ids", () => {
  const plan = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["one"] },
      { id: "A", title: "t2", objective: "o2", acceptance: ["two"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan), /Duplicate slice id: A/);
});

test("rejects dependency violations", () => {
  const missing = { slices: [{ id: "A", title: "t", objective: "o", acceptance: ["okay"], dependsOn: ["GHOST"] }] };
  assert.throws(() => validateSlicePlan(missing), /unknown slice GHOST/);

  const forward = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"] },
      { id: "C", title: "t3", objective: "o3", acceptance: ["ok3"], dependsOn: ["B"] },
    ],
  };
  // B is before C, so this is legal.
  assert.doesNotThrow(() => validateSlicePlan(forward));
  const selfLater = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"], dependsOn: ["C"] },
      { id: "C", title: "t3", objective: "o3", acceptance: ["ok3"] },
    ],
  };
  assert.throws(() => validateSlicePlan(selfLater), /not an earlier slice/);

  const skeletonDep = {
    slices: [
      { id: "A", title: "t", objective: "o", acceptance: ["okay"], dependsOn: ["B"] },
      { id: "B", title: "t2", objective: "o2", acceptance: ["ok2"] },
    ],
  };
  assert.throws(() => validateSlicePlan(skeletonDep), /not an earlier slice|walking skeleton/);
});

test("scenario coverage requires every frozen scenario to be tagged", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["[SC-1] One scenario lands"], demo: "Observe one scenario working end to end." },
      { id: "SLICE-B", title: "t2", objective: "o2", acceptance: ["[SC-2] Second scenario lands"], demo: "Observe the second scenario working." },
    ],
  };
  assert.doesNotThrow(() => validateSlicePlan(plan, { scenarioCount: 2 }));
  const normalized = validateSlicePlan(plan, { scenarioCount: 2 });
  assert.equal(normalized.slices[0].demo, "Observe one scenario working end to end.");
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 3 }), /SC-3/);
});

test("scenario coverage names every missing scenario", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["[SC-2] Only the second scenario"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 3 }), /SC-1, SC-3/);
  assert.throws(() => validateSlicePlan(plan, { scenarioCount: 1 }), /SC-1/);
});

test("a demo that is too thin is rejected and an absent demo is fine", () => {
  const thin = { slices: [{ id: "SLICE-A", title: "t", objective: "o", acceptance: ["okay"], demo: "ok" }] };
  assert.throws(() => validateSlicePlan(thin), /demo/);
  const none = { slices: [{ id: "SLICE-A", title: "t", objective: "o", acceptance: ["okay"] }] };
  assert.doesNotThrow(() => validateSlicePlan(none));
});

test("a criterion shared between slices is rejected as re-implementation", () => {
  const plan = {
    slices: [
      { id: "SLICE-A", title: "t", objective: "o", acceptance: ["The page saves a score"] },
      { id: "SLICE-B", title: "t2", objective: "o2", acceptance: ["the page saves a score"] },
    ],
  };
  assert.throws(() => validateSlicePlan(plan), /share the same acceptance criterion/);
});
