/**
 * adv-roster.ts — the live "who's active, on what" roster for the /adv
 * Sessions view (plan adv-sessions-live-roster-2026-06-02, P-002).
 *
 * coord_presence is the PRIMARY roster: every active psu agent heartbeats on
 * each tool call (commit d33d07837), so it carries liveness + intent +
 * current_files for the whole fleet — plan-tied and ad-hoc alike. adv_sessions
 * is the ENRICHMENT (plan/role/feature + terminal handles for Focus/Resume),
 * LEFT-joined on coord_owner_id = coord_presence.owner_id (D-001/D-002). An
 * agent with no adv_sessions row (a plain SU shell) still appears; a plan-tied
 * one gets the richer metadata.
 *
 * The DB I/O is a thin wrapper (`mergeRoster`); the merge + liveness logic is
 * pure (`mergeRosterEntries` / `deriveLiveness`) so it unit-tests without PG
 * and without a real clock (now is injected).
 */

import os from 'node:os';
import { listPresence, type PresenceRecord } from './agent-tools/coordination/presence';
import { advSessionsByCoordOwner, type AdvSessionRow } from './adv-sessions';
import { deriveLiveness, LIVE_MS, type Liveness } from './liveness';

// Re-export the liveness primitives (now sourced from the dep-free leaf so the
// client presence UI can share them) for existing importers.
export { deriveLiveness, LIVE_MS };
export type { Liveness };

/**
 * Drop ended adv_sessions whose coord owner is still live in the active
 * roster — that agent is already shown (with richer presence), so listing its
 * ended terminal row too would double-count it. Rows with no coord_owner_id
 * (console/legacy) can't collide, so they always pass. Pure → unit-tested.
 */
export function dedupeEndedAgainstActive(
  ended: AdvSessionRow[],
  active: { ownerId: string }[],
): AdvSessionRow[] {
  const liveOwners = new Set(active.map((a) => a.ownerId));
  return ended.filter((r) => !r.coordOwnerId || !liveOwners.has(r.coordOwnerId));
}

/** A presence row whose workspace is '*' is workspace-agnostic (an unscoped
 *  SU/engineer shell) — it belongs to every workspace's roster. */
export const GLOBAL_WORKSPACE = '*';

/** One agent in the live roster: presence (primary) + adv_sessions enrichment. */
export interface RosterEntry {
  // ── presence (always present — the primary roster) ──
  ownerId: string;
  label: string;
  /** client/source: claude · codex · omp · … */
  source: string;
  intent: string;
  currentFiles: string[];
  host: string;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  liveness: Liveness;
  /** The coord-store's own stale flag (heartbeat older than PRESENCE_STALE_MS). */
  stale: boolean;
  workspaceId: string;
  userId: string | null;
  revoked: boolean;
  /**
   * Is the OS process still alive? true/false only for same-host non-stale
   * entries we could check; null = unknown (different host, no pid, or stale).
   * A non-stale entry with pidAlive===false is a "zombie": fresh heartbeat but
   * the process is gone (P-008).
   */
  pidAlive: boolean | null;
  // ── adv_sessions enrichment (null when no joinable launch row) ──
  hasLaunchRecord: boolean;
  advSessionId: number | null;
  /** Live plan (presence) preferred; falls back to the launch-time plan. */
  currentPlanSlug: string | null;
  role: string | null;
  feature: string | null;
  agent: string | null;
  mode: 'omp' | 'console' | null;
  windowId: string | null;
  ompThreadId: string | null;
  cwd: string | null;
  launchStartedAt: string | null;
}

/**
 * Filter a presence list to a workspace's roster: rows in that workspace PLUS
 * the workspace-agnostic '*' rows (unscoped SU shells). A null workspaceId =
 * the "All" scope → every row.
 */
export function scopePresenceToWorkspace(
  presence: PresenceRecord[],
  workspaceId: string | null | undefined,
): PresenceRecord[] {
  if (workspaceId == null) return presence;
  return presence.filter(
    (p) => p.workspaceId === workspaceId || p.workspaceId === GLOBAL_WORKSPACE,
  );
}

/**
 * Pure merge: presence rows (primary) LEFT-joined to adv_sessions by owner id.
 * Order is preserved (listPresence already returns newest-heartbeat-first).
 */
export function mergeRosterEntries(
  presence: PresenceRecord[],
  advByOwner: Map<string, AdvSessionRow>,
  nowMs: number,
): RosterEntry[] {
  return presence.map((p) => {
    const adv = advByOwner.get(p.ownerId) ?? null;
    return {
      ownerId: p.ownerId,
      label: p.ownerLabel,
      source: p.source,
      intent: p.intent,
      currentFiles: p.currentFiles,
      host: p.host,
      pid: p.pid,
      startedAt: p.startedAt,
      heartbeatAt: p.heartbeatAt,
      liveness: deriveLiveness(p.heartbeatAt, nowMs),
      stale: p.stale,
      workspaceId: p.workspaceId,
      userId: p.userId,
      revoked: p.revoked,
      pidAlive: null, // enriched by mergeRoster for same-host non-stale entries
      hasLaunchRecord: adv != null,
      advSessionId: adv?.id ?? null,
      currentPlanSlug: p.currentPlanSlug ?? adv?.planSlug ?? null,
      role: adv?.role ?? null,
      feature: adv?.feature ?? null,
      agent: adv?.agent ?? null,
      mode: adv?.mode ?? null,
      windowId: adv?.windowId ?? null,
      ompThreadId: adv?.ompThreadId ?? null,
      cwd: adv?.cwd ?? null,
      launchStartedAt: adv?.startedAt ?? null,
    };
  });
}

/**
 * Whether a roster entry's OS process is worth a `process.kill(pid, 0)` probe:
 * it must have a pid, be non-stale (a stale entry is already known-gone, and
 * the probe would only add noise), and live on THIS host (a pid on another
 * machine can't be checked — and could collide with an unrelated local pid).
 * Pure → unit-tested; the probe itself stays in mergeRoster.
 */
export function shouldProbePid(entry: RosterEntry, localHost: string): boolean {
  return (
    entry.pid != null &&
    entry.liveness !== 'stale' &&
    (entry.host === '' || entry.host === localHost)
  );
}

/** Is `pid` a live OS process? Signal 0 = existence check; EPERM = alive-not-ours. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Enrich same-host non-stale entries with `pidAlive` so the UI can flag
 * zombies (fresh heartbeat, dead process). Mutates + returns `entries`.
 * Cheap: a syscall per eligible entry, no actual signal sent.
 */
export function enrichPidLiveness(entries: RosterEntry[], localHost: string): RosterEntry[] {
  for (const e of entries) {
    if (shouldProbePid(e, localHost) && e.pid != null) {
      e.pidAlive = isPidAlive(e.pid);
    }
  }
  return entries;
}

/**
 * The live roster for a workspace (or all workspaces when workspaceId is
 * null/omitted). coord_presence primary + adv_sessions enrichment, liveness
 * derived from the heartbeat, pidAlive probed for same-host non-stale entries.
 * The two reads run concurrently.
 */
export async function mergeRoster(
  opts: { workspaceId?: string | null } = {},
): Promise<RosterEntry[]> {
  const [presenceAll, advByOwner] = await Promise.all([
    listPresence(),
    advSessionsByCoordOwner(),
  ]);
  const presence = scopePresenceToWorkspace(presenceAll, opts.workspaceId ?? null);
  const entries = mergeRosterEntries(presence, advByOwner, Date.now());
  return enrichPidLiveness(entries, os.hostname());
}
