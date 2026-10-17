# Final checkpoint: SoloFactory 0.10.1 release (2026-10-17)

## State: released and announced

- **Smoke:** Claude 3/3. Codex 2/3 after fixes (runs 1 and 2 failed before the fixes; run 3 and the Node-24-spec Reading List run both completed). `npm test` 366/366.
- **Fixes in 0.10.1:** owner Waive button for a wrong reviewer test (reason required); newer Node accepted over a plan's Node pin; later-feature changes no longer blocked by an earlier feature's pinned test.
- **soloFactory:** v0.10.1 at 7b90176, pushed to `origin wip/feature-slice-recovery` with the tag. Main checkout fast-forwarded.
- **ambient-library:** 0f962ad (sync 0.10.1) and d089f14 (plugin 2.16.1), pushed to origin main.
- **aai-library (members):** 44eba71, tag v2.16.1, pushed; serves SoloFactory 0.10.1.
- **Local installs:** `~/.ailib` at 0.10.1; plugins `ambient` 2.16.1 and `dev-rules` 1.1.2 updated. Restart Claude to load them.
- **Tester page:** https://noble-juniper-8x63.here.now/ (0.10.1, slug reused). Source in `.aai/tester-page-0.10.1/`.
- **Member announcement:** sent via Resend to `aimm-members`, broadcast `9aff2f8a-9b77-4fcd-bcf5-3893a3cbbcf0`, 2026-10-17. Text in `.aai/member-letter-0.10.1.md`. Update path is a paste-in prompt to the public INSTALL.md runbook.

## Open items

1. ~~dev-rules dangling pointer~~ **Fixed 2026-10-17:** `~/.aai/rules/coding.md` now says "when that file exists" (~/.aai commit 1d0dd11). dev-rules 1.1.3, ambient-library 2.16.2 (c7facfd), aai-library 3a85957 tag v2.16.2, all pushed.
2. **Reviewer repro tests are not validated before they become gates.** Waive is the escape hatch; the upstream fix (sanity-run the test against known-good behavior first) is not built.
3. **Waive verified only with a hand-planted BUG proof.** No real reviewer produced a wrong test in the final runs.
4. **Delivery stats for the broadcast not checked.**
5. **Branch:** this worktree is `claude/real-provider-smoke-test-358e26`. `.aai/member-letter-0.10.1.md` and this file are uncommitted; `.herenow/` is untracked.

## Where to look

- Release mechanics: memory `solofactory-library-sync`. Member-letter convention: memory `member-update-via-install-runbook`.
- Smoke record: `SMOKE-0.10.0-REPORT.md`, `PROGRESS.md` (0.10.1 section).
- Session transcript: `/Users/loudalo/.claude/projects/-Volumes-Extreme-Pro-users-loudalo-GitHub-soloFactory--claude-worktrees-real-provider-smoke-test-358e26/c50ff4c8-3942-47d6-8a51-067da903eddb.jsonl`
