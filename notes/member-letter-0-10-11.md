Subject: SoloFactory 0.10.11 is now available

Hi [Name],

0.10.11 is out. Three changes, all from member runs.

- **A spending limit per run.** A run now parks once Claude has reported about $30 of cost for it. On a subscription that's not a bill; it's a gauge of how fast the run eats your usage limits. Nothing is lost. Press Resume and it gets another $30. Want a tighter leash? Set `SOLOFACTORY_MAX_RUN_COST_USD` to a lower number, like `10` (`0` turns it off). A run that's already past $30 when you update parks at its next step, so you decide before it spends more.
- **Your draft brief survives a closed tab.** Close the Guide mid-interview and the draft is still there when you come back. Start over clears it.
- **Checks that need hours of real time get rewritten.** If your brief says something like "recordings up to 6 hours" or "delete after 30 days," the Guide turns that check into a short sample or a test clock and keeps the long limit as a setting. The factory can then prove it in seconds instead of waiting it out.

To update, open Claude Code (or Codex) on the computer where SoloFactory lives. On Windows, open it in the Ubuntu window, not in PowerShell. Then paste this:

```
Please update my existing SoloFactory install to version 0.10.11. Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md

If `gh` isn't found, you're on the Windows side: run the same command inside Ubuntu with `wsl -e` in front of it. When it's done, tell me which version it reports.
```

The runbook handles the steps from whichever version you're on, so you don't need to update in between. Your projects carry over as they are.

**"How do I know Resume isn't just feeding a loop?"** Fair question. A run can't spin forever on its own. Each feature gets two repair tries, then it stops and asks you. The same failure on the same version stops without spending more. No single worker runs past 45 minutes. And now each Resume buys at most one more spending allotment. So a bad Resume costs you one allotment, not an open-ended run. On a Pro plan, $30 of work can be more than one 5-hour window, so start SoloFactory with `SOLOFACTORY_MAX_RUN_COST_USD=10 bash start.sh` to keep each Resume small.

To decide whether to press it, look at the feature map before and after:

- **Resume** if the run has moved since the last stop: more features verified, or more of the current feature's checks passing.
- **Don't** if you've resumed once and it stopped again on the same feature with the same checks passing, or the card says your last approvals "verified no features." That's stuck, not slow. Choose **Report this run** on the stopped card and send it to me. It attaches the evidence and the log, and I'll tell you what's blocking it.

Questions or a run that looks off? Reply and send me the run page.

Lou
