/**
 * GET /api/agent-mcp/operator-trigger-state — fingerprint poll for chrome scanner.
 * 1s in-process cache.
 * Ported from app/api/agent-mcp/operator-trigger-state/route.ts. `auth: 'public'`.
 */
import { fingerprint, readTriggerState, type TriggerState } from '../../../operator-trigger-state';
import { defineTool } from '@papercusp/agent-mcp';

interface CacheEntry { ts: number; payload: { fingerprint: string; state: TriggerState } }
const CACHE_KEY = '__papercuspTriggerStateCache';
type CacheGlobals = { [CACHE_KEY]?: CacheEntry | null };
const CACHE_TTL_MS = 1000;

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-trigger-state',
  auth: 'public',
  async handler() {
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
  },
});
