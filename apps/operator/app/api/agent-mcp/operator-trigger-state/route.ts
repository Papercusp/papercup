/**
 * GET /api/agent-mcp/operator-trigger-state — return the workspace's
 * current trigger-state fingerprint. The chrome-resident background
 * scanner polls this and fires a scan when the fingerprint changes
 * (with debounce + max-stall logic).
 */

import { fingerprint, readTriggerState } from '@/lib/operator-trigger-state';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const state = await readTriggerState();
    return Response.json({ fingerprint: fingerprint(state), state });
  } catch (err) {
    return new Response(`trigger-state unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 503,
    });
  }
}
