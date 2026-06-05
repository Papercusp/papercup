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
} from './dbos-flags';

const PINNED_APP_VERSION = process.env.DBOS__APPVERSION || 'papercusp-jobs-v1';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };

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
    systemDatabaseUrl: url,
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
  if (dbosTimersActive()) {
    // Phase 2 (default-on with the orchestrator): periodic timers (telemetry flush,
    // scratch GC, memory cleanup, completion-ref verify, embed backfill, backup
    // cadence) as scheduled workflows; their legacy setInterval workers stand down
    // (same condition). Disable with PAPERCUSP_DBOS_TIMERS=0.
    await import('./periodic-workflows');
  }
  if (dbosOrchestratorActive()) {
    // Phase 3 / P-009: the agent pipeline as a durable workflow is now the DEFAULT
    // orchestrator (on unless PAPERCUSP_DBOS_ORCHESTRATOR=0). The legacy main loop
    // is retired (already out of the live path); set =0 for the instant revert.
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

  await DBOS.launch();
  G.__papercuspDbosStarted = true;
  console.log(
    `[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`,
  );

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
}
