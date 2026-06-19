# Brief AF — Discovery / directory mechanics in depth

**Priority: S1 lane.** Integration + live. The directory is its own lightly-tested layer.

## Objective
Prove the hive **discovery/directory** layer is correct + consistent: announce, beacon,
TTL, withdraw, re-announce, and directory state across peers — under restart, churn, and
scale.

## Why it matters
The directory is how hives are FOUND (announce/discover) and is a distinct subsystem from
content federation, tested only at the happy-path level. Real gaps already surfaced: the
**deceptive-publish / reachablePeers** honesty bug (G-001) lived here; dc9db found an
**invite-hive beacon-capture type error** (`[hive-directory] beacon capture failed …
Received an Object`) this session; and the EI-681 memo notes the directory boot wiring.
A stale, inconsistent, or crash-not-recovered directory means hives that can't be found,
withdrawn hives that still appear (a privacy/UX issue), or the wrong reach reported.

## Scope / scenarios
1. **Announce → discover → join consistency:** a published hive appears in every peer's
   directory with correct metadata (member links, topic, visibility); a private hive
   never appears on the global topic.
2. **Withdraw / tombstone:** an unpublished/dissolved hive DROPS from every peer's
   directory within the poll/TTL (the G-003 withdraw-drops + the tombstone propagation) —
   no stale "ghost" hive lingering after withdraw.
3. **Re-announce after restart:** on owner restart, the directory re-announces the
   owned hives (ties to A-003/EI-681 — does the directory re-boot like the substrate
   must?); assert peers re-discover, no permanent disappearance.
4. **Beacon-capture bug (dc9db's finding):** the invite-hive status-beacon capture type
   error — repro + fix (`"string" argument must be of type string... Received an Object`),
   assert beacons capture cleanly for public AND invite hives.
5. **TTL / freshness / replay:** announce freshness (the ei117 replay-protection class) —
   a stale/replayed announce is rejected; TTL expiry removes dead entries.
6. **Directory at scale:** many hives in the directory (10s–100s) → discovery stays
   correct + fast, no per-hive leak (ties to W).

## Method
- Integration via the hive-directory + beacon modules; live legs on the `.deb` pair for
  announce/withdraw/re-announce timing. Verify via `/api/discovery/hives` + the directory
  internal state + each peer's view. Teeth-verify (neuter the withdraw-tombstone → assert
  the ghost-hive test goes RED).

## Deliverables
- `findings-AF.md`: the directory matrix (announce/withdraw/re-announce/TTL/scale), the
  beacon-capture bug repro+fix, any stale-ghost/leak/replay hole (S1).

## Done / verdict
GREEN only when hives announce, discover, withdraw (no ghosts), and re-announce-on-restart
consistently across peers, the beacon-capture bug is fixed, and the directory scales.
