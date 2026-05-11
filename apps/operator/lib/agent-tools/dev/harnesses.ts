/**
 * dev:harnesses — cross-workspace harness list with health.
 *
 * Drives the /dev page Harnesses tab. workspaceIds=null = all workspaces.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listAllHarnessesWithHealth } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:harnesses',
  description: 'List harnesses across selected workspaces with health verdict for each.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: ['operator', 'architect'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
  }),
  async handler(args) {
    const result = await listAllHarnessesWithHealth(args.workspaceIds ?? null);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.harnesses.length,
            harnesses: result.harnesses,
          }),
        },
      ],
    };
  },
});
