<!-- Draft for aimm-members. Not sent. Screenshots live in the linked GitHub guide (docs/update-notice.md). -->

Subject: SoloFactory 0.10.17: it now tells you when there's an update

Hi [Name],

SoloFactory 0.10.17 is out. The headline is a small feature you'll use for as long as you run the factory: **it now tells you when a newer version exists.** This is also the last update letter you need to watch for. From here on, the app tells you itself.

## The update notice

There's a new button in the top bar, next to *Manual*. When a newer SoloFactory is out, it turns into a green *Update available* pill. Click it and you get both version numbers and the exact prompt to paste into Claude Code (or Codex), with a **Copy prompt** button.

Nothing pops up over your work, a run in progress keeps going, and it never updates anything on its own. You update when it suits you. It checks only at startup, on page load and when you click the button, never in the background.

**See how it looks:** [The update notice, with screenshots](https://github.com/coachlou/soloFactory/blob/main/docs/update-notice.md)

## Also since 0.10.11

If you haven't updated in a while, these come along too:

- **Building and repairs run on Sonnet.** Opus still plans and checks the work. In my test builds the apps came out the same, and each feature used about a third less of your plan, so a 5-hour window lasts much longer. To keep Opus for everything, start with `SOLOFACTORY_CLAUDE_MODEL=opus bash start.sh`.
- **"Safe to resume?" on the stopped-run card.** When a run stops, the card says whether it stopped on a usage limit or an error, and whether it made progress since your last Resume. If it did, resume. If it stopped again on the same feature with the same checks passing, choose **Report this run** and send it to me.
- **Every model setting is in the manual.** *Settings* now lists the Claude and Codex model and effort variables with their defaults.
- **Fewer false failures from the test command.** Runs set up the test command correctly from the first feature, so they no longer pay for a repair on a test script that was never wired up.

## How to update

This one last time, the email is your notice. Open Claude Code (or Codex) on the computer where SoloFactory lives. On Windows, open it in the Ubuntu window, not in PowerShell. Then paste this:

```
Please update my existing SoloFactory install to version 0.10.17. Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md

If `gh` isn't found, you're on the Windows side: run the same command inside Ubuntu with `wsl -e` in front of it. When it's done, tell me which version it reports.
```

It doesn't matter which version you're on now. The runbook handles the steps from there, and your projects carry over as they are. After this, watch for the green pill.

Questions, or a run that looks off? Reply and send me the run page.

Lou
