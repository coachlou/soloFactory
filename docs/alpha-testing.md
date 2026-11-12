# SoloFactory 0.11.0 alpha: how to test and give feedback

Thank you for testing. This build is an alpha. It has a new Brief page and is not yet the stable release.

## What is new

1. The interview and the review screens are now one **Brief** page. The brief is on the left and the Guide is on the right.
2. **View** shows the brief. **Edit** lets you click a section and change it directly. Your edits are saved at once.
3. Nothing needs a save button. The Guide box and the brief save on their own.
4. **Revise brief** on a stopped or finished run opens that run's brief in Edit mode. Changed sections are marked.
5. **Queue** first asks the Guide for a final review of the exact brief. A small change gets a short confirmation. A wide change can get a question before anything queues.

## What to try

1. Start a new project and complete a brief with the Guide.
2. Switch to Edit, change one section, and press Queue.
3. When a run stops or finishes, press **Revise brief**, make a change, and queue it again.
4. On a phone or a narrow window, open the Guide from the rail on the right.

## Known limits

1. Each Queue uses one extra Guide turn, unless that exact brief was already reviewed.
2. The "being discussed" marker is an estimate.
3. After you queue, the page does not yet show a "Queued as run X" state.
4. The *Update available* pill does not show on an alpha build. We will tell you when the next build is ready.
5. Windows has been tested only on WSL2, not on a real Windows machine.
6. A typical build uses about $4 to $8 of your subscription capacity. Runs stop at the cost, token and worker ceilings and ask you before they continue.

## How to give feedback

1. Press **Report a problem** in the factory, or ask your agent to *Report a problem with the factory*.
2. Read the report before you send it. It holds no brief, transcript, agent output or file paths.
3. Send it with **Open GitHub** or **Copy & open email** (support@coachlou.com).
4. Put `[alpha]` at the start of the title.

For ideas about the new Brief page, use the same button and choose **Improvement**.

## Go back to the stable release

Ask your agent to update SoloFactory with the normal update prompt:

```
Please update my existing SoloFactory install. Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md
```

That installs the stable release over the alpha. Your projects and runs stay in place.
