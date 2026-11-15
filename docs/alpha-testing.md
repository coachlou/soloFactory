# SoloFactory 0.11.0-alpha.2: how to test and give feedback

Thank you for testing. This build is 0.11.0-alpha.2, the second alpha. It has the new Brief page and fixes from alpha.1 testing. It is not yet the stable release.

## New in alpha.2

1. A feature can now make a small edit to a file that a later feature owns. Before, the run stopped with nothing changed.
2. A final test that fails once and then passes is run one more time. The run continues, and the test is marked as flaky for the final review.
3. The factory now starts when its folder is opened through a symlink. Before, `start.sh` showed its banner and then stopped.
4. A repair plan that adds a feature next to a kept feature is no longer rejected when both write the same file.
5. One Claude turn now has a step limit. A turn that reaches it stops, and its work is kept. **Resume** starts a fresh turn.
6. A run stops repairing when the same failure comes back again and again, even after the code changed. The run then asks you what to do.
7. **Queue** on a revised brief no longer loops. Before, the Guide asked you to press Queue after every review, and Queue failed or reviewed again.

You can change the two new limits in the Manual's Settings table:

| Setting | What it does | Default |
| --- | --- | --- |
| `SOLOFACTORY_AGENT_MAX_TURNS` | Steps one Claude turn may take. 0 turns it off. | 150 |
| `SOLOFACTORY_SYMPTOM_THRESHOLD` | Same failures in a row before repair stops. 0 turns it off. | 4 |

## What is new

1. The interview and the review screens are now one **Brief** page. The brief is on the left and the Guide is on the right.
2. **View** shows the brief. **Edit** lets you click a section and change it directly. Your edits are saved at once.
3. Nothing needs a save button. The Guide box and the brief save on their own.
4. **Revise brief** on a stopped or finished run opens that run's brief in Edit mode. Changed sections are marked.
5. **Queue** first asks the Guide for a final review of the exact brief. A small change gets a short confirmation. A wide change can get a question before anything queues. Pressing again while the review runs does nothing, and a brief the review rewrote queues on the next press without a second review.

## What to try

1. Start a new project and complete a brief with the Guide.
2. Switch to Edit, change one section, and press Queue.
3. When a run stops or finishes, press **Revise brief**, make a change, and queue it again.
4. On a stopped run, press **Revise brief**, then **Queue**. It must queue the run, not ask you to press Queue again.
5. On a phone or a narrow window, open the Guide from the rail on the right.

## Known limits

1. This build had no full paid test run. Tell us about any run that stops.
2. Each Queue uses one extra Guide turn, unless that exact brief was already reviewed.
3. The "being discussed" marker is an estimate.
4. After you queue, the page does not yet show a "Queued as run X" state.
5. The *Update available* pill shows only once 0.11.0 or later is out. We will tell you about new alpha builds.
6. Windows has been tested only on WSL2, not on a real Windows machine.
7. A typical build uses about $4 to $8 of your subscription capacity. Runs stop at the cost, token and worker ceilings and ask you before they continue.

## How to give feedback

1. Press **Report a problem** in the factory, or ask your agent to *Report a problem with the factory*.
2. Read the report before you send it. It holds no brief, transcript, agent output or file paths.
3. Send it with **Open GitHub** or **Copy & open email** (support@coachlou.com).
4. Put `[alpha.2]` at the start of the title.

For ideas about the new Brief page, use the same button and choose **Improvement**.

## Updating from alpha.1

1. Stop the factory.
2. Install the alpha.2 zip the same way you installed alpha.1.
3. Start the factory again.

Your projects and runs stay in place.

## Go back to the stable release

Ask your agent to update SoloFactory with the normal update prompt:

```
Please update my existing SoloFactory install. Read the install runbook and follow its update path:

gh api -H 'Accept: application/vnd.github.raw' repos/coachlou/aimm/contents/aai-release/solofactory/INSTALL.md
```

That installs the stable release over the alpha. Your projects and runs stay in place.
