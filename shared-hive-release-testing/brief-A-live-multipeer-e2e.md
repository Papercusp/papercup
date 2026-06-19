# Brief A — Live multi-peer end-to-end federation (the real proof)

**Priority: S0 lane.** Owner of the live-instance harness. Coordinate via the
`shared-hive-live-instances` lock.

## Objective
Prove the FULL cycle on **real packaged instances** (the `.deb`, not a test rig):
`create → publish → discover → join → admit → write → federate → read` works for
**every content type**, in **both directions**, across **2 then 3 peers**. The
prior pass only proved this by *composition* of unit/integration tests; a public
release needs the real packaged binary doing it over a real DHT.

## Why it matters for release
The 2-peer integration rigs bypass `defaultResolveSwarmBinding` (they wire
matching topics directly). The packaged app is the only thing that exercises the
real joiner-resolves-its-own-topic path — the exact path the topic-split bug
lived in. If this lane is GREEN, the headline feature genuinely works.

## Scope / scenarios
For harnesses A (owner) and B, C (joiners):
1. **Owner create + publish** a hive (public, then a separate invite hive). Confirm
   the member/invite link carries the hive topic.
2. **Join** from B via the **current** share/join flow (NOT the retired
   `two-instance-interactive.sh` share step). Confirm B's `shared.json` gets the
   owner's topic and B lands on the **same swarm topic** (`derive-swarm-topic`
   hex equal — check both peers' logs / `[swarm]` events).
3. **Incremental sync, A→B and B→A**, for EACH: features/work-items,
   conversations, messages, threads, plans, plan-parts, plan-item assignments,
   presence, hive-members, hive-settings. Assert the row appears on the peer with
   `origin=remote` within a bounded poll.
4. **3rd peer C** joins late → gets full backfill of pre-existing content (not
   just new writes).
5. **Negative:** a peer that did NOT join must NOT receive the hive's content
   (no topic, no rows) — confirms isolation.

## Method
- Launch a fresh fixed-`.deb` pair/trio (the running instances are PRE-FIX —
  destroy them: `/home/marsh-office/.papercusp-interactive-fed/stop.sh`). Use a
  fresh PG data dir so no stale `origin=local` rows confuse results.
- Drive writes via each instance's sidecar API (ports in `instances.env`) or the
  desktop shell per `/internal/docs/testing/agent-e2e`. Verify via each
  instance's embedded PG (`origin` column) — `postgres@127.0.0.1:<pg>/papercusp`.
- Capture a per-content-type matrix: `{type × direction × {merge-on-join,
  incremental, backfill}}` → pass/fail + latency.

## Deliverables
- `findings-A.md` with the matrix and any non-crossing content (each = S0/S1).
- If a content type federates in tests but NOT live → that's the highest-value
  bug in the whole program; repro + root-cause (topic? capture trigger? projection
  not wired in the packaged graph? — recall the `createRequire` bundling gotcha).
- A reusable, documented live-test runbook (so this is repeatable, not one-off).

## Done / verdict
GREEN only when every content type crosses both directions on the packaged app,
backfill works for a late joiner, and a non-member sees nothing.
