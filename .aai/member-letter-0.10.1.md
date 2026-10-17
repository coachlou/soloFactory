**Subject:** SoloFactory 0.10.1 is ready for everyone

Hi everyone,

SoloFactory 0.10.1 is out, and it's on the Ambient Library GitHub now. A small group of testers had 0.10.0 first. Before opening it to everyone, I ran real builds on both Claude and Codex, from the first prompt to a finished app, and fixed everything that broke along the way. Three things broke, and all three are fixed in 0.10.1.

**What you get if you're updating from 0.9.7**

- **Builds are faster and use less.** On the same test app, a build went from 55 minutes to 35 and used about a third fewer tokens. The factory no longer redoes work it has already done.
- **One feature at a time.** Each feature gets built, checked and signed off before the next one starts. When one gets stuck, only that feature is planned again, and the rest of your app stays put.
- **The plan gets checked before any code is written.** A separate reviewer reads the plan against what you asked for. Mistakes get caught on paper, where they're cheap to fix.
- **Your computer is better protected.** Each feature says up front which files it will change, and the factory stops any feature that touches a file it didn't list. The agents building your app also can't install software on your computer anymore.
- **You'll know when a build needs you.** The run page shows your build as a map of stops, and an amber note appears at the top of every page when something is waiting on you.

**What 0.10.1 fixed**

- **A wrong reviewer test no longer traps your build.** Sometimes the reviewer writes a check that is itself broken, and the build gets stuck failing it. You now get a **Waive** button on the run page. Write a sentence on why the check is wrong, and the factory carries on and finishes the build.
- **Newer Node is fine.** If you have a newer version of Node than the plan asks for, the factory used to stop. Now it carries on.
- **Early tests no longer lock in later changes.** A test written for one feature could block a later feature that legitimately changed the same behavior. That's fixed.

**How to install or update**

Open your own Claude Code or Codex, paste this in, and follow along one step at a time.

Already have SoloFactory:

```
Update SoloFactory on this computer. Follow the runbook at https://raw.githubusercontent.com/coachlou/ambient-library/main/library/solofactory/INSTALL.md exactly. I already have SoloFactory installed, so use the update path, not the new-install path. Give me one step at a time.
```

New to SoloFactory:

```
Install SoloFactory on this computer. Follow the runbook at https://raw.githubusercontent.com/coachlou/ambient-library/main/library/solofactory/INSTALL.md exactly, one step at a time.
```

An update takes a couple of minutes and leaves your projects alone. If you have a build that's halfway through, let it finish first, because an unfinished build may have to start over afterward. When the update is done, the header should say 0.10.1.

Hit reply or use the **Feedback** button in the header if anything misbehaves. If a build goes wrong partway through, click **Report this run** at the top of that run's page before you do anything else. That sends me what I need to see what happened.

Lou
