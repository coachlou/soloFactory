// What a release changed in risky ways (spec item 4). Informational only: it never holds or asks.
// ponytail: two kinds; a blocking ask waits until 10 real runs show the findings are worth acting on.

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SECTIONS = ["dependencies", "devDependencies"];

const parse = (text) => {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
};

// nameStatus: `git diff --name-status -M` output. packageJson: the root package.json text before and after.
export function releaseRisks(nameStatus, { before = null, after = null } = {}) {
  const risks = [];
  for (const line of String(nameStatus ?? "").split("\n")) {
    const [status, file] = line.split("\t");
    // Renames are R<score>\told\tnew: the file moved, nothing was lost.
    if (status !== "D" || !file || file.startsWith(".factory/") || TEST_PATH.test(file)) continue;
    risks.push({ kind: "deletion", file, why: `Deleted ${file}` });
  }
  const old = parse(before), now = parse(after);
  if (old && now) for (const section of SECTIONS) {
    const a = old[section] ?? {}, b = now[section] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const why = !(name in a) ? `Added ${name} ${b[name]}`
        : !(name in b) ? `Removed ${name}`
          : a[name] !== b[name] ? `Changed ${name} from ${a[name]} to ${b[name]}` : null;
      if (why) risks.push({ kind: "dependency", file: "package.json", why: section === "devDependencies" ? `${why} (dev)` : why });
    }
  }
  return risks;
}

const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One line for the completed card. null means the run predates the scan.
export function riskLine(risks) {
  if (!Array.isArray(risks)) return null;
  if (!risks.length) return "No package changes or deleted files.";
  const deps = risks.filter((risk) => risk.kind === "dependency");
  const parts = [
    [deps.filter((risk) => risk.why.startsWith("Added")).length, "added", "package"],
    [deps.filter((risk) => risk.why.startsWith("Removed")).length, "removed", "package"],
    [deps.filter((risk) => risk.why.startsWith("Changed")).length, "changed", "package version"],
    [risks.filter((risk) => risk.kind === "deletion").length, "deleted", "file"],
  ].filter(([n]) => n).map(([n, verb, word]) => `${verb} ${count(n, word)}`);
  const line = parts.join(", ");
  return `${line[0].toUpperCase()}${line.slice(1)}.`;
}
