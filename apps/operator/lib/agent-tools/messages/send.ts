/**
 * messages:send — send a message to one or more recipient harnesses
 * via the existing send_message executeAction verb so identity binding,
 * provenance, and audit are preserved.
 *
 * Operator uses this with kind='Directive' to instruct a harness to run
 * a role; the existing flow (Directive → supervisor_notes → orchestrator
 * wakes → role runs) does the rest.
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
  name: 'messages:send',
  capability: 'messages:write',
  args: z.object({
    to: z.array(z.string().min(1)).min(1),
    kind: z.string().default('Directive'),
    subject: z.string().min(1),
    body: z.string().min(1),
    parentMessageId: z.string().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    const result = await executeAction(ctx.principal.slug, {
      actionId: newActionId(),
      action: {
        op: 'send_message',
        to: args.to,
        kind: args.kind,
        subject: args.subject,
        body: args.body,
        parentMessageId: args.parentMessageId,
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
    return {
      data: { recipients: args.to, kind: args.kind, executed: result },
    };
  },
});
