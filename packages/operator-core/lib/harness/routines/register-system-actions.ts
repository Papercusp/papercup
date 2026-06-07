/**
 * Side-effect imports that populate the system-action registry
 * (`system-actions.ts`). The routines engine imports this module once, so every
 * `system:<action>` handler is registered before the first tick dispatches.
 *
 * Add a new system action by importing its module here (the module body calls
 * `registerSystemAction(...)`).
 *
 * Registered handlers:
 *   - `system:git-sync` — git-sync-auto-commit P-005/P-009/P-010/P-012.
 *   - `system:blueprint-run` — harness-blueprint-orchestration P-021 / D-018.
 *   - `system:green-checkpoint` + `system:release-trigger` —
 *     release-gate-ready-branch-2026-06-04 (Phase 1 + D-010). Seeded INACTIVE.
 *   - `system:improvement-digest` + `system:improvement-implement` —
 *     papercusp-self-improvement-loop-2026-06-04 (Phase 2 + 3). Seeded INACTIVE;
 *     implement is additionally flag-gated (papercusp-improvement-auto-implement, OFF).
 *   - `system:p2p-perf-tier1` (nightly) + `system:p2p-perf-tier2` (weekly) —
 *     p2p-performance-suite-2026-06-07 P-014. Advisory bench runs; findings
 *     auto-file to the improvements backlog. Tier 3 stays on-demand (D-004).
 */
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
import './release-actions';
import './improvement-actions';
import './p2p-perf-actions';
