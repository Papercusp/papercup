/**
 * GET /api/marketplace/spawnable
 *
 * Returns the catalog filtered to entries declaring
 * `spawnable: { kind, requires }` in their manifest. Consumed by the
 * executor's scaffold_harness verb + prompt-build's "Available
 * templates" section.
 *
 * Ported from app/api/marketplace/spawnable/route.ts. `auth: 'public'`.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { getSpawnableTemplates } from '@/lib/spawnable-templates';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/marketplace/spawnable',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
    if (blocked) return blocked;
    const result = await getSpawnableTemplates();
    return Response.json(result);
  },
});
