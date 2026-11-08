#!/usr/bin/env python3
"""Snapshot a SoloFactory run into the small JSON row files the run dashboard reads.

Read-only: it only reads the run's state.json and events.jsonl.
Usage: python3 run-dashboard/extract.py [RUN_DIR] [OUT_DIR]
"""

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

RUN = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else "/Users/loudalo/Documents/photo-library-prototype/projects/medialibrary/.solofactory/runs/2026-10-07-4f2dd1cf"
)
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).parent / "data")
OUT.mkdir(parents=True, exist_ok=True)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


now = datetime.now(timezone.utc)
s = json.loads((RUN / "state.json").read_text())
events = [
    json.loads(line)
    for line in (RUN / "events.jsonl").read_text().splitlines()
    if line.strip()
]
# The "line" a run travels: a recovery plan, an approved feature plan, or (single pass) the pipeline itself.
PIPELINE = [
    ("SPEC", "Write PRD, plan and acceptance contract", "specifying"),
    ("BUILD", "Build the application", "building"),
    ("GATES", "Run deterministic quality gates", "verifying"),
    ("REVIEW", "Review against the frozen contract", "reviewing"),
    ("DEPLOY", "Launch and check the application", "deploying"),
]
phase = s.get("recoveryPhase")
if phase:
    mode, slices = "recovery", phase["plan"]["slices"]
    done, stats, current = (
        phase.get("done", []),
        phase.get("stats", {}),
        phase.get("current"),
    )
    approved = phase.get("approvedAt") or ""
elif s.get("approvedPlan") or s.get("slicePlanIds"):
    ap = s.get("approvedPlan") or {}
    plan_file = RUN.parents[2] / ".factory" / "slices.json"  # runs/<id> → project root
    titles = (
        {f["id"]: f for f in json.loads(plan_file.read_text())["slices"]}
        if plan_file.exists()
        else {}
    )
    slices = (ap.get("plan") or {}).get("slices") or [
        titles.get(i, {"id": i, "title": i}) for i in s["slicePlanIds"]
    ]
    mode, done, stats = "features", s.get("sliceDone", []), s.get("sliceStats", {})
    nxt = s.get("sliceIndex", 0)
    current = (
        slices[nxt]["id"] if nxt < len(slices) and s["state"] != "completed" else None
    )
    approved = ap.get("approvedAt") or ""
else:
    mode, approved, stats = "single", "", {}
    slices = [{"id": i, "title": t} for i, t, _ in PIPELINE]
    seen = {st["state"] for st in s["stageHistory"]}
    live = s["state"] == "completed"
    done = [i for i, _, st in PIPELINE if live or (st in seen and st != s["state"])]
    current = next((i for i, _, st in PIPELINE if st == s["state"]), None)
order = {i + 1: f["id"] for i, f in enumerate(slices)}
by_state = {st: i for i, _, st in PIPELINE}

# When each feature of the current plan was verified. Unnumbered stages (gates, whole-app review, deploy)
# belong to the feature before them only until that feature is verified.
finished = {
    e["slice"]: e["at"]
    for e in events
    if e["type"] in ("slice.completed", "recovery.slice.completed")
    and e.get("at", "") >= approved
}

# Stages: one row per stage; stages of the current plan are attributed to the feature they serve.
stages, feature = [], ""
for i, st in enumerate(s["stageHistory"]):
    end = st.get("endedAt") or now.isoformat()
    m = re.search(r"(?:feature|slice) (\d+)/\d+", st["label"], re.I)
    if mode == "single":
        feature = by_state.get(st["state"], "")
    elif st["startedAt"] < approved:
        feature = ""
    elif m:
        feature = order.get(int(m.group(1)), "")
    elif feature in finished and ts(st["startedAt"]) >= ts(finished[feature]):
        feature = ""
    stages.append(
        {
            "i": i,
            "state": st["state"],
            "label": st["label"],
            "start": st["startedAt"],
            "end": end,
            "minutes": round((ts(end) - ts(st["startedAt"])).total_seconds() / 60, 2),
            "feature": feature,
        }
    )

# Features of the current plan.
active = Counter()
for st in stages:
    if st["feature"]:
        active[st["feature"]] += st["minutes"]
features = []
for i, f in enumerate(slices):
    st = stats.get(f["id"], {})
    status = (
        "verified" if f["id"] in done else "current" if f["id"] == current else "queued"
    )
    features.append(
        {
            "order": i + 1,
            "id": f["id"],
            "title": f["title"],
            "dependsOn": ";".join(f.get("dependsOn") or []),
            "status": status,
            "reviews": st.get("reviews", 0),
            "repairs": st.get("repairs", 0),
            "activeMinutes": round(active[f["id"]], 2),
            "verifiedAt": st.get("verifiedAt", ""),
        }
    )


# Incidents: the moments the run was stopped, blocked, or turned back.
def kind(e):
    t, msg = e["type"], e.get("message", "")
    if t == "error":
        return "Usage limit" if "usage limit" in msg.lower() else "Agent error"
    if t == "gate.failed":
        return "Review blocked" if e.get("gate") == "review" else "Gate failed"
    return {
        "job.failed": "Run stopped",
        "plan.blocked": "Plan blocked",
        "job.paused": "Paused",
        "job.resumed": "Resumed",
    }.get(t)


incidents = []
for e in events:
    k = kind(e)
    if k:
        msg = re.sub(r"\s*\(?https?://\S+\)?", "", e.get("message", "")).strip()
        incidents.append(
            {
                "n": len(incidents) + 1,
                "at": e["at"],
                "kind": k,
                "state": e.get("state", ""),
                "message": msg[:160] + ("…" if len(msg) > 160 else ""),
            }
        )

# Plan attempts: every repair plan drafted, in order.
plans = []
history = s.get("recoveryPhaseHistory", []) + [phase] if phase else []
if not phase and mode == "features":
    history = [
        {
            "id": s["id"][-8:],
            "status": "approved",
            "reviews": s.get("planReviews", 0),
            "corrections": s.get("planCorrections", 0),
            "approvedAt": approved,
            "plan": {"slices": slices},
        }
    ]
for i, p in enumerate(history):
    plans.append(
        {
            "attempt": i + 1,
            "id": p["id"][:8],
            "status": p["status"],
            "reviews": p.get("reviews", 0),
            "corrections": p.get("corrections", 0),
            "approvedAt": p.get("approvedAt", ""),
            "features": len((p.get("plan") or {}).get("slices", [])),
        }
    )

# proof-<case> gates re-run single acceptance cases; they are reported as cases, not as quality gates.
gates = Counter(
    e["type"]
    for e in events
    if e["type"] in ("gate.passed", "gate.failed")
    and not str(e.get("gate", "")).startswith("proof-")
)
cases = (s.get("caseResults") or {}).values()
cur = next((f for f in features if f["status"] == "current"), None)
run = [
    {
        "snapshotAt": now.isoformat(),
        "id": s["id"],
        "mode": mode,
        "name": (s.get("brief") or {}).get("workingName") or s["id"],
        "state": s["state"],
        "stage": s["stage"],
        "provider": s["provider"],
        "attempt": s["attempt"],
        "repairBudget": s.get("repairBudgetLimit", 0),
        "startedAt": s["startedAt"],
        "updatedAt": s["updatedAt"],
        "wallHours": round(
            (ts(s["updatedAt"]) - ts(s["startedAt"])).total_seconds() / 3600, 1
        ),
        "featuresTotal": len(features),
        "featuresVerified": len(done),
        "currentId": cur["id"] if cur else "",
        "currentTitle": cur["title"] if cur else "",
        "currentOrder": cur["order"] if cur else 0,
        "casesPassed": sum(1 for c in cases if c["status"] == "passed"),
        "casesTotal": len(cases),
        "gatesPassed": gates["gate.passed"],
        "gatesFailed": gates["gate.failed"],
        "plansDrafted": len(plans),
        "nextAction": ((s.get("recovery") or {}).get("nextAction") or {}).get(
            "label", ""
        ),
        "lastEventAt": events[-1]["at"] if events else "",
        "quietMinutes": round((now - ts(events[-1]["at"])).total_seconds() / 60, 1)
        if events
        else 0,
        "nowLabel": s["stageHistory"][-1]["label"] if s["stageHistory"] else s["stage"],
        "nowSince": s["stageHistory"][-1]["startedAt"] if s["stageHistory"] else "",
        "lastAction": next(
            (
                re.sub(r"/(?:private|Users|Volumes)/\S+/", "…/", e.get("message", ""))[:140]
                for e in reversed(events)
                if e["type"] == "item.completed"
            ),
            "",
        ),
        "supervision": next(
            (e.get("status", "") for e in reversed(events) if e["type"] == "supervision.changed"), ""
        ),
    }
]


# Plan: the features in order, then the whole-run review and release that follow them.
finished_all = s["state"] == "completed"
stopped = s["state"] in ("failed", "paused", "cancelled")
plan = [
    {"step": f["order"], "id": f["id"], "title": f["title"], "status": f["status"]}
    for f in features
]
if stopped:
    plan = [dict(p, status="stopped") if p["status"] == "current" else p for p in plan]
tail_review = "verified" if finished_all else ("stopped" if stopped else "current") if features and not cur else "queued"
plan.append({"step": len(plan) + 1, "id": "FINAL-REVIEW", "title": "Whole-run review against the frozen contract", "status": tail_review})
plan.append({"step": len(plan) + 1, "id": "DONE", "title": "Run complete", "status": "verified" if finished_all else "queued"})


# Activity: the latest events, sorted into a few kinds a person reads at a glance.
def group(t):
    if t == "item.completed":
        return "Tool call"
    if t.startswith("gate."):
        return "Gate"
    if t.startswith("agent.") or t == "stage.started":
        return "Agent"
    if t == "git.committed" or t.endswith("slice.completed") or t.startswith("plan."):
        return "Progress"
    return "Incident" if kind({"type": t, "message": ""}) else "Other"


activity = [
    {
        "n": len(events) - k,
        "at": e["at"],
        "group": group(e["type"]),
        "type": e["type"],
        "state": e.get("state", ""),
        "feature": e.get("slice") or e.get("feature") or "",
        "message": re.sub(r"/(?:private|Users|Volumes)/\S+/", "…/", e.get("message", ""))[:140],
    }
    for k, e in enumerate(reversed(events[-150:]))
]

# Pulse: events per 10 minutes over the last 12 hours, by kind.
pulse = Counter()
for e in events:
    age = (now - ts(e["at"])).total_seconds()
    if age <= 12 * 3600:
        b = ts(e["at"]).replace(minute=ts(e["at"]).minute // 10 * 10, second=0, microsecond=0)
        pulse[(b.isoformat().replace("+00:00", "Z"), group(e["type"]))] += 1
pulse = [{"bucket": b, "group": g, "events": n} for (b, g), n in sorted(pulse.items())]

for name, rows in dict(
    run=run, plan=plan, activity=activity, pulse=pulse, stages=stages, features=features, incidents=incidents, plans=plans
).items():
    (OUT / f"{name}.json").write_text(json.dumps(rows, ensure_ascii=False))
    print(f"{name}: {len(rows)} rows", file=sys.stderr)
