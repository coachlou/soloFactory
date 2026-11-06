# PRD audit: job-match-prototype (why the Claude run ran away)

Scope: the PRD only (`PRD — job-match-prototype.txt`, 32 KB, Windows job-search assistant for one user). Factory v0.10.3, `claude -p` workers, opus. Member run logs were not available; see "Not determinable" at the end.

## Bottom line

The PRD is a fine brief for one agentic session (which is why Antigravity, the tool it was written for, built it in one pass). It is lethal for soloFactory's prove-every-clause regime: 52 frozen checks, a third of them asserting outcomes only a Windows desktop with a live Gmail account and a local Antigravity binary can produce. Each such check becomes a reviewer blocker by construction, each blocker becomes a repair, and each repair is an opus turn of up to 45 minutes. The run did not loop on a bug. It looped on requirements that cannot be true on the machine running the proofs.

Three causes most likely burned the budget, in order:

1. Matching and dossiers are routed through a Windows-only binary (`agy.exe`) and the acceptance text names it.
2. Windows platform artefacts (scheduled task, shortcut, logon entry, notifications, uninstall) are asserted as real outcomes.
3. Scope: 23 must-haves + 29 scenarios, each needing one closing feature and a passing proof, multiplied by the repair/recovery budget.

## Finding 1 — Antigravity CLI as a hard dependency (highest cost)

PRD passages: §3.4 "two-tier matching ... via the local Antigravity CLI (`agy.exe` at a user-profile path)"; §3.8 dossier generation via Antigravity; MH-9, MH-11, MH-12, MH-13 ("zero paid external API keys"); SC-10, SC-11 (French dossier), SC-11b (de-CH, no ß), SC-12/SC-13 ("when evaluated via Antigravity CLI ... penalized score").

Why it loops: the feature plan must list `agy.exe` under `compatibility` as "verified"; anything else throws `Unresolved compatibility` in `wbs.mjs` and the plan goes to corrections, up to 3× `maxRepairs` rounds, each a full opus plan turn. If the planner marks it verified anyway, every build proof touching matching fails and the reviewer, bound by REVIEW_BAR ("a check that cannot run on this machine is a blocker, never something to skip or fake"), blocks MH-9/11/12/13 and SC-10 to 13 on every review. §8.3 says the CLI is injectable with a fixture, but SC-12 says "evaluated via Antigravity CLI", and the reviewer audits the SC text verbatim. The fixture is then "not the observable result the case names" and gets blocked too. Language and orthography checks (SC-11, SC-11b) judge generated text a headless reviewer cannot generate.

Rewrite: make the adapter the thing under test. "MH-9: Matching runs through a `Matcher` interface; the default implementation shells out to the configured CLI path, the test implementation returns fixture scores from `data/fixtures/matches/`. SC-12: with the fixture matcher, the Gastroenterologie ad scores below 40 and the gap list names 'Fachgebiet'." Move MH-13 to Non-goals ("no paid API keys") and reword SC-11/11b as post-processing assertions on fixture text ("a dossier produced from a French fixture ad keeps `language: fr` in its front matter; de-CH post-processing turns 'Straße' into 'Strasse'").

Factory-side alternative: none cheap. The compatibility gate is doing its job.

## Finding 2 — Windows platform artefacts asserted as outcomes

PRD passages: MH-1 (boot-time catch-up), MH-17 (desktop notifications), MH-22 (uninstall removes scheduled task, shortcut, logon entry, program folder, DB, credentials); SC-19, SC-20 (notification shown / not shown), SC-21 (catch-up after missed slot), SC-22 ("the Windows scheduled task is registered for 09:00"), SC-25, SC-26 (full uninstall, DocsRoot untouched); §3.6 "Im Explorer öffnen".

Why it loops: HOST_RULE says checks run only on this machine, no VM or other OS. §8.1 says non-Windows reports `not-applicable`, but the SC text asserts the Windows result, so the reviewer blocks it on macOS or Linux and on Windows too, because `schtasks`, shortcut creation and toast notifications are outside the proof allowlist (npm/node/npx only, no shell). Nine checks that can never pass, re-blocked on every review round, each sending a repair turn. Hazard on top: SC-25's "program folder removed" is the factory workspace. A literal proof deletes the app under test and the next gate fails on a missing `package.json`.

Rewrite: assert the recorded command, not the OS state. "SC-22: after saving 09:00 in Settings, the scheduler adapter's last call is `schtasks /Create ... /ST 09:00` (recorded in `data/adapter-log.jsonl`); on non-Windows the adapter records `not-applicable` and the test passes." Same shape for notifications (recorded payload), uninstall (recorded removal list, never executed against the repo), and Explorer (recorded `explorer.exe <path>`).

## Finding 3 — Scope × repair budget

PRD passages: §3.1 to §3.12 (8 intake sources, 7 email digest formats with no samples, 2-stage dedup with agency safeguard, 7-state pipeline, 6 UI sections, settings, uninstall, search, notifications, scheduler, health/metrics); §9: 23 MH + 29 SC.

Why it loops: 52 frozen checks, each needing exactly one closing feature, so the planner lands near the 30-feature cap. Per feature: 1 build + up to 2 repairs + a scoped review + up to 4 review repairs, each an opus turn of up to 45 minutes. Plan phase alone: 1 plan + audit + up to 6 correction rounds. Every time the run parks and the owner approves a recovery, `totalRepairLimit` is refilled (`attempt + maxRepairs × (slices + 1)`), and the recovery request carries the full source set plus prior plan, so those prompts grow toward the 200K cap. That refill is the mechanism that turns one parked run into a week of usage: no single loop is unbounded, but each approval buys another full round.

Rewrite: cut v1 to what fixtures can prove in about 10 checks. Intake from fixture files (Job-Room JSON + three sample emails), region/fit filter, dedup, Inbox/Shortlist/Bewerbungen cards, decision actions, Markdown archive. Everything else (IMAP parsers per digest format, expiry sweep, settings, uninstall, notifications, dossiers, search) becomes a follow-on brief; the factory has `followOn` for this.

Factory-side: cap approvals per run or show cumulative turns and tokens at each recovery prompt so the owner sees the refill cost before saying yes.

## Secondary findings

| # | PRD passage | Why it costs turns | Rewrite |
|---|---|---|---|
| 4 | MH-2, MH-2b, MH-16, SC-1 to SC-7, SC-24: live Job-Room API, Gmail IMAP with a 16-char App Password, ad-page fetch with redirect/403/429/CAPTCHA handling, 404 expiry sweep | PLAN_CHECKLIST forbids proofs that depend on network. No credentials exist on the build machine. Blocked or `not-applicable` on every review. | "Intake sources are adapters with a fixture implementation under `data/fixtures/`; acceptance runs against fixtures. Live mode is manual, out of scope for acceptance." |
| 5 | §3.7 12:30 CET slot, 10-day reminder, ±3-day dedup window, 1–2 s throttle, boot catch-up | Wall-clock-dependent proofs are forbidden by PLAN_CHECKLIST; tests either sleep (time out at 5 min) or get blocked. | Inject a clock. "SC-21: with the clock set to 2026-03-02 10:00 and last run 2026-03-01, catch-up fires once." |
| 6 | MH-6, MH-11, MH-22 hard-code `D:\App-for-job-gemini\...`, `%LOCALAPPDATA%`, a `C:\Users\<name>\...` path | DATA_RULE puts owner data under `data/`. §8.2 says paths are config, but the MH text names drive letters, so a reviewer blocks tests that write to `./data/`. | Replace every literal path in §9 with `<DocsRoot>` / `<AppData>` and state the test default once. |
| 7 | §3.1 seven proprietary digest formats (jobs.ch, JobScout24, Indeed, LinkedIn, ...) with no sample emails | Builder invents HTML fixtures and parsers; reviewer cannot verify against the real format and blocks or passes arbitrarily, both costing rounds. | Ship 1 sample `.eml` per board under `data/fixtures/mail/` or drop boards to one generic parser for v1. |
| 8 | §3.4 "calibrated 0–100 score", §3.8 "language of the ad", de-CH orthography | Fuzzy judgments of generated text; reviewer has no deterministic oracle. | Replace with thresholds on fixture inputs ("fixture A scores ≥ 70, fixture B ≤ 40") and a fixed ß→ss replacement test. |
| 9 | §3 density overall | `slices.json`, recovery requests (checks + blockers + full `sources` + prior plan) and plan-correction prompts trend toward `MAX_PROMPT_CHARS` 200K; an oversized prompt parks the run as needing a factory fix. | Same as Finding 3: shorter brief, fewer checks. |

## Why Antigravity succeeded

Same PRD, different regime. Antigravity is `agy`, so Finding 1 was a feature, not a blocker. It ran on the member's Windows machine with the Gmail account and docs folder present, so Findings 2, 4 and 6 were simply true. And it has no frozen contract and no reviewer that must give every check a status with evidence, so an unverifiable clause costs nothing. That is not an argument that the PRD is good; it is an argument that soloFactory's acceptance text must be written for a headless reviewer with no network, no credentials and no OS.

## Not determinable without the member's run logs

- Which stage consumed the budget: plan corrections, per-feature repairs, final-review repairs, or recovery phases.
- Whether the interview rewrote `mustHaves` / `acceptanceScenarios` or copied §9 verbatim (this decides which of the 52 checks were frozen).
- The member's OS, whether `agy.exe` and the Gmail credentials were present, and how the planner marked compatibility.
- How many features the planner produced and how many recovery approvals the member gave.
- Whether `SOLOFACTORY_MAX_REPAIRS` or the hard-minute cap were overridden.
- Whether an oversized-prompt park occurred.

## What to tell the member

Rewrite §9 so every MH and SC is provable with fixtures on a laptop with no network and no Windows, as in Findings 1, 2 and 4 to 6. Cut v1 to the ~10 checks in Finding 3. Expect the result to be the walking skeleton, with the live integrations wired by hand or as follow-on briefs.
