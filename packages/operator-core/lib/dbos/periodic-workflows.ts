/**
 * Phase 2 of `dbos-durable-jobs-2026-05-31` — the simple periodic background
 * timers as DBOS scheduled workflows (default **skip-missed** mode, D-009 — no
 * backfill storm after a long-closed desktop). Replaces the `setInterval`
 * workers in `telemetry-flush.ts` and `scratch-gc.ts`.
 *
 * Flag-gated by `PAPERCUSP_DBOS_TIMERS=1` — registered only when `bootstrap.ts`
 * imports this module. Each legacy `start*()` worker stands down when the flag
 * is set (guard in its own file), so exactly one implementation runs (D-011 A/B,
 * instant revert by un-setting the flag).
 *
 * The tick bodies are the EXISTING, already-tested single-run functions
 * (`flushTelemetry`, `runScratchGc`) — this only swaps the scheduler driving
 * them, with DBOS step retries + a recovery cap (P-006). The remaining timers
 * (memory cleanup, completion-ref verifier, operator scanner, embeddings,
 * backups) follow this exact shape per the P-008 / D-016 classification.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { flushTelemetry } from '../telemetry-flush';
import { runScratchGc } from '../scratch-gc';
import { runEmbedBackfillOnce } from '../search/embed-backfill';
import { runDeadWorkflowMonitorOnce } from './dead-workflow-monitor';
import { runBackupSchedulerTick } from '@papercusp/backup';
import { gcOldNotifies } from '../agent-tools/coordination/notify-gc';
import { readRegistry } from '../workspace-registry';
import { sweepOrphanSnapshots } from '@papercusp/backup';
import { refreshAll as refreshPushCredentials } from '../device-push-credentials';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { runSubstrateOutboxBackstopGc } from '../substrate-outbox-backstop-gc';
import { runDbosWorkflowGcOnce } from './dbos-workflow-gc';
import { reconcileStaleEscalationsOnce } from '../attention/reconcile-escalations';
// EI-1622: the high-frequency EPHEMERAL periodic checks (systemHealth,
// harnessStatusSweep, connectionPressure, serviceHealth, completionRefVerify,
// spawnReclaimSweep, staleClaimSweep, learningInfraHealth, steeringChurnSweep) were
// converted from durable DBOS scheduled workflows → lightweight in-process intervals
// (in-process-periodic.ts, armed from host-bootstrap). They wrote ~200k
// dbos.workflow_status rows/day with no durability need — the source of the recurring
// routine-engine freeze. The shed policy they shared with the kept heavy ticks below
// now lives in tick-load-shed.ts.
import { shouldShedHeavyTick } from './tick-load-shed';

// storage-settings-page-2026-06-15 P-006: a pre-existing background prune is
// skipped when the owner disables its STORAGE_RETAIN_* flag from the Storage page
// (D-001 keep-all). FAIL-SAFE: getFlag already returns the flag's default (true)
// on any read error, and we default true on an unexpected throw — so this can
// never silently STOP a prune.
async function retentionEnabled(flag: FlagKey): Promise<boolean> {
  try {
    return await getFlag(flag, 'system:retention');
  } catch {
    return true;
  }
}

// Hourly: drain the telemetry ring buffer → archive, forward to PostHog (gated),
// enforce retention. A transient PostHog failure already degrades to retry-next,
// so a light step retry covers PG hiccups.
async function telemetryFlushTick(): Promise<void> {
  // NB: the telemetry RETENTION (30d archive delete) is gated inside flushTelemetry
  // itself (STORAGE_RETAIN_TELEMETRY) — NOT here, so disabling retention still lets
  // the flush archive + forward telemetry; only the delete-old step is skipped.
  await DBOS.runStep(() => flushTelemetry(), {
    name: 'flush-telemetry', retriesAllowed: true, maxAttempts: 2, intervalSeconds: 30,
  });
}
const telemetryFlushWorkflow = DBOS.registerWorkflow(telemetryFlushTick, {
  name: 'telemetryFlush', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(telemetryFlushWorkflow, { name: 'telemetryFlush', crontab: '0 0 * * * *' });

// Daily 03:00: scratch-storage GC sweep (retention + dead-workspace + quota).
async function scratchGcTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.STORAGE_RETAIN_SCRATCH))) return;
  await DBOS.runStep(async () => {
    const workspaceRegistry = readRegistry().workspaces.map((w) => w.id);
    runScratchGc({ workspaceRegistry });
  }, { name: 'scratch-gc' });
}
const scratchGcWorkflow = DBOS.registerWorkflow(scratchGcTick, {
  name: 'scratchGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(scratchGcWorkflow, { name: 'scratchGc', crontab: '0 0 3 * * *' });

// (The 6-hourly mem0 ephemeral-TTL sweep was removed — the `ephemeral` kind is
// retired, so nothing carries expires_at; ephemeral state lives in coord now.
// docs-and-memory-as-projections-2026-06-05 D-006.)

// Every 5min: embed-backfill sweep (battery-aware). The sweep's own batching
// is the rate limit on the embedding API (P-010).
async function embedBackfillTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('embed-backfill')) return;
    try {
      await runEmbedBackfillOnce();
    } catch (err) {
      // F1/F4 (infra-perf-reliability-audit-2026-06-19): a transient embedder
      // failure (embedder_disabled / openai_api_key_missing / a gateway or HTTP
      // error) must NOT throw out of the scheduled step. DBOS would retry, then
      // mark the workflow permanently dead (exceeded maxRecoveryAttempts) — which
      // silently STOPS all future backfill (the cosine/embedding leg that mem0
      // search depends on). This was the observed failure: `embedBackfill` dead,
      // memory:search degraded to ~50% errors / 19.5s p95. Log + skip; the next
      // 5-min tick retries once the embedder recovers.
      console.warn(`[embed-backfill] sweep skipped (non-fatal): ${(err as Error).message}`);
    }
  }, { name: 'embed-backfill' });
}
const embedBackfillWorkflow = DBOS.registerWorkflow(embedBackfillTick, {
  name: 'embedBackfill', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(embedBackfillWorkflow, { name: 'embedBackfill', crontab: '0 */5 * * * *' });

// Every minute: backup cadence tick — fires kopia snapshots for any workspace
// whose interval cadence is due (per-workspace dueness + in-flight dedup + PG
// cadence floor are inside the tick). P-011.
async function backupTick(): Promise<void> {
  await DBOS.runStep(() => runBackupSchedulerTick(), { name: 'backup-cadence' });
}
const backupWorkflow = DBOS.registerWorkflow(backupTick, {
  name: 'backupCadence', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(backupWorkflow, { name: 'backupCadence', crontab: '0 * * * * *' });

// Daily 04:00: GC the coord `notify` firehose (D-002 de-noise). Notify is
// opt-in + low-value, so drop rows past the retention window — bounded growth
// even though the dominant source (lock_acquired) is already removed.
async function coordNotifyGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldNotifies(3), { name: 'coord-notify-gc' });
}
const coordNotifyGcWorkflow = DBOS.registerWorkflow(coordNotifyGcTick, {
  name: 'coordNotifyGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(coordNotifyGcWorkflow, { name: 'coordNotifyGc', crontab: '0 0 4 * * *' });

// Every 6h: global substrate_outbox backstop GC — sweeps orphaned/old
// federation-queue rows the per-harness inline GC never reaches. An un-booted or
// mis-routed (workspace, harness) has no drain, so its captures accumulate
// unbounded (the EI-126 102 GB class; observed 5.3 GB on 2026-06-15). The
// conservative 48h-undrained / 24h-drained windows preserve every in-flight row.
// P-012 / operator-memory-and-psu-resilience-2026-06-14 D-016.
async function outboxBackstopGcTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('substrate-outbox-backstop-gc')) return;
    await runSubstrateOutboxBackstopGc();
  }, { name: 'substrate-outbox-backstop-gc' });
}
const outboxBackstopGcWorkflow = DBOS.registerWorkflow(outboxBackstopGcTick, {
  name: 'outboxBackstopGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(outboxBackstopGcWorkflow, { name: 'outboxBackstopGc', crontab: '0 0 */6 * * *' });

// Daily 04:30 (after coordNotifyGc 04:00, off the stampede): prune old TERMINAL
// dbos.workflow_status + operation_outputs rows (R4-5 / EI-1607 defense-in-depth) —
// 325k+ workflow rows accrue with no DBOS-native retention, bloating the system DB +
// the scheduler/recovery scans that walk it. NO-OP unless PAPERCUSP_DBOS_WORKFLOW_GC=1
// (a DELETE on DBOS's own system tables is arm-deliberately); only terminal statuses,
// batched, NEVER in-flight (PENDING/ENQUEUED) rows. Heavy DELETE → shed under loop pressure.
async function dbosWorkflowGcTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('dbos-workflow-gc')) return;
    const r = await runDbosWorkflowGcOnce();
    if (!r.skipped && (r.deletedWorkflows > 0 || r.deletedOutputs > 0)) {
      console.log(
        `[dbos-workflow-gc] pruned ${r.deletedWorkflows} terminal workflow(s) + ${r.deletedOutputs} operation_output(s) (${r.batches} batch(es), cutoff ${r.cutoffMs})`,
      );
    }
  }, { name: 'dbos-workflow-gc' });
}
const dbosWorkflowGcWorkflow = DBOS.registerWorkflow(dbosWorkflowGcTick, {
  name: 'dbosWorkflowGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(dbosWorkflowGcWorkflow, { name: 'dbosWorkflowGc', crontab: '0 30 4 * * *' });

// Hourly (:20, off the :00 stampede): reconcile the attention queue — auto-resolve
// stale OPERATIONAL escalations (placement-watchdog cursed placements / aging
// sweeps: system sender, no options) idle past the TTL. They are redundant
// duplicates of the derived placements.cursed health metric, emitted en masse and
// never resolved (~7000 open / ~135 resolved), so without this they accumulate
// forever in the alert tier. Genuine human-decision escalations are never touched.
// Batch-limited (500/tick) to drain a large backlog without a coord-log write
// burst. queue-pending-accuracy-and-drift P-003/P-005.
async function attentionReconcileTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('attention-reconcile')) return;
    await reconcileStaleEscalationsOnce();
  }, { name: 'attention-reconcile' });
}
const attentionReconcileWorkflow = DBOS.registerWorkflow(attentionReconcileTick, {
  name: 'attentionReconcile', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(attentionReconcileWorkflow, { name: 'attentionReconcile', crontab: '0 20 * * * *' });

// Hourly (:23, off the stampede): surface silently-dead DBOS workflows
// (MAX_RECOVERY_ATTEMPTS_EXCEEDED / ERROR) — the embedBackfill/systemHealth class the
// infra audit (F4) found dying with ZERO alerting (185 dead + 229 errored instances).
// READ-ONLY (SELECTs dbos.workflow_status) and never throws, so the monitor can't
// affect the workflows it watches. Logs a WARN summary; not a per-instance human
// escalation (round-1 D-005: don't flood the human channel with operational noise).
async function deadWorkflowMonitorTick(): Promise<void> {
  await DBOS.runStep(async () => {
    await runDeadWorkflowMonitorOnce();
  }, { name: 'dead-workflow-monitor' });
}
const deadWorkflowMonitorWorkflow = DBOS.registerWorkflow(deadWorkflowMonitorTick, {
  name: 'deadWorkflowMonitor', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(deadWorkflowMonitorWorkflow, { name: 'deadWorkflowMonitor', crontab: '0 23 * * * *' });

// Every 5min: backup orphan-snapshot sweep (consolidation P-002). REVIVES the
// job — its only legacy start site was the dead instrumentation-node, so this
// both ports it to DBOS and re-activates it (D-003).
async function orphanCleanupTick(): Promise<void> {
  await DBOS.runStep(async () => { await sweepOrphanSnapshots(); }, { name: 'backup-orphan-cleanup' });
}
const orphanCleanupWorkflow = DBOS.registerWorkflow(orphanCleanupTick, {
  name: 'backupOrphanCleanup', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(orphanCleanupWorkflow, { name: 'backupOrphanCleanup', crontab: '0 */5 * * * *' });

// Every 30min: refresh APNs/FCM push credentials (consolidation P-003). Replaces
// the legacy 50min setInterval (which stands down on dbosTimersActive); 30min is
// comfortably inside the 60min token TTL.
async function pushCredentialsTick(): Promise<void> {
  await DBOS.runStep(() => refreshPushCredentials(), { name: 'push-credentials-refresh' });
}
const pushCredentialsWorkflow = DBOS.registerWorkflow(pushCredentialsTick, {
  name: 'pushCredentialsRefresh', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(pushCredentialsWorkflow, { name: 'pushCredentialsRefresh', crontab: '0 */30 * * * *' });

// Daily 04:17 UTC: test_runs retention prune (consolidation P-009). Replaces the
// papercup-test-runs-prune systemd-user timer; calls harness_shared.prune_test_runs(50)
// (migration 083 — keep 50 rows per file_path/branch). Fail-soft inside the SQL fn.
async function testRunsPruneTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.STORAGE_RETAIN_TEST_RUNS))) return;
  await DBOS.runStep(async () => {
    const { sql } = getOrgPg();
    await sql`SELECT harness_shared.prune_test_runs(50)`;
  }, { name: 'test-runs-prune' });
}
const testRunsPruneWorkflow = DBOS.registerWorkflow(testRunsPruneTick, {
  name: 'testRunsPrune', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(testRunsPruneWorkflow, { name: 'testRunsPrune', crontab: '0 17 4 * * *' });
