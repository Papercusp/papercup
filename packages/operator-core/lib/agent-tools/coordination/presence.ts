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

import { getOrgPg } from '@papercusp/db-org';
import {
  PgPresenceStore,
  PRESENCE_STALE_MS,
  type PresenceInput,
  type PresenceRecord,
} from '@papercusp/coordination/presence';
import { deriveAgentRole, type AgentIdentity } from './identity';

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

/** List presence records, newest heartbeat first, optionally scoped. */
export async function listPresence(
  opts: { workspaceId?: string | null } = {},
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
