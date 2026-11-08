Segment: gears_owners (012ce100-aa6e-4ff5-be55-f169baa381bc)
From: Coach Lou <support@coachlou.com>
Reply-to: CoachLou <support@coachlou.com>
Subject: SoloFactory 0.10.13: same apps, about a third less usage
Preview: Sonnet now does the building, plus a spending limit per run and a clear answer on when to press Resume.

---

GEARS OWNERS GROUP

Hi {{{FIRST_NAME}}},

SoloFactory 0.10.13 is out. It's the biggest practical change since launch: the same apps now use noticeably less of your Claude plan.

WHAT'S NEW

- **Building and repairs run on Sonnet.** Opus still does the planning and the checking. Sonnet now writes the code and fixes it. In our test builds the results matched, and each feature cost about a third less. On a subscription, that means your 5-hour usage window lasts much longer. If you'd rather keep Opus for everything, start SoloFactory with `SOLOFACTORY_CLAUDE_MODEL=opus bash start.sh`.
- **A spending limit per run.** A run now pauses once Claude has reported about $30 of cost for it. On a subscription that isn't a bill. It's a gauge of how fast the run uses your plan. Nothing is lost: press Resume and it gets another $30. To set a tighter limit, set `SOLOFACTORY_MAX_RUN_COST_USD` to a lower number, like `10`. Setting it to `0` turns the limit off.
- **"Safe to resume?" on the run card.** When a run stops, the card now tells you whether it has made progress since the last Resume. If it has, resume. If it stopped again on the same feature with the same checks passing, it's stuck, not slow. Choose **Report this run** and send it to me.
- **Your draft brief survives a closed tab.** Close the Guide mid-interview and your draft is still there when you come back.
- **Long checks get rewritten.** Suppose your brief says something like "recordings up to 6 hours" or "delete after 30 days." The Guide turns that check into a short sample or a test clock, so the factory can prove it in seconds.
- **Fewer false failures.** Test commands are set up correctly from the first feature, so runs no longer stall on a test script that was never wired up.

HOW TO UPDATE

Open Claude Code (or Codex) where SoloFactory is installed and paste this. On Windows, do it in your Ubuntu window, not PowerShell.

    Please update my existing SoloFactory install to version 0.10.13. Read the install runbook and follow its update path:

    gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md

    If `gh` isn't found, you're on the Windows side: run the same command inside Ubuntu with `wsl -e` in front of it. When it's done, tell me which version it reports.

It doesn't matter which version you're on now. The runbook handles the steps from there, and your projects carry over as they are.

Questions, or a run that looks off? Reply to this email and send me the run page.

To your growth,

Lou

Service. Impact. Joy. Prosperity.
