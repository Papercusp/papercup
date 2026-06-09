/**
 * GET /api/snapshots
 *
 * Lists all snapshots across all harnesses.
 *
 * Ported from app/api/snapshots/route.ts. `auth: 'public'` — flag-gated.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '../../../require-flag';
import { listAllSnapshots } from '../../../snapshot-discovery';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/snapshots',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
    if (blocked) return blocked;
    const all = await listAllSnapshots();
    return Response.json({
      snapshots: all.map((s) => ({
        id: s.id,
        harnessSlug: s.harnessSlug,
        bytes: s.bytes,
        createdAtMs: s.createdAtMs,
        name: s.manifest.name,
        description: s.manifest.description ?? null,
        template: s.manifest.template,
        filesCount: s.manifest.files.length,
        excludedCount: s.manifest.excluded.length,
        pluginsCount: s.manifest.plugins.length,
        partial: s.manifest.partial,
        license: s.manifest.license,
        redactions: s.manifest.redactions,
        publishes: s.publishes,
      })),
    });
  },
});
