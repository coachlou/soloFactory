# {{NAME}} — Behavior

This is one project inside a SoloFactory workspace. The parent folder's
`.aai/instructions.md` (two levels up) governs the factory as a whole; if it
exists, load it first, then this file.

- The contract is `.factory/{PRD,PLAN,ACCEPTANCE}.md`. Build to it; propose
  changes to it rather than silently drifting.
- Run evidence in `.solofactory/runs/` and memory in `.aai/memory/` are
  gitignored working state. Read them; do not hand-edit `state.json`.
- The factory commits at stage boundaries. Keep the tree clean between runs.
- Never put credentials or customer records in this repo.
