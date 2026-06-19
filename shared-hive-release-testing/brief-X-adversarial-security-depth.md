# Brief X — Adversarial security depth (untrusted peers)

**Priority: S0/S1 lane.** Threat-model + DoS + DHT. Extends Brief C (don't duplicate).

## Objective
Harden against a **public, untrusted swarm** where an *admitted* member can be
malicious and an *outside* attacker controls DHT nodes. Prove the substrate resists
Byzantine members, DoS, Sybil/eclipse, and metadata-privacy attacks — beyond C's
admission / forged-sig / malformed-op basics.

## Why it matters
A PUBLIC hive admits people you don't fully trust. C proved a non-member can't write
and a forged sig is rejected — but it did NOT model a *legitimately admitted* member
who then turns hostile, nor a DHT-level adversary. For a public release that's the real
threat surface: one bad member shouldn't be able to corrupt, exhaust, deanonymize, or
DoS the whole hive, and an outside attacker shouldn't be able to eclipse/Sybil it.

## Scope / scenarios
1. **Byzantine admitted member:** an admitted peer floods garbage ops / malformed-at-
   scale / oversized payloads / op-key collisions / HLC-skew bombs. Assert: honest
   peers stay converged, the bad ops are rejected/quarantined, no crash/OOM, the bad
   member is bounded (rate-limited / evictable).
2. **DoS / resource exhaustion:** hive-directory spam (announce flood), topic-join
   flood, connection exhaustion, outbox bomb (write amplification). Assert bounded
   resource use + the honest path stays responsive (ties to Brief W limits).
3. **Sybil / eclipse on the DHT:** many attacker DHT nodes try to eclipse a peer's
   view or Sybil the topic. Assert discovery still finds honest peers (or document the
   DHT trust assumptions honestly — hyperdht's model).
4. **Metadata / traffic-analysis privacy:** what does an on-path observer or topic
   peer learn? Hive membership, who-writes-what, timing. Assert the invite-secret +
   topic derivation don't leak membership to non-members; document residual metadata.
5. **Invite-secret strength:** brute-force / guess resistance of the invite secret +
   the derived invite topic; replay of a captured invite link after revocation.
6. **Re-key adversary (coordinate w/ V):** a removed member who keeps the topic + old
   key + runs a hostile node — confirm the re-key holds against active attack, not just
   the happy-path cut-off.

## Method
- Extend `federation-threat-model.test.ts` / `revoked-swarm` with Byzantine + DoS
  cases (integration). DHT Sybil/eclipse via `createTestnet` adversary nodes. Privacy =
  an observer harness inspecting wire/topic. Teeth-verify each; `log()` documented
  trust assumptions (what hyperdht/the design does NOT defend).

## Deliverables
- `findings-X.md`: the adversarial battery + verdicts, any corruption/exhaustion/leak
  (S0), the honestly-documented trust boundary (what a public hive does + does NOT
  protect against), and recommended hardening (rate-limits, eviction, payload caps).

## Done / verdict
GREEN only when a Byzantine admitted member + a DHT adversary cannot corrupt, exhaust,
deanonymize-members-to-non-members, or DoS the hive — with residual trust assumptions
documented honestly, not hidden.
