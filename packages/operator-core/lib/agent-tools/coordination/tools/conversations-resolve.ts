/**
 * conversations:resolve — accept an answer and close one OR many questions. Sets
 * each conversation's Lifecycle state to resolved, records the accepted answer,
 * and CAPTURES it back into the knowledge layer (D-004 — the loop-closer) so the
 * NEXT asker gets a synchronous coord:ask hit and the answer is never lost if the
 * asker went idle. Notifies all subscribers (a resolution reaches even
 * mention-mode followers).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): resolve ONE inline
 * ({ id, accepted_answer|accepted_post_id, capture? }) or MANY heterogeneous
 * (items:[{ id, accepted_answer|accepted_post_id, capture? }]) — each item carries
 * its OWN accepted answer → { ok, results:[{ ok, id, state? | error }], counts }.
 * Each result self-describes its id; one not-found item never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { resolveConversation } from '../conversations';
import { runBulk, bulkContent } from '../../_bulk';

const itemSpec = z.object({
  id: z.string().min(1).describe('conversation id (alias: conversation_id)'),
  conversation_id: z.string().min(1).optional().describe('alias for id'),
  accepted_answer: z.string().min(1).max(8000).optional().describe('The accepted answer text (synthesized). Provide this OR accepted_post_id.'),
  accepted_post_id: z.number().int().positive().optional().describe('The coord_thread_posts id of the post to accept as the answer.'),
  capture: z.enum(['mem0', 'none']).optional().describe('Where to write the answer back (D-004). mem0 (default) makes the next coord:ask find it; none skips capture.'),
});

export default defineTool({
  name: 'conversations:resolve',
  description:
    'Resolve one OR many questions: accept an answer (by text or by accepted_post_id) and close it. The accepted answer is captured to the knowledge layer (mem0 by default) so the next coord:ask finds it synchronously. Notifies subscribers. Single: { id, accepted_answer | accepted_post_id, capture? }. Many heterogeneous: items:[{ id, accepted_answer | accepted_post_id, capture? }] (each carries its own answer). Returns { ok, results:[{ ok, id, state? | error }], counts } — correlate by id; one item that lacks an answer or is not found never fails the rest.',
  guidance: {
    when:
      'A question conversation has been answered satisfactorily. Accept the best answer here — this both closes it and feeds the answer back so nobody has to ask again. Resolve several at once via items:[…] (each item supplies its own accepted answer).',
    notWhen:
      'Still gathering answers → leave it open. For an open-ended discussion that just ran its course, this still works (capture is skippable with capture:none).',
    chaining:
      'conversations:answer → conversations:resolve { id, accepted_post_id }. Provide accepted_answer to write a synthesized answer instead of quoting a single post.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-resolve shorthand: the conversation id'),
      conversation_id: z.string().min(1).optional().describe('alias for id (single form)'),
      accepted_answer: z.string().min(1).max(8000).optional().describe('The accepted answer text (synthesized). Provide this OR accepted_post_id (single form).'),
      accepted_post_id: z.number().int().positive().optional().describe('The coord_thread_posts id of the post to accept as the answer (single form).'),
      capture: z.enum(['mem0', 'none']).optional().describe('Where to write the answer back (D-004). mem0 (default) makes the next coord:ask find it; none skips capture (single form).'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('resolve many conversations at once — each { id, accepted_answer | accepted_post_id, capture? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id) || Boolean(a.conversation_id), {
      message: 'pass { id, accepted_answer | accepted_post_id } for one, or items:[{ id, accepted_answer | accepted_post_id }] for many',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items.map((it) => ({
          id: it.id ?? (it.conversation_id as string),
          accepted_answer: it.accepted_answer,
          accepted_post_id: it.accepted_post_id,
          capture: it.capture,
        }))
      : [
          {
            id: (args.id ?? args.conversation_id) as string,
            accepted_answer: args.accepted_answer,
            accepted_post_id: args.accepted_post_id,
            capture: args.capture,
          },
        ];
    const env = await runBulk(
      list,
      async (it) => {
        if (!it.accepted_answer && it.accepted_post_id == null) {
          return { ok: false as const, id: it.id, error: 'need_accepted_answer_or_post_id' };
        }
        const res = await resolveConversation(identity, {
          conversation_id: it.id,
          accepted_answer: it.accepted_answer,
          accepted_post_id: it.accepted_post_id,
          capture: it.capture,
        });
        if ('error' in res) return { ok: false as const, id: it.id, error: res.error };
        return {
          ok: true as const,
          id: res.conversation.id,
          state: res.conversation.state,
          captured: res.capture,
          notified_subscribers: res.delivered,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
