# EI-6756 — CHRONIC autoloop failure: loop-su-c25e5372-…@* red 10 consecutive fires

Run: 1783096590-worker · 2026-07-03

## Reproduced (live PG)
- `autoloop_state` (role `loop-su-c25e5372-fd63-4ecd-959e-a819bd0ae9a6`, ws `papercusp-workspace`,
  harness `*`): consecutive_errors climbed to **19**, `last_status='loop-terminal-unreachable'`
  (title said `loop-stuck-backstop` at filing time — 10 fires; it kept climbing after).
- `routines` (`loop-su-c25e5372…`): **`active=false`**, `next_fire_at=null`, last fired
  2026-07-03 07:39. The WI-1399 dead-owner terminal guard already **deactivated** it.
- Owner `adv_session` 9135 (`su-c25e5372…`): started 2026-06-30 22:28, **ended 2026-07-01 18:11**
  (only session, never restarted) — owner permanently gone ~1.5 days before the loop's last fire.
  ⇒ the terminal guard's `loop-terminal-unreachable` verdict was **correct**, not a false kill.

## Root cause (this instance)
Dead-owner loop: the pinned warm su-session died, so every fire stuck-backstopped (owner
unreachable → no injectable/resumable channel). consecutive_errors climbed; the WI-1399 terminal
guard (`loop-unreachable-guard.ts`) correctly auto-paused the routine (`active=false`,
`last_status=loop-terminal-unreachable`). A dead-owner loop's correct end-state **is** deactivation
— no capability is lost. The EI was a **premature** chronic escalation fired in the window before
the terminal guard's ~4h window elapsed.

## Resolution (this EI — condition resolved)
- The reported live-failure condition no longer exists: routine `active=false`, watchdog now
  **skips** the row. Verified with the exact watchdog JOIN
  (`autoloop_state` ⋈ `routines` on `name=role AND workspace_id`): `routine_active=false` ⇒
  `selectChronicFailures` filters it (skipped-paused). It also becomes stale-watermark-skipped <1h.
- Cleanup (the EI body's prescribed closing step, `autoloop:control reset-errors`): targeted
  single-row UPDATE on the dead row → `consecutive_errors=0, last_status='errors-reset'` (routine
  stays `active=false`; the tool path can't scope the `*` brain-scope row, so a precise raw UPDATE
  via `getHarnessAdminUrl()` was used).

## Verification (testsRun)
`cd packages/operator-core && npx vitest run
lib/harness/routines/autoloop-chronic-failure.test.ts lib/harness/routines/loop-unreachable-guard.test.ts
lib/harness/routines/reconcile-loop-routines.test.ts` → **40 passed (3 files)**. Confirms the guard
machinery that resolves this class (chronic-failure skip guards, WI-1399 terminal guard, reconcile
integration) is green.

## Durable class fix — filed, NOT auto-implemented (protected surface)
Dozens of these EIs (EI-6696/6699/6704/6707/6721/6724/6727/6747/6753 open; EI-6754 **and** EI-6756
for this same loop) = a real noise cluster. The durable fix (stop the escalator firing for a
dead-owner loop in the pre-termination window) touches the self-improvement watchdog +
routines scheduler — a design decision on STOP-list surfaces. Captured once as **EI-7016**
(`change`, 3 fix options) for human review rather than auto-implementing.

## Validator should re-verify
- The `c25e5372` `autoloop_state` row stays `consecutive_errors=0` / routine `active=false` (no
  re-fire, no re-escalation).
- No code changed in this EI; the only write is the single-row error-counter reset (data hygiene).
