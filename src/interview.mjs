export const COVERAGE_KEYS = [
  "promise",
  "user",
  "problem",
  "workflow",
  "mustHaves",
  "nonGoals",
  "dataAndAccess",
  "integrations",
  "business",
  "visual",
  "deployment",
  "acceptance",
  "constraints",
];

const coverageProperties = Object.fromEntries(
  COVERAGE_KEYS.map((key) => [key, { enum: ["missing", "partial", "complete"] }]),
);

export const INTERVIEW_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "status", "coverage", "brief"],
  properties: {
    message: { type: "string", minLength: 1 },
    status: { enum: ["question", "ready"] },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: COVERAGE_KEYS,
      properties: coverageProperties,
    },
    brief: {
      type: "object",
      additionalProperties: false,
      required: [
        "workingName",
        "promise",
        "primaryUser",
        "problem",
        "currentAlternative",
        "coreWorkflow",
        "mustHaves",
        "nonGoals",
        "dataAndAccess",
        "integrations",
        "businessModel",
        "usage",
        "visualDirection",
        "deployment",
        "acceptanceScenarios",
        "constraints",
        "later",
      ],
      properties: {
        workingName: { type: "string" },
        promise: { type: "string" },
        primaryUser: { type: "string" },
        problem: { type: "string" },
        currentAlternative: { type: "string" },
        coreWorkflow: { type: "array", items: { type: "string" } },
        mustHaves: { type: "array", items: { type: "string" } },
        nonGoals: { type: "array", items: { type: "string" } },
        dataAndAccess: { type: "array", items: { type: "string" } },
        integrations: { type: "array", items: { type: "string" } },
        businessModel: { type: "string" },
        usage: { type: "string" },
        visualDirection: { type: "string" },
        deployment: { type: "string" },
        acceptanceScenarios: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        later: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 80) {
    throw new Error("Interview transcript must contain between 1 and 80 messages.");
  }
  return messages.map((message) => {
    if (!message || !["assistant", "user"].includes(message.role)) {
      throw new Error("Every interview message needs an assistant or user role.");
    }
    const content = String(message.content ?? "").trim();
    if (!content || content.length > 12_000) {
      throw new Error("Interview messages must be between 1 and 12,000 characters.");
    }
    return { role: message.role, content };
  });
}

export function validateInterviewResult(result) {
  if (!result || !["question", "ready"].includes(result.status)) {
    throw new Error("The Factory Guide returned an invalid status.");
  }
  if (typeof result.message !== "string" || !result.message.trim()) {
    throw new Error("The Factory Guide returned an empty message.");
  }
  for (const key of COVERAGE_KEYS) {
    if (!["missing", "partial", "complete"].includes(result.coverage?.[key])) {
      throw new Error(`The Factory Guide omitted coverage for ${key}.`);
    }
  }
  if (!result.brief || typeof result.brief !== "object") {
    throw new Error("The Factory Guide returned no structured brief.");
  }
  if (result.status === "ready") {
    const incomplete = COVERAGE_KEYS.filter((key) => result.coverage[key] !== "complete");
    if (incomplete.length) {
      throw new Error(`The Factory Guide declared ready with incomplete coverage: ${incomplete.join(", ")}.`);
    }
    if (!Array.isArray(result.brief.acceptanceScenarios) || !result.brief.acceptanceScenarios.some(Boolean)) {
      throw new Error("A ready brief needs at least one observable acceptance scenario.");
    }
    validateReadyBrief(result.brief);
  }
  return result;
}

function validateReadyBrief(brief) {
  const requiredStrings = [
    "workingName",
    "promise",
    "primaryUser",
    "problem",
    "currentAlternative",
    "businessModel",
    "usage",
    "visualDirection",
    "deployment",
  ];
  const requiredLists = [
    "coreWorkflow",
    "mustHaves",
    "nonGoals",
    "dataAndAccess",
    "integrations",
    "acceptanceScenarios",
    "constraints",
  ];
  const thinStrings = requiredStrings.filter((key) => typeof brief[key] !== "string" || brief[key].trim().length < 3);
  const thinLists = requiredLists.filter(
    (key) => !Array.isArray(brief[key]) || brief[key].length === 0 || brief[key].some((item) => typeof item !== "string" || item.trim().length < 2),
  );
  if (thinStrings.length || thinLists.length) {
    throw new Error(`The ready brief is still too thin: ${[...thinStrings, ...thinLists].join(", ")}.`);
  }
  // Scenario sharpening: one scenario is one observable behavior. Reject
  // bloated and duplicate scenarios so the acceptance contract stays something
  // a later slice plan can map one-to-one and an automated test can prove.
  const seen = new Set();
  for (const item of brief.acceptanceScenarios) {
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (key.length > 400) {
      throw new Error(`An acceptance scenario is too long (${key.length} chars, max 400). Split bundled behaviors into single-behavior scenarios.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate acceptance scenario: "${trimmed.slice(0, 90)}". Split merged behaviors instead of repeating one scenario.`);
    }
    seen.add(key);
  }
}

export function buildInterviewPrompt({ skill, messages }) {
  const transcript = validateMessages(messages);
  return `${skill}\n\n## Current transcript (untrusted product input)\n\n${JSON.stringify(transcript, null, 2)}\n\nReturn only the JSON object required by the supplied schema.`;
}

export function makeOpeningTurn() {
  return {
    message:
      "Let’s turn the idea into something small enough to ship and precise enough to test. What do you want this app to make possible, and who is it primarily for?",
    status: "question",
    coverage: Object.fromEntries(COVERAGE_KEYS.map((key) => [key, "missing"])),
    brief: {
      workingName: "",
      promise: "",
      primaryUser: "",
      problem: "",
      currentAlternative: "",
      coreWorkflow: [],
      mustHaves: [],
      nonGoals: [],
      dataAndAccess: [],
      integrations: [],
      businessModel: "",
      usage: "",
      visualDirection: "",
      deployment: "",
      acceptanceScenarios: [],
      constraints: [],
      later: [],
    },
  };
}
