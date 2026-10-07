# Vibe pilot: handoff (checkpoint 2026-10-07)

Read this first in a new session, then read `docs/vibe-pilot-spec.md`. Together they hold everything needed to continue. Branch: `claude/ecstatic-tesla-stfhsz` in `coachlou/soloFactory`.

## Where we are
- **The pilot spec is approved** (`docs/vibe-pilot-spec.md`).
  - The build starts **2026-10-08**, and the stop date is **2026-10-22**.
  - The owner's time cap is **24 hours**. Agent time is measured, not capped.
- **Next action:** when the owner says "start the build", begin **build step 1**. Steps 1 and 2 are planned for day one.
- **Nothing has been built yet.** The only commits on the branch are the spec and this handoff.

## How the owner wants to work
- **Lead them step by step and make the decisions where possible.** The owner said: "lead me through, make decisions when possible."
- **Write plain language.** The owner is a solo builder and may be non-technical. Don't make them read logs, ports or git.
- **The goal:** "the most intuitive UX, one that makes me feel like I'm vibe coding, but has rigor hidden from me, under the hood."
- **Design for a solo builder,** not a team or enterprise. No heavyweight machinery by default.
- **Bill everything to subscriptions,** never API keys. That includes Codex: it runs on the owner's machine, signed in with ChatGPT.
- **The owner likes independent audits** (Fable agents, and Codex run locally via a bundle) before decisions.

## The owner's machine (macOS)
- **Their soloFactory clone:** `/Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory`. The path has a space, so quote it.
- **soloFactory projects:** `…/soloFactory/my-folder/projects/`. Today's test app is `reading-list`, plus the baseline copy `reading-list-baseline`.
- **Their Claude Code works in isolated worktrees by default.** Agent edits to an app land on a hidden branch unless told otherwise. When the owner uses Claude Code on an app, have them say first: "edit files directly in this folder; don't use worktrees or separate branches."

## How the build runs
- **The building happens in the cloud Claude session on this branch,** in small steps, each with tests (`npm test`; it runs `node --test` after the distro check).
- **The owner tries each step locally in a separate worktree,** so their everyday soloFactory stays untouched:
  ```bash
  cd "/Volumes/Extreme Pro/users/loudalo/GitHub/soloFactory"
  git fetch origin
  git worktree add ../soloFactory-vibe claude/ecstatic-tesla-stfhsz
  cd ../soloFactory-vibe
  PORT=4174 SOLOFACTORY_ROOT="$PWD/pilot-projects" npm start
  ```
  Then copy `reading-list` into `soloFactory-vibe/pilot-projects/projects/`. The everyday soloFactory stays at port 4173; the pilot runs at **4174**. Remove it afterwards with `git worktree remove ../soloFactory-vibe`.
- **This is a branch of soloFactory, not a new product.** If the pilot passes its gates, the lane merges back as a soloFactory feature.

## Test suite: fixed on 2026-10-07
`npm test` used to hang in the cloud container. **Cause:** a deployed app is started with `npm start`, which runs it under `sh -c`. On Linux, `/bin/sh` is often dash, which doesn't hand over to the last command, so SIGTERM to npm left the real server running. That broke the "next release replaces its previous live deployment" test, and the orphaned server's open output pipe stopped the test run from ever exiting.

**Fix** (`src/factory.mjs`): deployed apps now get their own process group, and every place that stops an app signals the whole group (`stopApp`). `npm test` now passes 83 of 83 in about 18 seconds and leaves no stray servers.

**Who it affects:** Linux and WSL users, since Ubuntu's `/bin/sh` is dash. A replaced or stopped app kept running and holding its port. macOS's `/bin/sh` (bash) didn't show it.

**Follow-up for build step 1:** `src/process.mjs` (`runProcess`, used for gates and agent CLIs) stops children with a plain SIGTERM too, so a timed-out `npm test` could orphan its test processes the same way. Apply the same process-group treatment there when building step 1.

## Build plan (the order follows the findings)
1. **One owner of the running app (preview process).**
   - soloFactory starts and restarts the project app on a fixed preview port, from the working tree.
   - The fast checks verify that the app honours `PORT` and answers `healthPath` and `metricsPath`, before deploy.
   - The owner never touches ports or processes.
2. **Quick-fix lane backend**, from the `PROGRESS.md` "Patch lane" design:
   - reproduce-first test, then build, gates, commit;
   - the same bounded repairs as today;
   - "done" only after the preview shows the change and health passes.
3. **The chat-plus-preview screen** (`public/`).
4. **The discovery guideline** in the Guide prompt (spec §6), with the coverage keys made silent, plus the **risk check** on the actual diff.
5. **Away mode:** the "I can build this without you. Go ahead?" handoff, the return summary, and a notification.
6. **Plain-language stop messages.** These replace the generic "Review the recovery packet and the named log".

Each step must meet the spec's "Done means" checks that apply to it. Record the agent hours spent.

## Code facts already verified (useful for steps 1, 2 and 6)
- **Deploy** (`src/factory.mjs`): `deployLocal` spawns `commands.start` on a free loopback port. `waitForHttp` polls `/health` for 30 seconds, and failure raises `health_check_failed`. Only `invalid_metrics` and `deployment_exited` are in the repair budget, so **a health-check failure is never repaired**, and resume only redeploys.
- **Generic stop message:** `buildRecovery` (`src/factory.mjs` ~736) falls back to "The run paused before completion" when there are no diagnostics and no timeout reason.
- **Repairs:** `maxRepairs = 2` per *run*, not per slice (`factory.mjs:46`, `527`). SPEC.md:381 says per slice.
- **Review:** the review step is a writable agent pass followed by a re-run of the gates. It is **not** a gate on a verdict (`factory.mjs:239`).
- **Scheduling:** one active run per project. The global limit is `SOLOFACTORY_MAX_ACTIVE_RUNS`, default 1 (`server.mjs:55`).
- **Restore:** a parked follow-on that's set aside is restored to `baseCommit` (`server.mjs:140`). `data/` is gitignored and kept out of rewinds.
- **Quota:** a used-up quota is diagnosed as `usage_limit` (`providers.mjs:325`), which blocks the automatic retry.
- **Allowed commands:** only `npm`, `node` and `npx` (`process.mjs:132`). The generated-app contract is npm-based.
- **Pause:** `PAUSE_POINTS` = specifying, building, reviewing, deploying. A pause happens only when the owner requests it.
- **Project discovery:** projects are found under `SOLOFACTORY_ROOT/projects/`. The ambient distro sets `SOLOFACTORY_ROOT` to the installed folder.
- **The Patch lane is not implemented** (`PROGRESS.md` ~516). Its design is a "+ Quick fix" form with no chat and no preview.

## Findings so far (also in the spec)
1. **The reading-list build passed install, test and build, but failed its deploy health check.** The app ignored `PORT`. It was fixed by hand in Claude Code (honour `PORT`, add health and metrics), then resume completed it. Timing: about 15 minutes to the stop, 24 minutes total.
2. **A health-check failure isn't auto-repaired,** and resume repeated the same failure.
3. **The stop card was the generic catch-all.** It never said why until the owner copied the recovery packet.
4. **In the plain-chat baseline, Claude Code committed to a hidden worktree branch** and said "done" while nothing had visibly changed.
5. **The app has no hot reload.** Claude Code restarted the server in the background, the owner's restart clashed on the port, and a stray server "wouldn't die".
6. **The owner rated a storage-format change "nothing risky"** with no warning from the agent. Owners can't judge data risk.
7. **An empty app with no first step looked broken.**

## Baseline (plain Claude Code chat; full table in the spec)
- **Time to a working change:** 1–4 minutes.
- **Feel:** averaged 3.7 (rated 2, 4 and 5).
- **Chores:** about 2 per request.
- **What lost the feel:** chores and false "done" reports, not speed.
- **Gate 1 is therefore relative:** the pilot must be no more than twice plain chat's time to a *visible* change, average no more than 0.5 chores per request, and rate at least as well as chat on feel.

## How we got here (decisions, in order)
1. **Analysed the three products:**
   - wbs-toolkit: fast, and still runs a verify on every done;
   - soloFactory: TDD by prompt, with resume and repair;
   - software-factory: most rigorous, proven red, owner verdict.
2. **"One configurable product" was rejected first,** because trust postures differ.
3. **Then "share a core library" was recommended.**
4. **The owner added two requirements:** a mockup before build, and an architecture review, as shared skills.
5. **A first-principles design was produced:** "Ledger Factory", revised to v2 with an adversarial audit and a solo-builder calibration.
6. **A scorecard compared A, B and C:**
   - A: the shared core;
   - B: Ledger Factory v2;
   - C: "invisible rigor", a vibe surface on soloFactory.
7. **The scorecard went through six versions** under five Fable audits and one Codex audit.
8. **Final reading:**
   - B is the best blueprint, soloFactory the best starting point, and C a hypothesis.
   - The fit scores don't separate the options.
   - The next step is a two-gate pilot against plain chat.
9. **Other decisions:**
   - Don't merge, extract or retire anything.
   - software-factory keeps governing itself.
   - The discovery guideline makes the conversation focus on exploration, not on completing a spec.
   - Away mode is part of the pilot.

## Open items
- **The Codex assessor bundle.** Prepare it just before the pilot runs, not now. It should contain a brief for Codex to make two copies of the project, write and freeze criteria for 12 requests, and grade without knowing which arm a result came from. Use the same pattern as the earlier `codex-review-bundle` (run locally, read-only, subscription).
- **An unresolved judgment for the owner:** does approving *intent* count as rigor they have to manage? Codex says no; Fable says three front doors with approvals isn't hidden.
- **Spec open questions:** the preview mechanism (restart versus the app's own reload), and what desktop notifications look like on WSL.
- **software-factory governance:** nothing in this pilot touches software-factory. If that ever changes, go through its `run --spec`, and check `git show refs/factory/active:lease.json` first.

## Published pages (private to the owner)
- Factory direction scorecard (v6, decision-ready): https://claude.ai/artifact/JFP8vjD6TJfoDc7aJkNEvU
- Shared Factory Core architecture (option A, with the leaf, slice and packet work model): https://claude.ai/artifact/4Hrg4CZPK13B4FUscYVTss
- Ledger Factory design (option B, v2, solo-builder calibrated): https://claude.ai/artifact/M7qGi4PTkMheHKqKfCdZXd
- Vibe Baseline Checklist: https://claude.ai/artifact/YToFU5rw6WCV5KsuoBYyp3

## To resume
In a new session on this branch, say: **"Read docs/vibe-pilot-handoff.md and docs/vibe-pilot-spec.md, then start the build."**
