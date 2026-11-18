// SoloFactory supports the two LTS lines: Node 26 (Active LTS, recommended) and Node 24 (Maintenance LTS
// to 2028-04-30). .nvmrc and .node-version name the recommended one; package.json engines and the CI
// matrix name both. One rule for every check: distro/install.d/post.sh (install and Update now),
// distro/run.sh and the server (startup, the page). Below 22 cannot run the app; any other major runs,
// with a warning, because it is untested and odd majors are short-lived. Never a hard stop on a
// runnable major: an owner's projects keep working while they switch.
export const SUPPORTED_NODE_MAJORS = [24, 26];
export const RECOMMENDED_NODE_MAJOR = 26;
export const MINIMUM_NODE_MAJOR = 22;

export function nodeVersionStatus(version = process.version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]) || 0;
  const fix = `Install Node ${RECOMMENDED_NODE_MAJOR} LTS (or ${SUPPORTED_NODE_MAJORS[0]} LTS) as INSTALL.md A4 on a Mac or B3 on Ubuntu or WSL says, open a fresh terminal window, then start SoloFactory again. Your projects are not changed.`;
  if (SUPPORTED_NODE_MAJORS.includes(major)) return { version, major, supported: true, problem: null };
  if (major < MINIMUM_NODE_MAJOR) return { version, major, supported: false, problem: `Node ${version} is too old to run SoloFactory. ${fix}` };
  return { version, major, supported: false, problem: `SoloFactory is running on Node ${version}, which it does not support. It supports Node 24 and 26 LTS. Builds can fail on other versions. ${fix}` };
}
