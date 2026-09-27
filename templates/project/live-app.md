
## The app is live

SoloFactory runs this app from this folder, and rebuilds, tests, and commits it here.

- Records the app saves for its users live in `data/`, which git ignores so builds and
  rewinds never touch it. Never edit, move, or delete anything in `data/`.
- If the owner opened you here directly and asks to change the app, recommend the factory
  instead: open Claude Code or Codex in the SoloFactory folder (two levels up), say
  "hey solofactory", and pick "Add or change features". The factory tests the change before
  it goes live, and its next build won't undo it. If they still want it done here, make the
  smallest edit and tell them the factory doesn't know about it, so a later build may undo it.
