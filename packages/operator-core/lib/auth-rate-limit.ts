/**
 * Two-bucket auth rate limit (Step E, Tier-2 follow-up arc).
 *
 * The two-bucket ALGORITHM now lives in @papercusp/rate-limit (extracted
 * per papercusp-systems-abstraction-2026-05-29, P-031). This module is the
 * Papercusp host adapter: it supplies a PG-backed `BucketStore` (the exact
 * `harness_shared.auth_rate_limit` SQL kept verbatim), the loopback policy,
 * and the auth-specific key shapes, then re-exports the same public surface
 * the login route + tests already use.
 *
 * Bucket model (unchanged):
 *
 *   (1) SOFT per-IP: 10 attempts / 60s. Refund on successful auth. LOOPBACK
 *       EXEMPT (127.0.0.1, ::1) — the desktop trust boundary lives on
 *       loopback; a sticky-keyboard run on one's own install must not lock
 *       the whole install.
 *
 *   (2) HARD per-(IP, username): 5 failures / 15-min window → 5-min lockout.
 *       NOT refunded. Applies on loopback (username-scoped, so it only locks
 *       the targeted account, never the whole install).
 *
 * Both buckets are PG-backed via `harness_shared.auth_rate_limit` so state
 * survives operator restart. Key shapes: "ip:<addr>" (soft),
 * "user:<addr>:<username>" (hard). Reads GC their own table after 24h.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  createRateLimiter,
  isLoopbackIp,
  DEFAULT_SOFT,
  DEFAULT_HARD,
  DEFAULT_STALE_AFTER_MS,
  type BucketPayload,
  type BucketStore,
  type StoredBucket,
  type RateLimitResult,
} from '@papercusp/rate-limit';

export { isLoopbackIp };
export type { RateLimitResult };

const SOFT_WINDOW_MS = DEFAULT_SOFT.windowMs;
const SOFT_CAPACITY = DEFAULT_SOFT.capacity;
const HARD_WINDOW_MS = DEFAULT_HARD.windowMs;
const HARD_CAPACITY = DEFAULT_HARD.capacity;
const HARD_LOCKOUT_MS = DEFAULT_HARD.lockoutMs;
const STALE_AFTER_MS = DEFAULT_STALE_AFTER_MS;

/**
 * PG-backed BucketStore — the verbatim `harness_shared.auth_rate_limit`
 * SQL the operator has always used, now behind the @papercusp/rate-limit
 * storage seam. `updated_at` is the GC clock (ms epoch).
 */
const pgStore: BucketStore = {
  async read(key: string): Promise<StoredBucket> {
    const { sql } = getOrgPg();
    const rows = await sql<{ payload: BucketPayload; updated_at: string }[]>`
      SELECT payload, updated_at FROM harness_shared.auth_rate_limit WHERE key = ${key} LIMIT 1
    `;
    return rows.length === 0 ? null : (rows[0].payload as StoredBucket);
  },
  async write(key: string, payload: BucketPayload): Promise<void> {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.auth_rate_limit (key, payload, updated_at)
      VALUES (${key}, ${JSON.stringify(payload)}::text::jsonb, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET
        payload    = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
    `;
  },
  async delete(key: string): Promise<void> {
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.auth_rate_limit WHERE key = ${key}`;
  },
  async gcStale(olderThanMs: number): Promise<void> {
    try {
      const { sql } = getOrgPg();
      await sql`DELETE FROM harness_shared.auth_rate_limit WHERE updated_at < ${olderThanMs}`;
    } catch {
      /* GC failures are non-fatal */
    }
  },
  async clearPrefix(prefix: string): Promise<void> {
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.auth_rate_limit WHERE key LIKE ${prefix + '%'}`;
  },
};

const limiter = createRateLimiter({ store: pgStore });

/* ─── Soft per-IP bucket (loopback-exempt) ─── */

export async function checkSoftPerIp(ip: string): Promise<RateLimitResult> {
  if (isLoopbackIp(ip)) return { ok: true };
  return limiter.checkSoft(`ip:${ip}`);
}

export async function refundSoftPerIp(ip: string): Promise<void> {
  if (isLoopbackIp(ip)) return;
  await limiter.refundSoft(`ip:${ip}`);
}

/* ─── Hard per-(IP, username) bucket (applies on loopback) ─── */

export async function checkHardPerUser(ip: string, username: string): Promise<RateLimitResult> {
  if (!username) return { ok: true };
  return limiter.checkHard(`user:${ip}:${username.toLowerCase()}`);
}

export async function burnHardPerUser(ip: string, username: string): Promise<void> {
  if (!username) return;
  await limiter.burnHard(`user:${ip}:${username.toLowerCase()}`);
}

export async function resetHardPerUser(ip: string, username: string): Promise<void> {
  if (!username) return;
  await limiter.resetHard(`user:${ip}:${username.toLowerCase()}`);
}

/* Test seam — clear all buckets matching a prefix. Used by integration tests. */
export async function _clearAllForKeyPrefix(prefix: string): Promise<void> {
  await limiter.clearPrefix(prefix);
}

/* Tunable getters for test/audit visibility. */
export const RATE_LIMIT_CONSTANTS = {
  SOFT_WINDOW_MS,
  SOFT_CAPACITY,
  HARD_WINDOW_MS,
  HARD_CAPACITY,
  HARD_LOCKOUT_MS,
  STALE_AFTER_MS,
} as const;
