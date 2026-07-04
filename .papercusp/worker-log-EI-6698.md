# worker-log — EI-6698 (implement / self-improvement auto-fix)

Run: 1783186214-worker · 2026-07-04

## Item
EI-6698 (bug): "CHRONIC autoloop failure: `loop-su-5bd1ad27-2015-4f78-b2c6-c91f2a1d4ea2@*`
red 175 consecutive fires". last_status at filing (verbatim): `loop-stuck-backstop`.

## Reproduced (live PG, read-only)
- `autoloop_state` (role `loop-su-5bd1ad27…`, ws `papercusp-workspace`, harness `*`):
  `consecutive_errors=175`, `last_status='loop-stuck-backstop'` (recorded verbatim),
  `last_fired_at=2026-07-01 06:10` (~3.5 days stale at investigation).
- `routines` (`loop-su-5bd1ad27…`): `active=false`, **`next_fire_at=infinity`**,
  `target_owner_id=su-5bd1ad27…`, `reschedule_interval_sec=600`, last fired 2026-07-01 06:10,
  updated 2026-07-01 07:19. metadata: `last_error_source: dbos-executor-reaper`,
  `last_error: "DBOS routineFire produced no DBOS operation output; executor reaper cancelled the
  stuck fire and requeued the routine"` (2026-06-29). **No `loop_paused_reason` metadata.**

## Root cause (this instance) — a distinct variant of the dead-owner class
Dead-owner `loop:arm` loop (owner su-5bd1ad27 died → every fire stuck-backstopped, streak climbed
to 175 over ~29h at the 10-min interval). **Distinct from the sibling EIs in HOW it went inactive:**
its routine is `active=false` but with `next_fire_at=infinity` (the parked-in-flight sentinel) and
`last_status` still `loop-stuck-backstop` — i.e. it was NOT paused by the WI-1399 dead-owner
terminal guard (that path calls `autoPauseLoopRoutine` → `next_fire_at=NULL` +
`last_status='loop-terminal-unreachable'` + `metadata.loop_paused_reason`). Here the routine went
inactive via a different path (metadata trail: the DBOS executor-reaper cancelling stuck fires),
leaving the frozen 175-error watermark carrying the NON-terminal `loop-stuck-backstop` status.

## Condition no longer exists — verified (the "fixed: gone + suppressed" path)
The chronic-failure sweep (`autoloop-chronic-failure.ts` `selectChronicFailures`) suppresses this
row on THREE independent axes; reproduced with the exact live shape → returns `[]`:
1. `isLoopArmOwnerLoop` (EI-6727) — `routine_target_owner_id` non-null (a loop:arm owner loop, which
   has its OWN dead-owner escalation) → `skipped-loop-arm`.
2. `routine_active === false` → `skipped-paused`.
3. `isStaleWatermark` (EI-6765) — last fire ~3.5 days > 6h → `skipped-stale`.
None of the guards depend on `last_status`, so the `loop-stuck-backstop`-vs-terminal-marker
difference does not change the outcome. The row cannot re-escalate once staging deploys.

## Regression pin added (test-only; product code already suppresses)
`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` — pins EI-6698's
EXACT distinct shape: a loop:arm owner loop deactivated via a NON-terminal path (`active:false`,
`next_fire_at`-sentinel-equivalent, `last_status='loop-stuck-backstop'`) at the record streak
**175**, hitting all three axes at once → `selectChronicFailures` returns `[]`. Every prior
all-3-axes pin (EI-6718) carries the `loop-terminal-unreachable` marker; this pin proves the
suppression is INDEPENDENT of `last_status` text and guards against a future change that (wrongly)
gated the paused/loop-arm skip on the exact terminal-marker string. Highest real-world streak pin
in the file (prior stuck-backstop max was 36).

## Data hygiene — reset the frozen watermark (the EI-prescribed closing step; CORRECT here)
`autoloop:control reset-errors { harness: papercusp, role: loop-su-5bd1ad27… }` → `rowsReset:1`
in the `*` scope → row now `consecutive_errors=0, last_status='errors-reset'` (routine stays
`active=false`, never re-arms). Unlike a `loop-terminal-unreachable` row (where reset would strip
the marker and DELAY the EI-7009 class-2 immediate prune — see EI-6724 log), for THIS row reset is
the RIGHT move: with the non-terminal `loop-stuck-backstop` status it matched NEITHER prune class
(class-2 needs the terminal marker; class-1 needs `consecutive_errors=0`), so it was a permanently-
stuck watermark. Zeroing the errors makes it class-1-prunable → the hygiene prune auto-retires it
once ≥14 days stale.

## Class fix status (deploy-lag, out of a bug-fixer's scope)
The chronic-sweep guards are on `origin/staging` but not yet `origin/main`/deployed
(`dev:pipeline_position`: committed ✓ staging ✓ main ✗ — green gate STALLED, 4 reds). The stalled
gate is a release-machinery condition handled by the release-fixer/gate owner. The GENERATOR-class
durable fix (why the terminal guard didn't terminate this loop in some window; escalator firing in
the pre-termination window) is the routines-scheduler/terminal-guard surface tracked as EI-7016
(kind=change, now resolved) — a STOP-list protected surface, not auto-implemented here.

## Verification (testsRun)
`cd packages/operator-core && npx vitest run
  lib/harness/routines/autoloop-chronic-failure.test.ts
  lib/harness/routines/loop-unreachable-guard.test.ts
  lib/harness/routines/reconcile-loop-routines.test.ts
  lib/harness/improvements/watchdog.test.ts`
→ **214 passed (4 files)** — 30 chronic-failure (incl. the new EI-6698 pin), 25 loop-unreachable,
18 reconcile, 141 watchdog. (Benign post-run "Vite server exit" timeout, not a test failure.)

## Validator should re-verify
- The `loop-su-5bd1ad27` `autoloop_state` row stays `consecutive_errors=0` / routine `active=false`
  (no re-fire, no re-escalation).
- Only a test file changed (regression pin) + one sanctioned data-hygiene reset; no product code.
