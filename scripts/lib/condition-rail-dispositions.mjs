/**
 * Dispositions for the condition-rail inventory (plan `degradation-signals-on-condition-rail-2026-10-11`,
 * P-001, BAR R-4). Keyed `class|file` (a whole cluster) or `class|file|symbol` (one site).
 *
 *   { disposition: 'migrate', item: 'P-NNN' }               — moves onto the rail under that plan item
 *   { disposition: 'not-applicable', reason: '<why, >=20 chars>' }
 *
 * Seeded from a measured run of scripts/condition-rail-inventory.mjs, never from a hand grep
 * (2026-10-11, WI-6554700010008597). Each cluster was read at its site before it was dispositioned.
 *
 * ── THE MIGRATE ITEMS (plan Phase 2) ─────────────────────────────────────────────────────────
 *   P-005  retrieval-degradation-watchdog onto the primitive and rail.
 *   P-007  escalateAlarm (alarm-attention.ts) raises and resolves a keyed condition; its callers resolve on recovery.
 *   P-008  release and gate signals onto the rail.
 *   P-009  routine, loop, liveness and host-health signals onto the rail.
 *   P-010  retrieval, memory and search fallbacks record through observeFallback.
 *   P-011  sync-substrate, transport and authority fallbacks record through observeFallback.
 *   P-012  host boot, MCP transport, cache and DB-connection fallbacks record through observeFallback.
 *   P-013  agent-tool, coordination, work-item and scout fallbacks record through observeFallback.
 *   P-014  DETECTING watchdogs that only openEscalation (bespoke dedupKind, no conditionKey) or set health
 *          flags raise a keyed condition and resolve it on recovery.
 *   P-015  ACTUATING watchdogs (they self-heal: restart, reap, re-arm a wake) record each heal through
 *          observeFallback, so a recurring heal becomes a condition (P-003) instead of silence.
 *
 * ── WHY openEscalation ALONE IS NOT THE RAIL ─────────────────────────────────────────────────
 * The condition rail is the condition-KEYED broadcast (`broadcastSevereEvent({ conditionKey })` and its
 * resolution), which `coord:conditions` folds into open/resolved state and work items carry as
 * `condition_key`. An `openEscalation` with a bespoke dedupKind lands in the owner's escalation queue
 * with no keyed condition and no agent-owned work item, which is the gap this plan closes.
 */

const migrate = (item) => Object.freeze({ disposition: 'migrate', item });
const na = (reason) => Object.freeze({ disposition: 'not-applicable', reason });

const NA_CLI = na(
  'interactive or developer CLI: the fallback is printed to the invoking caller, and there is no long-running mechanism whose rate can collapse unobserved',
);
const NA_LINT = na('lint or gate tooling: the line is the tool’s own diagnostic output about the code it checks, not a runtime fallback');
const NA_FALLBACK_WAKE = na(
  '"fallback wake" names the watchdog’s normal backup-wake arming (outcome armed/kept), not a degraded path',
);
const NA_UI = na('UI component that renders a health value computed server-side; the producer is the site that raises the condition');
const NA_WATCHDOG_TOOLING = na(
  'configuration, status, key-migration or seeding code AROUND a watchdog; it raises no signal of its own, the watchdog it serves is dispositioned separately',
);

export const DISPOSITIONS = Object.freeze({
  // ── owner-only-alarm ──────────────────────────────────────────────────────────────────────
  'owner-only-alarm|apps/operator/bin/host-bootstrap.ts': migrate('P-009'),
  'owner-only-alarm|apps/operator/lib/release/green-checkpoint.ts': migrate('P-008'),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/operator/notify_owner.ts': na(
    'the notify_owner tool relays an agent-authored message to the owner; it reports no system condition',
  ),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/plans/set-status.ts': na(
    'needs-human decision request raised when a plan item needs the owner’s call; not a failure or degradation',
  ),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/routines/set.ts': na(
    'owner-authority audit notice that an agent deliberately paused an always-on routine; the resulting not-running state is the host-bootstrap always-on check (P-009)',
  ),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/work_items/claim-hold-guard.ts': na(
    'owner-authority audit notice of a deliberate forced claim by an agent; an authorization trail, not a system failure',
  ),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/work_items/release-force-guard.ts': na(
    'owner-authority audit notice of a deliberate forced release by an agent; an authorization trail, not a system failure',
  ),
  'owner-only-alarm|packages/operator-core/lib/attention/bulk-run-owner-digest.ts': na(
    'owner digest of a finished bulk run’s results; a report, not a failure signal',
  ),
  'owner-only-alarm|packages/operator-core/lib/dbos/in-process-periodic.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/endpoint-route/routes/internal/escalation-event.ts': na(
    'relays an escalation the harness already recorded on the escalations surface to the owner’s desktop; the raiser owns the condition, not this relay',
  ),
  'owner-only-alarm|packages/operator-core/lib/endpoint-route/routes/internal/smoke-test-event.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/fleet-ekg/scan.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/gates/gate-canary-sweep-action.ts': migrate('P-008'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/human-queue-digest-action.ts': na(
    'reminder and weekly digest of the owner’s own needs-human queue; a report, not a failure signal',
  ),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/loop-dead-man.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/project-history-refresh-action.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/release-actions.ts': migrate('P-008'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/release-pause-ttl.ts': na(
    'notice that a paused loop or routine AUTO-RESUMED after its stand-down TTL lapsed: the system already recovered, nothing remains to own',
  ),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/harness/routines/stalled-loops-guard.ts': migrate('P-009'),
  'owner-only-alarm|packages/operator-core/lib/agent-tools/release/deploy.ts': na(
    'owner-requested force-deploy audit notice after an explicitly accepted action; no continuing failure predicate is detected by this notification',
  ),
  'owner-only-alarm|packages/operator-core/lib/iq-battery/gen-loop.ts': na(
    'needs-human request for the owner to decide an IQ-battery cadence change; a decision request, not a failure',
  ),
  'owner-only-alarm|packages/operator-core/lib/papercup/papercup-proactive-sweep-deps.ts': na(
    'the Papercup assistant’s proactive Sentinel message to its user; a product feature, not a system failure signal',
  ),
  'owner-only-alarm|packages/operator-core/lib/release/idle-repair-queue-actuator.ts': migrate('P-008'),
  'owner-only-alarm|packages/operator-core/lib/release/lost-gate-run-alarm.ts': migrate('P-008'),
  'owner-only-alarm|packages/operator-core/lib/release/staging-fix-proposal-cli.ts': na(
    'a CLI proposing a staging fix for owner review at normal importance; a proposal, not a failure signal',
  ),
  'owner-only-alarm|packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts': migrate('P-014'),

  // ── log-only-fallback ─────────────────────────────────────────────────────────────────────
  'log-only-fallback|apps/operator/app/_components/voice/voice-mode.ts': na(
    'client-side webview fallback chain between wake-word engines and a retired-config notice; runs in the user’s UI process, not a server mechanism',
  ),
  'log-only-fallback|apps/operator/bin/hono-host.ts': migrate('P-012'),
  'log-only-fallback|apps/operator/bin/host-bootstrap.ts': migrate('P-012'),
  'log-only-fallback|apps/operator/bin/llm-test.ts': NA_CLI,
  'log-only-fallback|libs/papercusp/packages/cli/src/snapshot-cli.ts': NA_CLI,
  'log-only-fallback|apps/operator/lib/release/green-checkpoint.ts': migrate('P-008'),
  'log-only-fallback|apps/operator/scripts/hooks/omp/coord-hook.ts': migrate('P-013'),
  'log-only-fallback|apps/operator/scripts/onboard-launcher.mjs': NA_CLI,
  'log-only-fallback|apps/operator/scripts/psu-launcher.mjs': NA_CLI,
  'log-only-fallback|apps/operator/scripts/ptool.mjs': NA_CLI,
  'log-only-fallback|apps/operator/scripts/rotate-spawn-signing-key.mjs': NA_CLI,
  'log-only-fallback|libs/generic/memory/src/embed-device.ts': migrate('P-010'),
  'log-only-fallback|libs/generic/memory/src/local-embedder-worker.ts': migrate('P-010'),
  'log-only-fallback|libs/generic/rerank/src/local-engine.ts': migrate('P-010'),
  'log-only-fallback|libs/generic/rerank/src/local-reranker-worker.ts': migrate('P-010'),
  'log-only-fallback|libs/generic/search/src/backfill/backfill-table.ts': migrate('P-010'),
  'log-only-fallback|libs/generic/sync/src/fallback/useTransportFallback.ts': migrate('P-011'),
  'log-only-fallback|libs/generic/tooldef/src/dispatch-stack.ts': migrate('P-013'),
  'log-only-fallback|libs/papercusp/libs/db/scripts/pull-schema.mjs': NA_CLI,
  'log-only-fallback|libs/papercusp/libs/db/src/connection.ts': migrate('P-012'),
  'log-only-fallback|packages/agent-mcp/src/entity-resolvers-papercusp.ts': migrate('P-013'),
  'log-only-fallback|packages/docs-engine/src/render-mdx.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/coordination/messages.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/fleet/place_batch.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/index.ts': NA_FALLBACK_WAKE,
  'log-only-fallback|packages/operator-core/lib/agent-tools/loop/arm.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/loop/checkpoint.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/operator/converse-prompt.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/plans/remote-seat-inventory.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/agent-tools/search/embedder.ts': migrate('P-010'),
  'log-only-fallback|packages/operator-core/lib/attention/reconcile-escalations.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/authority/transport-wiring.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/blueprint/blueprint-run-action.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/blueprint/launch-blueprint.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/bounded-timeout.ts': migrate('P-012'),
  'log-only-fallback|packages/operator-core/lib/cache/l2-tier.ts': migrate('P-012'),
  'log-only-fallback|packages/operator-core/lib/db-tools/sanitize-baseline.ts': na(
    'developer tool that sanitizes the frozen schema baseline; the unknown-shape note is its own report to the operator running it',
  ),
  // The P-002 primitive's own throttled write-failure warning. A failed fallback-observation write
  // cannot be recorded through the same failing writer; its losses are counted instead by
  // fallbackObservationCounters().failed (BAR R-14). Not part of the 307-row seed (review note 1,
  // thread-post:1174718).
  'log-only-fallback|packages/operator-core/lib/degradation/fallback-observations.ts': na(
    'the fallback-observation writer’s own write-failure warning: recording it through the same failing writer would recurse, and its losses are counted by the writer’s lifetime failure counter (R-14)',
  ),
  'log-only-fallback|packages/operator-core/lib/dbos/bootstrap.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/dbos/dbos-executor-reaper.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/dbos/in-process-periodic.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/dbos/routines-workflow.ts|fail-open': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/dbos/routines-workflow.ts|fallback': NA_FALLBACK_WAKE,
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-el-spend.ts|fallback': na(
    'no EL API key configured: a configuration choice that selects the PG spend source, not a runtime failure',
  ),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-el-spend.ts|falling-back': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts|falling-back': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts|fallback': NA_FALLBACK_WAKE,
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/misc/updates-manifest.ts': migrate('P-008'),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/misc/updates-rollback.ts': migrate('P-008'),
  'log-only-fallback|packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts': migrate('P-012'),
  'log-only-fallback|packages/operator-core/lib/fleet/git-via-sidecar.ts': migrate('P-012'),
  'log-only-fallback|packages/operator-core/lib/grading-integrity.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/harness/improvements/watchdog.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/improvement-actions.ts': na(
    'configuration parse default: a non-integer tunable falls back to its documented default once at parse time',
  ),
  'log-only-fallback|packages/operator-core/lib/harness/routines/project-history-refresh-action.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/release-pause-ttl.ts': migrate('P-008'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/seed-work-item-admission-fail-open-routine.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/issues-engineer.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/learning/pot-gate/gates.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/learning/pot-gate/store.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts': NA_CLI,
  'log-only-fallback|packages/operator-core/lib/memory/embed-sidecar-spawn.ts': migrate('P-010'),
  'log-only-fallback|packages/operator-core/lib/memory/jev-transport.ts': migrate('P-010'),
  'log-only-fallback|packages/operator-core/lib/operator-sentinel-handoff-deps.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/overwatch/watchdog.ts': migrate('P-015'),
  'log-only-fallback|packages/operator-core/lib/papercup/papercup-deep-delegate-deps.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/plan-items/claim-authority-swarm.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/pot-membership.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/pot/watchdog.ts': migrate('P-015'),
  'log-only-fallback|packages/operator-core/lib/release/green-stall-watchdog.ts': migrate('P-008'),
  'log-only-fallback|packages/operator-core/lib/routines-dispatch-derivation.ts': migrate('P-009'),
  'log-only-fallback|packages/operator-core/lib/scout/cycle-deps.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/scout/dedup-burn-guard.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/scout/paused-rails.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/scout/routed-ledger.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/search/coverage-gate.ts': migrate('P-010'),
  'log-only-fallback|packages/operator-core/lib/search/lexical/rank.ts': migrate('P-010'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot-all.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/boot.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-active-set-facts.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/swarm.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/sync/hyperbee/sync-relay.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts': migrate('P-014'),
  'log-only-fallback|packages/operator-core/lib/system-health/single-primary-check.ts': migrate('P-012'),
  'log-only-fallback|packages/operator-core/lib/work-item-claim-authority-swarm.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/work-item-lock-release.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/work-item-replica-authority-swarm.ts': migrate('P-011'),
  'log-only-fallback|packages/operator-core/lib/work-items-stale-claims.ts': migrate('P-013'),
  'log-only-fallback|packages/operator-core/lib/work-items.ts': migrate('P-013'),
  'log-only-fallback|scripts/check-optional-seam-strands.mjs': NA_LINT,
  'log-only-fallback|scripts/check-partial-index-alignment.mjs': NA_LINT,
  'log-only-fallback|scripts/check-sidecar-fallback-reported.mjs': NA_LINT,
  'log-only-fallback|scripts/lib/tsc-baseline-gate.mjs': NA_LINT,
  'log-only-fallback|scripts/lint-as-committed.mjs': NA_LINT,
  'log-only-fallback|scripts/mcp-call.mjs': NA_CLI,
  'log-only-fallback|scripts/npm-install-safe.mjs': NA_CLI,
  'log-only-fallback|scripts/report-cargo-tests.mjs': NA_CLI,

  // ── health-flag-no-condition ──────────────────────────────────────────────────────────────
  'health-flag-no-condition|apps/operator-vite/src/components/adv/LearningInfraHealthChip.tsx': NA_UI,
  'health-flag-no-condition|apps/operator/app/harness/insights/SubstrateHealthPill.tsx': NA_UI,
  'health-flag-no-condition|libs/generic/search/src/leg-health.ts': migrate('P-010'),
  'health-flag-no-condition|packages/operator-core/lib/agent-tools/work_items/semantic-dedup-probe-alarm.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/consult/consult-routing-health.ts': migrate('P-013'),
  'health-flag-no-condition|packages/operator-core/lib/resource-governor/health-analysis.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/search/session-ingest-lag-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/goal-grading-backlog-sweep.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/goal-liveness-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/goal-owner-report-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/kernel-leak-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/perf-budgets.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/service-restart-rate-watchdog.ts': migrate('P-014'),
  'health-flag-no-condition|packages/operator-core/lib/system-health/unservable-critical-watchdog.ts': migrate('P-014'),

  // ── bespoke-watchdog ──────────────────────────────────────────────────────────────────────
  'health-flag-no-condition|packages/operator-core/lib/release/green-stall-watchdog.ts|alarm': na(
    'pure evaluateStrandedRepairQueue return values, not an emitting detector; checkStrandedRepairQueue consumes this verdict and already opens and resolves the keyed condition',
  ),
  'bespoke-watchdog|apps/operator/scripts/bghost-watchdog.mjs': migrate('P-015'),
  'bespoke-watchdog|apps/operator/lib/mcp-proxy/watchdog.mjs': migrate('P-015'),
  'bespoke-watchdog|apps/operator/scripts/recompute-watchdog-keys.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/agent-tools/improvements/set-watchdog-tunables.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/agent-tools/improvements/watchdog-status.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/attention/bulk-run-watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/dbos/dbos-hang-watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/fleet/spawner-sidecar-orphan-watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/harness/improvements/watchdog-key-migration.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/harness/improvements/watchdog-tunables.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/harness/improvements/watchdog.ts': na(
    'the improvements watchdog is itself a filing engine: it files deduplicated, owned EI work items through issues-engineer, so its findings already reach an owner',
  ),
  'bespoke-watchdog|packages/operator-core/lib/harness/routines/bulk-run-watchdog-action.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/harness/routines/seed-bulk-run-watchdog-routine.ts': NA_WATCHDOG_TOOLING,
  'bespoke-watchdog|packages/operator-core/lib/harness/routines/sync-read-budget-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/inference-gateway/watchdog.mjs': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/memory-watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/overwatch/watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/pot/placement-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/pot/watchdog.ts': migrate('P-015'),
  'bespoke-watchdog|packages/operator-core/lib/release/watchdog-health.ts': migrate('P-008'),
  'bespoke-watchdog|packages/operator-core/lib/release/worktree-coverage-watchdog.ts': migrate('P-008'),
  'bespoke-watchdog|packages/operator-core/lib/rubric-staleness-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/scout/draft-review-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/scout/ungraded-filings-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/scout/watchdog-health-lane.ts': na(
    'digest lane that summarizes the system watchdog’s persisted ticks for the scout digest; a reader of watchdog output, not a watchdog',
  ),
  'bespoke-watchdog|packages/operator-core/lib/search/session-ingest-lag-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/agent-productivity-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/carry-drill-drop-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/cluster-lag-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/codex-rollout-persistence-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/embed-latency-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/goal-liveness-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/goal-owner-report-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/installed-hook-drift-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/kernel-leak-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/service-restart-rate-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/unservable-critical-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/system-health/wedged-identity-activation-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|packages/operator-core/lib/wall-lapse-watchdog.ts': migrate('P-014'),
  'bespoke-watchdog|scripts/lib/batch-watchdog.mjs': na(
    'per-batch test timeout inside the gate runner: a hung batch is killed and reported as that task’s failure in the gate verdict, which already has an owner',
  ),
});
