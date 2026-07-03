# Worker log — EI-6799 (implement / auto-fix)

## Item
EI-6799 (kind=bug, harness=*, severity=major): "Engine loop
`loop-su-d99921e3-5b88-433c-bd53-a4b938814b2b` stalled (parked, no completion)".
Watchdog signal, source `loop-stalled`, watchdogKey
`loop-stalled:loop-stalled:*:loop-su-d99921e3-...`.

## Outcome: `fixed` (contract step 2 — cannot reproduce; the condition no longer exists)

## Investigation (read-only, `dev:pg_query`)

Read the referenced runbook `agent-insights/loop-wake-turn-deaths-recorded-as-delivered`
and the two prior same-class worker logs (EI-6256 → needs-human, EI-6443 → fixed),
then reproduced against live PG.

**The specific loop is already terminal (inactive):**
- `harness_shared.routines` (`loop-su-d99921e3-...`): `active=false`,
  `next_fire_at='infinity'`, `reschedule_interval_sec=90`, updated 2026-07-02 17:21:24.
- `harness_shared.autoloop_state` (role `loop-su-d99921e3-...`): `last_status='queued'`,
  `consecutive_errors=0`, `last_fired_at=2026-07-02 17:21:04`.
- `harness_shared.adv_sessions` (owner `su-d99921e3-...`): started 2026-07-02 13:55:39,
  **ended 2026-07-02 18:36:06** (no pid) — the owner session is permanently gone.

**The `loop-stalled` collector cannot re-surface this loop.**
`collectLoopStalledSignals` (`packages/operator-core/lib/harness/improvements/watchdog.ts:1098`)
gates its query on `WHERE r.active = true`. This loop is `active=false`, so it is
excluded. Confirmed by running the collector's EXACT predicate against live PG: this
loop is **not** among the current matches. The watchdog condition for EI-6799 is gone.

## Why `fixed` and not `needs-human`

The `needs-human` STOP path (used by EI-6256) is for when a durable fix is REQUIRED
but blocked by a protected surface. Here there is **no live defect on this instance** to
fix — the loop has already self-terminated (`active=false`), so the specific condition
is resolved. This matches the EI-6443 precedent for the identical class (that loop had
self-healed via the dead-man guard → resolved `fixed`, cannot-reproduce).

## The class-level defect is real, live, and already owned by EI-6256 (a STOP surface)

This is NOT a mitigation-hides-the-bug situation — I changed nothing; the loop
self-terminated. The underlying CLASS defect persists and is out of scope for
auto-implement:
- Running the collector predicate now returns **10 other active loops** parked at
  `'infinity'` for ~11–18h (e.g. `loop-su-7e812a66-...`, EI-6256's loop, still stuck).
- Root cause (per EI-6256, verified there): a genuinely-orphaned loop whose owner
  `adv_sessions.ended_at` is set is NOT auto-ended, because a detached `claude --resume`
  spawn counts as `woken>0` in `loop-fire.ts:207`, so P2c's `no-session-now` branch is
  skipped and the reconcile stuck-park backstop re-parks it forever.
- Durable fixes (auto-end when owner session ended / hard `consecutive_errors`
  deactivation cap / reclassify the collector so it stops minting one auto-implement
  `kind=bug` per ephemeral loop instance) all touch **`loop-fire.ts` +
  `reconcile-loop-routines.ts` + `autoloop.ts` (routines/DBOS scheduler)** and
  **`watchdog.ts` (the self-improvement loop's own code)** — both explicit STOP surfaces
  for the `implement` blueprint.
- That class fix is already open + owned by **EI-6256** (`state=open`, needs-human).
  Not re-filing (search-first dedup — EI-6256 covers it).

## For a validator to re-verify
- `SELECT active, next_fire_at, last_status FROM harness_shared.routines r
   JOIN harness_shared.autoloop_state a ON a.role = r.name
   WHERE r.target_owner_id='su-d99921e3-5b88-433c-bd53-a4b938814b2b'` → `active=false`.
- The `loop-stalled` collector requires `active=true` (watchdog.ts:1112), so an inactive
  loop can never re-surface. EI-6799's condition cannot recur.
