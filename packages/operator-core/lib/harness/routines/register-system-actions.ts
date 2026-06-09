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
 *   - `system:improvement-watchdog` + `system:improvement-implement` —
 *     papercusp-self-improvement-loop-2026-06-04 (the HARD feed-in + Phase 3).
 *     Seeded INACTIVE; implement is additionally flag-gated
 *     (papercusp-improvement-auto-implement, OFF). (The `system:improvement-digest`
 *     routine was removed — operator-learning-tab-2026-06-09 D-001 — the backlog is
 *     now PULLED in the Learning tab, not pushed to the human inbox.)
 *   - `system:p2p-perf-tier1` (nightly) + `system:p2p-perf-tier2` (weekly) —
 *     p2p-performance-suite-2026-06-07 P-014. Advisory bench runs; findings
 *     auto-file to the improvements backlog. Tier 3 stays on-demand (D-004).
 *   - `system:scout-cycle` — hive-creative-ideation-2026-06-08 P-008 (the Scout
 *     autonomous-ideation cadence; D-010). Self-gates on idle/friction + budget;
 *     seeded INACTIVE (seed-scout-routine.ts), bring-up human-gated.
 *   - `system:session-dir-gc` — the per-session isolation-dir janitor (the EI-155
 *     follow-on). Sweeps `session-claude/`, `session-mcp/`, codex homes of
 *     not-live, not-resumable sessions past a retention window. Seeded INACTIVE
 *     (seed-session-dir-gc-routine.ts).
 *   - `system:wake-brain` — the autonomous-Queen cadence (hive-agent-tabs-psu-tui
 *     P-005 / D-006). Wakes the EXISTING pinned brain session on cadence so it
 *     takes autonomous turns. Flag-gated by HIVE_AGENT_TABS (OFF → no-op); the
 *     cadence routine seed + live verify are the remaining P-005 wip.
 *   - `system:gym-cycle` — learning-system-audit-improvements-2026-06-09
 *     P-031/P-032. The gym's pulse: per tick, run ONE bounded human-gated gym
 *     cycle for the least-recently-run enabled+idle+budgeted autoloop, with
 *     triage-routed gym ideas fed to the proposer. Seeded INACTIVE
 *     (lib/gym/seed-gym-routine.ts).
 */
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
import './release-actions';
import './improvement-actions';
import './p2p-perf-actions';
import '../../scout/register-scout-action';
import './session-dir-gc-action';
import './wake-brain-action';
import './gym-actions';
