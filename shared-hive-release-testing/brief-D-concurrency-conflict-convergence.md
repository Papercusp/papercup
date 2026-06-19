# Brief D — Concurrency, conflict resolution & convergence

**Priority: S0 lane.** Integration + property-based; no live instances needed.

## Objective
Prove the substrate is a correct eventually-consistent store: under **any**
ordering of concurrent writes, partitions, and reconnections, all honest peers
**converge to the same state** with **no loss, no duplication, monotonic
watermarks**, and a **deterministic** conflict winner.

## Why it matters for release
P2P means concurrent edits and partitions are normal, not exceptional. There's
good seed coverage (`swarm-chaos`, `three-peer-partition-rejoin`,
`cross-peer-coordination-scale`, `merge-scaling`) but it isn't systematic across
content types or adversarial orderings.

## Scope / scenarios
1. **Concurrent same-key writes.** A and B both edit the same feature/work-item/
   plan/conversation "simultaneously" (interleaved appends). Assert the LWW winner
   is deterministic (same on every peer) and matches the documented rule. Do this
   for EVERY content type, not just features.
2. **Concurrent claim/assignment.** Two peers claim the same work-item /
   plan-item. Exactly one wins; the other sees the claim; no double-execution
   (`feature_claims`, `plan_item_claims`, `claim_audit`). Authority election +
   claim serialization under contention.
3. **Partition / heal.** N peers, partition into groups, each group keeps writing,
   then heal. Assert full convergence (no loss/dup, monotonic watermarks) — extend
   `three-peer-partition-rejoin` to all content types and to 4–5 peers.
4. **Authority churn.** Kill/reconnect the lock authority repeatedly mid-claim
   (`authority-failover-flood`); assert unanimous re-election among survivors and
   that claims still serialize at every epoch.
5. **Crashed-holder steal.** A claims, "crashes" (stops heartbeating); after the
   stale window another peer steals; the original's late write is rejected
   (`redundancy-two-swarm` covers a slice — generalize).
6. **Property-based convergence.** Generate random op sequences across K peers with
   random partition/reorder/dup, apply on all, assert final state identical on all
   (a model-based / fuzz harness). Seed-controlled (no `Math.random` in scripts —
   vary by index/args).

## Method
- Integration (`vitest.integration.config.ts`) + the chaos rigs. Use SET-semantics
  assertions (assert WHICH ids/values converge, never re-fold counts — dropping a
  revoked log resets the merge cursor → idempotent re-UPSERT).
- For the property test, a deterministic seeded generator; assert
  byte-identical projected state across peers.

## Deliverables
- `findings-D.md`: convergence matrix (content type × {concurrent, partition,
  churn, steal}) + the LWW rule documented per type + any non-convergence (S0).
- A reusable seeded fuzz harness (Vitest) for future regression.

## Done / verdict
GREEN only when every content type converges deterministically under concurrent
writes, partition/heal, authority churn, and crashed-holder steal, and the fuzz
harness finds no divergence over a large seed sweep.
