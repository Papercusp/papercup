# worker-log — EI-7532 (implement / auto-fix)

**Item:** EI-7532 (kind=bug, major) — "Dispatchable work in harness **papercup** is not being picked up"
**Watchdog key:** `stalled-feature:stalled:papercup`
**Outcome:** `needs-human` (routed — protected surface + design/authority decision)
**Precedent:** IDENTICAL class already routed `needs-human` for the papercusp variant — see `.papercusp/worker-log-EI-4639.md` (EI-4639, 2026-06-28).

## What the signal is
Recurring AGGREGATE watchdog signal from `collectStalledFeatureSignals`
(`packages/operator-core/lib/harness/improvements/watchdog.ts:1561`). It flags
feature work-items with status ∈ (todo/failing/pending/failed), older than
`stalledFeatureHours` (12h), whose `source_plan` is null or a *started* plan,
that have NO live (PENDING/ENQUEUED) DBOS pipeline. Fires per-harness.

## Reproduced (still real, current)
- `papercup` has exactly **1** stalled feature: **F-FIX-008** — *"fleet:tree throws
  handler_error: row.heartbeatAt.getTime is not a function"* (a genuine bug,
  `sourceIssueId=EI-482`), status=`todo`, `taken_by=null`, `source_plan=null`,
  updated 2026-07-03 (~2 days stale). So the signal is accurate — F-FIX-008 IS a
  dispatchable feature sitting untouched.

## Root cause (verified for papercup specifically)
papercup has **NO active autonomous coding-pipeline dispatcher** for its feature
work-items:
- `routines:list {installSlug:'papercup'}` → all **4 routines `active=false`**,
  including `hive-wake` (`system:blueprint-run`, last fired 2026-06-22), both
  `loop-su-*` (`system:loop-wake`), and `overwatch-wake`. No active
  director/bp-schedule/blueprint-run routine dispatches papercup's pipeline.
- `autoloop:status {papercup}` → loops last fired 2026-06-23/24 (10+ days);
  overwatch has 6 consecutive errors. Dead.
- papercup is a real, first-class harness (the P-006/P-008 ephemeral filter's own
  comment explicitly lists `papercup` as a slug that must NEVER be filtered),
  worked by the Queen/hive/su-fleet placement model — not an autonomous coding
  pipeline. The `stalled-feature` watchdog assumes every harness with old `todo`
  feature items has such a dispatcher, so it OVER-FIRES for real-but-dispatcherless
  harnesses (papercup, papercusp).

## Why needs-human (not a self-inline fix)
Two candidate root-cause fixes, BOTH on protected surfaces; choosing between them
is an owner/Queen design+authority call:
1. **Watchdog-scope fix** — exclude real-but-dispatcherless harnesses from the
   `stalled-feature` source (analogous to the existing `EPHEMERAL_BENCHMARK_SLUG_RE`
   / `projects.ephemeral` carve-out, but for "no autonomous dispatcher by design").
   Edits **the self-improvement loop's own code** (`watchdog.ts`) → STOP per contract.
2. **Arm an autonomous dispatcher** — re-arm/fix a `hive-wake`/bp-schedule routine
   so papercup features are dispatched. Edits **the routines/DBOS scheduler** → STOP.

No non-protected fix exists:
- papercup is NOT ephemeral, so the data-level `projects.ephemeral` flag is the
  wrong lever (it would wrongly suppress every per-harness signal for the main
  harness).
- Fixing the one underlying feature (F-FIX-008) would be (a) a DIFFERENT backlog
  item (contract: one item per run), and (b) a MITIGATION, not a root-cause fix —
  the watchdog re-fires for papercup the moment the next feature ages out.

## Recommendation for the human/Queen
Most likely correct: **fix #1 (watchdog scope)** — papercup/papercusp features are
placed by the Queen/su fleet, not a coding-pipeline dispatcher, so the signal is a
false-positive CLASS for real-but-dispatcherless self-dev/meta harnesses. A clean
implementation: gate `stalled-feature` (and the other per-harness dispatch-liveness
sources) on a per-harness "has an active autonomous dispatcher" predicate, rather
than the ephemeral flag. If instead papercup SHOULD have an autonomous dispatcher,
that's fix #2 (arm `hive-wake`). Either way:
- **F-FIX-008 is a genuine, self-inline-sized, testable bug** (`fleet:tree` →
  `row.heartbeatAt.getTime is not a function`) that can be placed via Queen/hive
  placement NOW, independent of the watchdog decision. Worth a separate dispatch.

## Files/tools consulted (no code changed)
- `packages/operator-core/lib/harness/improvements/watchdog.ts` (read — collector +
  ephemeral filter)
- `.papercusp/worker-log-EI-4639.md` (prior identical finding, papercusp variant)
- `routines:list`, `autoloop:status`, `dev:pg_query` (work_items, engineer_issues,
  routines)
