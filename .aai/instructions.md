# SoloFactory: common instructions for every agent

The one source of rules for every agent in this repo: Claude Code, Codex and others. `CLAUDE.md` and
`AGENTS.md` hold only tool-specific notes and route here. Read DEVELOPING.md when a task needs the details.

## Git hooks

1. Run `npm run hooks` once in each clone or worktree you work in, before your first commit.
   It sets `core.hooksPath` to `scripts/hooks`.
2. Never use `--no-verify` on `git commit` or `git push`. If a hook fails, fix the cause.
   Only the owner may skip a hook, and only by doing it themselves.
3. `pre-commit` checks that every staged `.mjs` file parses. It takes seconds.
4. `pre-push` runs the full `npm test` on any push to main. It takes about 2 minutes.
   Give the push command a timeout of at least 5 minutes.
5. A push to main that changes the `version` in `package.json` is a release push. It needs Linux CI
   to have passed on that exact commit (`node scripts/ci-green.mjs <sha>`, which uses `gh`).
   First push the commit to a branch, wait for CI, then push the same commit to main.
   Without network access the check refuses the push. Ask the owner; do not skip it.

## Changes

1. Work on a branch, not on main.
2. Run `npm test` before you say a change is done. Report the pass and fail counts.
3. Never skip, disable or weaken a test to make the suite pass.
4. Update the docs that the change affects (DEVELOPING.md, SPEC.md, `docs/manual/index.html`,
   README.md, PROGRESS.md) in the same change.
5. A UI change must keep every engine function and control.
6. Do not delete files in the owner's folders unless the owner approves that deletion.

## Branches

1. Clean up merged branches and worktrees with `npm run tidy`. It deletes only after a y/N confirm.
2. Agents may run it to show the list, but answer `y` only with the owner's written approval.
3. Never force-delete a branch or worktree (`git branch -D`, `git worktree remove --force`).

## Releases

Follow the release steps in DEVELOPING.md: the smoke gate, Linux CI green on the release commit,
then the tag and the sync to ambient-library.
A patch version (`X.Y.Z+1`) may carry only patch-safe files (DEVELOPING.md, *Patch release lane*).
Never move a change into the patch lane by hand. If the lane gate fails, bump the minor version.
