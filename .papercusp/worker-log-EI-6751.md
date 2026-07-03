# Worker log — EI-6751

**Bug:** CHRONIC autoloop failure: `loop-su-358bcbb3-0e96-440a-b87f-e002c5bd0674@*`
red 12→21 consecutive fires (title says `loop-stuck-backstop`; it advanced).

Run: 1783107062-worker · 2026-07-03

## Reproduced (live PG, read-only)
- `autoloop_state` (role `loop-su-358bcbb3-…`, harness `*`): `consecutive_errors=21`,
  **`last_status='loop-terminal-unreachable'`** (recorded verbatim — the failure mode
  advanced past the `loop-stuck-backstop` in the title).
- `routines` (`loop-su-358bcbb3-…`, install_slug `*`): **`active=false`**, `next_fire_at=NULL`,
  last fired 2026-07-02 17:26 — the WI-1399 / EI-7006 dead-owner terminal guard already
  **auto-paused** it.
- Owner `adv_session` 9123 (`su-358bcbb3-…`): started 2026-06-30 22:28, **ended 2026-07-01 10:03**,
  only session, never restarted — owner permanently gone ~1.5 days before the loop's last fire.
  ⇒ the terminal guard's `loop-terminal-unreachable` verdict was **correct**, not a false kill.

## Root cause (this instance)
Dead-owner loop: the pinned warm su-session died, so every fire stuck-backstopped (owner
unreachable → no injectable/resumable wake channel). `consecutive_errors` climbed; the WI-1399
dead-owner terminal guard (`loop-unreachable-guard.ts`, via the EI-7006 circuit-open fast path
wired through `reconcile-loop-routines.ts`) correctly auto-paused the routine (`active=false`,
`last_status=loop-terminal-unreachable`). **A dead-owner loop's correct end-state IS deactivation
— no capability is lost.** The EI was a premature chronic escalation fired in the window before
the terminal guard's window elapsed. Structurally identical to the resolved sibling EIs
EI-6753 (`loop-su-30633068`) and EI-6756 (`loop-su-c25e5372`).

## Verified the failing condition no longer exists
- The chronic-failure sweep (`autoloop-chronic-failure.ts` `selectChronicFailures`) now
  **double-skips** this row: `routine_active === false` → `skipped-paused`, AND `last_fired_at`
  age 7h55m > 6h staleness window → `skipped-stale`. It cannot re-escalate.
- Live workspace-wide check (the exact watchdog JOIN, `consecutive_errors>=6 AND routine_active
  IS DISTINCT FROM false AND last_fired_at > now()-6h`): **0 rows**. Every red autoloop row is
  paused or a stale watermark — both guards hold.

## Durable class fix already landed (no NEW product code needed)
The fix machinery for this class pre-exists and is green:
- WI-1399 dead-owner terminal guard + EI-7006 circuit-open fast path (`loop-unreachable-guard.ts`,
  `reconcile-loop-routines.ts`) — auto-pauses the dead loop.
- The two chronic-sweep skip guards — `routine_active=false` (skipped-paused) and staleness
  (EI-6765, skipped-stale).
- EI-6753's `resetErrorScopes` (`agent-tools/autoloop/control.ts`) — makes the EI-prescribed
  `autoloop:control reset-errors { role }` reach the `*` (loop:arm) scope.
The exact shape of this row is already pinned by the regression test
`autoloop-chronic-failure.test.ts` › **"EI-6753 real shape: an auto-terminated loop (last_status
loop-terminal-unreachable, active:false) is NOT re-escalated"** — adding a duplicate per-loop test
would be redundant noise (the shape-level test covers the whole `loop-su-*@* dead-owner` class).

## Deployed-remediation confirmation + data hygiene
Ran the EI body's prescribed closing step through the **sanctioned tool** (not raw PG):
`autoloop:control reset-errors { harness: papercusp, role: 'loop-su-358bcbb3-…' }` →
`rowsReset: 1` in the `*` scope. This both (a) **proves EI-6753's `resetErrorScopes` fix is
deployed and functional** (pre-fix this returned 0 for a `loop-su-*@*` row) and (b) cleaned the
residue → `consecutive_errors=0`, `last_status='errors-reset'`, routine stays `active=false`.

## Verification (testsRun)
`cd packages/operator-core && npx vitest run
lib/harness/routines/autoloop-chronic-failure.test.ts
lib/harness/routines/loop-unreachable-guard.test.ts
lib/harness/routines/reconcile-loop-routines.test.ts
lib/agent-tools/autoloop/control.test.ts` → **62 passed (4 files)**.

## STOP-gate note / residual
- No product code changed — the durable fix pre-existed; the only write is the single-row
  error-counter reset (data hygiene) via the sanctioned agent tool.
- The SEPARATE residual (the chronic-failure escalator minting an EI per dead-owner loop in the
  ~window BEFORE the terminal guard pauses it) is a design change on the self-improvement
  watchdog + routines scheduler — a **protected surface** (implement STOP gate). It is already
  captured as **EI-7016** (`change`, 3 fix options) for human review. I did NOT touch it here.

## Validator should re-verify
- `loop-su-358bcbb3-…` `autoloop_state` row stays `consecutive_errors=0` / routine `active=false`
  (no re-fire, no re-escalation).
