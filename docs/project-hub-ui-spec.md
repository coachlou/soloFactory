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
| 1 | Page loads with no console errors, dark theme | |
| 2 | WORK rail groups runs (Needs you / Running / Queued / Done) across projects | |
| 3 | Clicking a rail item in another project switches project and opens the run | |
| 4 | Queued item `···` → Remove from queue dequeues it | |
| 5 | Rail menu row stays open across a poll (>5 s) | |
| 6 | Project switcher lists projects, switches, marks the current one | |
| 7 | "+ New project" opens the name dialog and creates the project | |
| 8 | Attention line shows for a parked run and Open goes to it | |
| 9 | Tabs Run / Documents / Live app switch the panel; Close hides it | |
| 10 | Brief mode: Guide thread and composer work; draft text survives a poll | |
| 11 | Documents (brief): View/Edit toggle and Queue button present | |
| 12 | Run mode: summary card, Open the run, New brief | |
| 13 | Run panel: stages, run map, actions (Resume/Dismiss on a parked run) | |
| 14 | Theme menu: Light and Dark apply and persist across reload; Auto follows the system | |
| 15 | Menu: Feedback dialog opens, Manual link, Update pill | |
| 16 | Narrow width (390 px): columns stack, no sideways scroll | |
