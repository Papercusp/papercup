/**
 * topics:tag — tag any coordination object (issue/conversation/feature/plan) with
 * a topic, so it joins that topic's cross-object feed and routes to the topic's
 * subscribers (integration-adoption-2026-06-03, Capstone P1). The generic tagger;
 * issues:tag is the issue-specific shortcut.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { tagObject, untagObject, listObjectTags } from '../../../topics-feed';

export default defineTool({
  name: 'topics:tag',
  description:
    "Tag a coordination object (issue / conversation / feature / plan) with a topic so it appears in that topic's feed and its changes reach the topic's subscribers. Pass remove:true to untag.",
  guidance: {
    when: 'You want a feature/plan/issue/conversation to be visible to everyone following a relevance area — tag it with the topic.',
    notWhen: "The topic does not exist yet — topics:create it first (prefer an existing one). For an issue you can also use issues:tag.",
    chaining: 'topics:list → topics:tag { object_kind, object_ref, topic } → topics:feed { topic }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    object_kind: z.enum(['issue', 'conversation', 'feature', 'plan']),
    object_ref: z.string().min(1).describe('the object id — issue EI-<n>, feature F-<n>, plan slug, conversation id'),
    topic: z.string().min(1),
    remove: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    if (args.remove) await untagObject(args.object_kind, args.object_ref, args.topic);
    else await tagObject(args.object_kind, args.object_ref, args.topic, id.ownerId);
    const topics = await listObjectTags(args.object_kind, args.object_ref);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, object: { kind: args.object_kind, ref: args.object_ref }, topics }) }],
    };
  },
});
