# EI-6724 — CHRONIC autoloop failure: loop-su-f561ab33-…@* red 42 (now 54) consecutive fires

Run: 1783168258-worker · 2026-07-04

## Reproduced (live PG)
- `autoloop_state` (role `loop-su-f561ab33-26f1-450e-9d2a-35a220ac7cb7`, ws `papercusp-workspace`,
  harness `*`): `consecutive_errors=54`, `last_status='loop-terminal-unreachable'` (title said
  `loop-stuck-backstop` at filing — 42 fires; it kept climbing then terminated).
- `routines` (`loop-su-f561ab33…`): **`active=false`**, `next_fire_at=null`, `target_owner_id=
  su-f561ab33…`, last fired 2026-07-02 17:08. The WI-1399 dead-owner terminal guard already
  **deactivated** it.
- Owner `adv_session` 9180 (`su-f561ab33…`): started 2026-07-01 06:22, **ended 2026-07-01 12:09**
  (only session, never restarted) — owner permanently gone ⇒ the terminal guard's
  `loop-terminal-unreachable` verdict was **correct**, not a false kill.

## Root cause (this instance)
Dead-owner `loop:arm` loop. The pinned warm su-session died, so every fire stuck-backstopped
(owner unreachable → no injectable/resumable channel); `consecutive_errors` climbed and the
WI-1399 dead-owner guard auto-paused the routine. The EI was a **PREMATURE** chronic escalation
fired in the window before the guard circuit-opened (≥8) and paused the routine — EI-6727's exact
scenario. EI-6724 is one of the named noise-cluster EIs (see EI-6756 worker-log: "EI-6696/6699/
6704/6707/6721/**6724**/6727/6747/6753").

## Condition no longer exists — verified (this is the "fixed: gone" path)
Live watchdog JOIN (`autoloop_state ⋈ routines ON name=role AND workspace_id`) over the row shows
it suppressed on **three independent axes**:
1. `routine_active = false` → `skipped-paused` (WI-1399 terminal guard).
2. `routine_target_owner_id = su-f561ab33…` (non-null) → `skipped-loop-arm` (EI-6727 guard,
   `isLoopArmOwnerLoop`).
3. staleness `1 day 00:58` (>6h) → `skipped-stale` (EI-6765 frozen-watermark guard).
Ran the SAME JOIN across ALL **44** currently-breaching rows (`consecutive_errors >= 6`): **ZERO
would escalate** — every loop-su/loop-role row is `skipped-loop-arm`, the orphaned `overwatch@papercup`
row is `skipped-stale`. The chronic-failure escalator will never re-fire for this row (or any dead
loop:arm loop).

## Durable class fix — already LANDED (no new code needed)
The guards that resolve this class are live in the tree: EI-6727 (`isLoopArmOwnerLoop` loop-arm
skip), EI-6765 (`isStaleWatermark` staleness guard), WI-1399/EI-7006 (dead-owner terminal guard +
circuit-open fast path in `reconcile-loop-routines.ts`). Future dead-owner loops are dropped by the
sweep at the root — no more of these EIs will be minted. The residual (an EI can still be minted in
the sub-guard window BEFORE termination) is captured/human-gated as **EI-7016** (protected surface:
self-improvement watchdog + routines scheduler). No code change is in this implement's scope.

## Existing regression tests already pin EI-6724's shape (no new test added)
`autoloop-chronic-failure.test.ts` already pins both of EI-6724's suppression axes with real-world
shapes — adding a per-loop duplicate would be dead-weight in the corpus:
- "EI-6753 real shape" (L43): `last_status='loop-terminal-unreachable'` + `routine_active:false` →
  `selectChronicFailures` drops it. = EI-6724's paused/terminal axis.
- "EI-6727" loop:arm owner tests (L116/147/163): a `loop-su-<uuid>` with `routine_target_owner_id`
  is dropped even at streak 58/99. = EI-6724's loop-arm-owner axis.

## Cleanup — intentionally NOT run (reset-errors would DELAY it)
The EI body's generic "then autoloop:control reset-errors" is **counterproductive for a terminal-
paused row**: `resetFireErrors` sets `last_status='errors-reset'`, stripping the
`LOOP_TERMINAL_AUTO_PAUSE_STATUS` marker → the row no longer matches `pruneStaleFireState` **class-2**
(terminal-marker + inactive-routine → immediate retire) and falls back to **class-1** (14-day age
gate). Verified `class2_prune_matches = true` for this row, so the correct hygiene is to LEAVE IT —
`pruneStaleFireState` retires it on the next fire-path hygiene cycle. (Improvement over the EI-6756
worker, which ran reset-errors and thereby delayed that row's cleanup to the 14-day path.) The row is
fully inert regardless (suppressed on all 3 watchdog axes), so it causes no re-escalation while it
waits for the prune.

## Verification (testsRun)
`cd packages/operator-core && npx vitest run lib/autoloop.test.ts
lib/harness/routines/autoloop-chronic-failure.test.ts lib/harness/routines/loop-unreachable-guard.test.ts
lib/harness/routines/reconcile-loop-routines.test.ts` → **89 passed (4 files)**.

## Validator should re-verify
- The `f561ab33` `autoloop_state` row stays suppressed (no autoloop-chronic fire; watchdog verdict
  `skipped-loop-arm`) and is retired by `pruneStaleFireState` class-2 (no manual reset).
- No code changed in this EI; no DB write made (the row is left for natural prune).
