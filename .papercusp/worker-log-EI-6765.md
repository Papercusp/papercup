# Worker log — EI-6765 (auto-implement)

**Item:** EI-6765 — "CHRONIC autoloop failure: overwatch@papercup red 6 consecutive fires" (kind=bug)
**Outcome:** FIXED (verified) + item closed (state=resolved). One distinct blocker filed as EI-6938.

## Root cause
The chronic-autoloop-failure sweep (`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`)
escalated a **FROZEN watermark**. There are 4 overwatch `autoloop_state` rows; the live one is
`papercusp` (state `ok`, last fired 2026-07-02). `papercup` is an **orphaned** row: the active
overwatch loop moved to the `papercusp` home slug, leaving `papercup` frozen at
`consecutive_errors=6` with a stale "180000ms" `last_status` and `last_fired_at = 2026-06-25`
(8 days stale). Nothing fires that slug anymore, so its streak can NEVER reset — the sweep
re-escalated it every 24h debounce cycle forever.

The pre-existing `routine_active = false` guard only suppresses AUTO-PAUSED loops, not
orphaned/renamed slugs. The module header itself states the principle: "a `consecutive_errors`
streak is a STALE watermark — only meaningfully 'chronic' while the routine is still trying."

## Fix (durable class fix)
Added a `last_fired_at` staleness guard so ANY orphaned/renamed/retired slug is skipped, not just
this instance:
- `staleWindowMs()` — env `PAPERCUSP_AUTOLOOP_STALE_MS`, default 6h (= 6× the 1h fire-gate backoff
  cap, so a genuinely-failing loop — which fires ≥ hourly even fully backed off — is never
  suppressed). `<=0` disables (fail-open).
- `isStaleWatermark(row, now, staleMs)` — pure; fails OPEN on null/absent/unparseable `last_fired_at`.
- `selectChronicFailures(rows, threshold, { now, staleMs })` — drops breaching, non-paused rows
  whose last fire is outside the window.
- The sweep now `SELECT`s `s.last_fired_at` and reports skipped rows as `skipped-stale` (logged by
  routines-workflow) for observability.

## Files changed
- `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`
- `packages/operator-core/lib/harness/routines/autoloop-chronic-failure.test.ts` (+12 regression tests)

## Verification
- `cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` → **19 passed** (7 pre-existing + 12 new; incl. the EI-6765 orphaned-overwatch shape)
- `npx vitest run lib/harness/routines/` → **290 passed** (24 files)
- `npx tsc --noEmit` → no new errors in the changed files (224 pre-existing baseline errors, none in my files)

## Blocker discovered + routed (protected surface — NOT auto-fixed)
`improvements:resolve { outcome:'fixed' }` **silently no-ops on `'todo'`-state issues**: resolve-core's
fixed-path idempotency guard is `issue.state !== 'open'`, which treats a queen-PLACED item
(state `'todo'`, 640 such rows in the DB) as "already resolved" and returns `ok:true` without
persisting. resolve-core.ts is the self-improvement loop's own back-edge = a protected surface per
the implement contract → **not auto-fixed**; filed as **EI-6938** (kind=change, needs-human) with
the precise fix (short-circuit only on terminal states resolved/closed).

Because of that bug I closed EI-6765 via the general completion path (`work_items:complete`,
state=resolved + completion ref) instead of `improvements:resolve`. Item is terminal → won't
re-dispatch.

## What the validator should re-verify
- The staleness default (6h) never suppresses a genuinely slow-backed-off live loop (backoff cap is
  1h; 6× headroom).
- The change lands via the release gate; once deployed, the orphaned `papercup` overwatch row is
  inert (`skipped-stale`). Optional hygiene (NOT done — auto-implement worker doesn't touch the live
  operator): `autoloop:control reset-errors` / delete the ghost `papercup` row.
- EI-6938 (resolve-core `'todo'` no-op) is a real, high-impact loop-closure gap — worth a human fix.
