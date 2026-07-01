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
  /** Durable role (human/su/bee/principal/…), resolved host-side. Preserved on
   *  a later write that omits it (so it's a populate-once-then-keep field). */
  agentRole?: string | null;
  /** The agent's home Hive slug, resolved host-side (null = standalone). Also
   *  preserved across writes that omit it. */
  hiveSlug?: string | null;
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
  /** Last GENUINE-activity timestamp (tool dispatch / declare-intent / inbox) —
   *  distinct from heartbeatAt, which the 60s keepalive bumps (D-003). null
   *  until the row's first activity write (pre-existing rows). */
  lastActiveAt: string | null;
  /** Durable agent role (human/su/bee/principal/…). null when unresolved. */
  agentRole: string | null;
  /** The agent's home Hive slug (null = standalone / no hive). */
  hiveSlug: string | null;
  /** Per-session SOFT compaction limit in tokens (agent-managed-compaction).
   *  null/undefined ⇒ use the per-model default. Set via config:set-compaction-limit.
   *  Optional: only the PG store (live presence) carries it; roster/snapshot
   *  transforms may omit it. */
  compactionLimit?: number | null;
  /** Cached context-size estimate in tokens + when it was taken. The
   *  compaction-compliance watchdog writes these on a cadence (off the hot path);
   *  the coord:inbox usage signal reads them vs compactionLimit. */
  contextTokens?: number | null;
  contextEstimatedAt?: string | null;
  /** heartbeat older than PRESENCE_STALE_MS — the session is dead. */
  stale: boolean;
  /** Durable roster field — null for a non-roster (superuser) agent. */
  userId: string | null;
  /** True iff a roster row exists and is revoked. */
  revoked: boolean;
}

export interface PresenceStore {
  /** Upsert the caller's presence row to exactly this state; bumps heartbeat
   *  AND last_active_at (a write is genuine activity). */
  write(identity: PresenceIdentity, input?: PresenceInput): Promise<void>;
  /** Bump heartbeat ONLY (no-op if the row does not exist) — the keepalive
   *  path. last_active_at is deliberately NOT touched (D-003): the 60s
   *  supervisor beat means "process alive", not "active". */
  touchHeartbeat(ownerId: string): Promise<void>;
  /** Bump last_active_at AND heartbeat (no-op if the row does not exist) — the
   *  ACTIVITY path (e.g. tool dispatch). The genuine-activity counterpart of
   *  touchHeartbeat (D-003). */
  touchActivity(ownerId: string): Promise<void>;
  /** Ensure a row exists + bump heartbeat WITHOUT clobbering a declared
   *  intent/files/plan (unlike write). The read-driven liveness signal —
   *  every coord:inbox read is evidence the agent is alive, so it keeps a
   *  fresh presence row for every active agent even before it declares an
   *  intent. */
  heartbeat(identity: PresenceIdentity): Promise<void>;
  /** Remove the caller's presence row. */
  clear(ownerId: string): Promise<void>;
  /** List presence in deterministic ownerId order (presence-v2 P-005 / D-006 —
   *  cache- and diff-stable), optionally scoped to a workspace and/or a Hive
   *  (hiveSlug — the P-004 hive-scoped read; null/omitted = no hive filter). */
  list(opts?: { workspaceId?: string | null; hiveSlug?: string | null }): Promise<PresenceRecord[]>;
  /** Read one presence record by owner id, or null. */
  get(ownerId: string): Promise<PresenceRecord | null>;
  /** Delete presence rows whose heartbeat is older than maxAgeMs — true dead
   *  sessions, well past PRESENCE_STALE_MS. Keeps the table from accumulating
   *  hundreds of long-ended sessions (the coord:presence overflow source).
   *  Returns the number of rows removed. */
  sweepStale(maxAgeMs: number): Promise<number>;
}
