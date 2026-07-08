/**
 * conversations:get — read one OR many conversations in full: the
 * question/discussion seed, its topic tags, the whole reply/answer thread
 * (oldest-first), the accepted answer (if resolved), and the follower count.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): pass `id` for one or `ids` for
 * several; the result is `{ ok, results:[{ ok, id, conversation?, error? }], counts }`
 * — each result self-describes its id, so a not-found item never poisons the rest
 * and the agent correlates by id (not array position).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { resolveAgentIdentity, type AgentIdentity } from '../identity';
import { getConversation } from '../conversations';
import { mergeIds, runBulk, bulkContent } from '../../_bulk';

export default defineTool({
  name: 'conversations:get',
  description:
    'Read one OR many conversations in full: the seed, topic tags, the whole thread (posts oldest-first), the accepted answer if resolved, and follower count. Pass `id` for one or `ids` for several (1–100). Returns { ok, results:[{ ok, id, conversation? + topics/posts/subscriber_count | error }], counts } — correlate each result by its id, not by position; a missing id comes back as that item\'s { ok:false } without failing the rest.',
  guidance: {
    when: 'You have one or more conversation_ids (from coord:ask, conversations:list, or an inbox notice) and want the full thread. Pass every id you need at once via `ids` instead of calling per id.',
    notWhen: 'Browsing many → conversations:list.',
    chaining: 'conversations:get { ids:[…] } → conversations:answer / conversations:post / conversations:join / conversations:resolve.',
    seeAlso: [
      'conversations:answer (answer the question)',
      'conversations:post (reply to the thread)',
      'conversations:promote (turn it into a tracked work-item)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single conversation id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('conversation ids to fetch (1–100)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    // Read scoped to the CALLER's workspace partition (WI-1571 read side): a
    // workspace-scoped agent's asks land under identity.workspaceId, so an
    // identity-less read here resolved 'default' and returned not_found for
    // the caller's own conversations. Fail-open: an unattributable context
    // keeps the request-ALS chain (glance.ts selfOwnerId pattern).
    let identity: AgentIdentity | undefined;
    try {
      identity = resolveAgentIdentity(ctx);
    } catch {
      identity = undefined;
    }
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const detail = await getConversation(id, identity);
        if (!detail) return { ok: false as const, id, error: 'not_found' };
        const { conversation: c, topics, posts, subscriber_count } = detail;
        return {
          ok: true as const,
          id,
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
        };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
