/**
 * Rate-limit state for /api/operator/conversations/:id/card-response.
 *
 * Sliding window per identity key. We bucket on session userId rather
 * than caller-supplied workspaceId (audit: a malicious caller could
 * vary workspaceId per request to bypass the limit).
 *
 * Lives in its own module so the Next.js route file only exports HTTP
 * methods + the `dynamic`/`runtime` config exports — Next warns on
 * extra exports from route files.
 */

const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 30;

interface RateBucket {
  /** Wall-clock ms timestamps within the window. */
  ts: number[];
}

const __SYM = Symbol.for('papercusp.cardResponseRateLimiter');
type RateGlobals = typeof globalThis & {
  [__SYM]?: Map<string /* userId */, RateBucket>;
};

function buckets(): Map<string, RateBucket> {
  const g = globalThis as RateGlobals;
  if (!g[__SYM]) g[__SYM] = new Map();
  return g[__SYM]!;
}

/** Returns true when the request should proceed; false when 429. */
export function cardResponseRateAllow(identityKey: string): boolean {
  const now = Date.now();
  const m = buckets();
  let b = m.get(identityKey);
  if (!b) {
    b = { ts: [] };
    m.set(identityKey, b);
  }
  while (b.ts.length > 0 && now - b.ts[0] > RATE_WINDOW_MS) {
    b.ts.shift();
  }
  if (b.ts.length >= RATE_LIMIT) return false;
  b.ts.push(now);
  return true;
}

/** Test-only: clear all buckets. */
export function _resetCardResponseRateLimitForTests(): void {
  buckets().clear();
}

export const CARD_RESPONSE_RATE_LIMIT = RATE_LIMIT;
export const CARD_RESPONSE_RATE_WINDOW_MS = RATE_WINDOW_MS;
