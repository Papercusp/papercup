/**
 * presence.ts — operator host adapter for the L1 liveness layer.
 *
 * The store implementation (upsert / heartbeat / delete / roster-join
 * over harness_shared.coord_presence + power_user_sessions) lives in
 * @papercusp/coordination/presence's PgPresenceStore; here we wire its
 * two host seams — the org PG handle and the table bootstrap — and keep
 * the original function surface so all callers + the /api/coord route
 * are unchanged.
 *
 * agent-coordination-architecture-v2 §4.2. Held locks are intentionally
 * NOT stored here — they live in the separate papercusp_su DB.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  PgPresenceStore,
  PRESENCE_STALE_MS,
  type PresenceInput,
  type PresenceRecord,
} from '@papercusp/coordination/presence';
import { deriveAgentRole, deriveFleetMembership, type AgentIdentity } from './identity';
import { writeSessionBrief } from '../../session-brief';

export { PRESENCE_STALE_MS };
export type { PresenceInput, PresenceRecord };

const store = new PgPresenceStore({
  getSql: () => getOrgPg().sql,
  // Tables are defined by the migration baseline now; the host seam is a no-op.
  ensureSchema: async () => {},
});

/**
 * Upsert the caller's presence row — "set my presence to exactly this".
 * Always bumps heartbeat_at AND last_active_at (a declared write is genuine
 * activity, D-003). Resolves the populate-once scalars agentRole (D-004, from
 * the identity) + hiveSlug (from `harnessSlug` via hiveHomeSlugForHarness) when
 * the caller hasn't already set them. Omitted optional fields reset to defaults.
 */
export async function writePresence(
  identity: AgentIdentity,
  input: PresenceInput = {},
  harnessSlug?: string | null,
): Promise<void> {
  const agentRole = input.agentRole ?? deriveAgentRole(identity);
  let hiveSlug = input.hiveSlug ?? null;
  if (hiveSlug == null && harnessSlug) {
    try {
      const { hiveHomeSlugForHarness } = await import('../../hive-federation');
      hiveSlug = await hiveHomeSlugForHarness(identity.workspaceId ?? 'default', harnessSlug);
    } catch {
      hiveSlug = null; // best-effort: presence must write even if hive lookup fails
    }
  }
  await store.write(identity, { ...input, agentRole, hiveSlug });

  // Fleet membership (named-su-agent-fleets-2026-06-29 P-005): the SOFT presence label,
  // sourced from env at registration (PAPERCUSP_FLEET_SLUG / PAPERCUSP_FLEET_ROLE), the
  // per-agent mirror of hive_slug. The @papercusp/coordination store SELECT/INSERT does
  // not touch the fleet columns, so a follow-up FILL-IF-ABSENT update sets them here
  // (mig 407 added fleet_slug/fleet_role to coord_presence). COALESCE(existing, env)
  // means: the first declared write populates them, every later declare/heartbeat
  // PRESERVES them (like hive_slug's populate-once-then-keep), and a leader role a
  // handoff (P-007) promoted this row to is never clobbered back to the env default.
  // Only runs when the process actually carries a fleet, so non-fleet agents pay nothing.
  const { fleetSlug, fleetRole } = deriveFleetMembership();
  if (fleetSlug) {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.coord_presence
         SET fleet_slug = COALESCE(fleet_slug, ${fleetSlug}),
             fleet_role = COALESCE(fleet_role, ${fleetRole})
       WHERE owner_id = ${identity.ownerId}
    `;
  }

  // WI-573 (honest-presence): a declared presence write is GENUINE activity — so if this owner's
  // adv_sessions row still carries a stale `ended_at` from a PRIOR incarnation (resumed via a path
  // that never re-POSTed bootstrap-su, e.g. harness compaction), clear it now so a LIVE agent never
  // reads as `ended`. Generalizes psu-launcher's `reportSessionResumed` (psu --resume only) to ANY
  // resume. Fully best-effort + idempotent (0-row no-op when already live); never affects the write
  // above or the brief below.
  try {
    const { reactivateAdvSessionByOwner } = await import('../../adv-sessions');
    await reactivateAdvSessionByOwner(identity.ownerId);
  } catch {
    /* best-effort: presence already wrote; honesty-reactivation must never block it */
  }

  // EI-1742: persist a durable successor brief on this write path so the agent's last
  // declared lane survives the coord_presence reaper sweep + abrupt session death
  // (a continuing session reads it instead of doing transcript archaeology). Fully
  // isolated/best-effort — never affects the presence write above.
  await writeSessionBrief(identity, {
    intent: input.intent,
    currentPlanSlug: input.currentPlanSlug,
    currentFiles: input.currentFiles,
    harnessSlug: harnessSlug ?? null,
    hiveSlug,
  });
}

/**
 * EXPLICIT named-fleet membership setter (named-su-agent-fleets-2026-06-29 P-004).
 *
 * `writePresence`'s fleet fill-if-absent (COALESCE(existing, env)) is populate-once-
 * then-keep — it can NEVER OVERWRITE a label, which is exactly what the fleet REGISTRY
 * tools must do: promote the caller to `leader` on create / take-leadership, demote a
 * prior leader to `member`, set `member` on join, or clear both on leave. They go
 * through this AUTHORITATIVE hard UPDATE instead. Pass (null, null) to clear membership.
 * Keyed on (workspace_id, owner_id) — owner_id is the coord_presence PK, workspace_id is
 * the defensive scope guard. No-op (0 rows) when the owner has no presence row, so a
 * dead prior-leader is silently skipped (D-002 demotion only touches a live row).
 */
export async function setPresenceFleet(
  workspaceId: string,
  ownerId: string,
  fleetSlug: string | null,
  fleetRole: string | null,
  sql?: Sql,
): Promise<void> {
  const s = sql ?? getOrgPg().sql;
  await s`
    UPDATE harness_shared.coord_presence
       SET fleet_slug = ${fleetSlug}, fleet_role = ${fleetRole}
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
  `;
}

/** Bump heartbeat_at ONLY — the keepalive path (the 60s supervisor beat). No-op
 *  if the row does not exist. NEVER bumps last_active_at (D-003). */
export async function touchHeartbeat(ownerId: string): Promise<void> {
  await store.touchHeartbeat(ownerId);
}

/** Bump last_active_at AND heartbeat_at — the ACTIVITY path (tool dispatch via
 *  dispatch-heartbeat). No-op if the row does not exist (D-003). */
export async function touchActivity(ownerId: string): Promise<void> {
  await store.touchActivity(ownerId);
}

/** Ensure a presence row + bump heartbeat WITHOUT clobbering a declared
 *  intent — the read-driven liveness signal (piggybacked on coord:inbox).
 *  Makes coord:presence a complete live roster of active agents. */
export async function heartbeatPresence(identity: AgentIdentity): Promise<void> {
  await store.heartbeat(identity);
}

/** Remove the caller's presence row — the session_shutdown path. */
export async function clearPresence(ownerId: string): Promise<void> {
  await store.clear(ownerId);
}

/** List presence records in deterministic ownerId order (P-005), optionally
 *  scoped to a workspace and/or a Hive (hiveSlug — the P-004 hive-scoped read). */
export async function listPresence(
  opts: { workspaceId?: string | null; hiveSlug?: string | null } = {},
): Promise<PresenceRecord[]> {
  return store.list(opts);
}

/** Read one presence record by owner id, or null. */
export async function getPresence(ownerId: string): Promise<PresenceRecord | null> {
  return store.get(ownerId);
}

/** Delete presence rows whose heartbeat is older than maxAgeMs (true dead
 *  sessions). Best-effort GC so the roster doesn't accumulate hundreds of
 *  long-ended rows. Returns rows removed. */
export async function sweepStalePresence(maxAgeMs: number): Promise<number> {
  return store.sweepStale(maxAgeMs);
}
