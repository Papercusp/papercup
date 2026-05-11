/**
 * dev:sessions — cross-workspace agent-session list (grouped by spawn_id
 * from harness_shared.tool_invocations).
 *
 * v1: tool-invocation roll-up by spawn. Full transcript drilldown
 * (omp session jsonl + agent_chats transcript merge) is v2.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listSessions } from '@/lib/dev-data';

export default defineTool({
  name: 'dev:sessions',
  description: 'Cross-workspace agent sessions, one row per spawn_id with started/ended/tool_count/error_count/duration totals.',
  capability: 'intel:read',
  requirePrincipal: false,
  roles: ['operator', 'architect', 'debugger'],
  args: z.object({
    workspaceIds: z.array(z.string()).nullable().optional(),
    hours: z.number().int().positive().max(720).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const result = await listSessions({
      workspaceIds: args.workspaceIds ?? null,
      hours: args.hours,
      limit: args.limit,
    });
    return {
      content: [
        { type: 'text', text: JSON.stringify({ count: result.entries.length, entries: result.entries }) },
      ],
    };
  },
});
