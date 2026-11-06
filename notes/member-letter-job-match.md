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

1. **Fixtures, not live services.** Intake reads Job-Room JSON and sample emails from `data/fixtures/`; live Gmail and Job-Room stay outside acceptance.
2. **One sample `.eml` per job board**, or one generic parser for v1.
3. **Record the Windows command, don't run it.** "The scheduler's last recorded call is `schtasks /Create … /ST 09:00`." Same for notifications and uninstall (a real uninstall test deletes the app it's testing).
4. **An injected clock.** "With the clock at 2 March 10:00 and the last run on 1 March, catch-up fires once." No waiting for 12:30 CET.
5. **`<DocsRoot>`, not `D:\`.** Swap every drive letter for `<DocsRoot>` and state the test default once.

Then cut v1 to about 10 checks: fixture intake, region/fit filter, dedup, the Inbox/Shortlist/Bewerbungen cards, your decision actions and the Markdown archive. The rest becomes follow-on briefs once that skeleton runs.

Want a second pair of eyes on the rewrite? Send it over.

Lou
