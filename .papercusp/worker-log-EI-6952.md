# Worker log — EI-6952

**Title:** Background routine "loop-su-6e3f9350-bf33-4f01-bad9-66b9b7e735ff" is failing
**Outcome:** fixed (verified phantom — no longer exists)

## Diagnosis
This is the well-documented **reaper self-heal phantom** class (see
`agent-insights/routine-failure-ei-is-usually-a-reaper-self-heal-phantom.mdx`;
prior instances EI-5950/6061/6081/6083/6242/6855/6880 — 25+). The
`dbos-executor-reaper` stamps `metadata.last_error` = *"DBOS routineFire produced
no DBOS operation output; executor reaper cancelled the stuck fire and requeued
the routine"* as a **self-heal breadcrumb** (it recovered the routine), but
`collectRoutineFailureSignals` alarms on any non-empty `last_error` and mints a
bug EI.

`loop-su-*` routines are per-session self-wake loops (`loop:arm`); when the su
session ends the loop goes `active=false, next_fire_at=infinity` — normal
lifecycle, not a wedge.

## Evidence it is gone (triage query)
```
select active, metadata->>'last_error_source' src, last_fired_at,
       metadata->>'last_error_at' err_at, metadata->>'last_error' last_error,
       metadata->>'reaped_count' reaped_count, next_fire_at
  from harness_shared.routines
 where name = 'loop-su-6e3f9350-bf33-4f01-bad9-66b9b7e735ff';
```
Result (2 rows, both):
- `active = false`
- `last_error_source = null`, `last_error = null` (marker already cleared)
- `reaped_count = null`
- `next_fire_at = infinity`

The collector (`watchdog.ts:1053`) filters
`WHERE active = true AND COALESCE(metadata->>'last_error','') <> ''`. Both rows
are `active=false` with an empty `last_error`, so this EI is **structurally
dead** — it can never re-file. Confirmed `count(*) = 0` for any active row of
this routine carrying a non-empty error.

## Why no code change / regression test
The bug does not exist (verified-gone phantom). The durable class fix — making
`collectRoutineFailureSignals` source-aware so it skips `dbos-executor-reaper`
self-heal markers unless `reaped_count >= N` — lives in `watchdog.ts` /
`dbos-executor-reaper.ts`, both **protected auto-implement surfaces**, and is
already tracked for a human via EI-6061. Adding a regression test here would
require touching that protected surface, so it is out of scope for this
individual-instance auto-fix.

## Validator re-verify
Re-run the triage query above; confirm no `active=true` row for this routine
carries a non-empty `last_error`.
