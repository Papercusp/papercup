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
import { getFlag } from '@papercusp/flags/server';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { runSubstrateOutboxBackstopGc } from '../substrate-outbox-backstop-gc';
import { reconcileStaleEscalationsOnce } from '../attention/reconcile-escalations';
import { isLoopSaturated } from '../event-loop-lag-monitor';
import { getResourceProfile } from '../resource-profile';

// P5-1 (operator-scalability-event-loop-2026-06-16): Layer-2 load-shedding. When
// the request event loop is CRITICALLY saturated, skip this cycle of a HEAVY
// background tick so the serving loop recovers — instead of piling background CPU
// onto an already-wedged loop (the exact failure that crash-looped :3070). Safe to
// skip: each of these has an on-demand / next-cycle correctness floor. Light ticks
// (single-query sweeps, the connection-pressure + service-health probes) are NOT
// shed — they're cheap and we want their signal precisely under load.
function shedUnderLoopPressure(tickName: string): boolean {
  if (isLoopSaturated()) {
    console.warn(`[loop-shed] skipped ${tickName} — event loop critically saturated (P5-1)`);
    return true;
  }
  return false;
}

// P5-3 (operator-scalability-event-loop-2026-06-16): power-aware cadence throttle.
// On battery the resource profile widens the background cadence
// (backgroundCadenceMultiplier > 1). DBOS schedules are fixed crontabs, so we
// approximate the wider cadence by SKIPPING (mult-1)/mult of a heavy tick's
// invocations — a 1-min tick at multiplier 3 effectively fires ~every 3 min.
// Deterministic per-tick counter (no Math.random); AC ⇒ multiplier 1 ⇒ never skips.
const powerSaveCounters = new Map<string, number>();
function shedUnderPowerSave(tickName: string): boolean {
  const mult = getResourceProfile().backgroundCadenceMultiplier;
  if (mult <= 1) return false;
  const n = (powerSaveCounters.get(tickName) ?? 0) + 1;
  powerSaveCounters.set(tickName, n);
  if (n % mult !== 0) {
    console.warn(`[power-save] skipped ${tickName} — on battery (cadence x${mult}, P5-3)`);
    return true;
  }
  return false;
}

// A heavy background tick sheds this cycle under EITHER acute loop pressure (P5-1,
// recover the serving loop) OR chronic power-save (P5-3, battery life).
function shouldShedHeavyTick(tickName: string): boolean {
  return shedUnderLoopPressure(tickName) || shedUnderPowerSave(tickName);
}

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
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('embed-backfill')) return;
    await runEmbedBackfillOnce();
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

// Every minute: probe the dev endpoints (:3070/:3055/:3350/…) and
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

// Every 2min: the composite learning-infra health tick (self-improvement-
// consume-edges-2026-06-12 P-003 / D-002) — LLM-spine resolvability + runner
// spawn path + gym circuit → ONE offline/degraded status; owner notification
// on the transition to offline (infra failures escalate, they don't queue).
// Flag-gated (LEARNING_INFRA_HEALTH, default ON); transition-only, never a
// per-tick firehose. Offset 15s so it doesn't pile on the :00 stampede.
async function learningInfraHealthTick(): Promise<void> {
  await DBOS.runStep(async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.LEARNING_INFRA_HEALTH, 'learning-infra-health'))) return;
    const { runLearningInfraHealthTick } = await import('../harness/improvements/learning-infra-health');
    const { health, transition } = await runLearningInfraHealthTick();
    if (transition) {
      console.warn(`[learning-infra-health] ${transition === 'offline' ? 'OFFLINE' : 'recovered'} — ${health.reason}`);
    }
  }, { name: 'learning-infra-health' });
}
const learningInfraHealthWorkflow = DBOS.registerWorkflow(learningInfraHealthTick, {
  name: 'learningInfraHealth', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(learningInfraHealthWorkflow, { name: 'learningInfraHealth', crontab: '15 */2 * * * *' });

// Every 30s (at :10/:40, off the :00/:30 sweep stampede): the whole-system Health
// snapshot tick (system-health-tab-2026-06-15 P-003 / D-001). Recompute the
// per-workspace SystemHealth (computeSystemHealth, fail-soft per panel) + fire
// notifySyncInvalidate('health.snapshot') so an open Health tab stays SSE-live.
// Flag-gated (SYSTEM_HEALTH_TAB, default ON); the resolver's own on-demand recompute
// is the correctness floor, so this tick is the liveness bonus, not the engine.
async function systemHealthTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('system-health')) return;
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return;
    const { runSystemHealthTick } = await import('../system-health');
    for (const ws of readRegistry().workspaces.map((w) => w.id)) {
      await runSystemHealthTick(ws).catch((e) => {
        console.warn(`[system-health] tick failed for ${ws}: ${e instanceof Error ? e.message : e}`);
      });
    }
  }, { name: 'system-health' });
}
const systemHealthWorkflow = DBOS.registerWorkflow(systemHealthTick, {
  name: 'systemHealth', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(systemHealthWorkflow, { name: 'systemHealth', crontab: '10,40 * * * * *' });

// Every 30s (at :15/:45): connection-pressure watch — C5-1 of
// backend-connection-scaling-2026-06-17. pgHealth() reports server-wide
// saturation (numbackends/max_connections across ALL databases, incl. su-lock);
// warn LOUDLY past 85% with the top connection holders, so a creeping leak or a
// pool-sizing regression is visible BEFORE it becomes a "too many clients" outage
// (the 2026-06-17 incident had no such signal). Log-only liveness signal — a
// future admission governor (parent plan P5) reads the same numbers to shed load.
async function connectionPressureTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const { pgHealth } = await import('../dev-data');
      const h = await pgHealth().catch(() => null);
      if (!h || h.maxConnections <= 0) return;
      if (h.saturationPct >= 85) {
        const top = h.byApplication
          .slice(0, 6)
          .map((a) => `${a.name}=${a.count}`)
          .join(' ');
        console.warn(
          `[pg-pressure] DANGER ${h.serverWideConnections}/${h.maxConnections} conns ` +
            `(${h.saturationPct}%). Top holders: ${top}. ` +
            `Remedy: raise the ceiling (npx tsx scripts/pg-autotune.ts --apply), lower ` +
            `PAPERCUSP_DB_POOL_MAX, or enable PgBouncer (PAPERCUSP_PGBOUNCER=1).`,
        );
      }
    },
    { name: 'connection-pressure' },
  );
}
const connectionPressureWorkflow = DBOS.registerWorkflow(connectionPressureTick, {
  name: 'connectionPressure',
  maxRecoveryAttempts: 3,
});
DBOS.registerScheduled(connectionPressureWorkflow, {
  name: 'connectionPressure',
  crontab: '15,45 * * * * *',
});

// Every 30s: harness_status / harness_lanes PID-liveness sweep (consolidation
// P-001). Replaces the legacy setInterval in harness-status-sweep.ts (which
// stands down on dbosTimersActive).
async function harnessStatusSweepTick(): Promise<void> {
  await DBOS.runStep(async () => {
    if (shouldShedHeavyTick('harness-status-sweep')) return;
    await runHarnessStatusSweepOnce();
  }, { name: 'harness-status-sweep' });
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
    const { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims } = await import('../work-items-stale-claims');
    const r = await reclaimStaleWorkItemClaims(getOrgPg().sql);
    if (r.released.length > 0) {
      const byAction = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.action] = (acc[c.action] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[stale-claims] released ${r.released.length} work-item claim(s) from dead holders ` +
          `(${Object.entries(byAction).map(([a, n]) => `${a}:${n}`).join(', ')}): ` +
          r.released.map((c) => `${c.harness_slug}/${c.feature_id}<-${c.former_taken_by} [${c.former_status}->${c.new_status}]`).join(', '),
      );
      // GAP 1 fix (D-006): requeued mid-flight rows auto-return to `todo` — no
      // broadcast needed (the old "needs re-placement" broadcast existed BECAUSE
      // nothing re-placed them). We now broadcast ONLY dead-letters: poison items
      // that exhausted the requeue cap and parked in `blocked`, which DO need
      // human/Queen attention. Terminal/`blocked`/`todo` freed rows are no longer
      // mislabeled as "needs re-placement" (the F-FIX-038 [passed] wart).
      const deadLettered = r.released.filter((c) => c.action === 'dead-lettered');
      if (deadLettered.length > 0) {
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
                `stale-claim sweep: ${deadLettered.length} work item(s) dead-lettered to [blocked] ` +
                `(stale-reclaim-exhausted — requeued past the cap by repeatedly-dying holders, needs attention): ` +
                deadLettered.map((c) => `${c.harness_slug}/${c.feature_id} (requeued ${c.requeue_count}x)`).join(', '),
            },
          );
        } catch { /* best-effort — the console.warn above is the floor */ }
      }
    }

    // GAP 2 (P-005 / D-009): the issue-family reaper — clear dead holders off OPEN
    // bug/change issues (same alias-aware liveness), returning them to the open
    // pool. `task` (delegate) issues are excluded — assignee is a durable
    // conversational binding, not a heartbeating work-claim.
    const ir = await reclaimStaleIssueClaims(getOrgPg().sql);
    if (ir.released.length > 0) {
      console.warn(
        `[stale-claims] reaped ${ir.released.length} issue-family claim(s) from dead holders ` +
          `(returned to the open pool): ` +
          ir.released.map((c) => `${c.issue_id}[${c.kind}]<-${c.former_assignee}`).join(', '),
      );
    }

    // P-009: heartbeat — record this run (always, even when nothing was freed) so the
    // system-health reader can detect a WEDGED scheduler (last-run aged out). The
    // detection must be external to this (possibly wedged) sweep; this just stamps it.
    try {
      const { recordSweepRun, STALE_CLAIM_SWEEP_NAME } = await import('../work-queue-health');
      await recordSweepRun(getOrgPg().sql, STALE_CLAIM_SWEEP_NAME, r.released.length + ir.released.length);
    } catch { /* best-effort heartbeat */ }
  }, { name: 'stale-claim-sweep' });

  // …and the PLAN-ITEM analog (EI-179): plan_item_claims lapse lazily — a dead
  // holder's leased row lingers as 'orphaned' (the expired-lease watchdog's
  // "abandoned work piling up") until some other agent happens to re-claim that
  // exact item. This is the missing GC: delete claims whose lease lapsed past
  // grace AND whose holder is gone (same alias-aware liveness rule). The durable
  // ASSIGNMENT (mig 140) is untouched, so the item returns to its assignee/pool.
  await DBOS.runStep(async () => {
    const { reclaimExpiredPlanItemClaims } = await import('../plan-items/stale-claims');
    const r = await reclaimExpiredPlanItemClaims(getOrgPg().sql);
    if (r.released.length > 0) {
      console.warn(
        `[stale-claims] released ${r.released.length} EXPIRED plan-item claim(s) from dead holders ` +
          `(lease lapsed past grace, no live presence): ` +
          r.released
            .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_owner}`)
            .join(', '),
      );
    }
  }, { name: 'stale-plan-item-claim-sweep' });
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
