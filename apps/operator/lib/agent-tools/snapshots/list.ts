/**
 * snapshots:list — enumerate every published snapshot known to the
 * workspace registry. 5-second TTL cache lives in the underlying
 * `listAllSnapshots()` so repeated calls are cheap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listAllSnapshots } from '@/lib/snapshot-discovery';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'snapshots:list',
  description: 'List every published snapshot known to the workspace registry (id, slug, version, …).',
  capability: 'snapshots:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const snapshots = await listAllSnapshots();
    return { content: [{ type: 'text', text: JSON.stringify({ snapshots }) }] };
  },
});
