/**
 * Per-IP token-bucket rate limiter. In-memory; resets on restart.
 *
 * Two layers of protection because this endpoint is unauthenticated by
 * default (the bearer token is optional — when not set, anyone with the
 * URL can POST):
 *
 *   - capacity:  burst limit per IP (e.g. 30)
 *   - refillPerSecond: steady-state rate (e.g. 1 = 60 reports/min)
 *
 * For a real production deployment, put a CDN or reverse proxy
 * (Cloudflare, Caddy + http.rate_limit, nginx limit_req) in front and
 * make this a belt-and-suspenders backup.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();
const CAPACITY = Number(process.env.PAPERCUSP_TELEMETRY_RL_CAPACITY ?? 30);
const REFILL_PER_SEC = Number(process.env.PAPERCUSP_TELEMETRY_RL_REFILL ?? 1);

export function take(ip: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: CAPACITY, lastRefillMs: now };
    buckets.set(ip, b);
  }
  const elapsedSec = (now - b.lastRefillMs) / 1000;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.lastRefillMs = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterMs: 0 };
  }
  const need = 1 - b.tokens;
  return { ok: false, retryAfterMs: Math.ceil((need / REFILL_PER_SEC) * 1000) };
}

// Periodic eviction so the map doesn't grow without bound for one-shot
// IPs that never come back. Re-fill rate is per-second, so anything
// older than (CAPACITY / REFILL_PER_SEC) seconds is back at full;
// drop it.
const EVICT_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const stale = Date.now() - (CAPACITY / Math.max(0.01, REFILL_PER_SEC)) * 1000;
  for (const [ip, b] of buckets) {
    if (b.lastRefillMs < stale) buckets.delete(ip);
  }
}, EVICT_INTERVAL_MS).unref();
