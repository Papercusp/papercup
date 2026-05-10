/**
 * tasks:create — create a feature in a harness via the executeAction
 * dispatch path so identity binding, idempotency, and audit are
 * preserved.
 *
 * Calls executeAction() in lib/execute-action.ts directly — same
 * function the POST /api/admin/execute-action route projects. No HTTP
 * roundtrip.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { executeAction } from '@/lib/execute-action';

function newActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  );
}

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
    const result = await executeAction(ctx.principal.slug, {
      actionId: newActionId(),
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
    });
    if (!result.ok) {
      return { data: null, degraded: true, degradedReasons: [`executeAction: ${result.error}${result.detail ? ` (${result.detail})` : ''}`] };
    }
    return { data: result };
  },
});
