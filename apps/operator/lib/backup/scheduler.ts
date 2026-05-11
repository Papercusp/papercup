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

import { getOrgPg } from '@restart/db-org';
import { workspaceBackupFor } from './singleton';
import type { SnapshotTriggerReason } from './types';

const TICK_MS = 60_000;

interface WorkspaceTickState {
  lastFiredAt: number;
  inFlight: boolean;
}
const STATE = new Map<string, WorkspaceTickState>();

let timer: NodeJS.Timeout | null = null;

export function startBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // Run one immediate tick so a freshly-started operator catches up.
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
    const rows = await sql<{
      workspace_id: string; enabled: boolean; cadence_mode: string; cadence_minutes: number;
    }[]>`
      SELECT workspace_id, enabled, cadence_mode, cadence_minutes
      FROM harness_shared.workspace_backup_settings
      WHERE enabled = TRUE AND cadence_mode IN ('interval', 'both')
    `;
    const now = Date.now();
    for (const r of rows) {
      const s = STATE.get(r.workspace_id) ?? { lastFiredAt: 0, inFlight: false };
      const dueAt = s.lastFiredAt + r.cadence_minutes * 60_000;
      if (s.inFlight) continue;
      if (now < dueAt) continue;
      s.inFlight = true;
      s.lastFiredAt = now;
      STATE.set(r.workspace_id, s);
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
