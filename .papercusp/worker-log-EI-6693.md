# EI-6693 — CHRONIC autoloop failure: loop-su-ffe3af39-…@* red 221 consecutive fires

Run: 1783204590-worker · 2026-07-04

## Reproduced (live PG)
`autoloop_state` (role `loop-su-ffe3af39-0780-433f-a805-7aa3c0ebd52f`, ws `papercusp-workspace`,
harness `*`), joined to `harness_shared.routines` on `(name, workspace_id)`:
- `consecutive_errors=221`, `last_status='loop-stuck-backstop'`
- `last_fired_at=2026-07-01 06:09:54` — **3+ days stale** (today 2026-07-04)
- matching routine: **`active=false`**, `next_fire_at=infinity`, `target_owner_id=su-ffe3af39-…`,
  `reschedule_interval_sec=120`
- owner `adv_sessions` row for `su-ffe3af39-…`: **does not exist** (permanently gone) → dead-owner loop.

## Root cause (this instance)
Dead-owner `loop:arm` loop: the pinned warm su-session died, so every fire stuck-backstopped
(owner unreachable → no injectable/resumable channel). `consecutive_errors` climbed to 221 while
the reconcile terminal guard hadn't yet paused it; it is now paused (`active=false`). This EI is a
**premature chronic escalation** for a loop that the autonomy already retired — the frozen 221 is a
stale watermark, not a live failure.

## Why the condition is already resolved (durable class fix is LANDED in-tree)
`selectChronicFailures` (`autoloop-chronic-failure.ts`) now excludes this exact row on THREE
independent grounds, so the watchdog can never re-escalate it:
1. `routine_active === false` → **skipped-paused**.
2. `routine_target_owner_id` non-null (`isLoopArmOwnerLoop`, EI-6727) → **skipped-loop-arm**
   (loop:arm owner loops are owner-witnessed + auto-terminated by the reconcile dead-owner guard,
   which fires its own `escalateDeadLoop` escalation — the chronic sweep must not double-file).
3. `last_fired_at` older than the 6h `staleWindowMs()` (EI-6765) → **skipped-stale**.

No code change was needed and none was made — the class fix (EI-6727 / EI-6765 / the `active=false`
paused-skip) pre-existed this dispatch. This mirrors the resolution of the sibling cohort
(EI-6756/6753/… — dead-owner loops correctly auto-paused; the EI fired in the pre-termination window).

## Resolution (data hygiene — the EI body's prescribed closing step)
`autoloop:control { op:'reset-errors', harness:'papercusp', role:'loop-su-ffe3af39-…' }` →
`rowsReset:1` in the `*` scope (`resetErrorScopes` adds `'*'` for a role-scoped reset, EI-6753).
Post-reset the row reads `consecutive_errors=0`, `last_status='errors-reset'`, routine still
`active=false` (no re-arm — a dead-owner loop's correct end-state is deactivation; no capability lost).

## Verification (testsRun)
`cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts` →
**31 passed**. Plus the guard machinery that resolves the class:
`… loop-unreachable-guard.test.ts reconcile-loop-routines.test.ts` → **43 passed (2 files)**.
Total **74 passed** — chronic-failure skip guards (paused / loop-arm / stale), WI-1399 terminal
guard, reconcile integration all green.

## Validator should re-verify
- The `ffe3af39` `autoloop_state` row stays `consecutive_errors=0` / routine `active=false`
  (no re-fire, no re-escalation).
- No source code changed; the only write is the single-row error-counter reset (data hygiene).
