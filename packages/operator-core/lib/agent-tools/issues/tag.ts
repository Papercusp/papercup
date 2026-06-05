/**
 * issues:tag — add/remove topic tags on an issue (Taggable, engineer-issues-2026-06-03).
 * Tagging routes the issue to that topic's subscribers.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getIssue, tagIssue, untagIssue, getIssueDetail } from '../../issues-engineer';

export default defineTool({
  name: 'issues:tag',
  profile: 'engineer',
  description: "Add or remove topic tags on an issue. Tagging it with a topic routes it to everyone subscribed to that topic — the main way an issue reaches the right people. topics:list to see/create topics.",
  guidance: {
    when: 'An issue belongs to a relevance area (e.g. zero-cache, federation) so the people following that area should see it.',
    notWhen: 'The topic does not exist yet — topics:create it first (prefer an existing one).',
    chaining: 'topics:list → issues:tag { add:[topic] }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    add: z.array(z.string().min(1)).max(8).optional(),
    remove: z.array(z.string().min(1)).max(8).optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await getIssue(args.id);
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    for (const t of args.add ?? []) await tagIssue(args.id, t, id.ownerId);
    for (const t of args.remove ?? []) await untagIssue(args.id, t);
    const detail = await getIssueDetail(args.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, topics: detail?.topics ?? [] }) }] };
  },
});
