/**
 * dev:telemetry — cross-workspace tool-invocation rollup.
 *
 * Returns per-tool call counts, error counts, p50/p95 duration, and the
 * set of workspaces that invoked each tool — over the last N hours.
 * Drives the /dev page Telemetry tab.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { telemetryRollup } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:telemetry',
  description: 'Per-tool invocation rollup (count, error rate, p50/p95) across selected workspaces over the last N hours.',
  capability: 'intel:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    hours: z.number().int().positive().max(168).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await telemetryRollup({
      workspaceIds: args.workspaceIds ?? null,
      hours: args.hours,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: result.entries.length,
            entries: result.entries,
          }),
        },
      ],
    };
  },
});
