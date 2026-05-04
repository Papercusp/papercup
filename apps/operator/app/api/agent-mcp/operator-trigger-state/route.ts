/**
 * GET /api/agent-mcp/operator-trigger-state — return the workspace's
 * current trigger-state fingerprint. The chrome-resident background
 * scanner polls this and fires a scan when the fingerprint changes
 * (with debounce + max-stall logic).
 *
 * Cached for 1 second per process. The underlying read is 4 PG queries
 * (~3-5s in Next.js dev under load) and gets called on every page mount
 * by the chrome-shell scanner; without the cache, a tab open with the
 * scanner running was holding the event loop on this call repeatedly.
 * 1 second is short enough for trigger-state polling to feel real-time,
 * long enough to absorb concurrent same-tick callers. See
 * /docs/performance #A15.
 */

import { fingerprint, readTriggerState, type TriggerState } from '@/lib/operator-trigger-state';

export const dynamic = 'force-dynamic';

interface CacheEntry { ts: number; payload: { fingerprint: string; state: TriggerState } }
const CACHE_KEY = '__papercuspTriggerStateCache';
type CacheGlobals = { [CACHE_KEY]?: CacheEntry | null };
const CACHE_TTL_MS = 1000;

export async function GET() {
  try {
    const g = globalThis as CacheGlobals;
    const now = Date.now();
    const cached = g[CACHE_KEY];
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return Response.json(cached.payload);
    }
    const state = await readTriggerState();
    const payload = { fingerprint: fingerprint(state), state };
    g[CACHE_KEY] = { ts: now, payload };
    return Response.json(payload);
  } catch (err) {
    return new Response(`trigger-state unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 503,
    });
  }
}
