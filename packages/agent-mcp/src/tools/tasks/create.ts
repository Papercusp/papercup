/**
 * Create a task in a harness. Delegates to the existing executeAction
 * verb so identity binding and audit are preserved.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'tasks:create',
  capability: 'tasks:write',
  args: z.object({
    harnessSlug: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    goalId: z.string().optional(),
    estimatedCostCents: z.number().int().nonnegative().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    const bearer = process.env.AGENT_MCP_BEARER ?? '';
    const base = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';
    // Wrap in the ExecuteActionRequest shape the operator expects:
    // { actionId, callingHarness?, action: { op, ... } }. The action.op is
    // dispatched in apps/operator/lib/execute-action.ts → doCreateFeature.
    const actionId =
      (globalThis.crypto?.randomUUID?.() ?? '') ||
      `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    const r = await fetch(`${base}/api/admin/execute-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        actionId,
        callingHarness: args.harnessSlug,
        action: {
          op: 'create_feature',
          harness_slug: args.harnessSlug,
          title: args.title,
          summary: args.summary,
          goal_id: args.goalId,
          expected_cost_cents: args.estimatedCostCents,
          reason: args.reason,
        },
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { data: null, degraded: true, degradedReasons: [`executeAction ${r.status}: ${text}`] };
    }
    return { data: await r.json().catch(() => ({})) };
  },
});
