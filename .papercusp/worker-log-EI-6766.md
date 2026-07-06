# worker-log — EI-6766 (implement / self-improvement auto-fix)

**Outcome:** fixed (resolved via improvements:resolve)

## Item
EI-6766 (bug): "CHRONIC autoloop failure: loop-su-cea4c674-d05a-49df-9748-62a6702753d3@* red 6 consecutive fires". last_status verbatim: `loop-stuck-backstop`. Payload notes it is the DUPLICATE of EI-6769 (same loop; kept item carries the friction).

## Diagnosis — stale pre-fix phantom (same class as EI-7124 / EI-7299 / EI-7312)
Reproduced from the live store (`dev:pg_query` on `harness_shared.*`):
- `autoloop_state` (role=`loop-su-cea4c674-…`, harness=`*`): `consecutive_errors=6`, `last_status='loop-stuck-backstop'`, `last_fired_at='2026-07-01 06:09:38'` (~5 days stale).
- `routines` (name=`loop-su-cea4c674-…`): **`active=false`**, **`next_fire_at=infinity`**, `target_owner_id=su-cea4c674-…` (non-null → a `loop:arm` OWNER loop), `target_role='system:loop-wake'`. The loop is RETIRED — it will never fire again, so the streak can never climb or reset.
- `coord_presence`: **0 rows** for owner `su-cea4c674-…` → the owner su-session is DEAD (the root of the black-holed wakes / `loop-stuck-backstop`).

`selectChronicFailures` (packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts) suppresses this exact row **THREE** independent ways:
1. `isLoopArmOwnerLoop` — role begins with `loop-` (`isLoopArmOwnerRole`, EI-7220) AND `routine_target_owner_id` non-null (EI-6727) → owner-witnessed, auto-terminated by the reconcile dead-owner guard with its OWN `escalateDeadLoop`.
2. `routine_active === false` — auto-paused, a resolved condition (EI-6760/6761/6762).
3. `isStaleWatermark` — `last_fired_at` >6h (~5 days) → frozen watermark (EI-6765).

Timeline confirms stale-pre-fix: EI-6766 captured 2026-07-02 14:26; the `isLoopArmOwnerRole` role-name guard (EI-7220) landed 2026-07-05 12:10 (commit `34ab1dc348`). The escalation fired in the pre-fix window before the guard deployed.

## Why NO new code / regression pin (avoiding dead weight)
`selectChronicFailures` already returns `[]` for EI-6766's exact shape. The **EXACT loop** (`loop-su-cea4c674-…`, `consecutive_errors: 6`, `routine_active: false`) is ALREADY pinned in `autoloop-chronic-failure.test.ts` as the **EI-6769 boundary case** (lines 81–88) — EI-6769 is EI-6766's duplicate (same loop). Adding an EI-6766 pin would be byte-identical strictly-dominated dead weight; the repo discourages near-duplicate pins. The existing suite is the regression evidence.

## Files changed
None (source already correct; regression pin already present).

## Tests run
`TMPDIR=/tmp node node_modules/.bin/vitest run --config packages/operator-core/vitest.config.ts lib/harness/routines/autoloop-chronic-failure.test.ts` → **45 passed (45)**, 0 failed. Confirms the code suppresses EI-6766's exact loop shape (via the EI-6769 boundary pin + the loop-arm-role / stale-watermark pins).

## Remediation (`autoloop:control reset-errors`) — not needed
The routine is retired (`active=false`, `next_fire_at=infinity`) so it can never fire again, and the frozen streak-6 watermark row is suppressed by `selectChronicFailures` three independent ways regardless of its counter value. Resetting `consecutive_errors` would be a purely cosmetic no-op on a dead loop — it changes no behavior and the bug (chronic-escalation flood) cannot recur. Left as-is.

## Validator re-verify
- `harness_shared.routines` row for `loop-su-cea4c674-…` stays `active=false` / `next_fire_at=infinity` → will not fire or re-escalate.
- The EI-6769 pin in `autoloop-chronic-failure.test.ts` guards this exact shape (fails-before/passes-after the `routine_active` skip-filter).
- This recurring class is already documented in `agent-insights/loop-wake-turn-deaths-recorded-as-delivered.mdx` + the module header runbook + the mem0 "Phantom loop-su routine-failure EIs" fact — no new insight written (would duplicate).
