/**
 * recorded-sessions.ts — synthesize roster rows from the AUTHORITATIVE session
 * log (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * The fleet roster used to be anchored on the SELF-REGISTERED coord_presence
 * table: a session was visible only after it volunteered a coord heartbeat, so a
 * recorded-but-not-yet-registered live session — every console/queen/overwatch,
 * and any interactive session in its launch→first-turn window — was structurally
 * invisible AND undispatchable. This module makes presence a VIEW over the
 * authoritative `adv_sessions` log: for each recorded LIVE session not already
 * present in coord_presence, it projects a `UnifiedPresenceRecord` so the
 * snapshot surfaces it.
 *
 * CLI-AGNOSTIC by construction — it keys on the recorded row + its
 * `coordOwnerId`, never on which agent CLI (claude/codex/omp) backs the session.
 * The join key is uniform across CLIs (claude `s-<ts>-<hex>`, codex/su
 * `su-<uuid>`, …) because it is exactly the id the session later heartbeats
 * under.
 *
 * Pure (rows in → rows out); the IO seam is `listRecordedLiveSessions` in
 * adv-sessions.ts. Each synthesized row is marked `source: RECORDED_SESSION_SOURCE`
 * so the snapshot's wakeability pass renders it as `'recorded'` (authoritatively
 * live, but not inbox-wake-dispatchable) rather than `'ended'` (dead / relaunch).
 */

import type { AdvSessionRow } from '../../adv-sessions';
import type { UnifiedPresenceRecord } from './federated-presence';

/** The `source` marker stamped on a session-log-derived roster row. The snapshot
 *  keys the `'recorded'` session-state (alive but not inbox-wakeable) on this
 *  exact value, so it must match between the producer here and the consumer in
 *  presence-snapshot.ts. */
export const RECORDED_SESSION_SOURCE = 'session-log';

/** A best, human-meaningful label for a recorded session: its launch label,
 *  else its pipeline role, else its CLI, else a generic fallback. */
function recordedLabel(r: AdvSessionRow): string {
  const label = r.label?.trim();
  if (label) return label;
  if (r.role) return r.role;
  if (r.agent) return r.agent;
  return 'session';
}

/**
 * Project the LIVE recorded sessions NOT already in the live roster
 * (`existingOwnerIds` = the coord_presence + federated owner ids) into roster
 * rows. Each becomes a `UnifiedPresenceRecord` keyed by its coord owner id,
 * marked `source: RECORDED_SESSION_SOURCE`, `stale: false` (authoritatively live
 * — its adv_sessions `ended_at IS NULL` is a better liveness signal than
 * heartbeat age). Identity (label/role/workspace/plan/pid) comes from the
 * recorded row.
 *
 * Dedup rules (both matter):
 *  - a row whose owner is ALREADY in `existingOwnerIds` is skipped, so a session
 *    that HAS self-registered keeps its richer coord_presence row (never shadowed);
 *  - within the recorded list, the first row per owner wins (callers pass a
 *    most-recent-first, owner-deduped list, so this is just defence-in-depth).
 *
 * A row with no `coordOwnerId` is skipped (unaddressable — it could never be
 * woken). Pure → unit-tested.
 */
export function synthesizeRecordedRosterRows(
  recorded: readonly AdvSessionRow[],
  existingOwnerIds: ReadonlySet<string>,
): UnifiedPresenceRecord[] {
  const out: UnifiedPresenceRecord[] = [];
  const seen = new Set<string>();
  for (const r of recorded) {
    const ownerId = r.coordOwnerId;
    if (!ownerId) continue; // unaddressable — skip
    if (existingOwnerIds.has(ownerId)) continue; // already self-registered (richer row wins)
    if (seen.has(ownerId)) continue; // dedup within the recorded list
    seen.add(ownerId);
    out.push({
      ownerId,
      ownerLabel: recordedLabel(r),
      workspaceId: r.workspaceId,
      source: RECORDED_SESSION_SOURCE,
      intent: '',
      currentPlanSlug: r.planSlug,
      currentFiles: [],
      host: '',
      pid: r.pid,
      startedAt: r.startedAt,
      // No heartbeat yet — the launch ts is the liveness baseline. `stale:false`
      // below means this never reads as heartbeat-stale (the adv_sessions
      // ended_at IS NULL is the authoritative liveness signal).
      heartbeatAt: r.startedAt,
      lastActiveAt: null,
      agentRole: r.role,
      // adv_sessions carries no hive attribution yet → the synthesized leg is
      // workspace/all-scope only (P-002 adds hive_slug to the recording so the
      // hive-scoped Queen view can include un-self-registered bees too).
      hiveSlug: null,
      stale: false,
      userId: null,
      revoked: false,
      federated: false,
    });
  }
  return out;
}
