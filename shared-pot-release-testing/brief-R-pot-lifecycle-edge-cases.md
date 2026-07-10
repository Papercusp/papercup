# Brief R — Pot lifecycle & edge cases

**Priority: S1 lane.** Live + integration. The lifecycle operations never witnessed.

## Objective
Exercise the full pot lifecycle beyond create→join: **dissolve, member-leave,
ownership transfer, pot rename/re-config, and concurrent membership operations** —
and confirm each leaves the federation in a correct, converged state.

## Why it matters
Testing focused on the happy path (create→publish→join→federate). The lifecycle EDGES
are untested and are exactly where state machines break: a half-dissolved pot, a
leave that races a write, an ownership transfer that orphans the topic, a rename that
splits the slug. These also stress the **pot-home harness federation** (A-003/EI-681)
under mutation, and feed directly into the C-001 re-key (dissolve/leave are
epoch-boundary events). Brief E touched visibility flips; this lane is the rest.

## Scope / scenarios
1. **Dissolve:** owner dissolves the pot → assert it withdraws from discovery, peers
   stop receiving new content, and the local state tears down cleanly (no orphan
   cores/topics/PG rows). (Today dissolve is the ONLY thing that cuts reads — confirm it does.)
2. **Member leave (self-initiated, vs owner-remove):** a member leaves → tombstone
   federates, the member stops appearing in others' membership, leave is idempotent.
3. **Ownership transfer** (if supported): transfer pot ownership A→B; assert the new
   owner can publish/admit + the topic/identity continuity holds (or document it's unsupported).
4. **Rename / re-config:** rename a pot or change its repo binding; assert the slug /
   topic derivation stays consistent for existing members (no split).
5. **Concurrent membership ops:** add + remove members simultaneously, or two owners'
   ops interleave; assert the membership set converges deterministically.
6. **Re-publish / re-share:** owner republishes an existing pot; assert no duplicate
   directory entries, no double-boot, idempotent.

## Method
- Live packaged pair for the witnessable ops (dissolve, leave, republish); integration
  rigs for concurrency. Verify via embedded-PG + discovery directory + each peer's topics.
- Coordinate with Brief Q (membership churn) + the re-key lane (dissolve/leave = epoch events).

## Deliverables
- `findings-R.md`: lifecycle matrix + any orphaned-state / split-slug / non-idempotent
  bug, with the dissolve-cuts-reads confirmation (the current sole read-revocation path).

## Done / verdict
GREEN only when every lifecycle op (dissolve, leave, transfer, rename, concurrent)
leaves a correct, converged, orphan-free state, and dissolve verifiably cuts reads.
