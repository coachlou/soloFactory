# GitHub backup for generated apps

Status: spec for Lou's review. Not implemented. Grounded in `main` at 56b9602 (PR 13, release tags).
Origin: project chat, 2026-11-18. Decisions below are Lou's from that chat.

---

## Problem
A generated app lives in one git repo on the owner's Mac (`JobStore`, `src/store.mjs:39`). Each good
release is committed and tagged `solofactory/release/<n>` (`tagRelease`, `src/factory.mjs:1279`). If the
disk dies or the folder is lost, every release goes with it. There is no copy anywhere else.

## Decisions (Lou, 2026-11-18)
1. A plain backup only. After each good, tagged release, push `main` and the tags to a private GitHub repo.
   No CI, workflows, pull requests or deploys on GitHub.
2. Off until the owner turns it on, per project.
3. The GitHub account and the repo are chosen per project.
4. `gh` sign-in is fine in development, but the feature must not ship in a release until GitHub
   device-flow sign-in is in place (see Release gate).

## What is pushed, and what is not
- Pushed: the `main` branch, every `solofactory/release/<n>` tag, and every `solofactory/rolled-back/<runId>`
  tag (so rolled-back work stays recoverable off the Mac too).
- Not pushed, because they are gitignored (`src/store.mjs:52`): `data/` (the owner's app data),
  `.solofactory/` (run evidence and this feature's own config), `.factory/logs/`, `.aai/memory/`.
- `data/` is the owner's real content and it is **not** backed up by this feature. Settings says so in one
  plain line: "Your app's data (the data folder) is not in git, so this does not back it up."

## Setup, once per project
1. Settings shows a "Backup to GitHub" section for the open project, next to the project's profile.
   State: "Off. Not connected."
2. **Connect** picks the GitHub account (see Auth). With more than one signed-in account, the owner picks one.
3. Then the owner picks the repo:
   - **Create a new private repo** (default), named after the project folder (`jev-nugget-mining`), under the
     chosen account. A name already taken there gets a `-backup` suffix, then `-backup-2`, and so on.
   - **Use an existing repo**: a list of that account's repos. Only private, empty-or-ours repos are offered
     (see Privacy and Safety).
4. On creation SoloFactory also turns GitHub Actions off for that repo
   (`PUT /repos/{owner}/{repo}/actions/permissions`, `enabled: false`). So even if a build ever writes a
   file under `.github/workflows/`, nothing runs on GitHub.
5. SoloFactory adds a git remote named `solofactory-backup`, never `origin`, so an app the owner adopted
   with its own `origin` keeps it untouched.
6. Connecting does not turn backup on. The section then reads "Connected to owner/repo. Off." with an
   on/off switch. Turning it on runs a first push of `main` and all existing tags at once.

## Every release after that
1. After `tagRelease` succeeds and the run is `completed`, and only when backup is on, push in the
   background. The deploy never waits for it.
2. Command: `git push solofactory-backup main --follow-tags` plus an explicit push of any local
   `solofactory/*` tags the remote lacks. Tags are never force-pushed and never deleted on GitHub.
3. `main` is pushed with `--force-with-lease`. A rollback (`JobStore.reset`) moves local `main` back, so
   the next release is not a fast-forward of what GitHub has. The Mac is the source of truth; the lease
   refuses the push only if GitHub's `main` changed since SoloFactory last pushed it (someone pushed there by
   hand). Older commits are never lost: each one is held by its release or rolled-back tag.
4. **Back up now** in Settings runs the same push on demand.
5. A rollback itself does not push. The next release, or Back up now, carries the rolled-back tag.
6. Events on the run: `backup.pushed` (repo, release number, commit) and `backup.failed` (reason).

## Auth: options and recommendation
| Option | How | For | Against |
|---|---|---|---|
| A. `gh` CLI (dev first) | Use the accounts `gh auth status` already lists. At push time, get the token with `gh auth token --hostname github.com --user <login>` and hand it to git for that one command. | `gh` is already the online install and update path, so most owners are signed in. Handles several accounts. SoloFactory stores no secret. | Needs `gh` installed. Its token scopes must include `repo` (the `gh` default does). |
| B. Fine-grained token pasted in Settings | Owner makes a token limited to one repo with Contents read/write. Stored in the macOS Keychain (`security add-generic-password`, service `solofactory-backup`, account = project id). | Works without `gh`. Narrowest scope. | Can't create a repo (fine-grained tokens limited to one repo cannot), so the owner creates it first. Tokens expire; the push then fails with a clear amber line. |
| **C. OAuth device flow** (required to ship) | SoloFactory shows a code; owner approves on github.com. | Works for members without `gh`. | Needs a registered GitHub OAuth app owned by Lou, its client id shipped in the distro, and token storage like B. More to build and maintain. |

Decision (Lou, 2026-11-18): A may be built first for development, but it **must not ship in a release**.
Members won't have `gh`, so C (device flow) is required before release. B stays as a fallback.

### Release gate
1. Until device-flow sign-in (C) lands, the whole feature sits behind a dev-only flag,
   `SOLOFACTORY_DEV_GITHUB_BACKUP=1`. With the flag unset, the Settings section, the Live app line and the
   `/api/projects/backup*` routes do not exist, and no push ever runs.
2. The flag is read only from the environment, never from `profiles.json` or the UI, and is not listed in the
   Settings table.
3. The release steps (DEVELOPING.md) gain a check: a release that ships this feature must have C done and
   tested, and the flag removed. Until then the release checklist confirms the flag defaults off.
4. C needs a GitHub OAuth app registered by Lou, with device flow on and the `repo` scope. Its client id
   ships in the distro (a client id is public, not a secret). Tokens are stored as in B (Keychain).
5. With C in place, Connect offers device flow first and uses `gh` silently when it is already signed in.

### Where credentials live
- Never in the project repo, never in `backup.json`, never in a remote URL, never in run events or logs.
- A: nowhere new; `gh` keeps its own. B: the macOS Keychain only.
- The token reaches git through a one-shot credential helper on that push only
  (`git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo password=$TOKEN; }; f'`,
  with `TOKEN` in the child's environment), so it is never written to `.git/config`.
- Event messages pass through the existing `CREDENTIAL_PATTERNS` scrub (`src/credentials.mjs`) before they
  are stored.

### Where the per-project settings live
`<project>/.solofactory/backup.json`, server side and gitignored:
`{ enabled, account, auth: "gh" | "token", owner, repo, createdBySolofactory, lastPush: { at, commit, release, ok, reason } }`.
It is not in the browser (unlike the profile pick), because pushes run in the server after a release.

## Privacy and safety
1. Always private. A new repo is created private. **Use an existing repo** lists private repos only.
2. Before each push, SoloFactory reads the repo's visibility (`GET /repos/{owner}/{repo}`). If it is no
   longer private, the push is skipped, backup stays on but paused, and the amber line says
   "Backup paused: owner/repo is now public. Make it private, then press Back up now."
3. An existing repo is accepted only when it is empty, or its `main` already holds commits from this project
   (it was this project's backup before). A repo with unrelated history is refused, so SoloFactory never
   overwrites someone's other work with `--force-with-lease`.
4. A secrets check runs before each push: the commits since the last pushed one are scanned with
   `CREDENTIAL_PATTERNS`. The build's secrets gate (`src/factory.mjs:1582`) should already have stopped a key;
   this is a second net, because a backup can't be taken back once pushed. A hit blocks the push and names the
   file in the amber line.
5. SoloFactory never deletes a GitHub repo. Disconnect removes only the local remote and `backup.json`.

## Failure handling
1. A failed backup never fails or rolls back a deploy. The release still counts.
2. Causes named plainly: not signed in, token expired, repo missing, repo public, no network, lease refused,
   secret found.
3. The Live app panel shows one amber line: "Backup failed: <reason>. Retry". Retry runs the push now.
4. No automatic retry loop. The next release pushes everything missed since the last good push.
5. Per Lou's rule on reporting problems at once: the failure is an event on the run and the amber line the
   moment it happens. It is never only in a log.

## What the owner sees
Follows Lou's UI rules: neutral gray, hierarchy by weight and size, amber only for a failure or pause, and
any value not yet editable shown as plain text.
- **Live app panel**, one gray line when on: "Backed up to GitHub · release 4 · 2 min ago", the repo name as a
  link. Nothing at all when backup is off.
- **Settings, Backup to GitHub** (open project):
  - Account and repo, as plain text with the repo as a link.
  - On/off switch, **Back up now**, **Disconnect**.
  - Last backup: time, release number, or the amber reason.
  - The plain `data/` line from above.

## Upgrade safety for existing projects
1. No `backup.json` means off. An upgraded install changes nothing in any project until the owner connects.
2. No remote is added, and `origin` is never read or changed, until Connect.
3. The first push after turning it on sends `main` and every existing tag, so earlier releases are backed up too.
4. Projects from before release tags (no `solofactory/release/*` tags) push `main` only, then tags from the
   next release on.

## API
`GET /api/projects/backup` (state for the open project), `POST /api/projects/backup/connect`
(account, create-or-pick), `PUT /api/projects/backup` (`enabled`), `POST /api/projects/backup/push`
(Back up now and Retry), `DELETE /api/projects/backup` (Disconnect).

## Not in scope
CI or any GitHub workflow. Backing up `data/`. Restoring a project from GitHub in the UI (a clone by hand
works: the tags hold every release). GitHub Enterprise hosts. More than one backup remote per project.

## Checks (offline, `test/github-backup.test.mjs`)
A local bare repo stands in for GitHub; the GitHub API calls go through a stub.
- With `SOLOFACTORY_DEV_GITHUB_BACKUP` unset, the backup routes answer 404, Settings has no backup section, and a release pushes nothing.
- With no `backup.json`, a release pushes nothing and adds no remote.
- Connected but off: a release pushes nothing.
- On: a release pushes `main` and the new release tag; the panel line names the release.
- Turning on in a project with three releases pushes all three tags.
- After a rollback, the next release pushes `main` with lease, and the rolled-back tag is on the remote.
- A remote `main` changed by hand: the lease refuses, `backup.failed` says so, the deploy is still `completed`.
- A repo stub reporting public: the push is skipped with the paused line.
- A commit holding a key-shaped string: the push is blocked, the file is named.
- A failed push leaves the run `completed`, and the next release pushes both releases.
- The token never appears in `.git/config`, `backup.json` or any event.
- An existing `origin` is unchanged after Connect, push and Disconnect.

## Docs
README (Operational boundaries: what is and isn't backed up), SPEC (release section), manual Live app and
Settings sections, INSTALL note that `gh` sign-in enables backup, changelog and PROGRESS entry.

## Open questions for Lou
Answered: auth order (Lou, 2026-11-18): `gh` first in development only; device flow before any release.

1. When the owner picks an existing repo that has Actions on, should SoloFactory turn Actions off there
   too, or only warn? (Proposed: ask once with a plain yes/no.)
2. Repo name: the project folder name, or the app's working name from the brief?
3. Should Settings also offer a simple local copy of `data/` (a zip next to the project), since this
   backup leaves it out? That would be a separate brief.
