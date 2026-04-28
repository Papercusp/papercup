---
title: Decisions timeline
description: Every orchestrator decision verb, with parser-ghost detection.
---

The orchestrator emits one decision per iteration: `NEXT_WORKER F-023`, `NEXT_VALIDATOR F-022`, `DONE`, `ESCALATE …`, `CHECKPOINT …`. The decisions timeline is the audit log of every verb the orchestrator has emitted across the mission, with three things per row:

- **Verb** — recognised verbs are coloured; unrecognised verbs are flagged as **ghosts** (parser failed).
- **Iteration** — which iteration emitted it.
- **Args** — feature id, reason, etc.

## Why "ghost rate" matters

The orchestrator sometimes wraps its decision in a markdown fence or adds a `**bold**` decoration. The parser strips these, but it can fail. A failed parse = the harness saw no decision = the loop stalls.

Tracking `ghosts / total` as a percentage gave us visibility into a real bug we'd been masking: 8% of orchestrator outputs were silently ghost-classified. We hardened the orchestrator prompt with an anti-fence rule and the rate dropped to <1%.

## API

```
GET /api/harness/:slug/decisions
→ {
    decisions: [{ ts, verb, args, iteration, isGhost }, …],
    total: 63,
    recognized: 57,
    ghosts: 6,
    ghostRate: 0.095,
    byVerb: { NEXT_WORKER: 25, NEXT_VALIDATOR: 29, … }
  }
```

## UI

- Modal panel from the harness dashboard (palette → 🧠 Decisions).
- Live table: timestamp, iteration, verb pill, args.
- Toggle to hide ghost rows when reviewing only valid decisions.
- Summary strip: total / recognised / ghosts / ghost rate / by-verb chips.

## Why this is uncommon

We surveyed 11+ frameworks; none of them expose orchestrator parse-ghost telemetry. Orchestrator output is usually treated as opaque. Making it observable is one of our genuine differentiators — it lets us catch prompt regressions in a single dashboard glance.

The `low_ghost_rate` check is one of nine signals in the harness `/health` endpoint.
