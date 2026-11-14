# Project hub UI (version A): implementation spec

Source design: `notes/project-hub-ui-mockups/Main.dc.html` (version A). This spec maps every
control the current page has onto that layout, says what changes and what is deferred, and lists
the checks a live preview must pass.

## Layout

```
.hub                                   (flex, wraps to one column on narrow screens)
  nav.hub-nav                          left rail, neutral panel
    brand tile "SF", system status line, active-run capacity
    WORK list, grouped from /api/board: Needs you · Running · Queued · Done
    update pill (#update-button), Menu (popover): New project, Feedback, Manual
  .hub-body
    header.hub-head
      project switcher (button + popover menu, "+ New project")
      attention line (amber, only when a run needs the owner)
      theme menu (Auto / Light / Dark), panel tabs Run · Documents · Live app
    .hub-cols
      main.hub-main
        error notice, background-run banner
        brief mode: the Guide thread and composer (#brief-view)
        run mode: a run summary card (project, title, feature bar, state, Open the run, New brief)
      aside.hub-aside                  the panel the tabs choose; Close hides it
        Run: stage list + the full run view (recovery, run map, actions)
        Documents: brief mode, the brief document and its bar (View/Edit, Queue);
                   run mode, the run's artifacts
        Live app: run mode, live traffic and Open/Relaunch; brief mode, a placeholder
```

Mode switching reuses the existing `body.brief-mode` class: `.brief-only` and `.run-only` elements
show in one mode each. In run mode the aside takes the wide share of the row and the main column
narrows to the summary card, so the run map keeps its room; in brief mode the Guide takes the wide
share. Opening a run selects the Run tab; opening the brief selects Documents.

## What changes

| Old control | New home |
|---|---|
| Top bar project `<select>` | Project switcher button and menu; same `switchProject` |
| Top bar run `<select>` | WORK rail; every run in every project, click opens it |
| Factory button and board page | Removed; the WORK rail is the board, fed by `/api/board` on every poll |
| Feedback, Manual | Menu at the foot of the rail |
| Check for updates | Pill above the menu (unchanged popover) |
| Stage rail (left) | Top of the Run panel |
| Attention banner | Amber line in the header (same ids and action) |
| Guide sidebar | Main column (Guide thread); the phone rail is no longer shown |
| Brief document | Documents panel |
| Artifacts, Live app cards | Documents panel (run mode), Live app panel |

New: a queued run in the rail has a `···` toggle with **Remove from queue** (POST
`/api/jobs/:id/cancel`, which already dequeues). Open menus and the composer survive the 5-second
poll: the rail keeps its open row in state and is only rebuilt when the board changes, and
popovers are never rebuilt while open.

Palette: neutral grays from the mockup tokens in dark and light; hierarchy by weight, size and caps;
primary buttons use the inverted tile colour; amber and red appear only on attention (needs you,
errors, blocked stops, recovery). The brief document keeps its paper colour.

## Deferred (not in this build)

- Pick card, sizing, and suggestion pills from the mockup's thread.
- Queue reorder (Move up / Move down): no server endpoint yet.
- Adopt an existing folder or custom repo at New project; editable settings; a settings page.
- Guide chat inside the document viewer; per-document list beyond the brief and artifacts.
- Manual screenshots of the new layout.

## Function checklist (live preview)

Filled in by driving an isolated fixture server (temporary home, seeded projects and runs).

| # | Function | Result |
|---|---|---|
| 1 | Page loads with no console errors, dark theme | Pass: no console errors; dark by default |
| 2 | WORK rail groups runs (Needs you / Running / Queued / Done) across projects | Pass: Needs you 2, Queued 2, Done 2 across habit-tracker and recipe-box |
| 3 | Clicking a rail item in another project switches project and opens the run | Pass: "Import recipes from a link" switched to recipe-box and opened its run |
| 4 | Queued item `···` → Remove from queue dequeues it | Pass: POST cancel 202; the row moved to Done as "Removed from queue" |
| 5 | Rail menu row stays open across a poll (>5 s) | Pass: open row survived a 7 s wait (rail rebuilds only when the board changes) |
| 6 | Project switcher lists projects, switches, marks the current one | Pass: `aria-current` on the current project; switching works |
| 7 | "+ New project" opens the name dialog and creates the project | Pass: "Garden planner" created and selected as garden-planner |
| 8 | Attention line shows for a parked run and Open goes to it | Pass: "2 runs are stopped or paused and need you"; Open went to Streak calendar; tab title "(2) needs you" |
| 9 | Tabs Run / Documents / Live app switch the panel; Close hides it | Pass: each tab shows its panel with `aria-pressed`; Close hides the aside |
| 10 | Brief mode: Guide thread and composer work; draft text survives a poll | Pass: draft text and focus kept across a 6.5 s wait |
| 11 | Documents (brief): View/Edit toggle and Queue button present | Pass: View/Edit toggle `aria-pressed`; Queue disabled ("Brief not ready · 0 of 13") |
| 12 | Run mode: summary card, Open the run, New brief | Pass: summary card with Open the run and New brief |
| 13 | Run panel: stages, run map, actions (Resume/Dismiss on a parked run) | Pass: six stages, run map, Resume current run, Dismiss, recovery checkpoint |
| 14 | Theme menu: Light and Dark apply and persist across reload; Auto follows the system | Pass: Light kept after reload (`solofactory.theme`); Auto followed emulated dark and light |
| 15 | Menu: Feedback dialog opens, Manual link, Update pill | Pass: Feedback dialog opens; Manual link returns 200; update pill runs a forced check |
| 16 | Narrow width (390 px): columns stack, no sideways scroll | Pass: 390 px stacks rail, header, main and aside; scrollWidth equals viewport |

Notes from the run:

- The attention line counts each project's latest run; the rail lists every parked run, so the two can
  differ when an older run in a project is parked behind a newer one.
- "Cancel run" keeps its red outline: it is destructive, which the colour rule allows.
- Done shows at most five completed runs per project (server cap), so no "Show all" was added.
- A completed run's elapsed time now falls back to `completedAt` when it has no stage history, so a
  Done row never keeps counting.
