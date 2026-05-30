/**
 * Tiny in-memory per-IP rate limiter middleware.
 *
 * Token-bucket: each IP gets `capacity` tokens that refill at `refillPerSec`
 * tokens per second. Each request consumes 1 token. Empty bucket → 429.
 *
 * In-memory means it doesn't survive process restart and isn't shared
 * across replicas — fine for single-process dev / single-instance prod.
 * Swap for Redis if/when papercup goes multi-instance.
 *
 * `pollThrottle` is the same idea but stricter and per (IP, key) — for
 * dashboard endpoints that the UI polls in tight loops.
 */
import type { Context, Next } from 'hono';

type Bucket = { tokens: number; lastRefillMs: number };

interface LimiterOptions {
  capacity: number;        // burst size
  refillPerSec: number;    // sustained rate
  keyer?: (c: Context) => string;  // override IP-based keying
  nameForLog?: string;     // logged on 429
}

function takeToken(map: Map<string, Bucket>, key: string, opts: LimiterOptions): boolean {
  const now = Date.now();
  const b = map.get(key) ?? { tokens: opts.capacity, lastRefillMs: now };
  // Refill since last touch
  const elapsedSec = (now - b.lastRefillMs) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
  b.lastRefillMs = now;
  if (b.tokens < 1) {
    map.set(key, b);
    return false;
  }
  b.tokens -= 1;
  map.set(key, b);
  return true;
}

function clientIp(c: Context): string {
  // Prefer X-Forwarded-For (left-most), fall back to direct
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = c.req.header('x-real-ip');
  if (xri) return xri.trim();
  // Hono on Next.js doesn't surface the raw socket address conveniently;
  // bucket all unknown sources together (worst case: shared bucket for
  // requests that lack the headers — fine for dev).
  return 'unknown';
}

const PER_IP_BUCKETS = new Map<string, Bucket>();

/**
 * Generic per-IP rate limit. Default: 60 requests / 30s sustained
 * (capacity 60, refill 2/s) — comfortably above any real human use,
 * trips on a runaway loop or scraper.
 */
export function rateLimit(opts: Partial<LimiterOptions> = {}) {
  const merged: LimiterOptions = {
    capacity: opts.capacity ?? 60,
    refillPerSec: opts.refillPerSec ?? 2,
    keyer: opts.keyer ?? clientIp,
    nameForLog: opts.nameForLog ?? 'rate-limit',
  };
  return async (c: Context, next: Next) => {
    const key = merged.keyer!(c);
    if (!takeToken(PER_IP_BUCKETS, key, merged)) {
      // eslint-disable-next-line no-console
      console.warn(`[${merged.nameForLog}] 429 for ${key} on ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'rate limited' }, 429, {
        'retry-after': '5',
      });
    }
    await next();
  };
}

const POLL_BUCKETS = new Map<string, Bucket>();

/**
 * Poll throttle for endpoints the UI hits in tight setInterval loops.
 * Stricter than the generic limiter — caps a single (IP, endpoint) at
 * ~1 req/sec sustained with a small burst, so a runaway client polling
 * every 100ms gets pushed back to 1Hz.
 */
export function pollThrottle(endpointName: string, opts: Partial<LimiterOptions> = {}) {
  const merged: LimiterOptions = {
    capacity: opts.capacity ?? 4,        // 4-request burst
    refillPerSec: opts.refillPerSec ?? 1, // 1/s sustained
    keyer: opts.keyer ?? ((c) => `${clientIp(c)}::${endpointName}`),
    nameForLog: opts.nameForLog ?? `poll-throttle:${endpointName}`,
  };
  return async (c: Context, next: Next) => {
    const key = merged.keyer!(c);
    if (!takeToken(POLL_BUCKETS, key, merged)) {
      // eslint-disable-next-line no-console
      console.warn(`[${merged.nameForLog}] 429 for ${key} on ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'poll throttled — back off' }, 429, {
        'retry-after': '2',
      });
    }
    await next();
  };
}
