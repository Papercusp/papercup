/**
 * carry-drill-drop-watchdog (EI-12755) — real-time escalation for dropped
 * P-020 carry drills.
 *
 * Every carry-drill terminal outcome (delivered / dropped / respawn-failed,
 * incl. the EI-12655 busy-gate-expired and EI-12754 re-armed drops) is durably
 * mirrored to the shared ledger (~/.papercusp/psu-pty/carry-drills.events.jsonl),
 * and `session:carry-drill op:'verify' / op:'report'` expose them ON DEMAND —
 * but a dropped carry still surfaced only when a caller polled. The 2/2 silent
 * drill failures of 2026-07-15 sat unnoticed ~40 minutes (EI-12655). This
 * watchdog tails the ledger on a managed timer and opens ONE escalation per
 * dropped drill, so a drop reaches the attention queue in ~a minute.
 *
 * Design notes:
 *  - `managedSetInterval` (never a bare setInterval) — visible in
 *    schedule:inventory, category 'watchdog', like its system-health siblings.
 *  - Runtime gate: FLAGS.CARRY_DRILL_DROP_WATCHER (default ON — flip OFF at
 *    /admin/features to silence; no ad-hoc env boolean per lint:env-feature-gates).
 *  - Dedup is delegated to openEscalation's own (dedupKind, subjectSignature)
 *    PG-locked dedup — cluster-safe with zero new state surface. An in-process
 *    time watermark (boot backfill BACKFILL_MS) keeps each tick incremental and
 *    stops ancient rows from re-alerting after the escalation is resolved.
 *  - Escalations from this system identity carry no options, so the attention
 *    reader demotes them to the alert tier and the reconcile sweep TTL-reaps
 *    them — noise-bounded by construction.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  readColdBootDrillLedger,
  scanCarryDrillDrops,
  type CarryDrillDropAlert,
  type ColdBootDrillLedgerEvent,
} from '../cold-boot-drill-live';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const CARRY_DRILL_DROP_SWEEP_INTERVAL_MS = 60_000;
/** How far back the first tick after boot looks — covers a restart gap without
 *  re-alerting the whole ledger (open-escalation dedup absorbs any overlap). */
export const CARRY_DRILL_DROP_BACKFILL_MS = 15 * 60_000;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'carry-drill-drop-watchdog',
  ownerLabel: 'system · carry-drill drops',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface CarryDrillDropSweepDeps {
  readLedger: () => Promise<ColdBootDrillLedgerEvent[]>;
  escalate: (alert: CarryDrillDropAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.CARRY_DRILL_DROP_WATCHER, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

async function defaultEscalate(alert: CarryDrillDropAlert): Promise<void> {
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `Carry drill ${alert.kind === 'carry-drill-respawn-failed' ? 'respawn FAILED' : 'carry DROPPED'} ` +
      `(${alert.reason}) — drill ${alert.drillId.slice(0, 8)}… on ${alert.ownerId} [${alert.sessionClass}]`,
    body:
      `The P-020 cold-boot drill ${alert.drillId} for session owner ${alert.ownerId} ` +
      `(class ${alert.sessionClass}) ended in a terminal ${alert.kind} at ${alert.ts} ` +
      `(reason: ${alert.reason}).\n\n` +
      `The requesting session may be gone (drills cut the process), so this is surfaced here ` +
      `instead of waiting for someone to poll session:carry-drill { op:'report' }. ` +
      `Triage: session:carry-drill { op:'verify', drillId } from the requester, or read the shared ` +
      `ledger at ~/.papercusp/psu-pty/carry-drills.events.jsonl. Recurring busy-gate-expired drops ` +
      `mean the subject's turns outrun the re-arm cap (PAPERCUSP_PSU_PTY_REARM_CAP_MS); ` +
      `respawn-failed means the actuator itself broke — see EI-12655/EI-12754 for the failure taxonomy.`,
    meta: {
      dedupKind: 'carry-drill-drop',
      subjectSignature: `${alert.drillId}:${alert.kind}`,
      drillId: alert.drillId,
      drillOwnerId: alert.ownerId,
      sessionClass: alert.sessionClass,
      reason: alert.reason,
    },
  });
}

function sweepDeps(overrides: Partial<CarryDrillDropSweepDeps>): CarryDrillDropSweepDeps {
  return {
    readLedger: readColdBootDrillLedger,
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    ...overrides,
  };
}

/**
 * One incremental sweep: scan ledger drops newer than `sinceMs`, escalate each,
 * return the advanced watermark. A failed escalate keeps the OLD watermark so
 * the whole batch retries next tick — the open-escalation (dedupKind,
 * subjectSignature) dedup makes that retry idempotent. Exported for tests.
 */
export async function runCarryDrillDropSweepOnce(
  sinceMs: number,
  overrides: Partial<CarryDrillDropSweepDeps> = {},
): Promise<{ watermarkMs: number; escalated: number; skipped: boolean }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { watermarkMs: sinceMs, escalated: 0, skipped: true };
  const events = await deps.readLedger();
  const { alerts, watermarkMs } = scanCarryDrillDrops(events, sinceMs);
  let escalated = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch {
      // Keep the pre-scan watermark so this row is retried next tick; the
      // escalation-side dedup absorbs any double-fire from the overlap.
      return { watermarkMs: sinceMs, escalated, skipped: false };
    }
  }
  return { watermarkMs, escalated, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the carry-drill drop watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.CARRY_DRILL_DROP_WATCHER (checked per tick).
 */
export function startCarryDrillDropWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? CARRY_DRILL_DROP_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let watermarkMs = Date.now() - CARRY_DRILL_DROP_BACKFILL_MS;
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'carry-drill-drop-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runCarryDrillDropSweepOnce(watermarkMs)
        .then((r) => {
          watermarkMs = r.watermarkMs;
        })
        .catch((e) => {
          console.warn(
            `[carry-drill-drop-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    { category: 'watchdog' },
  );
}
