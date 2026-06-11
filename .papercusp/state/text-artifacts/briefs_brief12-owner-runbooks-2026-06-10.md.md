---
rel_path: "briefs/brief12-owner-runbooks-2026-06-10.md"
updated_at: 1781089225149
_body: "content"
---

# Brief 12 — owner-gated runbooks (su-8f376, 2026-06-10)

Prepared-to-the-gate per 00-COMMON #11. NOTHING below was executed: no Hetzner/Latitude provisioning, no LLM batches, no owner-machine steps. Each runbook = commands, expected cost, teardown, success oracles, and the one-line ask.

## 1. shared-hive-loop P-008 — full autonomous loop on real machines
EXTENDS the proven pattern: `packages/operator-core/lib/deployment/swarm-claim-dispatch.integration.test.ts` ran 3 Hetzner Swarms on 2026-06-09 (18/18 exactly-once, kill-authority fail-open, 35 remote RPC crossings, reconcile zero double-completions).
- Pre-req: brief 11's hermetic 2-swarm composition rig (shared-hive P-001) GREEN first — metal must reproduce hermetic results, not discover basics.
- Steps: (1) extend the swarm-claim-dispatch rig with a SCRIPTED Queen turn (no LLM by default; cheap-model Queen optional under that plan's D-004 cap) + fake-runner DBOS pipelines per swarm; (2) provision per the existing driver with UNIQUE names + own Hetzner project (the 2026-06-09 deploy-hive collision lesson: two agents shared a harness name + project and a teardown swept a peer's frame — announce via coord:send before provisioning); (3) run; collect work_item_claims + completion rows + convergence lag; (4) NARROW teardown (only own-named frames; verify deploy:status after).
- Cost: ~3 Hetzner CX-class × ~1h ≈ €0.10–0.30; +≤$1 if the scripted Queen is replaced by a cheap-model one.
- Oracles: exactly-once dispatch across swarms; steering monotonicity (A's next Queen turn sees B's completions); zero double-completions through kill-authority; convergence lag bounded.
- ASK: "OK to run the shared-hive full-loop on 3 Hetzner instances (~€0.30, ~1h, narrow teardown) once brief-11's hermetic rig is green?"

## 2. shared-hive-loop P-009 — real-metal chaos replay
Replays hermetic P-002 (partition mid-feature), P-003 (kill-authority), P-004 (lease-steal) on the same fleet as P-008: partition via iptables/nftables drop between swarm hosts, instance kill via driver destroy, lease expiry via config-compressed TTL.
- Pre-req: those hermetic scenarios green (brief 11) + P-008's fleet recipe.
- Cost: same fleet, +~1h ≈ €0.10–0.30 incremental.
- Oracles: hermetic results REPRODUCE (one winner per item on heal, no echo loops, no duplicated side effects or detected+adopted winner per the P-004 semantics brief 11 defines).
- ASK: bundled with P-008 ("same fleet, one extra hour").

## 3. coord-system-e2e P-010 — two-box verb sweep (owner-run)
Run P-005's full verb lifecycle + the P-008/P-009 rungs across two PHYSICAL machines per `/internal/docs/agent-insights/vm-federation-separate-machine-proof` (separate machines DO punch + merge — proven 2026-06-08, incl. the shipped .deb; same-host VM holepunch does NOT, any topology — don't waste a run on it). The federated peer main-server-Precision-7865 is already announcing in coord:presence — natural box B.
- Steps: box A = this dev box (staging operator); box B = main-server: install/boot the desktop or operator from staging, join the shared Hive topic, then drive declare-intent → send → await-inbox → wake → handoff accept → escalate → resolve from B against A's authority; run the lock-hook rung (pretooluse-locks-live.integration.test.ts with OPERATOR_BASE_URL=box A) and the wake rung from B.
- Traps (from the insight): identical slirp subnets kill discovery (n/a for real boxes); sidecar port-grep race; clean-machine embedded-PG boot race.
- Cost: $0 (own hardware). Owner-run because it drives the owner's second machine + live env.
- Oracles: all five families (delivery/isolation/mutex/liveness/durability) across the wire; lock fencing holds cross-box.
- ASK: "30–45 min with you driving main-server as box B for the cross-machine verb sweep?"

## 4. holepunch-voice P-014 — voice mesh 2/5/10-peer latency/bandwidth
Ready path per the plan: host a voice-mesh scenario on the `p2p-performance-suite` Tier-3 bench fleet (`packages/operator-core/lib/deployment/p2p-perf-tier3` — provision/destroy already verified on real metal). Each host runs an operator voice-node joined to one channel; measure mouth-to-ear latency + per-peer bandwidth at N=2/5/10 vs the P0 baseline (cross-NAT home↔Ashburn 38.8ms RTT, 0% loss).
- Quota: co-located hosts OK today; CROSS-REGION needs the Latitude quota raise (explicitly deferred to this item's domain by the p2p-perf plan).
- Cost: ~3–10 Latitude metal hosts × ~1h (bench-fleet rates; co-located first rung ≈ low tens of $; cross-region after quota).
- Oracles: latency/jitter/loss per mesh size vs P0 baseline; bandwidth scaling ~N×(N-1) streams; record into the plan as the P-014 numbers.
- ASK: "OK to run the co-located 2/5/10 voice-mesh bench (~1h fleet time) now, and shall I file the Latitude cross-region quota raise for the full run?"

