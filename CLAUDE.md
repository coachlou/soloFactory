# Claude Code

Read `.aai/instructions.md` first and follow it. It holds every rule common to all agents in this repo.
Load other files only when the task needs them; `.aai/instructions.md` says where to look.

## Claude-specific

- Give a `git push` to main a Bash timeout of at least 300000 ms: the pre-push hook runs the full suite.
