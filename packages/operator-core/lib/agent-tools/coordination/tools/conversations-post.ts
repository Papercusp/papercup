/**
 * conversations:post — start a DISCUSSION (open-ended, no single answer) or
 * append a reply to an existing conversation (coordination-conversations). A
 * conversation is Threadable; a post appends to its timeline and fans out to
 * its subscribers (topic + direct), honoring delivery_mode, excluding you.
 *
 *   • no conversation_id → starts a new `discussion` tagged with your topics.
 *   • conversation_id     → appends a reply to that conversation's thread.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { openConversation, postReply } from '../conversations';
import { hardText, LIMITS } from '../../limits';

export default defineTool({
  name: 'conversations:post',
  description:
    'Start a discussion (open-ended) or append a reply to an existing conversation. Omit conversation_id to start a new discussion tagged with topics; pass conversation_id to reply. Replies fan out to the conversation\'s subscribers.',
  guidance: {
    when:
      'Open-ended coordination with no single answer ("how should we approach X?"), or contributing to an existing thread. For a question that wants an answer, use coord:ask instead.',
    notWhen:
      'A factual question → coord:ask (it tries knowledge first). To accept an answer + close a question → conversations:resolve.',
    chaining:
      'conversations:post (start) → others conversations:post (reply) / conversations:join. conversations:get to read the thread.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().optional().describe('Append to this conversation. Omit to start a new discussion.'),
    body: hardText(8000),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Short headline (new discussion only).'),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Topic slugs to route a new discussion (new discussion only).'),
    harness: z.string().optional().describe('Scope a new discussion to a harness (new discussion only).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    if (args.conversation_id) {
      const res = await postReply(identity, { conversation_id: args.conversation_id, body: args.body });
      if ('error' in res) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: res.error }) }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, conversation_id: args.conversation_id, post_id: res.post.id, notified_subscribers: res.delivered }),
        }],
      };
    }

    const opened = await openConversation(identity, {
      kind: 'discussion',
      body: args.body,
      title: args.title,
      topics: args.topics,
      harness_slug: args.harness,
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          conversation_id: opened.conversation.id,
          kind: 'discussion',
          topics: opened.topics,
          unrouted: opened.unrouted,
          notified_subscribers: opened.delivered,
          hint: opened.unrouted ? 'Started, but NO topics tagged → only direct subscribers see it. Add topics for routing.' : 'Discussion started and routed to topic subscribers.',
        }),
      }],
    };
  },
});
