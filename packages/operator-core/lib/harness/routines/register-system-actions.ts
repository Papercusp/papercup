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
 *
 * NOTE (deterministic-blueprints-migration P-144 / D-026): the 13 migrated learning loops
 * below (negative-space, neologism, fleet-ekg, calibration, deferral-interest, graduation,
 * red-queen, regret, transfer, prompt-ablation, change-ledger, scout, iq-battery) NO LONGER
 * fire a bespoke `system:<loop>` action and are NO LONGER seeded by a `seed-*-routine.ts`
 * script (all retired). Each now fires `system:blueprint-run` from a single workspace-singleton
 * routine `@singleton/bp-singleton-<id>-0` (the blueprint declares `singleton: true`; the
 * always-on ones — change-ledger/scout/iq-battery — declare `singletonActive: true`).
 * Materialize/seed them via `blueprint/seed-learning-singletons.ts`; arm a dark one by setting
 * its `@singleton` row `active=true`. The per-loop "(seed-*-routine.ts)" mentions below are
 * historical.
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
 *     provisioned INACTIVE per-hive at hive:create
 *     (lib/hive/provision-learning-loop.ts), bring-up human-gated.
 *   - `system:session-dir-gc` — the per-session isolation-dir janitor (the EI-155
 *     follow-on). Sweeps `session-claude/`, `session-mcp/`, codex homes of
 *     not-live, not-resumable sessions past a retention window. Seeded INACTIVE
 *     (seed-session-dir-gc-routine.ts).
 *   - `system:claim-discipline-watch` — claim-discipline-enforcement-2026-06-10.
 *     Nudges (inject, never wake) alive agents declared on a plan with no claim
 *     backing it; teaches claim-on-wip / declare-intent items. Outbox-throttled
 *     1/hr per agent. Seeded ACTIVE (seed-claim-discipline-routine.ts) — a nudge
 *     is non-destructive.
 *   - `system:wake-brain` — the autonomous-Queen cadence (hive-agent-tabs-psu-tui
 *     P-005 / D-006). Wakes the EXISTING pinned brain session on cadence so it
 *     takes autonomous turns. Flag-gated by HIVE_AGENT_TABS (OFF → no-op); the
 *     cadence routine seed + live verify are the remaining P-005 wip.
 *   - `system:gym-cycle` — learning-system-audit-improvements-2026-06-09
 *     P-031/P-032. The gym's pulse: per tick, run ONE bounded human-gated gym
 *     cycle for the least-recently-run enabled+idle+budgeted autoloop, with
 *     triage-routed gym ideas fed to the proposer. The per-hive autoloop ROWS it
 *     sweeps are provisioned inline at hive:create (provision-learning-loop.ts,
 *     dark) — the standalone per-hive `seed-gym-routine.ts` env-slug seed was
 *     RETIRED (per-hive-learning-loops-2026-06-14 P-022).
 *   - `system:interactive-usage-ingest` + `system:token-weekly-report` —
 *     token-usage-reduction-audit-2026-06-09 P-001/P-003. Tail local Claude Code
 *     transcripts into `agent_usage_samples` (source='interactive'); broadcast a
 *     week-over-week token/spend report. Both SQL/FS-only (no LLM calls); seeded
 *     INACTIVE (seed-token-telemetry-routines.ts).
 *   - `system:hive-canary` — hive-loop-e2e-testing-2026-06-10 P-009. The daily
 *     live canary: queue one trivial feature into the dedicated canary harness;
 *     a canary still un-terminal past its deadline files a forensics-laden
 *     improvement. Self-gates on the canary harness being registered; seeded
 *     ACTIVE (seed-hive-canary-routine.ts).
 *   - `system:coord-probe-canary` + `system:coord-invariant-monitor` —
 *     coord-system-e2e-testing-2026-06-10 P-012/P-013 (Layer D). The live
 *     probe-pair verb-cycle canary (15 min, SLO'd, self-sweeping) and the
 *     hourly substrate invariant checks (stuck handoffs, unacked escalations,
 *     expired-unswept locks, presence ghosts, wake-queue growth); violations
 *     file deduped improvements. The ONE home for substrate monitors — the
 *     shared-hive-loop P-012/P-013 checks plug in here. Seeded ACTIVE
 *     (seed-coord-invariant-routines.ts).
 *   - `system:cross-hive-outbox-drain` — hive-network-surface-2026-06-11 P-001
 *     (B-01). Per tick: reconcile the boot-wired cross-Hive boundaries against
 *     the directory-publish state (publish/visibility changes converge without
 *     a restart), then run one backoff-aware drain pass over every wired
 *     Hive's durable outbox. Self-gates on zero published Hives; seeded ACTIVE
 *     (seed-cross-hive-drain-routine.ts).
 *   - `system:iq-battery-gen` — self-improvement-consume-edges-2026-06-12
 *     P-033 (B-12). Monthly benchmark cadence: one budget-capped gen-N
 *     IQ-battery run per new code generation (skip at an already-measured
 *     SHA). REFUSES without an owner-set payload budget (gym precedent).
 *     Seeded INACTIVE (lib/iq-battery/seed-benchmark-routine.ts).
 *   - `system:improvement-human-digest` — self-improvement-consume-edges
 *     P-022 (B-08). Weekly owner digest: the top-5 human-lane items ranked by
 *     blocking impact (blocks edges, references, re-captures, watchdog
 *     persistence) via the inbox + attention rails. Read-only; seeded ACTIVE
 *     (seed-human-digest-routine.ts).
 *   - `system:change-ledger-scan` — self-learning-frontier-2026-06-12 P-004
 *     (FB-02). The repo-edit leg of the behavior-change ledger: git-log the
 *     prompt-source roots, one ledger row per (commit, file), idempotent via
 *     the dedupe index. No LLM; flag-gated by CHANGE_LEDGER (ON); seeded
 *     ACTIVE (seed-change-ledger-scan-routine.ts) — pure bookkeeping.
 *   - `system:negative-space-mine` — self-learning-frontier-2026-06-12 P-010
 *     (FB-04). Every-6h demand-map recompute over zero-hit docs/plans/memory
 *     searches (tool_invocations) + capped kind=change candidate filing via
 *     the capture core. SQL-only; flag-gated OFF
 *     (papercusp-negative-space-miner — the frontier D-001 arming gate) AND
 *     seeded INACTIVE (lib/negative-space/seed-negative-space-routine.ts).
 *   - `system:neologism-mine` — self-learning-frontier-2026-06-12 P-011
 *     (FB-05). Every-6h mine of coord traffic + insights for emergent
 *     recurring vocabulary with no corresponding primitive; capped
 *     abstraction-proposal candidates route into Scout's improvement rail
 *     via the capture core. SQL/fs-only; flag-gated OFF
 *     (papercusp-neologism-miner — the frontier D-001 arming gate), governor-
 *     preflighted (loop `neologism-miner`), AND seeded INACTIVE
 *     (lib/neologism/seed-neologism-routine.ts).
 *   - `system:regret-mine` — self-learning-frontier-2026-06-12 P-021
 *     (FB-07). Every-6h bad-session selection (burn percentile, bounces,
 *     rescue markers) + divergence-turn detection over persisted transcripts
 *     (regret_findings, mig 248); the counterfactual replay + report-filing
 *     legs activate when FB-06's lib/replay runner is wired. Flag-gated OFF
 *     (papercusp-regret-mining — the frontier D-001 arming gate), governor-
 *     preflighted (loop `regret-mining`, per-cycle replay budget), AND
 *     seeded INACTIVE (lib/replay/regret/seed-regret-routine.ts).
 *   - `system:transfer-distill` — self-learning-frontier-2026-06-12 P-022
 *     (FB-08, D-006). Nightly lesson distillation from the day's transcripts
 *     (admitted FREE at memory tier 'probationary') + student-transfer tests
 *     (with-lesson vs baseline on the source historical task via lib/replay)
 *     that promote/demote/retire via the pure gate; learning-pack candidate
 *     adoption inherits the bar. LLM spend; flag-gated OFF
 *     (papercusp-transfer-harness — the frontier D-001 arming gate),
 *     governor-preflighted (loop `frontier:transfer-harness`, lifetime
 *     budget), AND seeded INACTIVE (lib/transfer/seed-transfer-routine.ts).
 *     The testing leg self-skips until frontier:replay-landed is wired.
 *   - `system:fleet-ekg-scan` — self-learning-frontier-2026-06-12 P-030
 *     (FB-10). Every-6h behavioral-embedding pass over agent sessions
 *     (agent_activity → fleet_ekg_sessions) + distribution-shift detection
 *     vs the trailing baseline, attributed against the behavior-change
 *     ledger (D-003); unattributable MAJOR shifts alarm the attention rail.
 *     SQL-only; flag-gated OFF (papercusp-fleet-ekg — the frontier D-001
 *     arming gate), governor-preflighted (loop `fleet-ekg`), AND seeded
 *     INACTIVE (lib/fleet-ekg/seed-fleet-ekg-routine.ts).
 *   - `system:prompt-ablation` — self-learning-frontier-2026-06-12 P-023
 *     (FB-09). Weekly prompt sedimentology: SHADOW-ablate ONE SU-playbook
 *     governance rule and replay the llm-testing `su` suite baseline-vs-
 *     ablated (lib/ablation); dead-weight evidence rows land in
 *     harness_shared.prompt_ablation_runs for owner review. NEVER mutates a
 *     live prompt. Real LLM spend — flag-gated OFF (papercusp-prompt-ablation
 *     — the frontier D-001 arming gate), governor-preflighted with the
 *     per-cycle budget as the hard cycle cap (loop `prompt-ablation`), AND
 *     seeded INACTIVE (lib/ablation/seed-prompt-ablation-routine.ts).
 *   - `system:deferral-interest-refit` — self-learning-frontier-2026-06-12
 *     P-042 (FB-14, D-006). Nightly backfill of realized deferral costs from
 *     history (human-lane items → downstream blockage accrued in-window over
 *     coord_links + same-signature re-captures) + re-fit of the learned
 *     pricing model (lib/deferral-interest/, mig 252) the one queue ranker
 *     (P-040/FB-12) reads as its deferral-interest feature. SQL-only;
 *     flag-gated OFF (papercusp-deferral-interest — the frontier D-001
 *     arming gate), governor-preflighted (loop `deferral-interest-refit`),
 *     AND seeded INACTIVE (lib/deferral-interest/seed-deferral-interest-routine.ts).
 *   - `system:calibration-resolve` — self-learning-frontier-2026-06-12 P-041
 *     (FB-13). Every-6h maturity sweep over calibration bets
 *     (calibration_predictions, mig 253): each matured bet resolves against
 *     its domain probe (fix-survival re-capture check, plan-ship status,
 *     flake-recurrence re-capture) and feeds the per-persona Brier scores the
 *     one queue ranker (P-040/FB-12) + calibration:summary read. SQL-only;
 *     flag-gated OFF (papercusp-calibration-markets — the frontier D-001
 *     arming gate, which also gates the capture seams), governor-preflighted
 *     (loop `calibration-markets`), AND seeded INACTIVE
 *     (lib/calibration/seed-calibration-routine.ts).
 *   - `system:red-queen-drill` — self-learning-frontier-2026-06-12 P-031
 *     (FB-20). The vaccination cadence: per tick, ONE drill cycle — plant a
 *     known origin=drill friction in the SANDBOX workspace, detect it with a
 *     real watchdog tick, triage it through the real path (drill-opted-in),
 *     heal it with the class's known remedy; MTTSH + the zero-leak assertion
 *     land on harness_shared.red_queen_drills (mig 255). SQL-only; flag-gated
 *     OFF (papercusp-red-queen — the frontier D-001 arming gate, which also
 *     gates the out-of-band engine-death sentinel), governor-preflighted
 *     (loop `red-queen`), AND seeded INACTIVE
 *     (lib/red-queen/seed-red-queen-routine.ts).
 *   - `system:graduation-scan` — self-learning-frontier-2026-06-12 P-045/P-046
 *     (FB-19, D-008). Daily per-class clean-pass counting over the outcome
 *     rails (resolve evidence, decay verification, dispatch ledger, gym/EKG
 *     regressions); a class crossing the graduation threshold files an OWNER
 *     ratification report through the capture rails — NEVER an automatic
 *     autoKinds edit. SQL-only; flag-gated OFF (papercusp-graduation-tracker
 *     — the frontier D-001 arming gate), governor-preflighted (loop
 *     `graduation-tracker`), AND seeded INACTIVE
 *     (lib/graduation/seed-graduation-routine.ts).
 */
import '../git-sync/git-sync-action';
import '../../blueprint/blueprint-run-action';
// scheduled-recurring-plans-2026-06-16 P-007: `system:plan-run` — one fire of a
// scheduled plan (instance plan → plan_runs row → run-scoped frontier work_items).
import './plan-run-action';
// overwatch-role-2026-06-15 B-04 (C-3): the `system:overwatch-launch` action the
// one-shot `overwatch-wake` routine fires — computes the OverwatchBrief + launches
// role=overwatch. Importing it here also registers the B-07 wake-bridge waker at
// boot (the module body calls registerOverwatchWaker). Self-gated on FLAGS.OVERWATCH
// + B-07's started bit; fully inert until the flag flips (B-12).
import '../../overwatch/loop';
import './release-actions';
import './improvement-actions';
import './p2p-perf-actions';
// (scout's bespoke system:scout-cycle action is RETIRED — P-130; scout runs via the
//  `scout` blueprint. register-scout-action no longer registers anything; the
//  scout:cycle op lazy-imports productionScoutRunner from it directly.)
import './session-dir-gc-action';
// `system:telemetry-retention` — daily prune of the unbounded high-volume
// diagnostic tables (route_invocations/tool_invocations); infra-audit R2 (plan
// infra-perf-robustness-audit-2026-06-18 P-006). Seeded INACTIVE
// (seed-telemetry-retention-routine.ts --active).
import './telemetry-retention-action';
// operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
// reaper — marks dead-process open adv_sessions ended (reclaims roster +
// unblocks session-dir-gc). Flag-gated DEFAULT-OFF + seeded INACTIVE.
import './idle-session-reaper-action';
// bee-context-efficiency-2026-06-14 P-013 (D-007): the bee transcript-cap backstop —
// recycles a bee whose session transcript grew past the cap (idle-only, D-005) so its
// next task spawns fresh. Flag-gated DEFAULT-OFF + seeded INACTIVE (double-gated).
import './bee-transcript-cap-action';
import './claim-discipline-action';
import './wake-brain-action';
import './gym-actions';
import '../../interactive-usage/interactive-usage-action';
import './token-report-action';
import './hive-canary-action';
import './coord-invariant-actions';
import './cross-hive-drain-action';
import './human-queue-digest-action';
// P-130 (deterministic-blueprints-migration-2026-06-13): TWELVE bucket-A learning
// loops migrated to deterministic blueprints — their bespoke `system:<loop>` action
// handlers are RETIRED (negative-space / neologism / regret / transfer / fleet-ekg /
// prompt-ablation / red-queen + change-ledger / deferral-interest / calibration /
// graduation + iq-battery-gen [the hybrid eval engine, D-013]). Their seeds fire
// `system:blueprint-run {blueprintId}`; the lib logic lives on as each op's impl (the
// shared `run<Loop>` orchestration); the no-retired-style guard (P-132) blocks
// re-wiring. Scout's `system:scout-cycle` registration is retired in
// register-scout-action.ts (that module also provides `productionScoutRunner`, the
// scout:cycle op's dependency, so the file stays).
// queen-autonomy-policy-2026-06-13 B-16: the auto-revert tripwire + graduation
// sweep (`system:autonomy-trust-scan`). Self-gates on QUEEN_AUTONOMY_ARMED (P-092);
// the seed routine ships INACTIVE (go-live activates it).
import './autonomy-trust-scan-action';
