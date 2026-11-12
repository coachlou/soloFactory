# test/new-ui: the brief as a document, with the Guide in a sidebar

Test branch for option **B, cleaner** from the *Brief workspace mockups* canvas (artboards B3 to B6).
Not released. Built on the uncommitted "Revise brief" work that was on `main` on 2026-11-11 (first commit on this branch).

## What changed

`public/index.html`, `public/app.js` and `public/styles.css`; server changes for direct edits and the final review (`src/server.mjs`, `src/interview.mjs`, tested in `test/brief-edits.test.mjs`); and a new "Final review before queuing" section in the Guide skill (`skills/factory-guide.md`).

1. The interview page and the review page are now one **Brief** page.
2. The left side is the brief as a cream document. The right side is the Guide, flush and sticky.
3. A bar over both shows the project, a status line, a View/Edit switch and the queue button.
4. The queue button says what queuing does:
   - "Brief not ready · 4 of 13" until the Guide marks the brief ready.
   - "Queue for the factory" for a new brief.
   - "Queue and replace run X" when the revised run holds the queue.
   - "Queue and set aside run Y" when a different stopped run holds the queue.
   - "Queue as a new run" for a finished run.
5. While the interview runs, the topic the Guide is asking about is marked "being discussed". Topics with nothing yet are listed under "Still to cover".
6. A revision compares the brief with the brief its run was queued with. Changed sections are marked, with removed items struck through and new text highlighted. The bar counts the changes.
7. Edit mode: click a section (or Tab to it and press Enter) to rewrite it. Leave the section, or press Cmd/Ctrl+Enter, to keep the edit; Escape cancels. The edit is saved to the draft at once (`PATCH /api/interview/draft` with `edits`), then sent to the Guide to check.
   - The Guide rebuilds the brief from the conversation, so it can drop an edit. The server holds each edit: the turn that checks it always keeps it, and later turns keep it while the Guide still writes the old text there. When the Guide writes something new for that section (for example because you asked it to), the edit stops being held.
   - An edit before the first answer starts the draft.
8. A revision opens in Edit mode, with the run's stop reason and an "Open the run" link at the top of the Guide. Only the last 4 messages show; the rest open from "N earlier messages".
9. Nothing needs a save button. The Guide box saves unsent text to the draft about a second after you stop typing, and when it loses focus. The brief saves after every edit and every Guide turn. Queuing refuses while the box holds unsent text. (The mockup's "Save for later" button was removed for this reason.)
10. Enter sends, Shift+Enter adds a line.
11. **Queue reviews first.** Pressing Queue runs a final Guide review of the exact brief that would freeze (owner edits included; for a revision, also the brief of the run it changes). The skill tells the Guide to size the change: a narrow change (one rule, screen, field or message; no new data, integration, flow or architecture) gets a one-line confirmation, a wide one gets the full checklist and a question if anything is thin. Then:
   - Ready, brief unchanged: it queues.
   - A question: nothing queues; the Guide's question and a note show in the sidebar.
   - Ready but the Guide adjusted the brief: nothing queues; the changed sections are marked; press Queue again (no second review, since it reviewed that exact brief).
   - The Guide kept dropping one of your direct edits: the button becomes "Queue anyway" for one click.
   A brief already reviewed as it stands queues at once. Any later turn or edit clears the review. The review costs one Guide turn per queue.
12. Under 700 px wide, the Guide collapses to a rail at the right edge and opens over the brief. The top bar's controls scroll sideways instead of widening the page.
13. The stage rail on the left is hidden on the Brief page, as in the mockup. It still shows on a run.

## Try it

```bash
cd "/Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory/.worktrees/new-ui"
SOLOFACTORY_DEMO=1 SOLOFACTORY_HOME=/tmp/sf-new-ui PORT=4174 npm start
```

Open http://127.0.0.1:4174. Demo mode uses the fixture provider, so the Guide answers instantly with a ready brief.
Leave out `SOLOFACTORY_DEMO=1` and `SOLOFACTORY_HOME` to try it on your real projects.

## Checked

- `node --test test/e2e.test.mjs`: 31 of 31 pass. `test/brief-edits.test.mjs`: 2 of 2 pass. `test/interview.test.mjs` passes. `test/plan-amendment.test.mjs` and `test/set-aside.test.mjs`: 30 of 30 pass. Distro check ok.
- In a browser (fixture mode): new brief to queue, a direct edit sent to the Guide, the Guide box saving itself across a reload, the queue refusal with unsent notes, and Revise brief on a finished run.
- Screens at 1280 px and 390 px for a new idea, a revision, Edit mode and the phone rail.

## Known gaps

1. "Being discussed" picks the first partly covered topic. The Guide does not say which topic it is asking about.
2. After queuing, the page goes back to a new brief and the status says "Queued as run X". The mockup's "Queued as run X" state on the page itself is not built.
3. The new state-map entry points (a queued run waiting behind a stopped run, a run still building) need server work and are not built.

## Docs

Updated on this branch:

1. `docs/manual/index.html`: §3 Shape the brief rewritten for the Brief page (View/Edit, auto-save, phone rail) with two new screenshots; §4 Queue a run explains the final review and Queue anyway; the Revise brief row describes the new page.
2. `README.md`: the quick-start paragraph names the Brief page, the final review and Attach.
3. `PROGRESS.md`: an Unreleased entry for the branch.

Still to do before release: run the real-provider smoke set (DEVELOPING.md), since the Guide skill and `src/interview.mjs` changed. The smoke briefs post straight to `/api/jobs`, so they do not exercise the final review; also try one real interview through Queue. Old release notes in `docs/INSTALL.md` that mention "the review screen" describe past releases and stay as they are.
