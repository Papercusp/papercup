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
import { hardText, LIMITS } from '../../limits';

export default defineTool({
  name: 'coord:ask',
  description:
    'Ask a question knowledge-FIRST. Runs search:semantic + mem0 before interrupting anyone: a hit returns answer candidates inline (with sources); a miss opens a `question` conversation routed to topic subscribers and returns immediately (answers arrive in your inbox — never blocks). Pass topics to route a miss; force_open:true to ask peers even when knowledge had candidates.',
  guidance: {
    when:
      'DEFAULT FIRST MOVE for any question you cannot answer from your own knowledge or the code — it routes to the peer/expert who owns the area (knowledge-first, non-blocking). Reach for this BEFORE escalating to the owner/human: ask peers here first; only ask the owner (coord:ask-owner / coord:escalate) if the best answer is still unclear after asking. NAME the agents in `to:` — a topic tag alone reaches only that topic\'s subscribers, and most have none. Pass harness for a harness-specific question.',
    notWhen:
      'For an open-ended discussion (no single answer), use conversations:post. Do NOT jump to coord:ask-owner / coord:escalate (interrupting the owner) before trying coord:ask — escalate to the owner only when peers + knowledge leave the answer unclear. coord:ask is deliberately non-blocking; to turn-block on a peer/handoff use coord:escalate / coord:handoff.',
    chaining:
      'topics:list → coord:ask (with topics). On a miss you get a conversation_id; conversations:get to read replies, conversations:resolve when answered. Still unclear after peers replied? THEN coord:ask-owner / coord:escalate.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    question: hardText(LIMITS.ANNOTATION),
    topics: z.array(z.string().min(1)).max(8).optional().describe('Topic slugs to route a miss to (topics:list). Strongly recommended — without them only direct subscribers see the question.'),
    to: z.array(z.string().min(1)).max(8).optional().describe('Agent ids to ask DIRECTLY. They are subscribed to the question before fan-out, so it reaches them even when no topic routes to them; implies force_open (you asked a person, not the knowledge base). Topics still widen the audience on top.'),
    harness: z.string().optional().describe('Scope the question to a harness (restricts knowledge search + tags the conversation harness-scoped).'),
    force_open: z.boolean().optional().describe('Open a peer question even if the knowledge tier returned candidates (use when the inline candidates did not answer you).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // A DIRECTED ask names a person, so the knowledge tier must not answer on
    // their behalf — addressing someone implies force_open (WI-5754).
    const directTo = args.to ?? [];
    const forceOpen = args.force_open || directTo.length > 0;

    const tier = await runKnowledgeTier({
      query: args.question,
      workspaceId: identity.workspaceId,
      asker_id: identity.ownerId,
      harness_slug: args.harness ?? null,
    });

    if (tier.candidates.length > 0 && !forceOpen) {
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
      direct_to: directTo,
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
          asked: opened.direct_to,
          unrouted: opened.unrouted,
          notified_subscribers: opened.delivered,
          searched: tier.searched,
          // `unrouted` is now measured from actual delivery, so this hint can
          // state what really happened instead of what the asker attempted.
          // Tagging topics used to produce the cheerful "opened to topic
          // subscribers" line even when the topic had zero subscribers and the
          // question reached no one at all — the asker then waited on an answer
          // that could never come.
          hint: opened.unrouted
            ? `Question opened, but it reached NOBODY — 0 agents were notified${
                opened.topics.length
                  ? ` (the topics you tagged — ${opened.topics.join(', ')} — have no subscribers)`
                  : ' (no topics tagged, no agent addressed)'
              }. Nobody will answer this as-is: re-ask with \`to: ['<ownerId>']\` to address a specific agent (coord:presence lists who is live), which subscribes them directly.`
            : `Question opened and ${opened.delivered} agent${opened.delivered === 1 ? '' : 's'} notified${
                opened.direct_to.length ? ` (incl. ${opened.direct_to.join(', ')})` : ''
              }; answers arrive in your inbox on a later turn. If you are BLOCKED on the answer, events:await { event: 'conversation:answered:${opened.conversation.id}' } and end your turn — the resolve wakes you. conversations:resolve when answered (captures the answer for the next asker).`,
        }),
      }],
    };
  },
});
