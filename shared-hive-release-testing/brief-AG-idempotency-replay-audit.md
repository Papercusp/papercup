# Brief AG — Idempotency / determinism / replay audit

**Priority: S1 lane (S0 if non-idempotent → loss/dup).** Property-based over the full pipeline.

## Objective
Prove the federation pipeline is **idempotent + deterministic**: re-applying the same op
log yields identical state, replay from ANY cursor converges, and there is no
double-apply, no order-dependence beyond the documented LWW. The foundational guarantee
every other lane assumes.

## Why it matters
Federation is a CDC pipeline: capture → outbox → drain → projection → merge, with cursors,
HLC ordering, and re-applies on reconnect/backfill. Every recovery, churn, and partition
scenario relies on re-applying ops being SAFE — but idempotency is assumed, not audited.
The session already saw the resurrection class (a re-applied/reordered delete-vs-put), the
cursor-reset-on-revoked-log behavior (re-UPSERT must be idempotent), and backfill re-fold.
If any step is non-idempotent, every reconnect/backfill/crash-recovery silently
double-applies or loses — and it'd pass the happy-path tests. This is the audit that
underwrites all the recovery/churn lanes.

## Scope / scenarios (property-based, seeded)
1. **Double-apply safety:** apply an op log, then apply it AGAIN (same ops) → byte-identical
   projected state. For every content type + the claims/authority append-only logs.
2. **Replay-from-any-cursor:** start the projection from cursor 0, then from an arbitrary
   mid-cursor → both reach the same final state (the backfill/cold-boot-resume invariant,
   generalized; F's cold-boot-resume is prior art — make it a property).
3. **Reorder-within-LWW:** apply ops in different orders → final state identical (LWW is
   order-independent by design); EXCEPT where causal HLC ordering is required (deletes,
   epoch keys) — assert those are stable too.
4. **Duplicate / at-least-once delivery:** the substrate is at-least-once — assert
   duplicate op delivery is absorbed (no dup rows, no count inflation — the SET-semantics
   rule: never re-fold counts).
5. **Cursor-reset idempotency:** dropping a revoked log resets the merge cursor → the
   re-UPSERT must be idempotent (no resurrection, no loss) — audit it explicitly.
6. **Determinism across runs:** the same seeded op sequence → identical state across
   repeated runs + across peers (no Math.random/Date.now nondeterminism in the apply path).

## Method
- **fast-check** property tests over the real capture→drain→projection pipeline (real PG):
  generate random op sequences, apply with random dup/reorder/replay/cursor-reset, assert
  byte-identical projected state. Reuse `_convergence-fuzz-rig` + `_cross-peer-rig`.
  SET-semantics assertions (assert WHICH ids/values, never re-fold counts). Teeth-verify
  (inject a non-idempotent UPSERT → the double-apply property goes RED).

## Deliverables
- `findings-AG.md`: the idempotency/determinism audit results, any non-idempotent step
  (S0/S1 — it underwrites every recovery lane), the reusable replay-property harness.

## Done / verdict
GREEN only when double-apply, replay-from-any-cursor, reorder-within-LWW, duplicate
delivery, and cursor-reset are all proven idempotent + deterministic across a large seed sweep.
