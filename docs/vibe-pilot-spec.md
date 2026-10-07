# Vibe pilot: spec

**Status: approved by the owner on 2026-10-07.** The build starts 2026-10-08, and the stop date is 2026-10-22. The owner's time cap during the build is 24 hours.

**Goal.** Find out, cheaply and with real numbers, whether soloFactory can feel like vibe coding while its checks run out of sight. The bar is plain chat: Claude Code or Codex in the same project with the app open beside it. If the pilot can't match plain chat on feel while beating it on correctness, we don't build further.

**Where this comes from.** This is the factory-direction scorecard (v6), steps 2–4: build the pilot surface, run the two-gate pilot, decide by rule. Five independent reviews converged on this path. Note: soloFactory's `PROGRESS.md` records the Patch lane, Ask pane and Triage session as ideas. This pilot builds a chat-and-preview version of the Patch lane first.

## What gets built

One conversation with two speeds, inside soloFactory, on top of the quick-fix lane already designed in `PROGRESS.md` ("Patch lane").

### 1. The screen
- **Left: a chat.** **Right: a live preview of the app,** running from the project's working tree and reloading after every change that passes its checks.
- No run board, logs or stage names on this screen. They stay one click away ("how do you know?" opens the record in plain words).
- The existing interview and full release flow are unchanged and reachable from the same chat ("this is a release" hands over, as `PROGRESS.md` already describes).

### 2. Live mode (you're watching)
- Each request becomes a quick fix, using the stages already designed in `PROGRESS.md`: build, gates, commit. No spec, no plan review, no review audit, no deploy.
- **Reproduce first:** the agent writes a test that fails for the stated reason before touching code. If it can't reproduce the problem, it says so plainly and asks one question.
- The same two bounded repairs as today. When they run out, it stops with one plain sentence and two or three options.
- The preview reloads when the gates pass, and the chat says what changed in one line.

### 3. Away mode (you walk away)
- When the conversation and the mockup are enough to build without you, the agent asks: **"I can build this without you. Go ahead?"** This is the handoff. The owner can also start it: "build this while I'm away."
- Before the owner leaves, the mockup of the main journey must be confirmed. That is the guard against coming back to the wrong thing, built rigorously.
- It runs as a normal queued run, so resume, repairs and parking work as today.
- **Return summary:** a working preview, three or four plain sentences on what was built, and any decisions waiting. Never a log.
- **Notification** when it finishes or stops: a desktop notification at minimum.

### 4. Risk
- A **risk check** runs on the actual change, not on the wording of the request. It covers new packages, database or stored-data structure, deleting data, accounts and login, money, and publishing. When it trips, the agent asks one plain question before continuing.
- If the risk check proves unreliable in the pilot, it is replaced by a single question asked on every request: "Does this touch money, accounts, stored data, new packages, the database structure, or publishing?"

### 5. The record
- Every request records **what the agent claimed beside what the controller observed** (exit codes, test results). Only the observation moves work forward.
- "How do you know it works?" is answered from this record, in plain words.

### 6. Discovery guideline (instructions for the conversation)
This replaces the "complete the coverage keys" orientation in `skills/factory-guide.md` for the pilot's chat, and becomes the core of the shared mockup skill.

> **Your job is to find the best experience for the person who'll use this, not to complete a spec.** The spec is a by-product you write afterwards from the conversation and the mockup. Never ask the owner to fill it in.
>
> 1. **Start from the person and the moment.** Who uses it, when, and what they're trying to get done. How do they feel before and after? Features come later.
> 2. **Show early, show rough.** After two or three exchanges, sketch something clickable. Reactions to a picture beat answers to questions.
> 3. **Offer real alternatives at the forks.** When there are two good ways to do it, a list or a board, a form or a chat, show both, say which you'd pick and why, and let the owner choose by feel.
> 4. **Question the request.** If there's a simpler way to get the outcome, say so plainly, even if it means building less.
> 5. **Think about the whole experience,** not just the main screen: the first visit with empty states, mistakes and errors, using it on a phone, and coming back on day 30.
> 6. **Recommend the approach that suits it,** in plain words: a simple page or a full app, accounts or none, local or online. Give the trade-off and a recommendation, not a menu.
> 7. **Stay exploratory until the owner settles.** Don't steer toward "ready". It's fine to explore, discard and retry.
> 8. **Know when it's enough to build.** Hand off only when three things are true: the owner has confirmed a mockup of the main journey, you can say what "done" means in their own words, and you've named anything risky (money, accounts, stored data). Then ask: "I can build this without you. Go ahead?"
>
> **Never:** question field by field; ask technical questions; polish visuals early; accept the first idea without at least considering an alternative; declare "ready" just to end the conversation.

**Decision:** the 13 coverage keys stay as a silent checklist. The Guide fills them from the conversation in the background so the build keeps its safety net, but they no longer shape the conversation.

## Out of scope for the pilot
- Merging or extracting anything shared with software-factory or wbs-toolkit.
- Porting software-factory's checks.
- Automatic rigor levels beyond the risk check.
- Non-Node apps.
- Remote deployment.

## Build budget
- **Stop date (calendar):** 2026-10-22, two weeks after the build starts on 2026-10-08. It's a deadline for a decision, not an estimate. If the surface isn't usable by then, stop and record what blocked it. That's a pilot result too.
- **Owner time cap:** at most 24 hours of the owner's attention during the build (set by the owner) (reviews, answers, try-outs). Calendar time is mostly waiting; this is the budget that actually matters to a solo builder.
- **Agent time is measured, not capped:** record the hours of agent work and the subscription limits hit. It's evidence for the scorecard's effort and cost rows. If the build hits rate limits often enough to threaten the stop date, that's a finding.
- **Record the actual build time.** It is evidence for the scorecard's "effort" row.
- **How it gets built:** with Claude Code in the soloFactory repo, through soloFactory's normal practice of small steps, each with its own tests. It touches roughly these files:
  - `src/server.mjs`: the chat endpoint for quick fixes, preview process control, and the notification hook;
  - `src/factory.mjs`: the quick-fix stages and the away-mode handoff;
  - `src/prompts.mjs` and `skills/factory-guide.md`: the discovery guideline and quick-fix prompts;
  - `public/index.html` and `public/app.js`: the chat-plus-preview screen and the return summary;
  - tests under `test/`.

## Done means (acceptance for the build)
1. On a real project, a look tweak typed into the chat appears in the preview without the owner running a command, refreshing, or reading a log.
2. A request that breaks an existing test is repaired, or stops with one plain sentence and options. It never shows as done.
3. Asking "build this while I'm away" on a confirmed mockup runs unattended, notifies on finish, and shows a return summary with a working preview.
4. A change that adds a package or alters stored data triggers the risk question before it continues.
5. "How do you know it works?" answers from the record, in plain words.
6. All existing soloFactory tests still pass.

## The pilot (after the build)
**Duration:** two weeks, and at most 20 hours of the owner's time.

**Setup:**
- One existing project and a fixed model.
- **Assessor:** Codex, a different vendor from the builder. It makes two copies of the project, one for the pilot and one for plain chat. Then it writes and **freezes** pass/fail criteria for every request before anything runs.

**Requests:** 12 in total.
- 6 look tweaks.
- 3 features. 2 of them are run in **away mode**.
- 3 risky changes: login, deleting data, adding a package.
- Every request is run in both copies, alternating which goes first.

**Bad days, run in the pilot only:**
- an interrupted run;
- a used-up subscription quota;
- a deliberately wrong test;
- a rollback;
- one run on WSL.

Keep every failure and retry in the results.

### Gate 1: feel (the owner judges)
- **Speed, relative to plain chat.** The pilot's median time to a *visible* change is no more than twice plain chat's on the same request type (the baseline suggests about 4 minutes for tweaks and 6–8 for features). The slowest requests take no more than twice the median. Risky requests have no time target. The original absolute targets (5 and 20 minutes) were dropped once the baseline showed plain chat finishing in 1–4 minutes.
- **Questions and chores.** On average at most one question per request, and none about tests, gates, logs or git. On average no more than 0.5 chores per request (refreshes, restarts, merges, ports); plain chat averaged 2.
- **Feel rating.** After each request, before seeing timings, the owner rates "felt like vibe coding" from 1 to 5. The average must be 4 or more, and at least as good as plain chat. A tie passes.
- **Away mode.** Each away-mode request is rated on the return, from 1 to 5, and must average 4 or more. It counts how many times the run needed the owner. The assessor also judges whether the handoff came too early or too late.

### Gate 2: correctness (the assessor judges, without knowing which arm a result came from)
- **Pass mark.** At least 11 of the 12 pilot results meet their frozen criteria, and at least as many as plain chat.
- **Regressions.** None in the existing tests.
- **Risk.** All 3 clearly risky requests are caught, with at most 2 harmless ones flagged. This is a smoke test, not proof of reliable risk detection.
- **Plain chat's risky changes.** For the plain-chat runs, the assessor logs any risky change made without a warning.

### Decision rule
| Gate 1: feel | Gate 2: correctness | Then |
|---|---|---|
| pass | pass | Build the next small increment of the surface, using Ledger Factory v2's design for it. Not the whole architecture. |
| pass | fail | Keep the surface. Fix verification before anything else. |
| fail | pass | Keep soloFactory's verification, drop the chat surface, and rethink the experience. |
| fail | fail | Stop. Use plain chat for small work and the shared core for builds. |

If the risk check fails, it also fails Gate 2: apply the matching row above, and replace the automation with the single plain question.

## Baseline (do first, before any build)
Four plain-chat requests on the same project, recorded with the Vibe Baseline Checklist. They set the reference numbers that Gate 1's targets are checked against. If plain chat already rates 4–5, the pilot's question becomes "can we keep that feel *and* add checks underneath?"

## Open questions
- Is the preview a second copy of the app restarted after each passing change, or the app's own reload mode? This is decided during the build, by whatever reloads fastest.
- What does desktop notification look like on WSL? It may fall back to a sound plus the browser tab title.

## Findings from the first real run (reading-list, 2026-10-07)
1. **Gates passed an app that couldn't deploy.** install/test/build were green, but the app ignored `PORT`, so the deploy health check failed. The fast checks should cover whatever deploy will check: honoring `PORT`, plus the health and metrics paths.
2. **A health-check failure isn't repaired automatically.** It isn't in the repair budget, and resume only redeploys, so the same failure repeated. It needed a manual Claude Code fix.
3. **The stop message was the generic catch-all:** "Review the recovery packet and the named log". It never said *why* until the owner copied the packet. A plain stop would read: "Your app started but didn't answer on the port it was given. Want me to fix that?" Pilot acceptance check 2 covers this.
4. **Timing (owner-reported):** about 15 minutes from queue to the stop, and 24 minutes to a completed, deployed app including the manual fix (about 9 minutes). This was a single build of a small app.
5. **Baseline, request 1 (plain Claude Code chat):** the change was committed on a separate branch in an isolated worktree, so the running app never got it. Claude Code reported it as done without checking what the owner could see. The owner had to notice and say "I don't see any changes" before it offered to merge. This is the claimed-versus-observed gap in its plainest form. **Pilot requirement:** changes land where the preview runs, and "done" is only declared after the preview shows the change.
6. **Baseline, request 3:** the app has no hot reload, so Claude Code quietly restarted the server in the background itself. The owner's own restart then collided on the port ("address already in use"), and a server that "won't die" appeared. Two parties were managing one app process. **Pilot requirement:** exactly one owner of the preview process (the controller). It restarts after every change that passes its checks and never leaves stray servers, and the owner never touches ports or processes.

## Baseline results (plain Claude Code chat, reading-list copy, 2026-10-07)
| Request | First change (min) | Done (min) | Questions | Chores | Broke? | Warned? | Feel |
|---|---|---|---|---|---|---|---|
| 1 · look tweak | – | (gave up recorded at 1.9) | 1 | 5 | no | no | 2 |
| 2 · small feature | 1.9 | 2.9 | 0 | 1 | no | nothing risky | 4 |
| 3 · touches data | 3.5 | 3.9 | 0 | 1 | yes | nothing risky | – |
| 4 · your choice | 1.1 | 1.3 | – | – | no | nothing risky | 5 |

**Reading it:**
- **Plain chat is fast:** 1–4 minutes to a working change, against about 24 minutes for a full soloFactory build of the same app.
- **Feel averaged 3.7** (2, 4, 5), and it was lost to chores, not speed:
  - work done somewhere the owner couldn't see (a worktree);
  - "done" claimed while nothing had visibly changed;
  - manual refreshes and restarts;
  - two parties managing one server;
  - an empty app with no first step.
- **The owner rated a storage-format change "nothing risky".** An owner can't judge data risk, so the risk check must not rely on the owner noticing.

**What this means for the pilot:** it can't win on speed; at best it can come close. It wins only if it removes the chores and the false "done" while staying within twice plain chat's time. That is the hypothesis Gate 1 now tests.

**Caveats:**
- Four requests, one owner, one small app.
- Request 1's timer was stopped early (the 1.9 minutes is when "give up" was clicked, not the real duration).
- Request 3 has no feel rating.
