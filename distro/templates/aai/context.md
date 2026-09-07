# Context — what's in this folder

| Path | What it is | Read when |
|------|-----------|-----------|
| `.aai/instructions.md` | this folder's behavior | always, first |
| `.aai/identity.md` | who this folder is | always |
| `.aai/memory/solofactory/` | factory runtime state (interview log) | troubleshooting the guide |
| `.aai/skills/solofactory/` | a personalized fork of the factory, if one exists | resolving the capability (shadows `.ailib/`) |
| `start.sh` | root-level launcher (delegates into `.ailib/solofactory/run.sh`) | starting the factory |
| `.ailib/solofactory/` | vendored SoloFactory capability: `run.sh`, `app/` | updating the factory |
| `.ailib/manifest.yaml` | what's vendored and at which version | "what version is installed" |
| `projects/<name>/` | one project: a git repo with the app at its root, `.factory/` contract, `.solofactory/runs/` evidence | any question about that project |
