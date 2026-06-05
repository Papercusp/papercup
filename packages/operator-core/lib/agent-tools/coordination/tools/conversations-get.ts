/**
 * conversations:get — read one conversation in full: the question/discussion
 * seed, its topic tags, the whole reply/answer thread (oldest-first), the
 * accepted answer (if resolved), and the follower count.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { getConversation } from '../conversations';

export default defineTool({
  name: 'conversations:get',
  description:
    'Read one conversation in full: the seed, topic tags, the whole thread (posts oldest-first), the accepted answer if resolved, and follower count.',
  guidance: {
    when: 'You have a conversation_id (from coord:ask, conversations:list, or an inbox notice) and want the full thread.',
    notWhen: 'Browsing many → conversations:list.',
    chaining: 'conversations:get → conversations:answer / conversations:post / conversations:join / conversations:resolve.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    conversation_id: z.string().min(1),
  }),
  async handler(args) {
    const detail = await getConversation(args.conversation_id);
    if (!detail) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'not_found' }) }] };
    }
    const { conversation: c, topics, posts, subscriber_count } = detail;
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          conversation: {
            id: c.id,
            kind: c.kind,
            state: c.state,
            scope: c.scope,
            harness_slug: c.harness_slug,
            title: c.title,
            body: c.body,
            asker_id: c.asker_id,
            accepted_answer: c.accepted_answer,
            accepted_post_id: c.accepted_post_id,
            capture_target: c.capture_target,
            promoted_issue_id: c.promoted_issue_id,
            created_ts: c.created_ts,
            resolved_ts: c.resolved_ts,
          },
          topics,
          subscriber_count,
          posts: posts.map((p) => ({ id: p.id, author_id: p.author_id, body: p.body, created_ts: p.created_ts })),
        }),
      }],
    };
  },
});
