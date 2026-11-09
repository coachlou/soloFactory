# SDLC model/effort value table (2026-11-08)

Source: Artificial Analysis, "Intelligence Index vs. Cost per Task" (proprietary models, 37 of 337, log-scale USD).
All numbers are read off the chart by eye and are approximate (±1 index point, ±15% cost).

**Cost basis:** chart cost is API dollars per benchmark task; most members run on a subscription, where the real cost is how fast a stage burns their 5-hour usage window, so read cost here as relative weight, not a bill.

## 1. Chart transcription (Anthropic + OpenAI)

P = on the Pareto frontier (no other point is both smarter and cheaper).

| Model | Effort | Index | $/task | P |
|---|---|---|---|---|
| GPT-6 Luna | low | 10 | 0.0055 | P |
| GPT-6 Luna | medium | 18.5 | 0.042 | P |
| GPT-6 Luna | high / xhigh / max | 21.5 / 23.5 / 28 | 0.075 / 0.11 / 0.16 | |
| GPT-6.1 Terra | low | 29.5 | 0.07 | P |
| GPT-6.1 Terra | medium | 38 | 0.17 | P |
| GPT-6.1 Terra | high | 42.5 | 0.26 | P |
| GPT-6.1 Terra | xhigh | 46.5 | 0.36 | P |
| GPT-6.1 Terra | max | 52.5 | 0.78 | P |
| GPT-6.1 Sol | low | 35 | 0.165 | P |
| GPT-6.1 Sol | **medium (Codex default)** | 45.5 | 0.40 | dominated by Terra xhigh |
| GPT-6.1 Sol | high | 50.5 | 0.60 | P |
| GPT-6.1 Sol | xhigh | 52 | 2.7 | |
| GPT-6.1 Sol | max | 54.5 | 1.25 | P |
| GPT-6 Astra | low / medium | 43.5 / 51.5 | 1.4 / 1.0 | |
| GPT-6 Astra | high / xhigh / max | 54.5 / 55 / 57 | 3.0 / 3.4 / 6.5 | high near P |
| Sonnet 5.5 | low | 25.5 | 0.5 | |
| Sonnet 5.5 | **medium (builders, repairs)** | 30.5 | 0.8 | |
| Sonnet 5.5 | high | 41.5 | 1.7 | |
| Sonnet 5.5 | xhigh (label unclear) | 38.5 | 4.5 | |
| Sonnet 5.5 | max | 54.5 | 10 | |
| Opus 5.5 | **low (reasoning stages)** | 34.5 | 1.0 | |
| Opus 5.5 | **medium (Guide)** | 48 | 2.3 | |
| Opus 5.5 | high | 52 | 2.9 | |
| Opus 5.5 | xhigh | 57.5 | 6 | near P at the top |
| Opus 5.5 | max | 59 | 10 | |
| Fable 5.1 | low → max | 38.5 → 50 | 4.5 → 13 | dominated everywhere |

Reference only: Gemini 4 Carbon (high) ≈ 60 at $7.8, the top of the frontier.

What the chart says in one line each:
- OpenAI owns the value frontier. Terra xhigh (46.5, $0.36) and Sol high (50.5, $0.60) beat every Anthropic point on value.
- Inside Anthropic, Opus beats Sonnet at almost every intelligence level: Opus low (34.5, $1.0) is smarter than Sonnet medium for +25%, and Opus medium (48, $2.3) beats Sonnet high (41.5, $1.7).
- The big Anthropic step is Opus low → medium: +13.5 points for 2.3× cost. Medium → high is only +4 for +25%.
- Fable is never worth it, which backs dropping it as the Guide advisor.

## 2. Per-phase picks

Columns: **Claude pick** (if the member uses Claude), **Codex pick** (if they use Codex), runner-up, and today's default.
Codex today runs one model/effort for every stage (`SOLOFACTORY_CODEX_MODEL` / `_REASONING_EFFORT`, default gpt-6.1-sol medium), so per-stage Codex picks need a code change; see §3.

### Guide interview (`interview`)
Needs: solid judgment to turn a non-technical owner's words into a buildable brief; moderate volume.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | Opus medium (+ Opus advisor) | 48 | 2.3 |
| Codex pick | GPT-6.1 Terra xhigh | 46.5 | 0.36 |
| Runner-up | Opus high / Sol high | 52 / 50.5 | 2.9 / 0.60 |
| Current default | Claude: Opus medium + Opus advisor. Codex: Sol medium | 48 / 45.5 | 2.3 / 0.40 |

Chart agrees with Lou's call. Keep.

### Specification (`specification*`)
Needs: high. Every later stage inherits its mistakes; runs once per project.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus medium** | 48 | 2.3 |
| Codex pick | GPT-6.1 Sol high | 50.5 | 0.60 |
| Runner-up | Opus high / Terra max | 52 / 52.5 | 2.9 / 0.78 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees: Opus low is barely above Sonnet medium. One run per project makes medium cheap insurance.

### Feature planning (`feature-plan*`)
Needs: high. Slices the spec into features with proof checks; mistakes cause repair loops downstream.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus medium** | 48 | 2.3 |
| Codex pick | GPT-6.1 Sol high | 50.5 | 0.60 |
| Runner-up | Opus low / Terra xhigh | 34.5 / 46.5 | 1.0 / 0.36 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees, same reason as specification.

### Plan review / correction (`plan-review*`, `plan-correction-*`)
Needs: medium-high. Review has to catch what planning missed; correction is a narrower edit.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus medium** (review); Opus low is fine for correction | 48 / 34.5 | 2.3 / 1.0 |
| Codex pick | GPT-6.1 Sol high | 50.5 | 0.60 |
| Runner-up | Opus low for both | 34.5 | 1.0 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees mildly: a reviewer at the same level as the planner adds little.

### Build (`build*`, `build-slice-*`, `slice-resume-*`, `recovery-feature-*`)
Needs: medium. Highest volume by far, so cost per task dominates; the plan already carries the thinking.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | Sonnet medium | 30.5 | 0.8 |
| Codex pick | GPT-6.1 Terra xhigh | 46.5 | 0.36 |
| Runner-up | Sonnet high / Opus low | 41.5 / 34.5 | 1.7 / 1.0 |
| Current default | Claude: Sonnet medium. Codex: Sol medium | 30.5 / 45.5 | 0.8 / 0.40 |

Chart leans toward more intelligence (Sonnet high, or Opus low for +25%), but the 2026-11-08 smokes passed on Sonnet medium at about a third less usage. Keep; revisit only if repair counts climb.

### Repair (`repair-*`)
Needs: medium-high. Diagnosing a failed check is harder than writing to a plan, but runs are short and frequent.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | Sonnet medium | 30.5 | 0.8 |
| Codex pick | GPT-6.1 Terra xhigh | 46.5 | 0.36 |
| Runner-up | Sonnet high (escalate on 2nd+ repair) | 41.5 | 1.7 |
| Current default | Sonnet medium | 30.5 | 0.8 |

Keep. If a cheap upgrade is wanted later: Sonnet high from the second repair attempt on (needs code).

### Recovery planning (`recovery-plan-*`)
Needs: high. Only runs when a feature is stuck, so it must see what earlier stages missed; rare, so cost is minor.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus high** | 52 | 2.9 |
| Codex pick | GPT-6.1 Sol max | 54.5 | 1.25 |
| Runner-up | Opus medium / Sol high | 48 / 50.5 | 2.3 / 0.60 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees most: the stage exists because lower-effort work failed; re-planning at low effort repeats it.

### Feature review (`feature-review-*`, `recovery-feature-*-review-*`)
Needs: medium-high. Gatekeeper per feature; misses ship bugs, false alarms cost repairs.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus medium** | 48 | 2.3 |
| Codex pick | GPT-6.1 Sol high | 50.5 | 0.60 |
| Runner-up | Opus low | 34.5 | 1.0 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees. Biggest usage impact of the reasoning changes, since it runs per feature.

### Final AI review (`review*`, `recovery-review`)
Needs: highest. Last gate before the owner sees the app; runs once.

| | Model / effort | Index | $/task |
|---|---|---|---|
| Claude pick | **Opus high** | 52 | 2.9 |
| Codex pick | GPT-6.1 Sol max | 54.5 | 1.25 |
| Runner-up | Opus xhigh / Opus medium | 57.5 / 48 | 6 / 2.3 |
| Current default | Opus low | 34.5 | 1.0 |

Disagrees. Note: the current regex sends final and per-feature review (and every other `*-review-*` stage) through the same Opus/low route, so splitting them needs a code change.

## 3. Where the chart says change a default (recommendations, no code changed)

1. ~~**Claude reasoning stages: Opus low → Opus medium.**~~ **Withdrawn after the arm B smoke (§4): keep Opus low.** Medium cost 2.4–2.9× more per run, planned twice as many features on Voice Notes, and failed Habit Ledger.
2. **Recovery planning and final review: Opus high.** Rare stages, biggest leverage. Needs a new route in `claudeRun` (they share the reasoning regex today).
3. **Codex default: gpt-6.1-sol medium → gpt-6.1-terra xhigh.** Same intelligence (46.5 vs 45.5) for slightly less; Sol medium is the only dominated point we ship. Env-only: `SOLOFACTORY_CODEX_MODEL=gpt-6.1-terra SOLOFACTORY_CODEX_REASONING_EFFORT=xhigh`. Model ID string needs checking against the Codex CLI before shipping.
4. **Codex per-stage routing (optional, code):** Terra xhigh for Guide/build/repair, Sol high for planning/review, Sol max for recovery/final review. Mirrors the Claude split; currently one setting for all stages.
5. **Keep:** Guide on Opus medium + Opus advisor; builders and repairs on Sonnet medium (smokes back it, chart only mildly prefers more). Fable stays out.

## 4. Arm B smoke: reasoning stages on Opus medium (2026-11-09)

Code at 587a032, isolated homes `.solofactory/armb-habit` and `.solofactory/armb-recorder`, `SOLOFACTORY_CLAUDE_REASONING_EFFORT=medium`, $15 run cap. Builders and repairs stayed on Sonnet medium. Baseline A = the same briefs on Opus low (2026-11-08).

| Brief | Arm | Result | Features | Repairs | Cost | Wall |
|---|---|---|---|---|---|---|
| Habit Ledger | A (Opus low) | passed | 6 | 0 | $4.08 | 14 min |
| Habit Ledger | B (Opus medium) | **failed** (stuck on MARK-DONE) | 3 of plan | 3 | $9.63 | 28 min |
| Habit Ledger | B retest (restart from ADD-HABITS on 898ade3) | **hit $15 cap** in feature 4; MARK-DONE passed | 3 of 5 | 2 | $15.32 total | about 1h total |
| Habit Ledger | B fresh (898ade3) | passed | 4 | 1 (final-review bug) | $11.90 | 35 min |
| Voice Notes | A (Opus low) | passed | 6 | 1 | $5.23 | 19 min |
| Voice Notes | B (Opus medium) | **hit $15 cap** | 12 planned | 4 | $15.25 | 53 min |

What happened:
- **Reasoning stages ate the budget.** On Habit Ledger they cost about $7.8 of $9.63. Planning alone took 3 plan reviews and 2 corrections (17 min). Plan review 1 has blocked in all six Opus-medium Habit Ledger runs to date.
- **More planning, not better planning.** Voice Notes was sliced into 12 features against 6, and each feature review ($0.28–$0.70) cost more than its build ($0.11–$0.49).
- **The known planning defect recurred anyway.** ADD-HABITS froze a test that regex-pins `<li data-habit-id="h_…">Read</li>`, which conflicts with the row shape MARK-DONE needs. Three Opus-medium plan reviews missed it, and three Sonnet repairs could not get past it.

Verdict: recommendation 1 withdrawn, keep Opus low. Recommendation 2 (Opus high only for recovery planning and final review) is untested; the cost pattern here argues for scoping any effort bump to rare stages only. The pinned-markup defect was not a model-effort problem. It is fixed in the controller instead (0cb4bd5, 898ade3): a feature may now update an earlier feature's test that its change breaks, and one repair gets every such test. In the retest, MARK-DONE broke two earlier tests and one repair fixed both. The run then hit the cap, so Opus medium still did not finish Habit Ledger. The retest's cost and wall time are totals over the original run and both restarts. A fresh run on 898ade3 then passed: 4 features, 1 repair, $11.90 and 35 min, which is 2.9× arm A's cost and 2.5× its time for fewer features. So the controller fix lets Opus medium finish, but it still does not pay for itself; the verdict stands.
