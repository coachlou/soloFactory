// Update notice: compares the installed version with package.json on the public dev repo's main,
// which only moves at release commits. Never updates anything; the owner pastes the prompt.
export const LATEST_URL = "https://raw.githubusercontent.com/coachlou/soloFactory/main/package.json";
const CACHE_MS = 10 * 60_000; // a page reload within this window reuses the last answer

// Release versions only: a prerelease or anything malformed never counts as newer.
function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewer(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function updatePrompt(latest) {
  return `Please update my existing SoloFactory install to version ${latest}. Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md

If \`gh\` isn't found, you're on the Windows side: run the same command inside Ubuntu with \`wsl -e\` in front of it. When it's done, tell me which version it reports.`;
}

// One checker per server process. check() never throws: an error answer is { error: true }.
export function createUpdateChecker({ current, fetch = globalThis.fetch, url = LATEST_URL, timeoutMs = 3000, now = Date.now }) {
  let last = null; // { at, result }
  let pending = null;
  async function fetchLatest() {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { version } = await response.json();
    if (!parse(version)) throw new Error("No release version in package.json");
    return version;
  }
  return async function check({ force = false } = {}) {
    if (!force && last && now() - last.at < CACHE_MS) return last.result;
    pending ??= fetchLatest()
      .then((latest) => ({ current, latest, newer: isNewer(latest, current), prompt: isNewer(latest, current) ? updatePrompt(latest) : null }))
      .catch(() => ({ current, error: true }))
      .then((result) => {
        result.checkedAt = new Date(now()).toISOString();
        // An error is not cached, so the next reload tries again.
        last = result.error ? null : { at: now(), result };
        pending = null;
        return result;
      });
    return pending;
  };
}
