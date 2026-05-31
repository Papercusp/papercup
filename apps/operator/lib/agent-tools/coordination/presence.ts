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
import { ensureCoordPresenceTable } from '@/lib/ensure-schema';
import {
  PgPresenceStore,
  PRESENCE_STALE_MS,
  type PresenceInput,
  type PresenceRecord,
} from '@papercusp/coordination/presence';
import type { AgentIdentity } from './identity';

export { PRESENCE_STALE_MS };
export type { PresenceInput, PresenceRecord };

const store = new PgPresenceStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: ensureCoordPresenceTable,
});

/**
 * Upsert the caller's presence row — "set my presence to exactly this".
 * Always bumps heartbeat_at. Omitted optional fields reset to defaults.
 */
export async function writePresence(
  identity: AgentIdentity,
  input: PresenceInput = {},
): Promise<void> {
  await store.write(identity, input);
}

/** Bump heartbeat_at only — the lightweight turn_start path. No-op if
 *  the row does not exist yet. */
export async function touchHeartbeat(ownerId: string): Promise<void> {
  await store.touchHeartbeat(ownerId);
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
