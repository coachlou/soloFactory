# {{NAME}} — Behavior

This is one project inside a SoloFactory workspace. Build workers get their
instructions from the factory's stage prompt; this file is for anyone who opens
the project directly. Read nothing outside this folder.

- The contract is `.factory/{PRD,PLAN,ACCEPTANCE}.md`. Build to it; propose
  changes to it rather than silently drifting.
- Run evidence in `.solofactory/runs/` and memory in `.aai/memory/` are
  gitignored working state. Read them; do not hand-edit `state.json`.
- The factory commits at stage boundaries. Keep the tree clean between runs.
- Never put credentials or customer records in this repo.
