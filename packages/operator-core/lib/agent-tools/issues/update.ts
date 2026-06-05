/**
 * issues:update — edit an issue's mutable fields (engineer-issues-2026-06-03,
 * Phase 1). Subscribers are notified. State changes go through issues:close;
 * tags through issues:tag; comments through issues:comment.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { updateIssue } from '../../issues-engineer';

export default defineTool({
  name: 'issues:update',
  profile: 'engineer',
  description: "Edit an issue's title / body / severity / kind / found-during / linked feature. Notifies subscribers. (State → issues:close; tags → issues:tag; comments → issues:comment.)",
  guidance: {
    when: 'Refine an issue you or someone else filed — clarify the title/body, re-rate severity, correct a mislabeled kind (bug↔change — the kind picks the auto-implement lane, so keep it honest), or attach the feature that will fix it.',
    notWhen: 'Resolving it (issues:close), adding a note (issues:comment), or routing it to a topic (issues:tag).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(8000).optional(),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    kind: z.enum(['bug', 'change']).optional().describe('correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)'),
    foundDuring: z.string().max(120).nullable().optional(),
    linkedFeatureId: z.string().max(80).nullable().optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issue = await updateIssue(args.id, {
      title: args.title,
      body: args.body,
      severity: args.severity,
      kind: args.kind,
      foundDuring: args.foundDuring,
      linkedFeatureId: args.linkedFeatureId,
      by: id.ownerId,
    });
    if (!issue) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'issue not found' }) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, issue }) }] };
  },
});
