/**
 * DBOS Transact bootstrap — Phase 0 of `dbos-durable-jobs-2026-05-31`.
 *
 * Boots DBOS durable execution against the operator's embedded Postgres.
 * The call site (instrumentation-node.ts) gates this behind
 * `PAPERCUSP_DBOS_ENABLE=1` (default OFF) — same shape as the other
 * opt-in boot worker (`PAPERCUSP_IPC_ENABLE`). The PostHog `flags:*` A/B gate (plan D-011)
 * comes in Phase 1 with the AutoLoop runtime migration; the boot launch
 * itself stays env-gated so we never block startup on an async flag read.
 *
 * Verified end-to-end in the Phase-0 gate (P-002) against an
 * embedded-postgres-server PG 16 instance:
 *  - DBOS creates its `dbos` schema and runs/resumes workflows.
 *  - An unpinned application-version change leaves prior workflows PENDING
 *    (the D-008 hazard) — hence the pinned `applicationVersion` below.
 *  - A completed step is not re-executed on resume.
 *
 * Design (see the plan):
 *  - D-002: resolve the DSN via `getHarnessAdminUrlWithSource()`; never
 *    hardcode a port. Refuse the native-fallback so we don't point DBOS at
 *    the dead `:5432/papercusp_legacy` when the desktop isn't running.
 *  - DBOS system tables live in a dedicated `dbos` schema.
 *  - D-008 / D-012: pin the application version so timer workflows recover
 *    across app updates. Override per-deploy with `DBOS__APPVERSION`.
 *  - Functional API (`registerWorkflow` / `runStep`), not decorators — the
 *    operator transpiles under tsx/esbuild (:3070) and Next/SWC (:3055),
 *    which handle decorators inconsistently.
 */
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import {
  dbosOrchestratorActive,
  dbosTimersActive,
  dbosProvisionActive,
  dbosBackupActive,
  dbosRoutinesActive,
  dbosCurationActive,
  dbosReactionsActive,
  dbosPlanRenderActive,
  dbosPeriodicTimersActive,
} from './dbos-flags';

const PINNED_APP_VERSION = process.env.DBOS__APPVERSION || 'papercusp-jobs-v1';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };

/**
 * WI-2790: DBOS's own system-database pool (a raw `pg.Pool` inside
 * @dbos-inc/dbos-sdk, wholly separate from this app's postgres-js pools in
 * libs/papercusp/libs/db/src/connection.ts) sets no idle-in-transaction GUC of its
 * own, so it silently inherits the CLUSTER-level default — 60s, per EI-49's
 * deliberate fleet-wide leak/wedge safety net (an app MCP write whose transport
 * drops mid-call must not hold a transaction-scoped advisory lock open forever).
 * That 60s budget assumed "a healthy transaction is never idle this long" — true
 * at the concurrency EI-49 was tuned for, but this host now regularly runs at
 * very high load (measured load average ~40-60 under the full agent fleet), where
 * the Node event loop can legitimately stall a DBOS queue-poller / delayed-workflow
 * transition past 60s with zero actual leak. Postgres then kills the
 * still-healthy connection ("Unexpected error in idle client: ... idle-in-transaction
 * timeout"), and DBOS's own retry logic reconnects and continues — functionally
 * harmless, but ~114 log lines/2h of noise (the WI-2790 report).
 *
 * Fix: widen the timeout ONLY on DBOS's own system-db session, via a startup
 * `options` GUC appended to its connection string (node-postgres forwards `options`
 * verbatim as a startup packet, same mechanism connection.ts uses for the app's own
 * pools — just via the URL instead of a client-options object). The CLUSTER-wide
 * default (60s) — and therefore the EI-49 safety net for every OTHER connection,
 * including this app's own pools — is untouched; only DBOS's dedicated system
 * connections get more slack. A DBOS transaction genuinely wedged for minutes is
 * still clearly anomalous and still gets killed, just later.
 */
export function withDbosIdleTxGrace(url: string): string {
  const graceSec = Math.max(60, Number(process.env.PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC) || 300);
  const opt = encodeURIComponent(`-c idle_in_transaction_session_timeout=${graceSec * 1000}`);
  return url + (url.includes('?') ? '&' : '?') + `options=${opt}`;
}

/** Whether DBOS has actually launched in this process. The route-side A/B fall-back
 *  uses this: a flow flag can be ON while DBOS itself is OFF (PAPERCUSP_DBOS_ENABLE
 *  unset, or PG unreachable so launch was skipped) — in that case callers must use
 *  the legacy path instead of enqueuing into a non-running DBOS. */
export function dbosStarted(): boolean {
  return !!G.__papercuspDbosStarted;
}

/** Idempotent single launch. Safe across Next HMR re-registers. */
export async function startDbos(): Promise<void> {
  if (G.__papercuspDbosStarted) return;

  const { url, source } = getHarnessAdminUrlWithSource();
  // Probe the resolved PG before launching. The source label can't distinguish
  // a *dead* native-fallback (desktop product: :5432 is the retired
  // papercusp_legacy) from a *live* one (dev box: :5432 IS the operator DB) —
  // so connect-test instead: launch when reachable, skip cleanly when not.
  {
    const postgres = (await import('postgres')).default;
    const probe = postgres(url, { max: 1, connect_timeout: 5, prepare: false });
    try {
      await probe`SELECT 1`;
    } catch (err) {
      console.warn(
        `[dbos] resolved PG not reachable (source=${source}) — skipping DBOS launch:`,
        err instanceof Error ? err.message : err,
      );
      await probe.end({ timeout: 2 }).catch(() => {});
      return;
    }
    await probe.end({ timeout: 2 }).catch(() => {});
  }

  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'papercusp-operator',
    systemDatabaseUrl: withDbosIdleTxGrace(url),
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: PINNED_APP_VERSION,
    // The operator shares a box with Restart (shop-api binds :3001); DBOS's
    // admin server defaults to :3001 and would EADDRINUSE. We don't use it.
    runAdminServer: false,
  });

  // Register workflows BEFORE launch so recovery + the scheduler can bind them.
  await import('./hello-workflow');
  // The director-cadence autoloop workflow is RETIRED (autoloop-pot-operator-
  // rebuild-2026-06-05 P-010 / D-009): it read `.papercusp/director-config.json`,
  // an enablement surface nothing wrote. Scheduled decider fires are the routines
  // engine's job — blueprint `triggers.schedule` → `system:blueprint-run` — with
  // the consecutive_errors backoff gate in lib/autoloop.ts protecting the fires.
  if (dbosPeriodicTimersActive()) {
    // Phase 2 (default-on with the orchestrator): periodic timers (telemetry flush,
    // scratch GC, memory cleanup, completion-ref verify, embed backfill, backup
    // cadence) as scheduled workflows; their legacy setInterval workers stand down
    // on dbosTimersActive(). Disable with PAPERCUSP_DBOS_TIMERS=0. A headless UTILITY
    // host skips these shared-DB periodic drains (EI-596) — see dbosPeriodicTimersActive.
    await import('./periodic-workflows');
  }
  if (dbosOrchestratorActive()) {
    // Phase 3 / P-009: the agent pipeline as a durable workflow is now the DEFAULT
    // orchestrator (on unless PAPERCUSP_DBOS_ORCHESTRATOR=0). The legacy main loop
    // is RETIRED — archived to libs/papercusp/_retired/orchestrator-run-loop/ on
    // 2026-06-06 (archive-legacy-orchestrator-deadcode). Setting =0 does NOT revert
    // to it (there is no legacy loop left to revert to); it just leaves no DBOS
    // orchestrator registered at all.
    // Register the workflow + wire the real invoke runner (spawns invoke-once with
    // IDEMPOTENCY_KEY).
    await import('./orchestrator-workflow');
    const { wireOrchestratorInvokeRunner } = await import('./orchestrator-runner');
    wireOrchestratorInvokeRunner();
    // The orchestrator (scheduled): scans PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES for
    // features needing work and starts pipelines (no-op until harnesses opt in).
    await import('./orchestrator-loop');
    // coordination-ops-as-blueprint-primitives P-005: the durable coord-op
    // PROGRAM executor (vote / deliberate) — the program-mode sibling of the
    // feature pipeline. Register the workflow + wire the agent-spawn runner for
    // `orchestrator:spawn-roles`. Additive: no harness uses a program spine until
    // one is created with a `vote`/`deliberate`-shaped blueprint.
    await import('./coord-program-workflow');
    const { wireCoordSpawnRunner } = await import('./coord-spawn-runner');
    wireCoordSpawnRunner();
    // unify-agent-spawn-chokepoint P-010: register the reusable durable-spawn
    // wrapper (autonomous launch-blueprint fires survive a host crash + re-run
    // once) BEFORE launch, alongside the feature-pipeline + coord-program workflows.
    await import('./durable-spawn');
  }
  if (dbosProvisionActive()) {
    // dbos-flows P-001/P-002 (default-on; disable with PAPERCUSP_DBOS_PROVISION=0):
    // the plugin setup/teardown/verify provision as a durable workflow — register it
    // before launch so DBOS recovery can resume an interrupted provision. The legacy
    // claim path in provision/runner stands down when this is active.
    await import('./provision-workflow');
  }
  if (dbosBackupActive()) {
    // dbos-flows P-011 (opt-in; enable with PAPERCUSP_DBOS_BACKUP=1): the workspace
    // snapshot op as a durable workflow via the generic StepRunner seam (D-010).
    // Register the workflow before launch (so recovery can resume an interrupted
    // snapshot) and inject the DBOS-backed StepRunner into @papercusp/backup. When
    // off, the lib's snapshot() runs un-stepped exactly as before.
    const { wireBackupStepRunner } = await import('./backup-workflow');
    wireBackupStepRunner();
  }
  if (dbosRoutinesActive()) {
    // git-sync-auto-commit Phase 1 (opt-in; PAPERCUSP_DBOS_ROUTINES=1): the generic
    // scheduled-routines engine — a durable `routinesTick` driving
    // `harness_shared.routines`, replacing the dormant in-process `routine-ticker`.
    // git-sync rides it as the first `system:` action. Registered before launch so
    // recovery + the scheduler bind it.
    await import('./routines-workflow');
  }
  if (dbosCurationActive()) {
    // curator-operator P0 (opt-in; PAPERCUSP_DBOS_CURATION=1): the scheduled
    // `curationTick` — consumes the fleet's structured status, applies the
    // salience policy, and surfaces curated messages into the operator chat
    // ("faster when busy, slower when quiet"). Registered before launch so the
    // scheduler binds it. The urgent (event-driven) half is armed separately
    // below, after launch, so escalations/blockers surface immediately.
    await import('./curation-workflow');
  }
  if (dbosReactionsActive()) {
    // event-reaction-system P1 (opt-in; PAPERCUSP_DBOS_REACTIONS=1): durable
    // reaction execution — a matched reaction runs as a DBOS-queued workflow
    // (survives restart, retried, idempotent via the dedup ledger migration 153)
    // instead of the default in-process fire-and-forget. Register the workflow +
    // queue before launch (so recovery can resume an interrupted reaction) and
    // INJECT the enqueue runner into lib/events. When off, lib/events fires every
    // reaction in-process exactly as today.
    const { wireDurableReactions } = await import('./event-reaction-workflow');
    wireDurableReactions();
  }
  if (dbosPlanRenderActive()) {
    // plan-markdown-auto-render P-006 (opt-in; PAPERCUSP_DBOS_PLAN_RENDER=1): the
    // scheduled `planMarkdownRender` workflow mirrors PG-canonical plans to on-disk
    // markdown under apps/operator/docs/plans/ (incremental + coalesced +
    // settle-guarded, read-only projection). Registered before launch so the
    // scheduler binds it. Opt-in because it writes the tracked tree (git-sync
    // commits the mirror) — see dbosPlanRenderActive.
    await import('./plan-markdown-render-workflow');
  }

  await DBOS.launch();
  G.__papercuspDbosStarted = true;
  console.log(
    `[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`,
  );

  // EI-455 — start the dead-executor reaper: an immediate boot reap (clears dedup
  // wedges left by a prior crash/restart) plus a 2-min process-level sweep that runs
  // OUTSIDE the DBOS routine engine, so it un-wedges the scheduler even when the
  // routine engine is itself frozen. See dbos-executor-reaper.ts. Best-effort —
  // must not fail boot.
  try {
    const [{ startExecutorReaper }, { getOrgPg }] = await Promise.all([
      import('./dbos-executor-reaper'),
      import('@papercusp/db-org'),
    ]);
    startExecutorReaper(getOrgPg().sql);
  } catch (e) {
    console.warn('[dbos-executor-reaper] failed to start (non-fatal):', e instanceof Error ? e.message : e);
  }

  // EI-455 bug #2 — start the green-checkpoint silent-stall watchdog: a process-
  // level sweep (NOT a DBOS routine, same reason as the reaper) that alarms when an
  // ACTIVE green-checkpoint routine stops firing or stops producing greens. The
  // in-routine detector (trackGateStall) only runs when the routine fires, so it is
  // blind to the routine NOT firing — the actual EI-455 stall. See
  // release/green-stall-watchdog.ts. Best-effort — must not fail boot.
  try {
    const [{ startGreenStallWatchdog }, { getOrgPg }] = await Promise.all([
      import('../release/green-stall-watchdog'),
      import('@papercusp/db-org'),
    ]);
    startGreenStallWatchdog(getOrgPg().sql);
    // Sibling: git-sync FIRING-but-not-COMMITTING (the 2026-06-30 ~6h silent strand — DBOS
    // reaping stuck fires). Same process-level rationale; reads git-sync routine health.
    const { startGitSyncStallWatchdog } = await import('../release/git-sync-stall-watchdog');
    startGitSyncStallWatchdog(getOrgPg().sql);
    // Sibling (Layer 4, mcp-host-availability-resilience): a spawned bee working DARK (tool-less)
    // after a :3070 deploy restart — alive + generating output, but its tool-call-coupled presence
    // beat predates the restart, so it never re-attached its papercusp MCP. Same process-level
    // rationale. The safety net under Layers 1–3 (permanent URLs · sticky approval · the :9071
    // proxy). Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
    const { startMcpDarkWatchdog } = await import('../system-health/mcp-dark-watchdog');
    startMcpDarkWatchdog(getOrgPg().sql);
    // Sibling (agent-managed-compaction P-009): caches each limit-setting session's
    // context-size estimate on coord_presence (feeds the coord:inbox usage signal, P-007)
    // and logs sessions that ran past their own compaction_limit. Kill-switch:
    // PAPERCUSP_COMPACTION_WATCHDOG='0'.
    const { startCompactionComplianceWatchdog } = await import(
      '../system-health/compaction-compliance-watchdog'
    );
    startCompactionComplianceWatchdog(getOrgPg().sql);
  } catch (e) {
    console.warn('[stall-watchdog] failed to start (non-fatal):', e instanceof Error ? e.message : e);
  }

  // EI-1747 — structural-error verifier: a process-level sweep (NOT a DBOS routine, same
  // reason as the watchdogs above — EI-1622 workflow_status bloat) that AUTO-RESOLVES OPEN
  // watchdog structural-error EIs whose offending tool has emitted no error in the deployed
  // operator's live telemetry (tool_invocations) for a quiet window. The inverse of
  // completion-ref-verifier (presence-on-remote ↔ absence-on-deployed); stops already-fixed
  // items rotting open + agents re-investigating landed fixes. DEFAULT-OFF until validated —
  // arm with PAPERCUSP_STRUCTURAL_ERROR_VERIFIER=1. Best-effort — must not fail boot.
  if (process.env.PAPERCUSP_STRUCTURAL_ERROR_VERIFIER === '1') {
    try {
      const { startStructuralErrorVerifier } = await import('../harness/structural-error-verifier');
      startStructuralErrorVerifier({ log: (m) => console.warn(m) });
    } catch (e) {
      console.warn('[structural-error-verifier] failed to start (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  if (dbosCurationActive()) {
    // Arm the event-driven urgent wake (curator-operator P2): coord_inbox →
    // immediate urgent-only curation tick, so escalations/blockers surface
    // without waiting for the cadence. Post-launch so the LISTEN is established
    // after DBOS is up. Best-effort — a wake-wiring failure must not fail boot.
    try {
      const { startCurationUrgentWake } = await import('../curation/urgent-wake');
      startCurationUrgentWake();
    } catch (e) {
      console.warn('[curation] failed to arm urgent wake:', e instanceof Error ? e.message : e);
    }
  }

  // Arm the D-003 per-turn auto-renewal of plan-item ACTIVITY claims
  // (plan-item-assignment-claim-liveness-2026-06-04): the activity bridge already
  // fires per completed turn → renew the reporting owner's shared-harness activity
  // claims, so they stay while the agent works and lapse when it goes idle. Host-only
  // (rides the agent_activity LISTEN); post-launch; best-effort — must not fail boot.
  try {
    const { startPlanItemActivityRenewal } = await import('../plan-items/activity-claim-renewal');
    startPlanItemActivityRenewal();
  } catch (e) {
    console.warn('[plan-item-claim] failed to arm activity renewal:', e instanceof Error ? e.message : e);
  }

  // Pre-warm the system-health cache so the FIRST Health/Overwatch tab open is
  // instant instead of cold-computing the 15-collector aggregation (incl. the
  // ~2.5s gateway probe) on the user's critical path (system-health-tab P-003
  // follow-up — the cold-cache 2-3s load). The scheduled systemHealthTick keeps
  // it warm thereafter; this closes the ~30s post-boot cold window. The pre-warm
  // is itself fire-and-forget per workspace + SYSTEM_HEALTH_TAB-gated, so this
  // returns immediately — best-effort, must not block/fail boot.
  try {
    const { preWarmSystemHealth } = await import('../system-health');
    const warmed = await preWarmSystemHealth();
    if (warmed > 0) console.log(`[system-health] boot pre-warm kicked off for ${warmed} workspace(s)`);
  } catch (e) {
    console.warn('[system-health] failed to arm boot pre-warm:', e instanceof Error ? e.message : e);
  }
}
