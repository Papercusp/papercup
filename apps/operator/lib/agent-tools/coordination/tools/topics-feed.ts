/**
 * topics:feed — read everything tagged a topic, across issues / conversations /
 * features / plans: the whole work-stream of an area (integration-adoption-
 * 2026-06-03, Capstone P1; substrate D-001 cross-object index).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { topicFeed } from '@/lib/topics-feed';

export default defineTool({
  name: 'topics:feed',
  description:
    'Read everything tagged with a topic — across issues, conversations, features, and plans — the whole work-stream of an area. Each item carries its title + current state.',
  guidance: {
    when: 'To understand all current work in a relevance area before you start in it, or to see what is happening with e.g. `zero-cache` across every object kind.',
    notWhen: 'You want messages waiting for you (coord:inbox) or just the list of topics (topics:list).',
    chaining: 'topics:list → topics:feed { topic } → issues:get / conversations:get on an item.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ topic: z.string().min(1) }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const items = await topicFeed(args.topic);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, topic: args.topic, count: items.length, items }) }] };
  },
});
