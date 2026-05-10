/**
 * messages:feature_dismiss — mark a feature-lane message as archived.
 *
 * Calls executeAction() in lib/execute-action.ts directly — no HTTP
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
  name: 'messages:feature_dismiss',
  capability: 'messages:write',
  args: z.object({
    message_id: z.string().min(1),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    const result = await executeAction(ctx.principal.slug, {
      actionId: newActionId(),
      action: {
        op: 'mark_message_status',
        messageId: args.message_id,
        status: 'archived',
        reason: args.reason,
      },
    });
    if (!result.ok) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`executeAction: ${result.error}${result.detail ? ` (${result.detail})` : ''}`],
      };
    }
    return { data: result };
  },
});
