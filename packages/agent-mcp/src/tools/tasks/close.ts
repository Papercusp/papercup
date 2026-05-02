/**
 * Close a task — sets status to 'done' or 'cancelled'.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'tasks:write',
  args: z.object({
    harnessSlug: z.string().min(1),
    id: z.string().min(1),
    outcome: z.enum(['done', 'cancelled']),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    const bearer = process.env.AGENT_MCP_BEARER ?? '';
    const base = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';
    const r = await fetch(`${base}/api/admin/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        op: 'update_feature',
        harness_slug: args.harnessSlug,
        feature_id: args.id,
        status: args.outcome,
        reason: args.reason,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { data: null, degraded: true, degradedReasons: [`executeAction ${r.status}: ${text}`] };
    }
    return { data: await r.json().catch(() => ({})) };
  },
});
