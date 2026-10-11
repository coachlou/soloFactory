# Codex inbox rejects

Entries (or parts of entries) from `INBOX-codex.md` that Claude declined, with the reason.

## Enforceable bounded feature pilot — usage and reserve half
- From: "Enforceable bounded feature pilot with honest usage reporting" (batch half done in 6233251).
- Declined: a token/turn budget and automatic enforcement of the 25% five-hour reserve.
- Reason: per-stage provider usage is already recorded (`agent.completed` events, `usageTotals`), and no
  provider exposes subscription capacity to enforce against; a token cap would equate tokens with
  subscription percentage, which the entry itself warns against. The feature batch gives the owner a
  safe stopping point; the reserve stays under external supervision. Revisit if a provider reports capacity.

## Compact focused worker context — digest-bound work packet
- From: "Compact focused worker context without reducing review scope" (dedupe done in 306a9ed).
- Declined for now: a controller-owned, digest-bound per-feature packet file.
- Reason: the approved plan is already digest-bound and the builder prompt now carries the feature
  with shared commands once; a second bound artifact adds a staleness path without measured savings.
  Revisit with provider input-token numbers from a real run showing the prompt is the cost.
