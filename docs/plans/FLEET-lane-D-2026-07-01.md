# Lane D — Distributed test gate (Phase 8) (git-plan fleet)

You are **Lane D** of the `git-plan` fleet (model `claude-fable-5` @ xhigh). Leader:
**su-3700b**. Plan: `cross-machine-coord-parity-and-trust-2026-07-01` (harness `papercusp`).

**FIRST:** read `docs/plans/FLEET-git-briefs-2026-07-01.md` — the LEADER-LANDED FOUNDATION
(reuse the `ed25519.ts` signing idiom + the federated-table recipe from §0) and **§0 shared
ground rules**, especially the **6-surface federated-table recipe + the
`stamp_local_federated_write` BEFORE trigger** (the M7 trap — the
`stamp-trigger-coverage.integration.test.ts` guard fails if you forget it). Then `plans:get`
each item. This lane is the distributed test gate that runs the release suite across trusted
peers instead of one machine. Build under `sync/hive-git/gate/` (new dir).

1. **DG-2 shard manifest + inputsHash (P-045)** — do FIRST (pure, others build on it). Derive
   the shard list from the test-config unit/integration split; per-shard `inputsHash` =
   tree-hash of the files a shard depends on (so an unchanged shard's prior green verdict is
   reusable → the gate is INCREMENTAL). Pure `buildShardManifest()` + `shardInputsHash(shard)`.
   Acceptance: manifest deterministic; inputsHash changes iff inputs change.

2. **DG-1 verdict facts (P-044)** — a new FEDERATED table (6-surface recipe + stamp trigger) +
   store for a content-addressed, device-SIGNED verdict `{ stagingSha, shardId, inputsHash,
   verdict:'pass'|'fail', durationMs, deviceSig }`. Verify sig + membership on receive.
   Acceptance: a verdict federates + verifies; `stamp-trigger-coverage` guard green.

3. **DG-4 gate-trust + spot checks (P-047)** — an explicit `gate` trust grant in the
   comms-trust store (separable from `steer`), plus a spot-check policy (the aggregator
   re-runs a random fraction of a peer's shards to catch a lying peer). Pure trust check +
   spot-check selection.

4. **DG-3 shard scheduling (P-046)** — shards as claimable units on the claim-lease machinery
   (dedup floor: don't double-run a shard whose fresh verdict already exists for this
   inputsHash).

5. **DG-5 aggregator (P-048)** — `green(S)` = full trusted-shard coverage at staging sha S with
   all `pass`; emit a green-bot signature = the gate proof (consumed by Lane B's `promoteRelease`
   / G-6 crefs threshold). Acceptance: green only at full pass coverage; one fail or missing
   shard ⇒ not green.

6. **DG-6 hermeticity migration (P-049)** — make environment-coupled suites runnable from
   `(stagingSha, shard)` on any machine (document + adjust the few non-hermetic suites). Lower
   priority; if time-boxed, `log`/report what remains.

Report `coord:send { to:['su-3700b'], plan_slug:'cross-machine-coord-parity-and-trust-2026-07-01' }`
on each item green or on a blocker. The leader reviews every diff.

## STATUS AT LAUNCH (2026-07-02 ~08:50Z, from leader su-3700b)
All 6 lane items open: P-044..P-049 (DG-1..DG-6). P-045 (DG-2) is marked wip by a DEAD recovery bee — rehome it and check for partial work before starting.
Lane B landed staging-advance.ts, release-promotion.ts, handoff-token.ts in sync/hive-git/; DG-5 aggregator (P-048) feeds the release threshold in release-promotion.ts — read it first.
