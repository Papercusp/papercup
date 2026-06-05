/**
 * coord:ask — ask a question, knowledge-FIRST (coordination-conversations D-001/
 * D-002). The tool SHAPE runs the knowledge tier (search:semantic + mem0) before
 * any peer is interrupted:
 *   • HIT  → returns answer candidates inline (each citing its source), no peer
 *            touched, synchronously. The asker judges whether one answers them.
 *   • MISS → opens a `question` conversation tagged with your topics, fans it out
 *            to topic subscribers, and returns immediately (never blocks — peer
 *            answers arrive in your inbox on a later turn, D-002).
 * If the inline candidates don't answer you, call again with force_open:true to
 * open the question to peers anyway.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { runKnowledgeTier } from '../ask-knowledge-tier';
import { openConversation } from '../conversations';

export default defineTool({
  name: 'coord:ask',
  description:
    'Ask a question knowledge-FIRST. Runs search:semantic + mem0 before interrupting anyone: a hit returns answer candidates inline (with sources); a miss opens a `question` conversation routed to topic subscribers and returns immediately (answers arrive in your inbox — never blocks). Pass topics to route a miss; force_open:true to ask peers even when knowledge had candidates.',
  guidance: {
    when:
      'You have a question and want the fastest correct answer without needlessly interrupting a peer. Always include topics so a miss reaches the right people. For a harness-specific question pass harness.',
    notWhen:
      'For an open-ended discussion (no single answer), use conversations:post. To turn-block on a peer/human, use coord:escalate / coord:handoff instead — coord:ask is deliberately non-blocking.',
    chaining:
      'topics:list → coord:ask (with topics). On a miss you get a conversation_id; conversations:get to read replies, conversations:resolve when answered.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    question: z.string().min(1).max(2000),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Topic slugs to route a miss to (topics:list). Strongly recommended — without them only direct subscribers see the question.'),
    harness: z.string().optional().describe('Scope the question to a harness (restricts knowledge search + tags the conversation harness-scoped).'),
    force_open: z.boolean().optional().describe('Open a peer question even if the knowledge tier returned candidates (use when the inline candidates did not answer you).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);

    const tier = await runKnowledgeTier({
      query: args.question,
      workspaceId: identity.workspaceId,
      asker_id: identity.ownerId,
      harness_slug: args.harness ?? null,
    });

    if (tier.candidates.length > 0 && !args.force_open) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            found: true,
            searched: tier.searched,
            embedder_available: tier.embedder_available,
            answer_candidates: tier.candidates,
            hint: 'Knowledge-first hit — these come from existing knowledge (judge them by their source). If none answers you, call coord:ask again with force_open:true to open the question to topic subscribers.',
          }),
        }],
      };
    }

    const opened = await openConversation(identity, {
      kind: 'question',
      body: args.question,
      topics: args.topics,
      harness_slug: args.harness,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          found: false,
          conversation_id: opened.conversation.id,
          scope: opened.conversation.scope,
          topics: opened.topics,
          unrouted: opened.unrouted,
          notified_subscribers: opened.delivered,
          searched: tier.searched,
          hint: opened.unrouted
            ? 'Question opened, but NO topics tagged → only direct subscribers will see it. Add topics (topics:list) for routing.'
            : 'Question opened to topic subscribers; peer answers arrive in your inbox on a later turn. conversations:resolve when answered (captures the answer for the next asker).',
        }),
      }],
    };
  },
});
