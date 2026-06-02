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
import { flushTelemetry } from '@/lib/telemetry-flush';
import { runScratchGc } from '@/lib/scratch-gc';
import { runMemoryCleanupOnce } from '@/lib/memory/cleanup-worker';
import { runCompletionRefVerifierOnce } from '@/lib/harness/completion-ref-verifier';
import { runEmbedBackfillOnce } from '@/lib/search/embed-backfill';
import { runBackupSchedulerTick } from '@papercusp/backup';
import { gcOldNotifies } from '@/lib/agent-tools/coordination/subscriptions';
import { readRegistry } from '@/lib/workspace-registry';

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

// Every 6h: purge expired mem0 ephemeral memories.
async function memoryCleanupTick(): Promise<void> {
  await DBOS.runStep(() => runMemoryCleanupOnce(), { name: 'memory-cleanup' });
}
const memoryCleanupWorkflow = DBOS.registerWorkflow(memoryCleanupTick, {
  name: 'memoryCleanup', maxRecoveryAttempts: 5,
});
DBOS.registerScheduled(memoryCleanupWorkflow, { name: 'memoryCleanup', crontab: '0 0 */6 * * *' });

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
