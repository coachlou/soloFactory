# Installing SoloFactory — agent runbook

**You are the installer.** The person reading your messages is the *owner*. Assume they are
not technical: they do not know what a shell, a PATH, a package manager, or a runtime is,
and they should not have to learn. Your job is to get them from "nothing" to "a working
SoloFactory open in their browser" without ever making them understand the machinery.

This document is for you, not for them. Never paste it at them. Never show them this file's
headings, step numbers, or jargon. Translate everything into plain language.

---

## Rules of engagement

**1. One instruction at a time.** Give one copy/paste block, wait for them to report back,
then move on. Never hand over a wall of five commands.

**2. Every command goes in a copy/paste box** with a plain-language sentence before it
saying what it does, and a plain-language sentence after saying what they should see.

Say it like this:

> This installs the piece that runs SoloFactory. Copy the line below, paste it into the
> black window, and press Enter. It will take about a minute and print a lot of text —
> that's normal. Tell me when it stops and gives you a fresh line to type on.

**3. Never show them a raw error.** If a command fails, read the error yourself, fix it, and
tell them in one sentence what you're doing: "That needed one more piece — installing it
now, one more paste and we're past it."

**4. Fix, do not defer.** Do not tell the owner "you may need to install X." Detect it, and
either fix it in the same breath or hand them the one command that fixes it. Never finish
with a caveat list. Never leave a known-broken install and call it done.

**5. If you cannot fix it yourself, ask precisely.** Some things need the owner's password
or an administrator prompt, and you cannot type those. When you hit one, hand them the exact
command, tell them a password prompt will appear, and warn them that **the password will not
show any characters as they type — that is normal, not a broken keyboard.**

**6. Never invent a step.** Everything you need is in this document. If reality diverges
from it, say so plainly and stop rather than improvising.

---

## What you are installing

SoloFactory is a small web app that runs **on the owner's own computer**. They open it in
their browser at `http://127.0.0.1:4173`, answer an interview about what they want built,
and it drives their own Claude Code or Codex subscription to build it.

Two consequences that shape this whole runbook:

- **It needs a signed-in `claude` or `codex` CLI.** Without one, the app starts but refuses
  to build with *"Select an authenticated subscription provider."* There are no API keys to
  enter — a subscription login is the whole authentication story.
- **The last step is a browser, not a command.** Success looks like a web page, and you must
  tell them that before they see it.

Unlike its sibling the Software Development Factory, SoloFactory has **no sandbox layer and
no macOS requirement**. Nothing here needs a confinement setting.

---

## The one ordering rule that matters

**Install and sign in to the coding agent BEFORE you start SoloFactory.**

Nothing is written to a file this time — the app checks for the CLI every time it starts.
But if they open the web page before signing in, they see a dead provider list, conclude the
install failed, and you spend the next ten minutes undoing that impression.

Correct order, both platforms: **git → Node 22+ → coding agent (installed AND logged in) →
SoloFactory installer → start it.**

---

## Step 0 — Ask which computer

This is your first question. Ask exactly this, and nothing else:

> Quick first question: are you on a Mac, or on Windows?

- **Mac** → go to **Track A**.
- **Windows** → go to **Track B**.
- If they don't know: ask if the machine has an Apple logo on it. Apple logo → Mac.

Do not ask about versions, chips, terminals, or anything else yet. You will detect all of
that yourself.

---

# Track A — macOS

## A1. Open the terminal

> I need you to open a program called Terminal. Press `Command` and the `Space bar` at the
> same time, type the word `terminal`, and press Enter. A window with plain text in it will
> open. That's where everything goes.

If they say a black-and-white text window is open, continue.

## A2. Check what's already there

Give them this single block. It checks everything at once and prints a tidy report.

```sh
echo "macOS: $(sw_vers -productVersion)"; \
echo "git: $(git --version 2>/dev/null || echo MISSING)"; \
echo "node: $(node --version 2>/dev/null || echo MISSING)"; \
echo "claude: $(command -v claude 2>/dev/null || echo MISSING)"; \
echo "codex: $(command -v codex 2>/dev/null || echo MISSING)"
```

> This just looks around and tells me what's already on your machine. It changes nothing.
> Paste the whole thing, press Enter, then copy everything it prints back to me.

Read the report yourself. Then handle only what's missing:

| Line says | What to do |
|---|---|
| `git: MISSING` | A3 |
| `node: MISSING` or a version below `v22` | A4 |
| both `claude:` and `codex:` are `MISSING` | A5 |
| everything present and `node` ≥ v22 | skip to A6 |

**Reading the node version:** it prints like `v22.12.0` or `v24.3.0`. The requirement is
major version **22 or higher** — `v22.0.0` passes, `v20.19.0` does not.

**macOS already has** `curl`, `tar`, `rsync`, and `bash`. Do not install those, and do not
mention them.

## A3. Install git (only if missing)

git ships with Apple's developer command line tools.

```sh
xcode-select --install
```

> This asks macOS to install Apple's developer tools, which include a piece SoloFactory
> needs. A grey system window will pop up asking you to confirm — click **Install**, then
> **Agree**. It downloads in the background and can take five to ten minutes. Tell me when
> the pop-up says it's done.

When they report done, verify:

```sh
git --version
```

Expect something like `git version 2.39.5`. If the pop-up said the tools are *already
installed* but `git --version` still fails, that is the one macOS case worth escalating —
tell them their developer tools are damaged and the fix is `sudo rm -rf
/Library/Developer/CommandLineTools` followed by re-running `xcode-select --install`, and
that it will ask for their Mac password.

## A4. Install Node (only if missing or too old)

Do **not** send a non-technical owner to Homebrew. Use Apple's own installer package.

> SoloFactory runs on something called Node. I'll have you download it the normal way —
> like installing any other Mac app.
>
> 1. Go to **https://nodejs.org**
> 2. Click the big green download button on the left (the one that says **LTS**).
> 3. Open the file that lands in your Downloads folder.
> 4. Click Continue / Agree / Install through the windows. It will ask for your Mac password
>    near the end — type it and press Enter. The password stays invisible while you type;
>    that's normal.
> 5. Tell me when it says the installation was successful.

Then have them **close the Terminal window and open a fresh one** (the old window cannot see
newly installed programs), and verify:

```sh
node --version
```

Expect `v22` or higher. If it still says missing in a *fresh* window, the installer did not
finish — have them re-open the downloaded file and complete it.

## A5. Install and sign in to the coding agent

SoloFactory does not think for itself; it drives the owner's coding-agent CLI. Claude Code
is the default here.

> SoloFactory works by directing an AI coding assistant. Let's install it.

```sh
npm install -g @anthropic-ai/claude-code
```

> This installs the assistant. It'll print a few lines and take under a minute.

**If that fails with `EACCES` or `permission denied`**, do not reach for `sudo` — it leaves
the owner with root-owned files that break later installs. Fix it properly by giving npm a
folder in their own home directory. Hand them this as one block:

```sh
mkdir -p ~/.npm-global && \
npm config set prefix ~/.npm-global && \
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc && \
export PATH=~/.npm-global/bin:$PATH && \
npm install -g @anthropic-ai/claude-code
```

> That hit a permissions snag — this fixes it and finishes the install in one go.

Now sign in:

```sh
claude
```

> This opens the assistant and asks you to sign in. It'll open your web browser — log in
> with your Anthropic account and come back. Once it shows you a prompt where you could type
> a message, you're signed in: press `Control` and `C` together twice to close it, and tell
> me you're back at the plain text screen.

**The sign-in must be a subscription account, not an API key.** SoloFactory deliberately
rejects API-key authentication and will report the provider as unauthenticated. If the owner
mentions pasting a key anywhere, stop and have them sign in through the browser instead.

Verify it is on the PATH — this is the check that protects the ordering rule:

```sh
command -v claude
```

Expect a path such as `/usr/local/bin/claude` or `/Users/<name>/.npm-global/bin/claude`.
**If this prints nothing, stop.** Have them close the Terminal and open a fresh window, then
run it again.

## A6. Install SoloFactory

Ask where it should live. Default to a folder named `solofactory` in their home directory,
and do not make them choose a path if they have no opinion.

```sh
cd ~ && curl -fsSL https://raw.githubusercontent.com/coachlou/ambient-library/main/library/ambient-folder/bootstrap.sh | bash -s -- solofactory solofactory
```

> This is the real one — it sets up SoloFactory in a folder called `solofactory` in your home
> directory. It'll print a list of files as it goes. Send me everything it prints.

It ends with a `start:` line naming the launcher and the web address. Treat any line
beginning with `warn` as a failure to fix, not a note to pass along — see **Fixing a bad
install**.

Go to **C1**.

---

# Track B — Windows

SoloFactory's launcher and installer are Linux/Mac shell scripts, and the commands it runs
to build and test a project spawn bare names like `npm` that do not resolve to Windows shims
without a shell. So on Windows it runs inside WSL2 — a real Ubuntu Linux that Microsoft
ships as a standard Windows feature.

**WSL2 is a requirement on Windows, not a fallback.** There is no native-Windows path;
do not try to build one. B1 walks through installing it if it is absent, and converting it
if the machine has the older WSL1.

**Never explain WSL2 to the owner.** To them it is "a Linux window that Windows comes with,"
and after setup it is just "the Ubuntu window." Nothing more.

The good news: the browser part still works normally. They will open Chrome or Edge on
Windows as usual and go to the same address.

## B1. Set up the Linux window (WSL2)

**WSL2 is a hard requirement on Windows.** WSL1 is not sufficient — it emulates Linux
syscalls rather than running a real kernel, and the differences show up as confusing
failures much later, long after the point where you could connect them to the cause. If the
owner has WSL1, convert it here.

### B1a. Check what they already have

Many machines already have some of this. Find out before installing anything.

> Windows needs one component switched on. Microsoft includes it — we may just need to turn
> it on, or you may already have it.
>
> 1. Click the Start button and type `powershell`.
> 2. **Right-click** on *Windows PowerShell* in the results and choose **Run as
>    administrator**. A window will ask "do you want to allow this app to make changes" —
>    click **Yes**.
> 3. A blue window opens. Paste this in and press Enter, then send me everything it prints:

```powershell
wsl --status; wsl --list --verbose
```

> This only looks around and reports back. It changes nothing.

Read the output yourself and pick exactly one row:

| What you see | Meaning | Go to |
|---|---|---|
| `'wsl' is not recognized...` | WSL is not installed at all | **B1b** |
| An error mentioning *no installed distributions*, or an empty list | WSL is on, no Linux installed | **B1c** |
| A list with a distro at `VERSION  2` | Already correct | **B1e** |
| A list with a distro at `VERSION  1` | WSL1 — must be converted | **B1d** |
| Any mention of *WSL 1* as the default version | Default is wrong | **B1d** |

If the list shows several distros, prefer an Ubuntu one at VERSION 2. Tell the owner which
name you picked and use that name consistently from here on.

### B1b. Install WSL2 from scratch

```powershell
wsl --install
```

> That downloads and switches on the Linux component. When it finishes it will tell you to
> restart your computer. **Restart it.** Tell me once you're back and logged in.

**If it says `wsl` is not a recognized command even now**, their Windows is too old for the
one-line installer. Check the version:

```powershell
winver
```

WSL2 needs Windows 11, or Windows 10 version 2004 / build 19041 or higher. If they are
below that, the honest answer is that their Windows needs updating first — send them to
Settings → Windows Update, and stop until that is done. Do not attempt the legacy manual
WSL install with a non-technical owner; it is a six-step registry-and-reboot dance and it
is not worth it.

After the restart, go to **B1e**.

### B1c. Install Ubuntu (WSL is on, but there is no Linux)

```powershell
wsl --set-default-version 2
```

> This makes sure the right version is used. It prints one line.

```powershell
wsl --install -d Ubuntu
```

> This installs Ubuntu itself. It downloads for a few minutes.

Go to **B1e**.

### B1d. Convert an existing WSL1 install to WSL2

Set the default first so anything installed later is correct:

```powershell
wsl --set-default-version 2
```

Then convert their existing distro, replacing `Ubuntu` with the exact name from the list in
B1a if it differs:

```powershell
wsl --set-version Ubuntu 2
```

> This upgrades your existing Linux to the newer version. **It can take ten or twenty
> minutes and will look stuck partway through — leave it alone and let it finish.** Tell me
> when it says the conversion is complete.

Then confirm it actually took:

```powershell
wsl --list --verbose
```

The distro must now show `VERSION  2`. If it still shows `1`, the conversion failed — the
usual cause is the virtualization problem below.

Go to **B1e**.

### B1e. Open Ubuntu and create the Linux account

> Click Start, type `ubuntu`, and open it.
>
> The first time it runs it sets itself up for a couple of minutes, then asks you to create a
> username and password. Use anything you'll remember — this is separate from your Windows
> login. **When you type the password, nothing at all will appear on screen. That's normal —
> it's still working. Type it and press Enter.** It'll ask you to type it a second time to
> confirm.
>
> Tell me when you see a line ending in a `$` sign.

If it opens straight to a `$` with no setup, the account already exists and that is fine.

**From here on, every command goes in the Ubuntu window, not PowerShell.** State this
plainly once, and if a later command behaves strangely, first confirm which window they
pasted into — mixing them up is the single most common Windows failure.

### B1f. When WSL will not install at all

**If any of the above fails with a virtualization error**, the machine has hardware
virtualization disabled in its BIOS. You cannot fix that from software. Tell the owner
plainly that their computer has a setting switched off that only they can change, that it
requires going into the machine's start-up settings, and that it varies by manufacturer —
they should search their PC model plus "enable virtualization in BIOS," or ask whoever
supports their computer. Do not attempt to walk them through a BIOS blind.

Two other real causes worth recognising before you blame the BIOS: a virtual machine that
does not pass virtualization through to the guest, and a corporate laptop where an
administrator has blocked WSL by policy. In both cases the owner cannot fix it alone —
say so and stop rather than looping.

## B2. Check and install the Ubuntu essentials

Unlike macOS, a fresh Ubuntu has almost none of this. Check first:

```sh
echo "git: $(git --version 2>/dev/null || echo MISSING)"; \
echo "curl: $(command -v curl 2>/dev/null || echo MISSING)"; \
echo "rsync: $(command -v rsync 2>/dev/null || echo MISSING)"; \
echo "node: $(node --version 2>/dev/null || echo MISSING)"; \
echo "claude: $(command -v claude 2>/dev/null || echo MISSING)"
```

> This just looks around and reports back. It changes nothing.

Then install whatever is missing. `rsync` is genuinely required — the installer copies files
with it — and a fresh Ubuntu usually lacks it. This one block covers git, curl and rsync
together:

```sh
sudo apt update && sudo apt install -y git curl rsync
```

> This installs the missing pieces. It will ask for the password you just created for Ubuntu
> — **the password stays invisible as you type it.** Then it prints a few screens of text for
> a minute or two.

## B3. Install Node on Ubuntu

Ubuntu's built-in Node is far too old. Use NodeSource, which is the standard way to get a
current Node on Ubuntu.

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

> This installs the engine SoloFactory runs on. It'll ask for your Ubuntu password again and
> print a couple of screens of text.

Verify:

```sh
node --version
```

Expect `v22` or higher.

## B4. Install and sign in to the coding agent

```sh
sudo npm install -g @anthropic-ai/claude-code
```

Then sign in:

```sh
claude
```

> This opens the assistant and asks you to sign in. It will print a web link — hold `Control`
> and click it, or copy it into your browser. Log in with your Anthropic account, then come
> back. Once you see a prompt where you could type a message, press `Control` and `C`
> together twice to close it.

As on Mac: it must be a **subscription** sign-in, not an API key.

Verify — same protective check:

```sh
command -v claude
```

**If this prints nothing, stop and fix it before installing SoloFactory.**

## B5. Install SoloFactory

**It must live inside the Ubuntu home folder, never in `/mnt/c/`.** Windows drives mounted
into Linux have different file permissions and are dramatically slower, and git behaves
incorrectly on them. `cd ~` handles this; do not let the owner talk you into a Windows path
like `C:\Users\...`.

```sh
cd ~ && curl -fsSL https://raw.githubusercontent.com/coachlou/ambient-library/main/library/ambient-folder/bootstrap.sh | bash -s -- solofactory solofactory
```

> This is the real one — it sets up SoloFactory. Send me everything it prints.

Go to **C1**.

---

# Part C — Both platforms

## C1. Start it, safely, the first time

Verify the folder first:

```sh
ls ~/solofactory
```

Expect to see `start.sh` and `projects` listed, among others.

Now start it in **demo mode** for the first launch. Demo mode is deterministic and spends
**none** of the owner's subscription quota, which makes it the correct way to prove the
install works before anything costs them anything.

```sh
cd ~/solofactory && SOLOFACTORY_DEMO=1 bash start.sh
```

Tell them what to expect *before* they paste it — the behaviour is unusual and reads as a
hang if unexplained:

> This starts it up. Two things to know: it prints a web address and then **looks like it's
> frozen** — it isn't, that's it running and waiting for you. And this first run is a free
> practice mode, so nothing gets used up.
>
> Leave that window alone from now on. Don't close it, don't type in it.

It prints a line like `SoloFactory → http://127.0.0.1:4173`.

> Now open your web browser and go to: **http://127.0.0.1:4173**
>
> You should see the SoloFactory page. Tell me what you see.

If the page loads, the install is proven. Have them stop it:

> Great — that's it working. Go back to the text window and press `Control` and `C` together
> once to shut it down.

## C2. Confirm the coding agent is wired in

Start it again, this time for real:

```sh
cd ~/solofactory && bash start.sh
```

Then have them reload `http://127.0.0.1:4173` and tell you what the page says about the
provider.

You are looking for Claude or Codex shown as **signed in / authenticated**. If the page says
*"Select an authenticated subscription provider"* or shows the provider as not installed,
the ordering rule was broken. Do not tell the owner it's broken — fix it:

1. Stop the server (`Control` + `C`).
2. Re-run the A5 / B4 sign-in and confirm `command -v claude` prints a path **in the same
   window** you will start the server from.
3. Start it again.

If `command -v claude` prints a path but the page still shows the provider as
unauthenticated, the sign-in is an API-key one, which SoloFactory rejects by design. Have
them sign in again through the browser flow with their subscription account.

Codex is the supported alternative: `codex login`, choosing **ChatGPT sign-in** (not an API
key). Use it if Claude Code will not authenticate.

## C3. Tell them what they have, and stop

Do not launch into how to build an app. Installation is finished. Say something close to:

> You're done — SoloFactory is installed and running.
>
> The way you use it: leave that text window running, go to
> **http://127.0.0.1:4173** in your browser, and it interviews you about what you want built.
> It writes up a plan, shows it to you to approve, then builds it — and it stops to check
> with you at the points that matter.
>
> Whenever you want to use it again, open the same text window and type:
> `cd ~/solofactory && bash start.sh`, then open that web address.
>
> Want me to walk you through building your first thing?

Give them that restart command in its own copy/paste box — it is the one thing they will
need again and will not remember:

```sh
cd ~/solofactory && bash start.sh
```

If they say yes to building something, that is a separate conversation — the folder's own
`.aai/instructions.md` governs it.

---

# Updating an existing install

Updating is the same command as installing. It refreshes the machinery and leaves all their
work and settings untouched.

Make sure the server is **stopped** first (`Control` + `C` in the window running it) —
updating underneath a running server leaves it serving stale code until restarted.

```sh
cd ~ && curl -fsSL https://raw.githubusercontent.com/coachlou/ambient-library/main/library/ambient-folder/bootstrap.sh | bash -s -- solofactory solofactory
```

> This updates SoloFactory to the latest version. Your projects and settings are left exactly
> as they are.

What updates and what does not:

- **Refreshed:** `.ailib/` — the vendored app and machinery. `start.sh` is rewritten too.
- **Never touched:** `.aai/` (their settings and interview history) and `projects/` (all
  their work).

Re-check Node after any update, since a stale Node is the most common post-update failure:

```sh
node --version
```

Then start it and confirm the page loads before telling them the update is done.

---

# Fixing a bad install

Work these yourself. Do not read this table out loud.

| Symptom | Cause | Fix |
|---|---|---|
| `warn  node 22+ not found on PATH` | Node missing, or installed in a stale window | Fresh terminal window first; if still missing, A4 / B3 |
| `node 22+ is required` and it **exits** | Node not on PATH at all | A4 / B3 |
| `no .aai/ above ...` | Running `start.sh` from the wrong folder, or a half-install | `cd ~/solofactory` first; if that fails, re-run the installer |
| Page says *"Select an authenticated subscription provider"* | CLI missing or not signed in | C2 |
| Page says *"Codex CLI is not installed"* / *"Claude Code is not installed"* | Not on PATH in the window the server was started from | Fresh window, verify `command -v claude`, restart the server |
| Signed in, but still shown as unauthenticated | API-key auth, which is rejected by design | Sign in again via the browser flow with a subscription account |
| `Run \`codex login\` and choose ChatGPT sign-in.` | Codex signed in with an API key | `codex login`, pick ChatGPT |
| `requires a newer version of Codex` | Codex CLI is out of date | Update the Codex CLI, then restart the server |
| Browser shows "can't connect" / "site can't be reached" | The server window was closed or `Control`+`C`'d | Restart with `cd ~/solofactory && bash start.sh` and leave it running |
| `EADDRINUSE` | Something else is on port 4173 | Start with a different port: `cd ~/solofactory && PORT=5000 bash start.sh`, then use `http://127.0.0.1:5000` |
| `rsync: command not found` | Ubuntu missing rsync | B2 |
| `curl: command not found` | Ubuntu missing curl | B2 |
| `git: command not found` | git missing | A3 / B2 |
| `install: refused — these paths already exist with different contents` | A previous half-install left conflicting files | Do **not** delete anything. Show the owner the listed paths and ask whether they installed here before. Only proceed once they confirm the folder is disposable. |
| `command not found` right after installing something | Shell has a stale PATH | Fresh terminal window, then retry. This resolves it the overwhelming majority of the time. |
| Windows: odd filesystem, permission or exec failures with no other explanation | Running on WSL1, not WSL2 | `wsl --list --verbose` in PowerShell; if VERSION is 1, convert per B1d |
| Windows: `'wsl' is not recognized` after `wsl --install` | Windows build too old for WSL2 | `winver`; needs Win11 or Win10 build 19041+. Windows Update first, then stop |
| Windows: nothing behaves as documented | Commands went into PowerShell instead of Ubuntu | Confirm which window; everything after B1 belongs in Ubuntu |

**Two things you must never do to get past an error:** never delete a folder the owner did
not confirm is disposable, and never `sudo` your way around a permissions error on macOS —
use the npm prefix fix in A5 instead.

---

# Done means all of this

Do not tell the owner they are finished until every one of these is true. Verify them
yourself; do not ask the owner to confirm them.

1. `node --version` prints v22 or higher.
2. `git --version` prints a version.
3. `command -v claude` (or `codex`) prints a path, in the same window the server starts from.
4. `~/solofactory/start.sh` exists.
5. `bash start.sh` prints the `SoloFactory → http://127.0.0.1:4173` line and keeps running.
6. The owner has loaded that address in their browser and seen the page.
7. The page shows a provider as signed in — not "Select an authenticated subscription
   provider."
8. The owner has been given the restart command, in a copy/paste box.
9. On Windows only: `wsl --list --verbose` shows the distro at `VERSION  2`, not 1.

If any one of these fails, you are not done. Fix it.
