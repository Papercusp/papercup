# Brief Z — Data-integrity edges

**Priority: S1 lane (S0 if loss/resurrection).** Integration + property-based. The
correctness edges D-001 didn't cover.

## Objective
Prove federated content survives the **data edges** intact: large payloads, arbitrary
encodings, and the per-content-type conflict semantics — especially **deletes,
tombstones, and the delete-resurrection class** — for every federated type, not just
the LWW-convergence happy path.

## Why it matters
D-001 proved CONVERGENCE (same winner everywhere) but not per-type SEMANTIC correctness
at the edges. d2230's re-key del-guard work surfaced the **resurrection** risk directly:
"a forward clock excursion lets a federated delete lose to the put it supersedes →
resurrection." Deletes vs updates, tombstone propagation, empty/null fields, oversized
or binary payloads, and unicode are exactly where a federated store silently corrupts or
loses data — and none of it is systematically tested across types.

## Scope / scenarios
1. **Delete semantics per type:** federate a delete; assert it crosses + the row is gone
   on the peer (not resurrected by a later-arriving stale put). Test the d2230 del-guard
   invariant LIVE/integration for each mutable type: a causally-later delete beats an
   earlier put even under fed_ts skew (the HLC del-guard).
2. **Delete-resurrection (the S0 class):** concurrent delete (A) + update (B) of the same
   key under clock skew → assert a deterministic, NON-resurrecting outcome on all peers.
3. **Tombstone handling:** does a delete leave a tombstone that federates + suppresses
   re-creation, or can the row silently re-appear from an un-drained peer? Test
   `leave-pot-tombstone` / contributor-tombstone semantics under churn.
4. **Large / binary payloads:** federate large content rows (KB→MB), binary/blob fields
   — assert no truncation, no corruption, no encoding mangling (the op-key/value mapper
   round-trips). Find the payload ceiling + that it fails gracefully past it.
5. **Encoding / unicode / special chars:** emoji, RTL, NUL bytes, very long strings,
   JSON-special chars in content → round-trip through capture→drain→projection intact.
6. **Empty / null / boundary fields:** null vs empty-string vs missing; numeric extremes;
   the column-completeness mappers handle them (the B-001 silent-drop class per column).

## Method
- Integration (real PG round-trip via the value mappers) + **fast-check** property tests
  for payload/encoding round-trip + delete-vs-update ordering invariants. Reuse the
  convergence-fuzz rig for the resurrection cases. Teeth-verify each invariant.

## Deliverables
- `findings-Z.md`: per-type delete/tombstone/resurrection matrix, payload + encoding
  round-trip limits, any silent loss/corruption/resurrection (S0) with repro.

## Done / verdict
GREEN only when deletes federate without resurrection across all types under skew,
tombstones suppress re-creation, and arbitrary payloads/encodings round-trip intact.
