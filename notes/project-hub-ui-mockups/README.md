# Project hub UI exploration (2026-11-12)

Three clickable mockups that rethink the SoloFactory UI around many projects and an always-present Guide.
Design only. No app code was changed.

Canvas (press Play on an artboard): https://claude.ai/artifact/Bs4QcpwjK6PeVz6WALteuL

| File | Approach |
|---|---|
| `Main.dc.html` | A, Guide thread: one conversation per project; documents, run and all-projects dashboard open in a side panel on demand |
| `ControlRoom.dc.html` | B, Control room: every project as a lane; the Guide is a command bar with a "To" project selector |
| `Workbench.dc.html` | C, Workbench: project tabs, work and documents list, document in the middle, Guide in a dock |

The `.dc.html` files are Design canvas sources. They render on the canvas, not as plain HTML files.

## Shared model

1. A project owns its documents: `PRD.md`, `FEATURES.md`, `ACCEPTANCE.md`, feature specs (`specs/`), fix notes (`fixes/`), `.aai/context.md`.
2. The Guide reads those documents before it answers, then sizes the request:
   - Quick fix: the behavior is already in `FEATURES.md`. Steps: fix note, build, gates, deploy, update docs. No interview.
   - Feature: `PRD.md` covers the product; the request adds a capability beside existing ones. Steps: feature spec, plan, build, gates, review, deploy, update docs. The Guide asks only what the documents do not answer.
   - Full brief: no `PRD.md`, or the request changes the product contract. Steps: interview, PRD and plan, planned features, gates, review, deploy, update docs.
3. The Guide shows its pick, the reason and the steps. The owner can change the size with one click.
4. The last step of every run rewrites the documents to the as-built behavior.
5. Runs in one project go one after another. Runs in different projects overlap up to the build-slot limit.
