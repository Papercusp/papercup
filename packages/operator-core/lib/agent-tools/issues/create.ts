/**
 * issues:create — file an engineer/SU-discovered issue on the coordination
 * substrate (engineer-issues-2026-06-03, Phase 1 / D-003). The issue is
 * Subscribable + Taggable + Threadable + Claimable + Lifecycle; tagging topics
 * routes it to that area's subscribers.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { notifyAgents } from '../coordination/notify-agents';
import { createIssue, issueRef } from '../../issues-engineer';

export default defineTool({
  name: 'issues:create',
  profile: 'engineer',
  description:
    'File an engineer/SU issue — a real problem you discovered but are not fixing right now. Tag topics so agents subscribed to that area see it. Returns the issue id (EI-<n>). Dup-check with issues:search first.',
  guidance: {
    when: 'You hit a real problem mid-work that is out of your current scope (or that you are deferring) and want it tracked + visible to others in the area. Tag the relevant topics.',
    notWhen: 'A passing question with no clear owner — use coord:ask (knowledge-first). Something you are fixing right now in-scope — just fix it. A validator finding inside a pipeline run — that goes through the validator pipeline, not here.',
    chaining: 'issues:search (dedup) → issues:create { topics } → issues:claim when you start → issues:close on resolution; issues:promote to mint a fix feature.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(8000).optional(),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    kind: z.enum(['bug', 'change']).optional().describe('work-item kind (unify-work-items): bug (default; something broken) | change (a desired one-off / DX ask)'),
    scope: z.string().max(80).optional().describe("'operator' (default) or 'harness:<slug>'"),
    topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list to see them)'),
    notifyAgents: z
      .array(z.string().min(1))
      .max(8)
      .optional()
      .describe(
        "@-mention SPECIFIC agents: ownerId prefixes / handles (resolve via coord:presence). Each is SUBSCRIBED to the issue (gets every future update) AND pinged now, pointing at it — a DIRECTED handoff to a known owner. Distinct from `topics` (broadcast to whoever subscribed to an area) and from assigning (ownership). Use when you know exactly who should see/own this.",
      ),
    foundDuring: z.string().max(120).optional().describe('optional context — a feature/plan ref'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    const issue = await createIssue({
      title: args.title,
      body: args.body,
      severity: args.severity,
      kind: args.kind,
      scope: args.scope,
      topics: args.topics,
      foundDuring: args.foundDuring,
      createdBy: id.ownerId,
      source,
    });
    // Directed @-mention: subscribe + ping the named agents on the new issue.
    const notified = args.notifyAgents?.length
      ? await notifyAgents(id, {
          addressees: args.notifyAgents,
          objectRef: issueRef(issue.id),
          summary: `🔖 ${id.ownerLabel} tagged you on ${issue.id}: ${issue.title.slice(0, 80)}`,
          body:
            `${id.ownerLabel} tagged you on issue ${issue.id} (${issue.severity}): ${issue.title}` +
            (args.body ? `\n\n${args.body.slice(0, 600)}` : '') +
            `\n\n— it's on your radar: issues:get ${issue.id} (comment / claim / close there).`,
          harnessSlug: args.scope?.startsWith('harness:') ? args.scope.slice('harness:'.length) : undefined,
        }).catch(() => null)
      : null;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, issue, ...(notified ? { notified: notified.notified } : {}) }),
        },
      ],
    };
  },
});
