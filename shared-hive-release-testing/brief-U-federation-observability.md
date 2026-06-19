# Brief U — Federation silent-failure observability

**Priority: S1 lane.** Integration + a live audit. Born from this session's EI-681.

## Objective
Prove the system **detects and SURFACES** federation failures instead of failing
silently. When an outbox stops draining, a harness never joins its topic, or peers
diverge — there must be a signal (health/metric/log/UI), not a silent black hole.

## Why it matters
**EI-681 (A-003 send-side) sat completely silent for this entire session**: the
owner's hive-home `substrate_outbox` rows had `drained_at=NULL` forever, the
hive-home harness was never on the topic, and NOTHING reported it — it took live
PG-drilling to find. That's the deceptive-publish/silent-failure class, and it's an
S1 for a public product: users won't know their hive isn't actually syncing. Also
recall the original "deceptive-publish" honesty bug (reachablePeers) — same family.
If federation can break invisibly, every other green result is fragile.

## Scope / scenarios
1. **Stuck-outbox detection:** with an outbox accumulating `drained_at=NULL` rows past
   a threshold/time, assert a health endpoint / metric / log FIRES (today: silent).
2. **Not-on-topic detection:** a harness that should federate but never joined its
   swarm topic → assert it's detectable (the EI-681 signature).
3. **Divergence detection:** two peers materialize different rows for a key (the D-001
   class) → assert a convergence/health check can catch it (even post-fix, as a guard).
4. **Honest peer/sync status (extends G-004):** the `/api/discovery/federation-status`
   + UI must reflect REAL drain/sync state, not just peer count — "synced" must mean
   synced. Assert it would show RED for a stuck outbox.
5. **Self-check / reconcile:** is there (should there be) a periodic federation
   self-check that flags stalls? (There is NO periodic reconcile today — EI-681 memo.)
   Propose + test a minimal one, or document the gap as an EI.

## Method
- Integration tests that induce a stall (no-op the drain / skip the topic-join) and
  assert a signal is emitted. Live audit of the current health/metrics surfaces for
  what federation signals exist vs. should exist. Extend `federation-status.test.ts`.

## Deliverables
- `findings-U.md`: an inventory of current federation health signals, the gaps (what
  fails silently today), new detection tests, and either a minimal self-check/alert
  implementation or filed EIs for the missing observability.

## Done / verdict
GREEN only when a stuck outbox / not-on-topic harness / divergence is DETECTABLE via a
real signal (test-proven), and the desktop sync status reflects true drain state.
