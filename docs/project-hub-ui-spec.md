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

- Run detail: the metro run map; supervision controls; the stage rail; restart from a chosen step.
- Recovery: the recovery packet is copied to the clipboard; only the plan help packet downloads.
- Queue: reordering queued runs (no server endpoint yet). Remove from queue and Cancel remain.
- Guide thread: the earlier-messages pager, attachments, design A's pick card sizing alternatives and
  suggestion chips (the demo chips are hidden), and Guide edits to a document outside revise mode.
- Documents: editing a shipped brief in place; only revise mode edits.
- Live app: traffic stats and Relaunch; the panel shows "Nothing is live yet" or the live link.
- Projects: adopting an existing folder or custom repo at New project; editing settings.
- Hub chrome: resizable panes, the feedback form, the report-a-run form, update and background-run
  banners.
- Manual screenshots of the new layout.

## Run detail and recovery (added back)

These came back in design A's own style rather than as the earlier hub's panels.

- **Run Q&A and activity.** The run card in the right panel answers five questions (Moving?, Healthy?,
  How far?, Needs you?, Safe to resume?) and shows the latest factory events as an Activity list with
  filter chips (All, Agent, Files, Gates, Stages). It follows the selected run, else the active run, else the
  newest one, and refreshes with the rest of the page.
- **Recovery box.** When the factory's next step needs the owner, a Recovery section opens under the
  run card. It states what happened and what has been spent (workers, tokens, cost, time), then
  offers only the actions the server's `nextAction` allows:
  - Waive a proof the owner believes is wrong (needs a reason in the note box).
  - Approve a ready plan and continue repairs.
  - Prepare or retry a repair plan, sending the note box as guidance to the planner.
  - Upload a corrected plan when plan corrections are exhausted: download the plan help packet,
    choose the JSON plan, then submit it for one review.
  - Revise inputs and prepare a new plan, or add a spec or prototype file to the run.
- The Guide's "Let the Guide plan a repair" button uses the same note as guidance. At an exhausted plan
  it points to the upload instead of posting a plan that would be refused.

## Guide replies in Markdown

The Guide skill asks for its `message` in Markdown (short paragraphs, lists, bold, code, small
headings). The hub renders it with a small built-in renderer that escapes the reply first, so the
only markup on the page is what the renderer adds; links open only for http and https addresses.
The owner's own messages stay plain text.

## Draft spec before sending

As soon as the Guide's brief holds anything, Documents lists it first as **Draft spec**, and it follows
every Guide turn and every edit. It opens with Read and Edit: an edited section saves into the
interview draft at once, and asking the Guide in the viewer runs a normal interview turn. The pick
card names the draft spec as what the Guide read and offers **Read the draft spec** beside Send to the
factory, so the owner can read and revise it first. Nothing is queued until Send to the factory.

## Revising a stopped run's spec

As in design A, a paused, parked or cancelled run offers Revise the spec on the run card, in the run
panel and in the spec viewer (a cancelled run says Revise and resubmit). Revising reopens the brief as a
draft of the next revision with Resubmit to the factory and Discard changes. In the viewer, telling the
Guide what to change on a stopped run reopens the draft first and then runs the turn; the Guide's side of
the viewer shows that conversation. While a run is building or pausing the spec stays read only, and the
Guide says to pause the run first. List fields such as must-haves, the core workflow and acceptance
scenarios read as lists.

## Function checklist (live preview)

Driven on an isolated seed server (:4380, temporary home, projects habit-tracker, recipe-box and notes-app).

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
| 12 | Editing a brief section and pressing Cmd+Enter saves it, with nothing leaking into the composer | Pass after skipping events the redraw itself fires |
| 13 | Resubmit to the factory queues the revised brief (a second press queues an unconfirmed review as shown) | Pass |
| 14 | Remove from queue cancels a queued run | Pass |
| 15 | Cancel run shows only on active runs; parked runs offer repair, revise, start over instead | Pass (matches the earlier hub) |
| 16 | Run Q&A and Activity list render for a parked run; each chip shows only its kind of real factory event (agent, file edit, gate, stage) | Pass |
| 17 | Recovery box shows the summary, spend and the actions `nextAction` allows | Pass |
| 18 | Waive with an empty note asks for a reason; with a reason it posts `waive-proof` (200) | Pass |
| 19 | Exhausted plan: blockers listed, help packet link, choosing a JSON plan shows its size and phase | Pass |
| 20 | Review this plan posts `recovery-review`; the server's refusal shows inline | Pass (a dummy plan was refused with 400 as expected) |
| 21 | Add a spec or prototype file posts `inputs` (200) | Pass |
| 22 | Revise inputs posts `recovery-plan` with the note as guidance (202) | Pass (the seed's thin run then parked with the planner's error, shown on the run) |
| 23 | Approve and continue repairs posts `recovery-start` with the ready plan's digest | Pass (the server accepted the digest, then refused the seed's thin plan with 409, shown inline; a real start needs a planner-made plan) |
| 24 | A ready plan also offers the corrected-plan upload and lists its repair features and allowance | Pass |
| 25 | Let the Guide plan a repair at an exhausted plan points to the upload and posts nothing | Pass |
| 26 | Recovery box reads as neutral gray in light and dark at desktop width | Pass |
| 27 | Guide replies show Markdown headings, lists, bold, code and links; script tags and javascript links stay text | Pass (unit test on the renderer) |
| 28 | The draft spec shows in Documents while the interview runs, edits save into the draft, and the pick card opens it | Pass (unit test on the section and edit mapping) |
| 29 | A stopped run's spec viewer offers Revise the spec, the Guide box stays in view, asking the Guide reopens the spec as a draft, and list fields read as lists | Pass (stop-watch run on the live copy; unit test on the list rendering) |
