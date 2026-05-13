/**
 * Two-bucket auth rate limit (Step E, Tier-2 follow-up arc).
 *
 * Bucket model:
 *
 *   (1) SOFT per-IP: 10 attempts / 60s. Refund on successful auth so a
 *       legitimate user isn't penalized for an earlier typo. LOOPBACK
 *       EXEMPT (127.0.0.1, ::1) — the desktop trust boundary lives on
 *       loopback; a sticky-keyboard run on one's own install must not
 *       lock the whole install.
 *
 *   (2) HARD per-(IP, username): 5 failures / 15-min window → 5-min
 *       lockout. Refund DOES NOT happen — the lockout is the protection
 *       signal. Applies on loopback (username-scoped, so it only locks
 *       the targeted account, never the whole install).
 *
 * Both buckets are PG-backed via `harness_shared.auth_rate_limit` so
 * state survives operator restart. Key shapes:
 *   - "ip:<addr>"                 (soft)
 *   - "user:<addr>:<username>"    (hard)
 *
 * Reads garbage-collect their own bucket if the entry is older than 24h.
 */

import { getOrgPg } from '@restart/db-org';

const SOFT_WINDOW_MS = 60_000;
const SOFT_CAPACITY = 10;
const HARD_WINDOW_MS = 15 * 60_000;
const HARD_CAPACITY = 5;
const HARD_LOCKOUT_MS = 5 * 60_000;
const STALE_AFTER_MS = 24 * 60 * 60_000;

interface BucketPayload {
  recent: number[];        // ms timestamps of attempts (soft) or failures (hard)
  lockedUntilMs: number;   // 0 = not locked
}

export interface RateLimitResult {
  ok: boolean;
  retryAfterS?: number;
}

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const trimmed = ip.trim();
  if (trimmed === '127.0.0.1' || trimmed === '::1' || trimmed === 'localhost') return true;
  // x-forwarded-for can be a chain; take the leftmost (origin).
  const leftmost = trimmed.split(',')[0].trim();
  return leftmost === '127.0.0.1' || leftmost === '::1';
}

async function readBucket(key: string): Promise<BucketPayload> {
  const { sql } = getOrgPg();
  const rows = await sql<{ payload: BucketPayload; updated_at: string }>`
    SELECT payload, updated_at FROM harness_shared.auth_rate_limit WHERE key = ${key} LIMIT 1
  `;
  if (rows.length === 0) return { recent: [], lockedUntilMs: 0 };
  const p = rows[0].payload as Partial<BucketPayload> | null;
  return {
    recent: Array.isArray(p?.recent) ? p!.recent.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [],
    lockedUntilMs: typeof p?.lockedUntilMs === 'number' ? p!.lockedUntilMs : 0,
  };
}

async function writeBucket(key: string, payload: BucketPayload): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.auth_rate_limit (key, payload, updated_at)
    VALUES (${key}, ${JSON.stringify(payload)}::jsonb, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET
      payload    = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at
  `;
}

async function deleteBucket(key: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.auth_rate_limit WHERE key = ${key}`;
}

/** Best-effort lazy GC. Removes rows older than 24h. Logs and continues on error. */
async function gcStale(now: number): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`DELETE FROM harness_shared.auth_rate_limit WHERE updated_at < ${now - STALE_AFTER_MS}`;
  } catch {
    /* GC failures are non-fatal */
  }
}

/* ─── Soft per-IP bucket ─── */

export async function checkSoftPerIp(ip: string): Promise<RateLimitResult> {
  if (isLoopbackIp(ip)) return { ok: true };
  const key = `ip:${ip}`;
  const now = Date.now();
  await gcStale(now);
  const bucket = await readBucket(key);
  const cutoff = now - SOFT_WINDOW_MS;
  const recent = bucket.recent.filter((ts) => ts > cutoff);
  if (recent.length >= SOFT_CAPACITY) {
    const oldest = recent[0];
    const retryAfterS = Math.max(1, Math.ceil((oldest + SOFT_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfterS };
  }
  recent.push(now);
  await writeBucket(key, { recent, lockedUntilMs: 0 });
  return { ok: true };
}

export async function refundSoftPerIp(ip: string): Promise<void> {
  if (isLoopbackIp(ip)) return;
  const key = `ip:${ip}`;
  const bucket = await readBucket(key);
  if (bucket.recent.length === 0) return;
  // Pop the most recent attempt (the one we just burned for the success).
  const recent = bucket.recent.slice(0, -1);
  if (recent.length === 0) {
    await deleteBucket(key);
  } else {
    await writeBucket(key, { recent, lockedUntilMs: 0 });
  }
}

/* ─── Hard per-(IP, username) bucket ─── */

export async function checkHardPerUser(ip: string, username: string): Promise<RateLimitResult> {
  if (!username) return { ok: true };
  const key = `user:${ip}:${username.toLowerCase()}`;
  const now = Date.now();
  const bucket = await readBucket(key);
  if (bucket.lockedUntilMs > now) {
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((bucket.lockedUntilMs - now) / 1000)) };
  }
  return { ok: true };
}

export async function burnHardPerUser(ip: string, username: string): Promise<void> {
  if (!username) return;
  const key = `user:${ip}:${username.toLowerCase()}`;
  const now = Date.now();
  const bucket = await readBucket(key);
  const cutoff = now - HARD_WINDOW_MS;
  const recent = bucket.recent.filter((ts) => ts > cutoff);
  recent.push(now);
  const lockedUntilMs = recent.length >= HARD_CAPACITY ? now + HARD_LOCKOUT_MS : 0;
  await writeBucket(key, { recent, lockedUntilMs });
}

export async function resetHardPerUser(ip: string, username: string): Promise<void> {
  if (!username) return;
  const key = `user:${ip}:${username.toLowerCase()}`;
  await deleteBucket(key);
}

/* Test seam — clear all buckets matching a prefix. Used by integration tests. */
export async function _clearAllForKeyPrefix(prefix: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.auth_rate_limit WHERE key LIKE ${prefix + '%'}`;
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
