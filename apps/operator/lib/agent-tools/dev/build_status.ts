/**
 * dev:build_status — local-host build + service reachability check.
 *
 * Reads .next mtime, tails the prod log, and probes :3055 / :3070.
 * Used by the /dev right rail and the future Build block.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildStatus } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:build_status',
  description: 'Local-host build mtime + bin/prod log tail + dev/prod server reachability.',
  capability: 'intel:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({}),
  async handler() {
    const result = await buildStatus();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
