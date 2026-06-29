/**
 * Blueprint **deterministic step-ops** — the registration entrypoint for the
 * DETERMINISTIC step kind (deterministic-blueprints-migration-2026-06-13 P-010).
 *
 * A deterministic step-op is a registered typed function (declared args/result
 * I/O) that WRAPS shipped lib logic and runs as a program-mode spine step — the
 * same `CoordOp` primitive the coordination ops use (one registry, validated by
 * `knownOps`, run as a checkpointed DBOS step), so this is a new op FAMILY, not a
 * new engine (D-002 / D-003 / D-007). The op-name namespace (`<domain>:<verb>`,
 * e.g. `negative-space:scan`) marks the family; importing this module once
 * registers them all (the `defineTool` self-registration pattern).
 *
 * Migrated learning loops register their deterministic (and, for hybrid loops,
 * their `orchestrator:spawn-roles`-driven agent) steps here; the program-mode
 * blueprint at `blueprints/<id>/blueprint.yaml` declares the step + cadence.
 */

// Register each deterministic step-op — side-effect imports.
import './ops/negative-space-scan.js';
import './ops/regret-mine.js';
import './ops/red-queen-drill.js';
import './ops/neologism-mine.js';
import './ops/fleet-ekg-scan.js';
// The replay family (P-121): scout / transfer / ablation — behavior-neutral
// deterministic pipelines wrapping each loop's existing gated tick (D-009: their
// agent legs are governed llmCalls, not fleet spawns — so a single det step, not a
// spawn-roles hybrid).
import './ops/scout-cycle.js';
import './ops/transfer-distill.js';
import './ops/prompt-ablation.js';
// Bucket A (deterministic-blueprints-migration-2026-06-13 D-012 / P-101): four more
// pure-deterministic loops — change-ledger repo scan (flag-only, NO governor: pure
// bookkeeping), deferral-interest refit, calibration resolution sweep, graduation
// tracker (files an OWNER REPORT, never auto-widens). Each wraps its existing gated
// tick (behavior-neutral, D-004).
import './ops/change-ledger-scan.js';
import './ops/deferral-interest-refit.js';
import './ops/calibration-resolve.js';
import './ops/graduation-scan.js';
// The one true HYBRID (D-013): det cadence → governed fleet-bee spawns
// (spawnAgentInHarness → spawnInvokeOnce, internal to the op, not a spawn-roles step)
// → det persist. NOT a flag/governor loop — gated on the owner-set budgetUsd.
import './ops/iq-battery-gen.js';
// hive-run-evaluation-2026-06-13 (HE-07, P-050): the SIBLING benchmark — det cadence →
// whole-Hive runs over the seeded scenario corpus (internal to the op) → HE-06 score +
// persist to its OWN tables. Also gated on the owner-set budgetUsd; live runner P-051.
import './ops/hive-eval-gen.js';
// relight-self-learning-edges-2026-06-14 (P-033): the memory-precision monitoring bench —
// det cadence → floored hybrid gold-set replay (isolated bench schema, embeddings, no LLM) →
// record FP@5/R@10/precision. Flag-only (no governor, like change-ledger); always-on monitoring.
import './ops/memory-precision-bench.js';
// worker-chunk-loop-operator-hosted-2026-06-14 (P-002/P-003, = deterministic-blueprints
// P-142): the coding WORKER's chunk loop as an operator-hosted deterministic step — a
// near-PORT of runWorkerChunkLoop() (the heavy ctx-construction runner is dynamic-imported
// by the op, so registering it here stays light). DARK behind the DEFAULT-OFF
// papercusp-worker-chunk-loop-blueprint flag (the coding HOT PATH staged-rollout gate, D-003).
import './ops/worker-chunk-loop.js';
// oddsmith:prospect is no longer compiled in here. As of harness-provided-cadence-ops-
// 2026-06-26 (P-007 / D-001) it is a HARNESS-PROVIDED dispatched op: the oddsmith-prospector
// blueprint declares it in its `ops:` manifest, the operator registers a PROXY CoordOp on
// admission (harness-ops/proxy.ts), and the proxy DISPATCHES to the oddsmith sidecar's
// /api/op/oddsmith:prospect handler — which owns the live Kalshi/Polymarket connectors + the
// work_items enqueue (over HTTP). This removed the platform leak: operator-core no longer
// imports any @oddsmith engine code. See harness-ops/transport.ts for the dispatch transport.
// NOTE: the impartial benchmark suite (impartial-benchmark-suite-2026-06-15, P-019) is NOT
// a deterministic step-op. `external-bench` is a decider-edges `coding`-spine blueprint
// (the full-spine generation arm) SPUN as a throwaway harness by the `instantiateBenchHarness`
// port (packages/operator-core/lib/external-bench/run-loop.ts), not run as a program step.
