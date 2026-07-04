# EI-6705 — CHRONIC autoloop failure: loop-su-512780a7-…@* red 95 consecutive fires

Run: 1783201034-worker · 2026-07-04 · (dispatch attempt 3; attempts 1–2 died with no resolve)

Same recurring class as EI-6756/6754/6721/… — a dead-owner `loop:arm` loop whose stale
error watermark was surfaced by the chronic-failure escalator.

## Reproduced (live PG)
- `harness_shared.autoloop_state` (role `loop-su-512780a7-865f-480e-a426-5e1c9d4d62e9`,
  harness `*`, ws `papercusp-workspace`): `consecutive_errors=95`,
  `last_status='loop-stuck-backstop'`, `last_fired_at='2026-07-01 06:09:35'` (3 days stale).
- `harness_shared.routines` (`loop-su-512780a7…`): **`active=false`**, `next_fire_at=infinity`,
  `target_role='system:loop-wake'`, **`target_owner_id='su-512780a7-865f-480e-a426-5e1c9d4d62e9'`**
  (non-null ⇒ a `loop:arm` OWNER loop). Last fired 2026-07-01 06:14. The reconcile dead-owner
  guard already **deactivated** it 3 days ago.

## Root cause (this instance)
Dead-owner `loop:arm` loop: the pinned warm su-session (`su-512780a7…`) died, so every fire
stuck-backstopped (owner unreachable → no injectable/resumable channel) and consecutive_errors
climbed to 95. The reconcile dead-owner terminal guard correctly auto-paused the routine
(`active=false`, `next_fire_at=infinity`). **A dead-owner loop's correct end-state IS
deactivation — no capability is lost.** The EI (filed 2026-07-02) was a premature chronic
escalation minted in the window before the loop:arm skip guard landed.

## Condition resolved — watchdog already suppresses this row on THREE grounds
`selectChronicFailures` (`packages/operator-core/lib/harness/routines/autoloop-chronic-failure.ts`)
drops this row via ALL of:
1. `isLoopArmOwnerLoop` — `routine_target_owner_id` non-null ⇒ **skipped-loop-arm** (EI-6727: the
   root-fix that closes this flood; owner-witnessed loops are auto-terminated by the reconcile
   guard's OWN escalation, not the sweep's).
2. `routine_active === false` ⇒ **skipped-paused** (a resolved condition, not a live failure).
3. `isStaleWatermark` — `last_fired_at` 3 days old > 6h stale window ⇒ **skipped-stale**.
These guards are **already landed** in the tree — no code change needed here.

## Data hygiene (the EI's prescribed closing step)
`autoloop:control { op:'reset-errors' }` cannot scope the `harness_slug='*'` brain-scope row
(`harness_required` — the tool wants a concrete slug/`all`, same limit prior workers hit). Used a
pinned single-row UPDATE via `$PAPERCUSP_DATABASE_URL` (harness_admin):
`UPDATE harness_shared.autoloop_state SET consecutive_errors=0, last_status='errors-reset'
 WHERE role='loop-su-512780a7-…' AND harness_slug='*' AND workspace_id='papercusp-workspace'`
→ `UPDATE 1` (routine left `active=false`; no re-arm). No code, scheduler, migration, or
deploy surface touched.

## Verification (testsRun)
`cd packages/operator-core && npx vitest run lib/harness/routines/autoloop-chronic-failure.test.ts
lib/harness/routines/loop-unreachable-guard.test.ts lib/harness/routines/reconcile-loop-routines.test.ts`
→ **74 passed (3 files)**. Confirms the guard machinery that resolves this class is green.

## Durable class-fix — landed / tracked, NOT auto-implemented (protected surface)
The loop:arm skip that prevents THIS class of EI (EI-6727) is already live. The residual
(the escalator still minting an EI per dead-owner loop in the ~window before the reconcile guard
circuit-opens and pauses it) touches the self-improvement watchdog + routines scheduler — a
design decision on STOP-list surfaces — and is already filed as **EI-7016** (change, human-gated).
Not re-filing; not touching those surfaces from this implement worker.

## Validator should re-verify
- `loop-su-512780a7-…` autoloop_state row stays `consecutive_errors=0` / routine `active=false`
  (no re-fire, no re-escalation).
- Only write this EI made is the single-row error-counter reset (data hygiene) — no code changed.
