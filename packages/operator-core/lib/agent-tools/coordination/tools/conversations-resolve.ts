/**
 * conversations:resolve — accept an answer and close a question. Sets the
 * Lifecycle state to resolved, records the accepted answer, and CAPTURES it back
 * into the knowledge layer (D-004 — the loop-closer) so the NEXT asker gets a
 * synchronous coord:ask hit and the answer is never lost if the asker went idle.
 * Notifies all subscribers (a resolution reaches even mention-mode followers).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { resolveConversation } from '../conversations';

export default defineTool({
  name: 'conversations:resolve',
  description:
    'Resolve a question: accept an answer (by text or by accepted_post_id) and close it. The accepted answer is captured to the knowledge layer (mem0 by default) so the next coord:ask finds it synchronously. Notifies subscribers.',
  guidance: {
    when:
      'A question conversation has been answered satisfactorily. Accept the best answer here — this both closes it and feeds the answer back so nobody has to ask again.',
    notWhen:
      'Still gathering answers → leave it open. For an open-ended discussion that just ran its course, this still works (capture is skippable with capture:none).',
    chaining:
      'conversations:answer → conversations:resolve { accepted_post_id }. Provide accepted_answer to write a synthesized answer instead of quoting a single post.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1),
    accepted_answer: z.string().min(1).max(8000).optional().describe('The accepted answer text (synthesized). Provide this OR accepted_post_id.'),
    accepted_post_id: z.number().int().positive().optional().describe('The coord_thread_posts id of the post to accept as the answer.'),
    capture: z.enum(['mem0', 'none']).optional().describe('Where to write the answer back (D-004). mem0 (default) makes the next coord:ask find it; none skips capture.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    if (!args.accepted_answer && args.accepted_post_id == null) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'need_accepted_answer_or_post_id' }) }] };
    }
    const res = await resolveConversation(identity, {
      conversation_id: args.conversation_id,
      accepted_answer: args.accepted_answer,
      accepted_post_id: args.accepted_post_id,
      capture: args.capture,
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
          captured: res.capture,
          notified_subscribers: res.delivered,
        }),
      }],
    };
  },
});
