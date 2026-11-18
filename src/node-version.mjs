// SoloFactory is pinned to Node 24 LTS (.nvmrc, package.json engines, CI). One rule for every check:
// distro/install.d/post.sh (install and Update now), distro/run.sh and the server (startup, the page).
// Below 22 cannot run the app; 22, 23 and 25+ run, with a warning, because a build on them can fail
// (newer majors lack prebuilt files for some packages the factory builds with). Never a hard stop
// on a supported-but-wrong major: an owner's projects keep working while they switch.
export const SUPPORTED_NODE_MAJOR = 24;
export const MINIMUM_NODE_MAJOR = 22;

export function nodeVersionStatus(version = process.version) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]) || 0;
  const fix = `Install Node ${SUPPORTED_NODE_MAJOR} LTS (INSTALL.md A4 on a Mac, B3 on Ubuntu or WSL), open a fresh terminal window, then start SoloFactory again. Your projects are not changed.`;
  if (major === SUPPORTED_NODE_MAJOR) return { version, major, supported: true, problem: null };
  if (major < MINIMUM_NODE_MAJOR) return { version, major, supported: false, problem: `Node ${version} is too old to run SoloFactory. ${fix}` };
  const side = major > SUPPORTED_NODE_MAJOR ? "newer" : "older";
  return { version, major, supported: false, problem: `SoloFactory is running on Node ${version}, which is ${side} than the supported Node ${SUPPORTED_NODE_MAJOR} LTS. Builds can fail on it. ${fix}` };
}
