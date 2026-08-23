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
 * EI-18168050721107453 extends that SAME timer across production carry-respawns.
 * Production outcomes live in per-owner host ledgers rather than the shared
 * drill ledger. The watchdog reads only recently-modified bounded tails and
 * alarms when fewer than half of at least 20 terminal outcomes in the trailing
 * hour delivered their carry. The metric is deliberately terminal-outcome based:
 * `respawned` is written BEFORE first-prompt injection, so counting it beside a
 * later dropped row would double-count one attempt and overstate success.
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
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  readColdBootDrillLedger,
  scanCarryDrillDrops,
  type CarryDrillDropAlert,
  type ColdBootDrillLedgerEvent,
} from '../cold-boot-drill-live';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  PSU_PTY_DIR,
  readHostEventTail,
  type PtyHostEvent,
} from '../events/await/psu-pty-discovery';

export const CARRY_DRILL_DROP_SWEEP_INTERVAL_MS = 60_000;
/** How far back the first tick after boot looks — covers a restart gap without
 *  re-alerting the whole ledger (open-escalation dedup absorbs any overlap). */
export const CARRY_DRILL_DROP_BACKFILL_MS = 15 * 60_000;

export const PRODUCTION_CARRY_WINDOW_MS = 60 * 60_000;
export const PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES = 20;
export const PRODUCTION_CARRY_DELIVERY_RATE_FLOOR = 0.5;
/** The host writer caps each per-owner ledger at 256 KiB. Reading that same
 *  ceiling makes the watchdog bounded without discarding rows the writer still
 *  retains from a busy trailing hour. */
export const PRODUCTION_CARRY_SCAN_TAIL_BYTES = 256 * 1024;

const HOST_EVENT_SUFFIX = '.events.jsonl';
const SHARED_DRILL_LEDGER = 'carry-drills.events.jsonl';

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

export interface ProductionCarryDeliveryReading {
  windowStartMs: number;
  windowEndMs: number;
  delivered: number;
  dropped: number;
  respawnFailed: number;
  terminalOutcomes: number;
  /** `null` means the window had no terminal outcomes, not a 0% delivery rate. */
  deliveryRate: number | null;
  failureReasons: Record<string, number>;
}

export interface ProductionCarryDeliverySweepDeps {
  readEvents: (now: number, windowMs: number) => Promise<PtyHostEvent[]>;
  escalate: (reading: ProductionCarryDeliveryReading) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
  windowMs: number;
  minTerminalOutcomes: number;
  deliveryRateFloor: number;
}

function eventTimeMs(event: PtyHostEvent): number | null {
  if (typeof event.ts !== 'string') return null;
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Summarize production carry-respawn TERMINAL outcomes in one trailing window.
 *
 * `respawned` is intentionally absent. The host writer emits it after the new
 * child spawns but before carry injection; every such row can later be followed
 * by either delivered or dropped. The honest attempt-level numerator and
 * denominator are therefore the mutually-exclusive terminal rows below.
 */
export function summarizeProductionCarryDelivery(
  events: readonly PtyHostEvent[],
  now: number = Date.now(),
  windowMs: number = PRODUCTION_CARRY_WINDOW_MS,
): ProductionCarryDeliveryReading {
  const windowStartMs = now - windowMs;
  let delivered = 0;
  let dropped = 0;
  let respawnFailed = 0;
  const failureReasons = new Map<string, number>();

  for (const event of events) {
    const ts = eventTimeMs(event);
    if (ts == null || ts < windowStartMs || ts > now || event.mode !== 'carry-respawn') continue;

    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (kind === 'respawn-carry-delivered') {
      delivered += 1;
      continue;
    }
    if (kind !== 'respawn-carry-dropped' && kind !== 'respawn-failed') continue;

    const reason =
      typeof event.reason === 'string' && event.reason.trim() ? event.reason.trim() : 'unknown';
    const reasonKey = kind === 'respawn-failed' ? `respawn-failed:${reason}` : reason;
    failureReasons.set(reasonKey, (failureReasons.get(reasonKey) ?? 0) + 1);
    if (kind === 'respawn-carry-dropped') dropped += 1;
    else respawnFailed += 1;
  }

  const terminalOutcomes = delivered + dropped + respawnFailed;
  return {
    windowStartMs,
    windowEndMs: now,
    delivered,
    dropped,
    respawnFailed,
    terminalOutcomes,
    deliveryRate: terminalOutcomes > 0 ? delivered / terminalOutcomes : null,
    failureReasons: Object.fromEntries([...failureReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Read recently-modified per-owner event ledgers, bounded to the writer's own
 * 256 KiB cap. The shared drill ledger is excluded: some production drop rows
 * are mirrored there for drill-report compatibility and would be double-counted.
 */
export function readRecentProductionCarryEvents(
  dir: string = PSU_PTY_DIR,
  now: number = Date.now(),
  windowMs: number = PRODUCTION_CARRY_WINDOW_MS,
  maxBytes: number = PRODUCTION_CARRY_SCAN_TAIL_BYTES,
): PtyHostEvent[] {
  const cutoff = now - windowMs;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const events: PtyHostEvent[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(HOST_EVENT_SUFFIX) ||
      entry.name === SHARED_DRILL_LEDGER
    ) {
      continue;
    }
    try {
      if (statSync(join(dir, entry.name)).mtimeMs < cutoff) continue;
    } catch {
      continue;
    }
    const ownerId = entry.name.slice(0, -HOST_EVENT_SUFFIX.length);
    events.push(...readHostEventTail(ownerId, dir, maxBytes));
  }
  return events;
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

async function defaultEscalateProduction(reading: ProductionCarryDeliveryReading): Promise<void> {
  const rate = Math.round((reading.deliveryRate ?? 0) * 100);
  const reasons = Object.entries(reading.failureReasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'major',
    summary:
      `Production carry delivery fell to ${rate}% ` +
      `(${reading.delivered}/${reading.terminalOutcomes}) in the trailing hour`,
    body:
      `Across production carry-respawns in ~/.papercusp/psu-pty/*.events.jsonl, ` +
      `${reading.delivered}/${reading.terminalOutcomes} terminal outcomes delivered their ` +
      `carry in the trailing hour (${rate}%; alarm floor ` +
      `${Math.round(PRODUCTION_CARRY_DELIVERY_RATE_FLOOR * 100)}%, minimum sample ` +
      `${PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES}). Failures: ${reasons || 'none classified'}.\n\n` +
      `Metric definition: delivered / (delivered + dropped + respawn-failed). ` +
      `Do not substitute respawned / (respawned + dropped): the host writes respawned ` +
      `before first-prompt injection, so that formula double-counts an attempt that later drops. ` +
      `Triage the dominant reason in the per-owner ledgers and the psu-host/busy-gate path. ` +
      `Background: EI-18168050721107453 / WI-5623.`,
    meta: {
      dedupKind: 'production-carry-delivery-rate',
      subjectSignature: 'rolling-60m',
      delivered: reading.delivered,
      dropped: reading.dropped,
      respawnFailed: reading.respawnFailed,
      terminalOutcomes: reading.terminalOutcomes,
      deliveryRate: reading.deliveryRate,
      failureReasons: reading.failureReasons,
      windowStartMs: reading.windowStartMs,
      windowEndMs: reading.windowEndMs,
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

function productionSweepDeps(
  overrides: Partial<ProductionCarryDeliverySweepDeps>,
): ProductionCarryDeliverySweepDeps {
  return {
    readEvents: async (now, windowMs) => readRecentProductionCarryEvents(PSU_PTY_DIR, now, windowMs),
    escalate: defaultEscalateProduction,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    windowMs: PRODUCTION_CARRY_WINDOW_MS,
    minTerminalOutcomes: PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES,
    deliveryRateFloor: PRODUCTION_CARRY_DELIVERY_RATE_FLOOR,
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

/** One rolling-window production carry-health sweep. Exported for focused tests. */
export async function runProductionCarryDeliverySweepOnce(
  overrides: Partial<ProductionCarryDeliverySweepDeps> = {},
): Promise<{ reading: ProductionCarryDeliveryReading | null; escalated: boolean; skipped: boolean }> {
  const deps = productionSweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { reading: null, escalated: false, skipped: true };

  const now = deps.now();
  const reading = summarizeProductionCarryDelivery(
    await deps.readEvents(now, deps.windowMs),
    now,
    deps.windowMs,
  );
  const breached =
    reading.terminalOutcomes >= deps.minTerminalOutcomes &&
    reading.deliveryRate != null &&
    reading.deliveryRate < deps.deliveryRateFloor;
  if (!breached) return { reading, escalated: false, skipped: false };

  await deps.escalate(reading);
  return { reading, escalated: true, skipped: false };
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
      void (async () => {
        try {
          const result = await runCarryDrillDropSweepOnce(watermarkMs);
          watermarkMs = result.watermarkMs;
        } catch (e) {
          console.warn(
            `[carry-drill-drop-watchdog] drill sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          await runProductionCarryDeliverySweepOnce();
        } catch (e) {
          console.warn(
            `[carry-drill-drop-watchdog] production sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })()
        .finally(() => {
          sweeping = false;
        });
    },
    { category: 'watchdog' },
  );
}
