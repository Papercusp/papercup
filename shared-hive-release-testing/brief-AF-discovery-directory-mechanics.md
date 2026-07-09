# Brief AF — Discovery / directory mechanics in depth

**Priority: S1 lane.** Integration + live. The directory is its own lightly-tested layer.

## Objective
Prove the pot **discovery/directory** layer is correct + consistent: announce, beacon,
TTL, withdraw, re-announce, and directory state across peers — under restart, churn, and
scale.

## Why it matters
The directory is how pots are FOUND (announce/discover) and is a distinct subsystem from
content federation, tested only at the happy-path level. Real gaps already surfaced: the
**deceptive-publish / reachablePeers** honesty bug (G-001) lived here; dc9db found an
**invite-pot beacon-capture type error** (`[pot-directory] beacon capture failed …
Received an Object`) this session; and the EI-681 memo notes the directory boot wiring.
A stale, inconsistent, or crash-not-recovered directory means pots that can't be found,
withdrawn pots that still appear (a privacy/UX issue), or the wrong reach reported.

## Scope / scenarios
1. **Announce → discover → join consistency:** a published pot appears in every peer's
   directory with correct metadata (member links, topic, visibility); a private pot
   never appears on the global topic.
2. **Withdraw / tombstone:** an unpublished/dissolved pot DROPS from every peer's
   directory within the poll/TTL (the G-003 withdraw-drops + the tombstone propagation) —
   no stale "ghost" pot lingering after withdraw.
3. **Re-announce after restart:** on owner restart, the directory re-announces the
   owned pots (ties to A-003/EI-681 — does the directory re-boot like the substrate
   must?); assert peers re-discover, no permanent disappearance.
4. **Beacon-capture bug (dc9db's finding):** the invite-pot status-beacon capture type
   error — repro + fix (`"string" argument must be of type string... Received an Object`),
   assert beacons capture cleanly for public AND invite pots.
5. **TTL / freshness / replay:** announce freshness (the ei117 replay-protection class) —
   a stale/replayed announce is rejected; TTL expiry removes dead entries.
6. **Directory at scale:** many pots in the directory (10s–100s) → discovery stays
   correct + fast, no per-pot leak (ties to W).

## Method
- Integration via the pot-directory + beacon modules; live legs on the `.deb` pair for
  announce/withdraw/re-announce timing. Verify via `/api/discovery/pots` + the directory
  internal state + each peer's view. Teeth-verify (neuter the withdraw-tombstone → assert
  the ghost-pot test goes RED).

## Deliverables
- `findings-AF.md`: the directory matrix (announce/withdraw/re-announce/TTL/scale), the
  beacon-capture bug repro+fix, any stale-ghost/leak/replay hole (S1).

## Done / verdict
GREEN only when pots announce, discover, withdraw (no ghosts), and re-announce-on-restart
consistently across peers, the beacon-capture bug is fixed, and the directory scales.
