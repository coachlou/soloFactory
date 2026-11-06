Subject: Your job-match run: my bug, and it's fixed

Hi [Name],

The run that burned three of your weekly Claude windows failed because of a bug in soloFactory. Not you. Not your PRD. That's on me, and it's fixed.

On your Ubuntu (WSL) setup, Node 22 crashed right after every test had passed, because the factory sent the test report to `/dev/null`. The factory read that crash as a failed check. Then the recovery it offered re-planned all 25 features instead of the one that "failed." About 70% of the run's spend went there, rebuilding work that was never broken.

What's fixed in 0.10.6:

- **The crash** (fixed since 0.10.2).
- **Recovery stays on the failed feature.** The rest of your plan stays put.
- **Spend first.** Before you approve any recovery, you see what the run has spent so far.
- **A run-wide stop.** Once a run has used its budget, it asks you before going further.

To update, open Claude Code (or Codex) on that computer and paste this:

```
Please update my existing SoloFactory install to version 0.10.6. I'm on Windows with Ubuntu (WSL). Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md

When it's done, tell me which version it reports. Don't resume my job-match-prototype run; I'll start it fresh.
```

Before you rerun, one thing. The factory proves every check on a laptop with no network, no Windows and no live accounts, and some of yours can't pass there. So:

1. **Replace live services with sample files.** Wherever the PRD says the app fetches from Job-Room or Gmail, change it to read a saved file in `data/fixtures/`. Example: instead of "Intake pulls new jobs from Job-Room," write "Intake reads `data/fixtures/jobroom.json` and creates one Inbox card per listing." Keep the live connection in the PRD as a separate step that you test by hand. Don't make it an acceptance check.
2. **Add one saved alert email per job board.** For each job board whose alert emails the app reads, save one real alert as a `.eml` file in `data/fixtures/emails/` (remove your personal details first). Then write the check against that file, for example "Parsing `data/fixtures/emails/jobs-ch.eml` produces 3 cards." If you'd rather not collect them, write "v1 uses one generic email parser" and drop the per-board checks.
3. **Log Windows actions instead of running them.** Scheduling, desktop notifications and uninstall all change Windows itself, so in a test the app writes the command to a log file instead of running it. Write each check against the log, for example "After setup, the last logged scheduler command is `schtasks /Create … /ST 09:00`." This matters most for uninstall: a real uninstall in a test deletes the app being tested.
4. **Give every time-based check a fixed time.** The app reads the current time through one setting that a test can override. Write each check with an exact date and time, for example "With the clock set to 2 March 10:00 and the last run on 1 March, catch-up runs exactly once." Remove any check that means waiting for a real time of day, like 12:30 CET.
5. **Replace drive letters with `<DocsRoot>`.** Change every path like `D:\Bewerbungen\…` to `<DocsRoot>\Bewerbungen\…`. Add one line near the top of the PRD: "`<DocsRoot>` is a setting. On my PC it is `D:\`. In tests it is a temporary folder."

Then cut v1 to about 10 checks: fixture intake, region/fit filter, dedup, the Inbox/Shortlist/Bewerbungen cards, your decision actions and the Markdown archive. The rest becomes follow-on briefs once that skeleton runs.

Want a second pair of eyes on the rewrite? Send it over.

Lou
