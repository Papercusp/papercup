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
import { runCompletionRefVerifierOnce } from '../harness/completion-ref-verifier';
import { runEmbedBackfillOnce } from '../search/embed-backfill';
import { runBackupSchedulerTick } from '@papercusp/backup';
import { gcOldNotifies } from '../agent-tools/coordination/notify-gc';
import { runServiceHealthTick } from '../service-health';
import { readRegistry } from '../workspace-registry';
import { runHarnessStatusSweepOnce } from '../harness-status-sweep';
import { sweepOrphanSnapshots } from '@papercusp/backup';
import { refreshAll as refreshPushCredentials } from '../device-push-credentials';
import { getOrgPg } from '@papercusp/db-org';

// Hourly: drain the telemetry ring buffer → archive, forward to PostHog (gated),
// enforce retention. A transient PostHog failure already degrades to retry-next,
// so a light step retry covers PG hiccups.
async function telemetryFlushTick(): Promise<void> {
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

// Every minute: poll completion_refs against the remote (git ls-remote),
// stamping verified/divergent. Per-feature backoff stays in the worker.
async function completionRefTick(): Promise<void> {
  await DBOS.runStep(() => runCompletionRefVerifierOnce(), { name: 'completion-ref-verify' });
}
const completionRefWorkflow = DBOS.registerWorkflow(completionRefTick, {
  name: 'completionRefVerify', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(completionRefWorkflow, { name: 'completionRefVerify', crontab: '0 * * * * *' });

// Every 5min: embed-backfill sweep (battery-aware). The sweep's own batching
// is the rate limit on the embedding API (P-010).
async function embedBackfillTick(): Promise<void> {
  await DBOS.runStep(() => runEmbedBackfillOnce(), { name: 'embed-backfill' });
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

// Every minute: probe the dev endpoints (:3070/:3055/:4321/:4848/…) and
// broadcast a coord message on each up/down TRANSITION (fleet-coordination-
// painpoints Phase 3b). External liveness has no event source, so this is the
// one irreducible poll (D-006); transition-only, never a per-tick firehose.
async function serviceHealthTick(): Promise<void> {
  await DBOS.runStep(() => runServiceHealthTick(), { name: 'service-health' });
}
const serviceHealthWorkflow = DBOS.registerWorkflow(serviceHealthTick, {
  name: 'serviceHealth', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(serviceHealthWorkflow, { name: 'serviceHealth', crontab: '0 * * * * *' });

// Every 30s: harness_status / harness_lanes PID-liveness sweep (consolidation
// P-001). Replaces the legacy setInterval in harness-status-sweep.ts (which
// stands down on dbosTimersActive).
async function harnessStatusSweepTick(): Promise<void> {
  await DBOS.runStep(() => runHarnessStatusSweepOnce(), { name: 'harness-status-sweep' });
}
const harnessStatusSweepWorkflow = DBOS.registerWorkflow(harnessStatusSweepTick, {
  name: 'harnessStatusSweep', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(harnessStatusSweepWorkflow, { name: 'harnessStatusSweep', crontab: '*/30 * * * * *' });

// Every minute: reclaim orphaned spawn rows — 'running'/'restarting'
// spawned_agents whose launching operator host died and stopped heartbeating, so
// they stop counting forever against the global concurrency ceiling
// (unify-agent-spawn-chokepoint P-011). Workspace-agnostic; the in-band
// opportunistic reclaim in operator-spawn.ts is the correctness floor, this is
// the idle backstop that also un-sticks fleet:tree.
async function spawnReclaimSweepTick(): Promise<void> {
  await DBOS.runStep(async () => {
    const { reclaimOrphanedSpawns } = await import('../fleet/spawn-reclaim');
    const r = await reclaimOrphanedSpawns(getOrgPg().sql);
    if (r.reclaimed > 0) {
      console.warn(`[spawn-reclaim] freed ${r.reclaimed} orphaned spawn(s): ${r.spawnIds.join(', ')}`);
      // Freed slots → wake over-ceiling waiters sleeping on the slot key (D-004).
      try {
        const { emitAwaitedEvent } = await import('../events/await/engine');
        const { spawnSlotEventKey } = await import('../fleet/operator-spawn');
        for (const ws of r.workspaces) {
          await emitAwaitedEvent({
            key: spawnSlotEventKey(ws),
            summary: `${r.reclaimed} orphaned spawn slot(s) reclaimed by the periodic sweep`,
            source: 'spawn-reclaim-sweep',
            workspaceId: ws,
          }).catch(() => undefined);
        }
      } catch { /* best-effort — waiters fall back to their await timeout */ }
    }
  }, { name: 'spawn-reclaim-sweep' });
}
const spawnReclaimSweepWorkflow = DBOS.registerWorkflow(spawnReclaimSweepTick, {
  name: 'spawnReclaimSweep', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(spawnReclaimSweepWorkflow, { name: 'spawnReclaimSweep', crontab: '0 * * * * *' });

// Every minute: release work-item claims held by DEAD agents (owner-reported
// gap, 2026-06-11). Bee identities are per-spawn and never persisted — an app
// close/crash strands `taken_by = <dead alias>` on claimed items FOREVER
// (claimNextWorkItem filters `taken_by IS NULL`, so no other agent can ever
// pick them up). Liveness = the mig-225 alias-aware rule (coord_presence OR
// running-nursery aliases, fresh heartbeats) — the sweep is the missing ACTOR
// behind fleet_assignment's 'orphaned' signal. Companion to spawn-reclaim
// above: that frees the dead spawn's CONCURRENCY slot, this frees its CLAIMS.
async function staleClaimSweepTick(): Promise<void> {
  await DBOS.runStep(async () => {
    const { reclaimStaleWorkItemClaims } = await import('../work-items-stale-claims');
    const r = await reclaimStaleWorkItemClaims(getOrgPg().sql);
    if (r.released.length > 0) {
      const byStatus = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[stale-claims] released ${r.released.length} work-item claim(s) from dead holders ` +
          `(${Object.entries(byStatus).map(([s, n]) => `${s}:${n}`).join(', ')}): ` +
          r.released.map((c) => `${c.harness_slug}/${c.feature_id}<-${c.former_taken_by}`).join(', '),
      );
      // Non-'todo' rows died mid-flight — surface them for deliberate
      // re-placement instead of silently returning them to the backlog.
      const midFlight = r.released.filter((c) => c.status !== 'todo');
      if (midFlight.length > 0) {
        try {
          const { sendMessage } = await import('../agent-tools/coordination/messages');
          await sendMessage(
            {
              ownerId: 'stale-claim-sweep',
              ownerLabel: 'system · stale-claim-sweep',
              source: 'signed-spawn',
              workspaceId: null,
              userId: null,
            },
            {
              to: ['*'],
              summary:
                `stale-claim sweep: ${midFlight.length} work item(s) freed from DEAD holders mid-flight ` +
                `(non-todo status — needs re-placement): ` +
                midFlight.map((c) => `${c.harness_slug}/${c.feature_id} [${c.status}]`).join(', '),
            },
          );
        } catch { /* best-effort — the console.warn above is the floor */ }
      }
    }
  }, { name: 'stale-claim-sweep' });
}
const staleClaimSweepWorkflow = DBOS.registerWorkflow(staleClaimSweepTick, {
  name: 'staleClaimSweep', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(staleClaimSweepWorkflow, { name: 'staleClaimSweep', crontab: '30 * * * * *' });

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
  await DBOS.runStep(async () => {
    const { sql } = getOrgPg();
    await sql`SELECT harness_shared.prune_test_runs(50)`;
  }, { name: 'test-runs-prune' });
}
const testRunsPruneWorkflow = DBOS.registerWorkflow(testRunsPruneTick, {
  name: 'testRunsPrune', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(testRunsPruneWorkflow, { name: 'testRunsPrune', crontab: '0 17 4 * * *' });

// Every 5min: the multi-Queen steering-churn tripwire sweep (hive-network-surface
// P-010 / Brief B-12; D-004). Across all workspaces, find backlog items whose
// feature_order (the Queen's steer lever) was re-steered by >= 2 distinct writers
// in the recent window and raise a debounced owner coord:escalate above the flip
// threshold. The catch-all for interleavings the synchronous post-steer check in
// setWorkItemPriority misses (e.g. two REMOTE Swarms ping-ponging an item this box
// never locally steered). At N=1 every steer is local → one writer → no churn.
async function steeringChurnSweepTick(): Promise<void> {
  await DBOS.runStep(async () => {
    const { sweepSteeringChurn, pruneSteeringChurnEvents } = await import('../steering-churn');
    const r = await sweepSteeringChurn();
    if (r.escalated > 0) {
      console.warn(`[steering-churn] swept ${r.checked} churned item(s); escalated ${r.escalated} to the owner`);
    }
    await pruneSteeringChurnEvents();
  }, { name: 'steering-churn-sweep' });
}
const steeringChurnSweepWorkflow = DBOS.registerWorkflow(steeringChurnSweepTick, {
  name: 'steeringChurnSweep', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(steeringChurnSweepWorkflow, { name: 'steeringChurnSweep', crontab: '0 */5 * * * *' });
