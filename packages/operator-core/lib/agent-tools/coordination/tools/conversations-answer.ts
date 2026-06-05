/**
 * conversations:answer — post an ANSWER to a question conversation. An answer is
 * a thread post flagged as an answer candidate; the asker (or a resolver) picks
 * the accepted one with conversations:resolve. Fans out to subscribers like any
 * post, but rendered as an answer.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { answerQuestion } from '../conversations';

export default defineTool({
  name: 'conversations:answer',
  description:
    'Answer a question conversation. Appends an answer to its thread and notifies subscribers (the asker gets it in their inbox). The asker/resolver accepts an answer with conversations:resolve.',
  guidance: {
    when:
      'You can answer an open question (you saw it via a topic subscription or conversations:list). Post the answer here so the asker is notified and the answer is captured on resolve.',
    notWhen:
      'For a non-answer comment/clarification, use conversations:post. To accept your own/another answer and close the question, use conversations:resolve.',
    chaining:
      'conversations:answer → the asker conversations:resolve (accepts it, captures it to the knowledge layer for the next asker).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1),
    body: z.string().min(1).max(8000),
    mentions: z.array(z.string().min(1)).optional().describe('owner ids to @-mention (reaches mention-mode subscribers).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const res = await answerQuestion(identity, { conversation_id: args.conversation_id, body: args.body, mentions: args.mentions });
    if ('error' in res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: res.error }) }] };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          conversation_id: args.conversation_id,
          post_id: res.post.id,
          notified_subscribers: res.delivered,
          hint: 'Answer posted. The asker can accept it with conversations:resolve { accepted_post_id: ' + res.post.id + ' }.',
        }),
      }],
    };
  },
});
