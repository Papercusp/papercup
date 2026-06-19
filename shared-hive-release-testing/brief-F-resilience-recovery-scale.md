# Brief F — Resilience, recovery & scale

**Priority: S1 lane.** Integration + perf; no live instances strictly needed (but a
scale pass on the packaged app is a bonus).

## Objective
Prove the substrate survives the messy real world: peers come and go, restart,
fall far behind, and hives grow large — without losing data, hanging, or
exhausting resources.

## Why it matters for release
A public hive runs for weeks across flaky networks and restarts. Convergence in a
clean test says nothing about a peer that was offline for a day or a hive with
20k ops.

## Scope / scenarios
1. **Reconnect:** drop a peer's swarm connection and restore it repeatedly
   (`swarm-chaos` does kill-reconnect — extend to assert no missed ops across many
   cycles, and that presence/heartbeat recover).
2. **Restart / cold boot:** kill a peer's process mid-sync and reboot. Assert it
   resumes from its watermark, re-derives the SAME topic (the join-side topic
   persistence — ties to the topic-split fix), and converges. The revocation set
   re-seeds correctly on boot (`revocation` G8: re-admission requires reboot).
3. **Long-offline catch-up / backfill:** a peer offline while the hive advances
   far, then rejoins → full backfill, idle thereafter (`merge-scaling`: idle ticks
   must decode/apply NOTHING after backfill — extend to a large gap).
4. **Outbox drain under failure:** kill the sidecar mid-drain; on restart the
   outbox drains exactly-once (no lost, no double-applied). `wire-outbox-drain-online`,
   `substrate-outbox-trigger` are seeds.
5. **Stale-reclaim / dead-letter:** the stuck-item recovery (migration 307 /
   `requeue_count`) — a dead holder's item requeues up to the cap then dead-letters
   to `blocked` with `requeue_count >= cap`. Prove the bound holds (no poison loop).
6. **Scale:** a hive with many peers (8–16) and large history (10k–50k ops);
   measure merge time (must stay ~idle when nothing changed), memory, and
   convergence time. Many work-items / many conversations.
7. **Schema-version skew:** two peers on adjacent `known_schema_versions` — does
   federation degrade gracefully or corrupt? (Critical for rolling public upgrades.)

## Method
- Integration + the perf rigs (`perf/merge-scaling.test.ts` pattern). Seeded,
  deterministic timing assertions (belt-and-braces, generous under load).
- For exactly-once outbox drain, assert the applied-set, not counts.

## Deliverables
- `findings-F.md`: a resilience matrix + measured scale numbers (merge/idle/memory
  at 10k/50k ops, 8/16 peers) + any loss/hang/leak (S0/S1) + the schema-skew
  verdict (a known limitation to document if not graceful).

## Done / verdict
GREEN only when reconnect/restart/long-offline/outbox-failure all converge with no
loss, the stale-reclaim bound holds, scale numbers are acceptable, and schema-skew
behavior is known and safe (or documented as a release constraint).
