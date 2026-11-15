# Project hub UI (version A): implementation spec

Source design: `notes/project-hub-ui-mockups/Main.dc.html` (version A, also published as the design A
canvas). The hub is now that design and nothing else: the page is design A's own markup and styles,
and its component logic is wired to the factory API. No markup, styles or controls from the earlier
hub remain. The rollback point is the tag `hub-ui-pre-design-a-rebuild`.

## How the page is built

- `public/index.html` holds design A's template (`<script type="text/x-template" id="tpl">`).
- `public/app.js` has three parts: a small template engine (`{{path}}`, `sc-if`, `sc-for`, a DOM
  morph that keeps focus and scroll), design A's component class unchanged in behaviour, and a
  `Live` class that replaces the demo data with factory state (`/api/board`, `/api/jobs`,
  `/api/interview/draft`) and turns each design A button into the matching API call.
- `public/styles.css` is design A's stylesheet. Colours are its neutral grays; amber and red only
  mark attention (needs you, failed, stopped).

## Layout

Left rail (brand, WORK list grouped Needs you · Running · Queued · Done, Menu), header (project
switcher, attention line, theme menu, Run · Documents · Live app tabs), the Guide thread with its
composer in the middle, and the panel on the right. Revising a spec puts the brief in the wide
column with Resubmit to the factory and Discard changes, exactly as design A shows it.

## Left out for later

These worked in the earlier hub and are not in design A, so this build drops them. Retrofit them
into design A's layout one at a time.

- Run detail: the metro run map, live stream, health line and Q&A; supervision controls; the stage
  rail; restart from a chosen step.
- Recovery: waiving a proof, extra inputs, uploading a plan amendment, spend figures. The recovery
  packet is copied to the clipboard instead of downloaded as a file.
- Queue: reordering queued runs (no server endpoint yet). Remove from queue and Cancel remain.
- Guide thread: the earlier-messages pager, attachments, design A's pick card sizing alternatives and
  suggestion chips (the demo chips are hidden), and Guide edits to a document outside revise mode.
- Documents: editing a shipped brief in place; only revise mode edits.
- Live app: traffic stats and Relaunch; the panel shows "Nothing is live yet" or the live link.
- Projects: adopting an existing folder or custom repo at New project; editing settings.
- Hub chrome: resizable panes, the feedback form, the report-a-run form, update and background-run
  banners.
- Manual screenshots of the new layout.

## Function checklist (live preview)

Driven on an isolated seed server (:4380, temporary home, projects habit-tracker and recipe-box).

| # | Function | Result |
|---|---|---|
| 1 | Page loads with no console errors | Pass after guarding projects with no thread yet |
| 2 | WORK rail lists runs across projects; clicking one switches project and opens it | Pass |
| 3 | Project switcher lists projects and switches | Pass |
| 4 | Guide thread and composer render for the selected project | Pass |
| 5 | Documents panel lists one brief per run and opens it read-only | Pass |
| 6 | Live app panel with no deployment says nothing is live | Pass |
| 7 | Stopped run shows the factory's own stop reason, not demo text | Pass |
| 8 | Revise the spec marks the run as revising and opens the brief for editing | Pass |
| 9 | Discard changes deletes the draft and returns the run to stopped | Pass |
| 10 | Let the Guide plan a repair resumes the run | Pass (fixture provider shipped it; next queued run started) |
| 11 | Theme menu: Light applies and persists (`solofactory.theme`) | Pass |
