/**
 * POST /api/admin/spawn-signing/rotate — coarse revocation: rotate the
 * spawn-URL signing key + bump the in-process cache.
 *
 * Ported from app/api/admin/spawn-signing/rotate/route.ts.
 * `auth: { trust: ['trusted'] }`.
 */
import { rotateSpawnSigningKey } from '../../../spawn-signing';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/admin/spawn-signing/rotate',
  auth: { trust: ['trusted'] },
  async handler() {
    try {
      await rotateSpawnSigningKey();
      return Response.json({ ok: true, rotatedAt: new Date().toISOString() });
    } catch (err) {
      return Response.json(
        { error: 'rotate_failed', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});
