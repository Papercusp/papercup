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
