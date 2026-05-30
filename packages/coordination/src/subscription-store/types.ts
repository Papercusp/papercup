/**
 * types.ts — the SubscriptionStore seam: per-watcher path/glob watches (L3 #5).
 *
 * Under the fs design a watch was an append-only `subscribe`/`unsubscribe`
 * line pair folded on read; under PG it is a MUTABLE row (insert on watch,
 * set `cancelled_at` on unwatch), so this is its own seam — not the
 * CoordEventLog (D-009, coord-channels-pg-port Q-2). The pure glob matcher
 * stays in `@papercusp/coordination/core`; this seam is only persistence.
 *
 * The host owns identity + the clock (it passes `created_ts`/`expires_ts`),
 * matching how the event log takes a fully-formed envelope. The production
 * impl is PG (`PgSubscriptionStore`); `InMemorySubscriptionStore` is the
 * test double + swappability proof (coord-channels-pg-port P-003).
 */

export interface SubscriptionRecord {
  msg_id: string;
  owner_id: string;
  pattern: string;
  trigger: string;
  /** ISO-8601 — when the watch was created. */
  created_ts: string;
  /** ISO-8601 expiry, or null for a watch that never expires. */
  expires_ts: string | null;
}

export interface AddSubscriptionInput {
  msg_id: string;
  owner_id: string;
  pattern: string;
  trigger: string;
  /** ISO-8601 create time (host clock — kept host-side like the envelope ts). */
  created_ts: string;
  expires_ts?: string | null;
}

export interface SubscriptionStore {
  /** Register a watch. */
  add(sub: AddSubscriptionInput): Promise<void>;
  /** Cancel one of `ownerId`'s watches by its `msg_id` (idempotent). */
  cancel(ownerId: string, msgId: string): Promise<void>;
  /**
   * Active watches — not cancelled and not past `expires_ts` as of now —
   * optionally one owner, sorted by `(created_ts, msg_id)`.
   */
  listActive(opts?: { owner?: string }): Promise<SubscriptionRecord[]>;
}
