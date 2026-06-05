/**
 * conversations:promote — a question/discussion that concludes "this is a real
 * problem" promotes into an engineer issue (coordination-conversations D-005).
 * It CARRIES its thread (re-parented onto the issue, not migrated), mints the
 * engineer_issues row via the issues surface (carrying the conversation's topic
 * tags + scope), closes the conversation, and records the issue id. The
 * discussion then continues on the issue.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { promoteConversation } from '../conversations';

export default defineTool({
  name: 'conversations:promote',
  description:
    'Promote a conversation (question/discussion) into an engineer issue, carrying its thread. Mints an engineer_issues row (with the conversation\'s topics + scope), closes the conversation, and records the issue id. Use when a discussion concludes there is a real problem to track.',
  guidance: {
    when:
      'A conversation has concluded that there is a concrete, trackable problem — turn it into an issue so it can be claimed, prioritized, and promoted to a feature.',
    notWhen:
      'A question that just needs an answer → conversations:resolve (captures the answer). An open discussion still in progress → leave it. To file a fresh issue unrelated to a conversation → issues:create.',
    chaining:
      'conversations:get → conversations:promote → issues:get / issues:claim. The issue keeps the conversation\'s thread; further discussion uses issues:comment.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('Issue severity (default minor).'),
    source: z.enum(['engineer', 'su']).optional().describe('Issue source (default su).'),
    harness: z.string().optional().describe('Force a harness-scoped issue (a harness-scoped conversation already carries its harness).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const res = await promoteConversation(identity, {
      conversation_id: args.conversation_id,
      severity: args.severity,
      source: args.source,
      harness: args.harness,
    });
    if ('error' in res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: res.error }) }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          conversation_id: res.conversation.id,
          state: res.conversation.state,
          issue: res.issue,
          thread_carried: res.thread_reparented,
          notified_subscribers: res.delivered,
          hint: `Promoted to engineer issue ${res.issue.id}. The conversation is closed; the discussion continues via issues:comment { id: "${res.issue.id}" }.`,
        }),
      }],
    };
  },
});
