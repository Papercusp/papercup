# Worker log — EI-6799 (implement / auto-fix)

## Item
EI-6799 (kind=bug, harness=*, severity=major): "Engine loop
`loop-su-d99921e3-5b88-433c-bd53-a4b938814b2b` stalled (parked, no completion)".
Watchdog signal, source `loop-stalled`, watchdogKey
`loop-stalled:loop-stalled:*:loop-su-d99921e3-...`.

## Outcome: `needs-human`

Two independent reasons, both landing on protected/STOP surfaces:
1. The item's original watchdog CONDITION is already self-resolved, but its
   durable CLASS fix touches the routines/DBOS scheduler + the self-improvement
   watchdog (already owned by EI-6256, needs-human).
2. **I discovered, mid-fix, a distinct systemic bug in the self-improvement
   loop's own resolve back-edge** that makes `improvements:resolve { outcome:
   'fixed' }` SILENTLY NO-OP for this item (and ~447 others) — so `fixed` cannot
   actually close EI-6799. Fixing it touches the self-improvement loop's own code
   (`resolve-core.ts`) and/or shared core `work-items.ts`. Captured separately.

## Part 1 — the watchdog condition is self-resolved (read-only repro)

- `harness_shared.routines` (`loop-su-d99921e3-...`): `active=false`,
  `next_fire_at='infinity'`, `reschedule_interval_sec=90`, updated 2026-07-02 17:21:24.
- `harness_shared.autoloop_state` (role `loop-su-d99921e3-...`): `last_status='queued'`,
  `consecutive_errors=0`, `last_fired_at=2026-07-02 17:21:04`.
- `harness_shared.adv_sessions` (owner `su-d99921e3-...`): started 2026-07-02 13:55,
  **ended 2026-07-02 18:36:06** (no pid) — owner session permanently gone.
- The `loop-stalled` collector (`collectLoopStalledSignals`, watchdog.ts:1098)
  gates its query on `WHERE r.active = true`. This loop is `active=false`, so it
  cannot re-surface. Ran the collector's EXACT predicate live → this loop is NOT
  among the 10 current matches. The watchdog condition for EI-6799 is gone.
- Class defect (already owned by EI-6256, still `open`/needsHuman): 10 OTHER loops
  currently match the predicate, parked ~11–18h; an orphaned loop whose owner
  `adv_sessions.ended_at` is set is not auto-ended because a detached
  `claude --resume` spawn counts as `woken>0` in `loop-fire.ts:207`. Durable fix =
  routines/DBOS scheduler + watchdog = STOP surface. Not re-filed (dedup with EI-6256).

## Part 2 — DISCOVERED: `improvements:resolve` silently no-ops on `state='todo'` EIs

While closing the loop I found `improvements:resolve { outcome: 'fixed' }` returns
`ok:true` but does NOT resolve EI-6799. Root cause, traced end-to-end:

- `harness_shared.engineer_issues` is a **VIEW** over base table
  `harness_shared.work_items`, exposing `status AS state`.
- `work_items.status` for EI-6799 is **`'todo'`**. The canonical issue-family
  lifecycle (`LifecycleState`, libs/generic/pubsub-substrate/.../types.ts:195) is
  only `'open' | 'resolved' | 'closed'` — `'todo'` is out-of-vocabulary for an
  issue. It arises because the work-items create path hardcodes `status='todo'`
  for ALL kinds (`work-items.ts:800`), and issue-family mints via that path get
  `'todo'` instead of `'open'`. (447 issue-family EIs are stuck this way: 127 bug +
  320 change with `state='todo'`.)
- Every read layer normalizes `todo→open` (e.g. `work_items:get` reported EI-6799
  as `state:'open'`), so it looks resolvable — EXCEPT `resolve-core.ts`, which reads
  the raw value via `getIssue` (`state: r.state as IssueState`, a raw cast) and
  compares to the literal `'open'`:

  ```ts
  if (issue.state !== 'open' && input.outcome === 'fixed') {
    await closeLedger();                    // runs
    return { ok: true, outcome: 'fixed', state: issue.state };  // NO setIssueState!
  }
  ```
  `'todo' !== 'open'` is true → it treats `todo` as ALREADY-TERMINAL → idempotent
  no-op → the item is never transitioned to `resolved`. Proven: my `fixed` resolve
  returned `ok:true` but the row stayed `state='todo'`, `updated_at` unchanged.

- Consequence: a `todo`-state improvement can NEVER be resolved-fixed. The
  dispatcher treats `todo` as dispatchable, resolve-core refuses to resolve it →
  it ping-pongs (dispatch → worker → no-op resolve → dispatch) until
  `implementAttempts` hits maxAttempts (3) → routeExhaustedImprovementToHuman.
  Contrast: EI-6443 (state was `open`) resolved cleanly open→resolved→applied;
  EI-6256 (state `open`, needs-human) set `needsHuman=true`. Only EI-6799's `todo`
  state triggers the no-op.

### Candidate fixes (all STOP surfaces — for a human)
- **Narrow (self-improvement loop's own code):** in `resolve-core.ts`, replace
  `issue.state !== 'open'` with a real terminal check
  (`issue.state === 'resolved' || issue.state === 'closed'`) so both `open` and the
  `todo` synonym proceed to actually resolve. Lowest blast radius; add a regression
  test alongside `resolve.test.ts` / `resolve-core` tests.
- **Root (shared core `work-items.ts`):** make issue-family creation use
  `status='open'` (not the unified `'todo'` default) — bigger blast radius, and
  needs a data migration for the 447 already-`todo` rows.

## Why `needs-human` (not `fixed`, not `could-not-fix`)
- `fixed` PROVABLY no-ops for this item (state stays `todo`) — it would not close
  the loop; EI-6799 would keep re-dispatching. Wrong outcome.
- `needs-human` runs unconditionally (no `state !== 'open'` guard): it sets
  `payload.needsHuman=true` + releases the claim + closes the dispatch ledger, so
  EI-6799 actually LEAVES the auto lane and is flagged for a human — the only
  outcome that both sticks AND is honest, since every remaining durable fix
  (loop-stall class fix + the resolve-core no-op) is a protected STOP surface.

## For a validator to re-verify
- `SELECT status FROM harness_shared.work_items WHERE feature_id='EI-6799'` → `todo`
  (pre-resolve), and after this needs-human resolve, `payload->>'needsHuman'='true'`.
- `SELECT active FROM harness_shared.routines WHERE target_owner_id='su-d99921e3-...'`
  → `false` (the loop is inactive; the watchdog condition is gone).
- Reproduce the no-op: `improvements:resolve { id:<any state='todo' bug>, outcome:'fixed',
  testsRun:'x' }` returns `ok:true` but the row's `status` stays `todo`.
