/**
 * types.ts — the PresenceStore seam: live agent presence (L1).
 *
 * Kept SEPARATE from CoordEventLog by design (D-009): presence is a
 * mutable single-row-per-owner table (upsert / heartbeat / delete /
 * roster-join), NOT an append-only log. It shares the coord identity
 * vocabulary, not a storage interface.
 *
 * The production impl is PG (`PgPresenceStore`, over an injected PgHandle);
 * `InMemoryPresenceStore` is the test double + swappability proof.
 */

/** A session whose heartbeat is older than this is treated as dead. */
export const PRESENCE_STALE_MS = 10 * 60 * 1000;

/**
 * The identity fields a presence write needs. Structurally satisfied by
 * the host's `AgentIdentity` (which stays host-side). `userId` is
 * roster-derived in PG (ignored on write there) but carried by the
 * in-memory double.
 */
export interface PresenceIdentity {
  ownerId: string;
  ownerLabel: string;
  source: string;
  workspaceId: string | null;
  userId?: string | null;
}

/** Mutable work-state an agent declares about itself. */
export interface PresenceInput {
  intent?: string;
  currentPlanSlug?: string | null;
  currentFiles?: string[];
  host?: string;
  pid?: number | null;
}

export interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  workspaceId: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  host: string;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  /** heartbeat older than PRESENCE_STALE_MS — the session is dead. */
  stale: boolean;
  /** Durable roster field — null for a non-roster (superuser) agent. */
  userId: string | null;
  /** True iff a roster row exists and is revoked. */
  revoked: boolean;
}

export interface PresenceStore {
  /** Upsert the caller's presence row to exactly this state; bumps heartbeat. */
  write(identity: PresenceIdentity, input?: PresenceInput): Promise<void>;
  /** Bump heartbeat only (no-op if the row does not exist). */
  touchHeartbeat(ownerId: string): Promise<void>;
  /** Ensure a row exists + bump heartbeat WITHOUT clobbering a declared
   *  intent/files/plan (unlike write). The read-driven liveness signal —
   *  every coord:inbox read is evidence the agent is alive, so it keeps a
   *  fresh presence row for every active agent even before it declares an
   *  intent. */
  heartbeat(identity: PresenceIdentity): Promise<void>;
  /** Remove the caller's presence row. */
  clear(ownerId: string): Promise<void>;
  /** List presence, newest heartbeat first, optionally scoped to a workspace. */
  list(opts?: { workspaceId?: string | null }): Promise<PresenceRecord[]>;
  /** Read one presence record by owner id, or null. */
  get(ownerId: string): Promise<PresenceRecord | null>;
  /** Delete presence rows whose heartbeat is older than maxAgeMs — true dead
   *  sessions, well past PRESENCE_STALE_MS. Keeps the table from accumulating
   *  hundreds of long-ended sessions (the coord:presence overflow source).
   *  Returns the number of rows removed. */
  sweepStale(maxAgeMs: number): Promise<number>;
}
