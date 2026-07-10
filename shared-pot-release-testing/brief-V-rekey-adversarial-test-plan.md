# Brief V — Re-key (Move 2) adversarial test plan

**Priority: S0-for-release lane.** The test GATE for the C-001 re-key. Author NOW;
runs as the re-key (ed300 crypto foundation + K boundary/distribution) lands.
**Co-own with K** (whose lane includes the live cut-off witness) — this is the
adversarial half: actively try to BREAK the read-cutoff guarantee.

## Objective
Define + build the adversarial test battery that proves the re-key actually delivers
read-revocation: a removed member (or excluded peer) **cannot read content created
after the boundary**, while remaining members keep converging — and that the crypto
+ key distribution don't introduce loss, deadlock, or a new leak.

## Why it matters
The owner decided C-001 = re-key precisely BECAUSE the live witness proved removed
members keep reading. The re-key is the release critical path, and crypto/key-rotation
is the easiest place to ship a subtle hole (a missed core, an ordering race, a replay).
The test battery must be as adversarial as the threat: assume a motivated removed
member who keeps the topic + the old key. "It encrypts" is not the bar; "the removed
peer provably can't read post-boundary content" is.

## Scope / scenarios (the battery)
1. **Read-cutoff (the headline):** owner removes B → owner writes content under the
   new epoch → assert B gets **ciphertext it cannot decrypt** (old/no key), while a
   remaining member C reads it cleartext + converges. Live, on the real binary.
2. **No-pre-boundary-loss:** content from BEFORE the boundary that B legitimately had
   stays readable to B (don't over-revoke); remaining members keep all of it.
3. **Epoch-ordering race (ties to D-001):** a member must hold epoch-N's key BEFORE
   epoch-N content arrives. Reorder key-distribution vs content (delay the key) →
   assert the member buffers/blocks, never silently drops or reads garbage.
4. **Replay across epochs:** replay an old-epoch op into a new epoch → rejected.
   Replay a wrapped key to a removed member → it can't unwrap (not its device key).
5. **Removed-then-rejoined:** B removed (epoch++), later re-added (epoch++) → B reads
   from its re-add epoch forward, NOT the gap it was excluded from.
6. **Concurrent boundary ops:** two removals / remove+go-private at once → epochs
   advance deterministically, no member ends on a stale key.
7. **Key-distribution under churn/partition:** a remaining member offline during the
   re-key → on return, gets the new epoch key + catches up (no permanent lockout).
8. **(If MLS later) FS/PCS:** a compromised old key doesn't decrypt future epochs;
   a compromised member's removal heals the group. (v1 wrap-to-member: document the
   weaker guarantee explicitly.)
9. **Negative/threat:** flip the existing `revoked-swarm.integration.test.ts` from
   "codifies the gap" to "asserts the cut-off"; extend `federation-threat-model.test.ts`.

## Method
- Integration for the crypto/ordering/replay (deterministic). Live packaged pair for
  the headline read-cutoff witness (the release gate). Coordinate the `HiveEpochCrypto`
  interface with ed300; the boundary/distribution with K. Teeth-verify each.

## Deliverables
- `findings-V.md`: the battery results + the live read-cutoff witness (inverse of the
  current C-001 witness), the documented v1-vs-MLS guarantee, any leak/loss/deadlock.

## Done / verdict
GREEN only when, on the real binary, a removed member provably cannot read
post-boundary content while members converge — and the replay/ordering/rejoin/churn
battery is green. **This is the gate that flips C-001 (and the public-release verdict).**
