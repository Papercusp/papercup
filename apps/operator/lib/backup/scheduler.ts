/**
 * Backup scheduler — interval timer + event trigger entry point.
 *
 * Single in-process timer that wakes every minute, checks each enabled
 * workspace's settings, and fires `snapshot('interval')` if its
 * cadence is due. Per-workspace state (lastFiredAt, in-flight bool)
 * lives in this module's Map; nothing crash-survives, so on operator
 * restart the next due cycle fires immediately.
 *
 * `triggerEvent(workspaceId, reason, context)` is the public hook for
 * event-driven snapshots — call it from pre-destructive code paths,
 * post-run completion, plugin install, secret change. The function
 * checks the workspace's event_triggers_json setting before firing so
 * users can opt individual triggers off without touching the call
 * sites.
 *
 * Idempotency: at most one snapshot per workspace in-flight at any
 * moment. Calls during a running snapshot are dropped silently (logged
 * to backup_events for the UI).
 */

import { spawnSync } from 'node:child_process';
import { getOrgPg } from '@restart/db-org';
import { workspaceBackupFor } from './singleton';
import type { SnapshotTriggerReason } from './types';

const TICK_MS = 60_000;
const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

/** Detect whether kopia is on $PATH at scheduler start. Surface a clear log */
/** so the operator's startup messages explain "no snapshots yet" cleanly. */
function detectKopia(): { ok: boolean; version?: string; reason?: string } {
  try {
    const r = spawnSync(KOPIA_BIN, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) {
      return { ok: true, version: r.stdout.split(/\s+/)[0] };
    }
    return { ok: false, reason: r.stderr?.trim() || `exit ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

let kopiaDetection: { ok: boolean; version?: string; reason?: string } | null = null;
export function getKopiaDetection(): { ok: boolean; version?: string; reason?: string } {
  return kopiaDetection ?? detectKopia();
}

interface WorkspaceTickState {
  lastFiredAt: number;
  inFlight: boolean;
}
const STATE = new Map<string, WorkspaceTickState>();

let timer: NodeJS.Timeout | null = null;

export function startBackupScheduler(): void {
  if (timer) return;
  kopiaDetection = detectKopia();
  if (!kopiaDetection.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[backup-scheduler] kopia not on PATH (${kopiaDetection.reason}); snapshots disabled. Install kopia or set KOPIA_BIN.`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[backup-scheduler] kopia ${kopiaDetection.version} detected; cadence tick every ${TICK_MS / 1000}s`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void tick();
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  try {
    const { sql } = getOrgPg();
    // Join settings with most-recent snapshot start time so we use a
    // persistent floor for cadence — restarting the operator doesn't
    // re-fire snapshots that just ran in the previous process.
    const rows = await sql<{
      workspace_id: string; cadence_minutes: number; last_started_at: Date | null;
    }[]>`
      SELECT s.workspace_id,
             s.cadence_minutes,
             MAX(snap.started_at) AS last_started_at
      FROM harness_shared.workspace_backup_settings s
      LEFT JOIN harness_shared.backup_snapshots snap
             ON snap.workspace_id = s.workspace_id
      WHERE s.enabled = TRUE AND s.cadence_mode IN ('interval', 'both')
      GROUP BY s.workspace_id, s.cadence_minutes
    `;
    const now = Date.now();
    for (const r of rows) {
      const mem = STATE.get(r.workspace_id) ?? { lastFiredAt: 0, inFlight: false };
      // Use the larger of in-memory and PG — in-memory wins after a
      // local fire (avoids extra PG round-trip), PG wins after a process
      // restart.
      const pgFloor = r.last_started_at ? r.last_started_at.getTime() : 0;
      const lastFiredAt = Math.max(mem.lastFiredAt, pgFloor);
      const dueAt = lastFiredAt + r.cadence_minutes * 60_000;
      if (mem.inFlight) continue;
      if (now < dueAt) continue;
      const next: WorkspaceTickState = { lastFiredAt: now, inFlight: true };
      STATE.set(r.workspace_id, next);
      void runSnapshot(r.workspace_id, 'interval', undefined)
        .finally(() => {
          const cur = STATE.get(r.workspace_id);
          if (cur) cur.inFlight = false;
        });
    }
  } catch (err) {
    console.warn('[backup-scheduler] tick failed:', err);
  }
}

async function runSnapshot(
  workspaceId: string,
  reason: SnapshotTriggerReason,
  context: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const wb = workspaceBackupFor(workspaceId);
    const settings = await wb.getSettings();
    if (!settings.enabled) return;
    // Event triggers — gate by per-workspace setting.
    if (reason !== 'interval' && reason !== 'manual' && reason !== 'startup'
        && !settings.eventTriggers.includes(reason)) {
      return;
    }
    await wb.snapshot(reason, context);
  } catch (err) {
    console.warn(`[backup-scheduler] snapshot ${reason} for ${workspaceId} failed:`, err);
  }
}

/**
 * Event-driven snapshot trigger. Safe to call from anywhere; dedupes
 * to at most one in-flight per workspace, respects per-workspace
 * event_triggers setting.
 */
export async function triggerSnapshotEvent(
  workspaceId: string,
  reason: Exclude<SnapshotTriggerReason, 'interval' | 'manual'>,
  context?: Record<string, unknown>,
): Promise<void> {
  const s = STATE.get(workspaceId) ?? { lastFiredAt: 0, inFlight: false };
  if (s.inFlight) return;
  s.inFlight = true;
  STATE.set(workspaceId, s);
  try {
    await runSnapshot(workspaceId, reason, context);
  } finally {
    const cur = STATE.get(workspaceId);
    if (cur) cur.inFlight = false;
  }
}
