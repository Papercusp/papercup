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
import { gcOldOperatorMessages } from '../agent-tools/coordination/message-log-gc';
import { gcResolvedEscalationFamilies } from '../agent-tools/coordination/escalation-log-gc';
import { gcOldPlanRevisions } from '../agent-tools/plans/revisions-gc';
import { readRegistry } from '../workspace-registry';
import { sweepOrphanSnapshots } from '@papercusp/backup';
import { refreshAll as refreshPushCredentials } from '../device-push-credentials';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { runSubstrateOutboxBackstopGc } from '../substrate-outbox-backstop-gc';
import { runDbosWorkflowGcOnce } from './dbos-workflow-gc';
import { reconcileStaleEscalationsOnce } from '../attention/reconcile-escalations';
import { reconcileStalePendingHandoffsOnce, reconcileHandoffRepingsOnce } from '../reconcile-handoffs';
import { runStorageGrowthAlarmOnce } from '../storage/storage-growth-alarm';
import { runReplicationSlotAlarmOnce } from '../storage/replication-slot-alarm';
import { runTestDesktopReaperOnce } from '../test-desktop-reaper';
import { runDiskSpaceAlarmOnce } from '../storage/disk-space-alarm';
import { runMemoryAnchorAuditOnce } from '../memory/audit-memory-anchors';
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

// Daily 04:05 (after notify-gc, before escalation-gc): physical retention cap
// for OPERATOR-SCOPE coord messages. Harness-scoped messages federate, so the GC
// keeps them; rooted message threads are deleted only when the whole thread is
// fully aged and unreferenced by coord_thread_posts (WI-401).
async function coordMessagesGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldOperatorMessages(), { name: 'coord-messages-gc' });
}
const coordMessagesGcWorkflow = DBOS.registerWorkflow(coordMessagesGcTick, {
  name: 'coordMessagesGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(coordMessagesGcWorkflow, { name: 'coordMessagesGc', crontab: '0 5 4 * * *' });

// Daily 04:15 (off the 04:00 notify-gc / 04:30 dbos-gc stampede): physical retention
// GC for the coord_event_log `escalations` surface — the dominant growth driver
// (~35k rows, operational raise+resolve churn). Deletes RESOLVED, fully-aged,
// operator-scope escalation FAMILIES atomically (the existing archiveResolvedEscalations
// is a logical archive that only ADDS rows). infra-fail-fast C3/P-011. Safety rationale
// in escalation-log-gc.ts (family-atomic, resolved-only, fully-aged, harness_slug NULL).
async function coordEscalationGcTick(): Promise<void> {
  await DBOS.runStep(() => gcResolvedEscalationFamilies(), { name: 'coord-escalation-gc' });
}
const coordEscalationGcWorkflow = DBOS.registerWorkflow(coordEscalationGcTick, {
  name: 'coordEscalationGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(coordEscalationGcWorkflow, { name: 'coordEscalationGc', crontab: '0 15 4 * * *' });

// Daily 04:45 (off the 04:00/04:15/04:30 GC stampede): per-plan retention cap for
// the plan_revisions spine — keep the newest N revisions per plan, delete the older
// tail. Every plans:* write appends a full content_snapshot, so a hot plan would
// otherwise grow unbounded. infra-fail-fast C4/P-012. Safety (current state always
// preserved, no federation trigger) in revisions-gc.ts.
async function planRevisionsGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldPlanRevisions(), { name: 'plan-revisions-gc' });
}
const planRevisionsGcWorkflow = DBOS.registerWorkflow(planRevisionsGcTick, {
  name: 'planRevisionsGc', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(planRevisionsGcWorkflow, { name: 'planRevisionsGc', crontab: '0 45 4 * * *' });

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

// Every 30 min (:26 + :56, off the :00/:20/:23 stampede): the coord-handoff
// invariant passes. (1) F-FIX-037 EXPIRE — auto-expire handoffs left pending past
// the 12h TTL: a handoff is an immutable coord_event_log offer of work; an
// unaccepted one sits `open` forever and misleads successors ("pick up the open
// handoff" chases a stale offer). The sweep writes a sibling 'handoff_expired'
// record (never mutates the original) so the fold drops it from `open`. (2)
// coord-dispatch-reliability P-003 RE-PING — an open, un-acked handoff older than
// ~30m (but < the 12h expire TTL) re-pings the OFFERER once (sibling
// 'handoff_repinged' + a coord message + a fail-soft wake) so they can follow up /
// reassign before the expire backstop. The :56 tick is why the cadence is 30min —
// the re-ping is only useful if it fires promptly; the 12h expire pass in the same
// tick is idempotent + batch-limited (500) so running it twice an hour is harmless.
// Both passes are independently fail-soft; one failing never blocks the other.
async function handoffReconcileTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('handoff-reconcile')) return;
    // live-configurability-audit P-014 + P-003: apply the handoff TTL / re-ping
    // overrides (undefined ⇒ baked defaults: 12h expire, 30m re-ping).
    const { readCoordLivenessConfig } = await import('../coord-liveness-config');
    const livenessCfg = await readCoordLivenessConfig();
    // EXPIRE pass (12h backstop) — unchanged.
    await reconcileStalePendingHandoffsOnce({ ttlMs: livenessCfg.handoffTtlMs });
    // RE-PING pass (~30m offerer nudge) — isolated so an expire failure never skips
    // it and vice versa.
    try {
      await reconcileHandoffRepingsOnce({
        repingMs: livenessCfg.handoffRepingMs,
        ttlMs: livenessCfg.handoffTtlMs,
      });
    } catch (e) {
      console.warn(`[handoff-reconcile] re-ping pass failed: ${e instanceof Error ? e.message : e}`);
    }
  }, { name: 'handoff-reconcile' });
}
const handoffReconcileWorkflow = DBOS.registerWorkflow(handoffReconcileTick, {
  name: 'handoffReconcile', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(handoffReconcileWorkflow, { name: 'handoffReconcile', crontab: '0 26,56 * * * *' });

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

// Every 6h (:50, off the :00 stampede + after the outbox backstop GC at :00):
// storage growth alarm (infra-perf-reliability-audit-round4 P-017 — the EI-126
// 102 GB silent-growth guard). READ-ONLY catalog-size check (sizesOnly, no row
// scan); emits a notifications:recent toast if any PG storage category crosses
// its absolute ceiling. Default ON; kill-switch PAPERCUSP_STORAGE_GROWTH_ALARM=0.
// Never throws → can't affect what it watches. Shed under loop pressure.
async function storageGrowthAlarmTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_STORAGE_GROWTH_ALARM === '0') return;
    if (shouldShedHeavyTick('storage-growth-alarm')) return;
    const r = await runStorageGrowthAlarmOnce();
    if (r.breaches.length > 0) {
      console.log(
        `[storage-growth-alarm] ${r.breaches.length} categor(y/ies) over ceiling: ${r.breaches.map((b) => `${b.id}=${(b.bytes / 1024 ** 3).toFixed(1)}GB`).join(', ')}`,
      );
    }
  }, { name: 'storage-growth-alarm' });
}
const storageGrowthAlarmWorkflow = DBOS.registerWorkflow(storageGrowthAlarmTick, {
  name: 'storageGrowthAlarm', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(storageGrowthAlarmWorkflow, { name: 'storageGrowthAlarm', crontab: '0 50 */6 * * *' });

// Hourly (:40, off the :00/:50 stampede): replication-slot WAL-retention alarm
// (infra-perf-reliability-audit-round4 P-009 / D-004). READ-ONLY pg_replication_slots
// check; emits a notifications:recent toast when a slot pins WAL past its ceiling —
// the silent disk-fill SPOF, since max_slot_wal_keep_size=-1 means PG never caps an
// abandoned slot (a dropped federation subscriber / stale retired-Zero slot). Silent
// on the normal 0-slot steady state. Default ON; kill-switch
// PAPERCUSP_REPLICATION_SLOT_ALARM=0. Never throws → can't affect what it watches.
async function replicationSlotAlarmTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_REPLICATION_SLOT_ALARM === '0') return;
    if (shouldShedHeavyTick('replication-slot-alarm')) return;
    const r = await runReplicationSlotAlarmOnce();
    if (r.breaches.length > 0) {
      console.log(
        `[replication-slot-alarm] ${r.breaches.length} slot(s) over WAL ceiling: ${r.breaches.map((b) => `${b.slotName}=${(b.retainedWalBytes / 1024 ** 3).toFixed(1)}GB/${b.reason}`).join(', ')}`,
      );
    }
  }, { name: 'replication-slot-alarm' });
}
const replicationSlotAlarmWorkflow = DBOS.registerWorkflow(replicationSlotAlarmTick, {
  name: 'replicationSlotAlarm', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(replicationSlotAlarmWorkflow, { name: 'replicationSlotAlarm', crontab: '0 40 * * * *' });

// Every 15min (:07/:22/:37/:52, off the :00 stampede): runaway/leaked TEST-desktop
// + zombie alarm (infra-perf-reliability-audit-round4 P-006 — the host-CPU drain
// from killed/wedged E2E webviews leaking and pegging a core). READ-ONLY /proc
// scan; CPU-samples only the handful of positively-identified test desktops, never
// the live user desktop (fail-safe classifier); emits a notifications:recent toast
// on a runaway desktop or a zombie pile. Detection-ONLY — auto-reap of a non-agent
// host process is a separate owner-gated kill path. Default ON; kill-switch
// PAPERCUSP_TEST_DESKTOP_REAPER=0. Never throws → can't affect what it watches.
// Shed under loop pressure.
async function testDesktopReaperTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_TEST_DESKTOP_REAPER === '0') return;
    if (shouldShedHeavyTick('test-desktop-reaper')) return;
    const r = await runTestDesktopReaperOnce();
    if (r.alarmed) {
      console.log(
        `[test-desktop-reaper] alarmed: ${r.candidates.filter((c) => c.reason === 'runaway-test-desktop').length} runaway desktop(s), ${r.candidates.filter((c) => c.reason === 'zombie').length} zombie(s) (sampled ${r.sampled})`,
      );
    }
  }, { name: 'test-desktop-reaper' });
}
const testDesktopReaperWorkflow = DBOS.registerWorkflow(testDesktopReaperTick, {
  name: 'testDesktopReaper', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(testDesktopReaperWorkflow, { name: 'testDesktopReaper', crontab: '0 7,22,37,52 * * * *' });

// Every 30min (:13/:43, off the :00 stampede): disk/inode low-free-space tripwire
// (infra-fail-fast-build-integrity P-018 / D5 — a full FS silently wedges the
// single-Node operator behind a green health check; only one-time prunes existed).
// READ-ONLY statfs probe of the watched filesystems; emits a notifications:recent
// toast when free bytes/% or free inodes fall below a floor. Default ON; kill-switch
// PAPERCUSP_DISK_SPACE_ALARM=0. Never throws → can't affect what it watches. Shed
// under loop pressure.
async function diskSpaceAlarmTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_DISK_SPACE_ALARM === '0') return;
    if (shouldShedHeavyTick('disk-space-alarm')) return;
    const r = await runDiskSpaceAlarmOnce();
    if (r.breaches.length > 0) {
      console.log(
        `[disk-space-alarm] ${r.breaches.length} filesystem(s) low: ${r.breaches.map((b) => `${b.path}=${(b.freePct * 100).toFixed(1)}%`).join(', ')}`,
      );
    }
  }, { name: 'disk-space-alarm' });
}
const diskSpaceAlarmWorkflow = DBOS.registerWorkflow(diskSpaceAlarmTick, {
  name: 'diskSpaceAlarm', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(diskSpaceAlarmWorkflow, { name: 'diskSpaceAlarm', crontab: '0 13,43 * * * *' });

// Daily 05:00 (after the 03:00–04:30 GC/prune cluster, off the :00 stampede): the
// Layer-1 memory-anchor audit (papercusp-su-memory-2026-05-25 P-019). Re-checks
// every harness_shared.memory_anchors row structurally — file anchors via the
// repo basename-resolve + external-skip checker (audit-anchors.fileChecker), plus
// plan/migration/feature — stamps last_checked_at + last_check_ok and flips
// memory_canonical.state broken_anchor⇄active. This is the job that gives the
// EI-2032 anchor-rooting cleanup LIVE effect: until it ran, the residue was purely
// latent (the checker was never scheduled). SKIPS cleanly on a source-less host
// (detectPapercupRoot()→null) so a packaged install never false-flags. It WRITES,
// but broken_anchor does NOT affect recall (canonical recall filters only
// state='archived') → low blast radius. Default ON; kill-switch
// PAPERCUSP_MEMORY_ANCHOR_AUDIT=0. Never throws (mirrors embed-backfill: a thrown
// step → DBOS marks the workflow permanently dead → silent stop forever) → can't
// poison the scheduler. Shed under loop pressure (git ls-files + N UPDATEs).
async function memoryAnchorAuditTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_MEMORY_ANCHOR_AUDIT === '0') return;
    if (shouldShedHeavyTick('memory-anchor-audit')) return;
    try {
      const r = await runMemoryAnchorAuditOnce();
      console.log(`[memory-anchor-audit] ${r.skipped ? `skipped: ${r.reason ?? 'no-op'}` : (r.summary ?? 'done')}`);
    } catch (err) {
      console.warn(`[memory-anchor-audit] run skipped (non-fatal): ${(err as Error).message}`);
    }
  }, { name: 'memory-anchor-audit' });
}
const memoryAnchorAuditWorkflow = DBOS.registerWorkflow(memoryAnchorAuditTick, {
  name: 'memoryAnchorAudit', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(memoryAnchorAuditWorkflow, { name: 'memoryAnchorAudit', crontab: '0 0 5 * * *' });

// Weekly (Sun 05:30 UTC, off the daily 03:00–05:00 GC/prune cluster): code-recipes
// hygiene (recipes-reuse-activation-2026-06-22 P-003). There was NO scheduled automation
// for the recipe corpus — recipes:sweep / recipes:candidates were manual su-only tools —
// so the never-reused one-off tail accumulated unbounded (the audit found the corpus was
// already mostly trivial dogfood noise). This (1) RETIRES the stale long-tail via
// sweepRecipes (a reversible status flip that NEVER touches hot / promoted / merged /
// NULL-last-run recipes) and (2) LOGS the current promote/merge worklist for visibility
// (the Queen still pulls recipes:candidates live; this is a passive heartbeat so a
// Queen-less window still surfaces what's graduating). Default ON; kill-switch
// PAPERCUSP_RECIPE_HYGIENE=0. Never throws → can't poison the scheduler. Shed under load.
async function recipeHygieneTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (process.env.PAPERCUSP_RECIPE_HYGIENE === '0') return;
    if (shouldShedHeavyTick('recipe-hygiene')) return;
    try {
      const { runRecipeHygieneOnce } = await import('../recipe-hygiene');
      const { sql } = getOrgPg();
      const r = await runRecipeHygieneOnce(sql);
      if (r.sweptIds.length > 0 || r.promoteCandidates > 0 || r.mergeClusters > 0) {
        console.log(
          `[recipe-hygiene] retired ${r.sweptIds.length} stale one-off recipe(s); ` +
            `${r.promoteCandidates} promote candidate(s), ${r.mergeClusters} merge cluster(s) awaiting Queen review`,
        );
      }
    } catch (err) {
      console.warn(`[recipe-hygiene] run skipped (non-fatal): ${(err as Error).message}`);
    }
  }, { name: 'recipe-hygiene' });
}
const recipeHygieneWorkflow = DBOS.registerWorkflow(recipeHygieneTick, {
  name: 'recipeHygiene', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(recipeHygieneWorkflow, { name: 'recipeHygiene', crontab: '0 30 5 * * 0' });
