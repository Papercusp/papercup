/**
 * messages:dismiss — mark a message as archived (soft-hide, reversible).
 *
 * Works for any message — harness-level or feature-scoped. (Subsumes the
 * old `messages:feature_dismiss`, which was never feature-specific: it just
 * moves a message to status='archived' by id.)
 *
 * Goes through executeAction (mark_message_status) — no HTTP roundtrip.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { executeAction } from '../../execute-action';

function newActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  );
}

export default defineTool({
  name: 'messages:dismiss',
  guidance: {
    when: 'Soft-hide a message you\'ve handled — "ignore that note", "dismiss the comment on X". Reversible (status→archived, not deleted).',
    notWhen: 'For deleting a message, this isn\'t it — dismiss is reversible. For archiving a CHAT (multi-turn), use `agent_chats:archive`.',
    seeAlso: [
      'messages:inbox (the durable inbox)',
      'messages:send (send a durable note)',
      'agent_chats:archive (archive a multi-turn CHAT instead)',
    ],
  },
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
