# worker-log — EI-4639 (implement / auto-fix)

**Item:** EI-4639 (kind=bug, critical) — "Dispatchable work in harness papercusp is not being picked up"
**Watchdog key:** `stalled-feature:stalled:papercusp`
**Outcome:** `needs-human` (routed — protected surface + design decision)

## What the signal is
A recurring AGGREGATE watchdog signal from `collectStalledFeatureSignals`
(`packages/operator-core/lib/harness/improvements/watchdog.ts`). It flags feature
work-items in a harness with status in (todo/failing/pending/failed), older than
`stalledFeatureHours` (12h), whose `source_plan` is null or a started plan, and
that have NO live (PENDING/ENQUEUED) DBOS pipeline. It re-fires as the flagged set
churns: the item body listed WI-327/356/357…; at investigation time the live set
was 6 "Brief N" plan features (WI-1329, WI-1330, WI-1333, WI-1334, WI-1335, WI-1339),
all `todo`, unclaimed, `source_plan=null`, updated 2026-07-03 (~24h stale).

## Root cause
papercusp has NO active autonomous coding-pipeline dispatcher for its feature
work-items:
- `autoloop:status` → the `director` role last fired **2026-05-01**, `last_status`
  "error: The operation was aborted due to timeout", `consecutive_errors=2` (dead).
- routines: the only ACTIVE `system:blueprint-run` routine is `hive-eval-battery`
  (monthly eval battery — not a coding dispatcher). `scan` and `scout-cycle`
  (blueprint-run) are `active=false`. No active director/bp-schedule routine
  dispatches the papercusp scoper→worker→validator pipeline.
- papercusp is the self-development meta-harness, worked by the interactive su
  fleet + Queen/hive placement — not an autonomous coding pipeline. The
  stalled-feature watchdog assumes every harness with old `todo` feature items has
  such a dispatcher, so it OVER-FIRES for papercusp.

## Why needs-human (not a self-inline fix)
Two candidate fixes, BOTH on protected surfaces, and choosing between them is an
owner/Queen decision:
1. **Watchdog-scope fix** — exclude self-dev / dispatcher-less harnesses from the
   `stalled-feature` source (like the existing benchmark-instance filter in
   `HARNESS_SCOPED_WATCHDOG_SOURCES`). Edits **the self-improvement loop's own
   code** (`watchdog.ts`) → STOP per contract.
2. **Arm an autonomous dispatcher** — re-arm/fix the `director` autoloop or add a
   bp-schedule routine so papercusp features are dispatched. Edits **the
   routines/DBOS scheduler** → STOP per contract.

Deciding whether papercusp *should* be autonomously dispatched (fix 2) or the
watchdog should stop flagging it (fix 1) is a design/authority call, not a
mechanical bug fix. Per the implement contract, routing early on a protected
surface is the correct outcome.

## Recommendation for the human/Queen
Most likely correct: fix #1 (watchdog scope) — papercusp's features are placed by
the Queen/su fleet, not a coding-pipeline dispatcher, so the signal is a
false-positive class for self-dev harnesses. If instead papercusp SHOULD have an
autonomous dispatcher, fix #2 (revive `director`). Either way: the 6 currently
stalled "Brief N" features can be placed now via Queen/hive placement independent
of the watchdog decision.

## Files/tools consulted (no code changed)
- `packages/operator-core/lib/harness/improvements/watchdog.ts` (read)
- `autoloop:status`, `routines:list`, `dev:pg_query` (work_items, improvement_dispatches)
