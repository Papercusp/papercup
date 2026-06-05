/**
 * GET /api/admin/commands — list registered admin commands.
 *
 * Ported from app/api/admin/commands/route.ts. `auth: 'public'` —
 * faithful (no prior auth check). The Next `import 'server-only'`
 * poison-pill is dropped: a `defineTool` module is server-only by
 * construction (only the route registry imports it).
 */
import { listCommands } from '../../../admin-commands';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/commands',
  auth: { trust: ['verified', 'trusted'] },
  handler() {
    return Response.json({ commands: listCommands() });
  },
});
