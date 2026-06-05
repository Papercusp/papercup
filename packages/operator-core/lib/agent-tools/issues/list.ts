/**
 * issues:list — the engineer/SU issue surface (engineer-issues-2026-06-03 D-003,
 * redefining the retired per-harness stub). Cross-cutting, claimable, lifecycle-
 * managed issues that ride the coordination substrate. Filter by state / scope /
 * assignee / severity / topic.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listIssues } from '../../issues-engineer';

export default defineTool({
  name: 'issues:list',
  profile: 'engineer',
  description:
    'List engineer/SU issues. Filters: state (open|resolved|closed), scope, assignee, severity, topic (issues tagged it), mine (assigned to you). The agent-facing problem tracker — distinct from the validator pipeline (harness:status shows that).',
  guidance: {
    when: 'To see open problems in an area before starting work, find something to pick up, or check what you are assigned. Filter by a topic to see everything filed against that area.',
    notWhen: 'You want validator-pipeline findings for one harness — that is harness:status. You want one issue in full — issues:get.',
    chaining: 'topics:list → issues:list { topic } → issues:get → issues:claim.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    state: z.enum(['open', 'resolved', 'closed']).optional(),
    scope: z.string().optional(),
    assignee: z.string().optional(),
    severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
    kind: z.enum(['bug', 'change']).optional().describe('work-item kind (unify-work-items): bug | change'),
    topic: z.string().optional(),
    mine: z.boolean().optional().describe('only issues assigned to you'),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const issues = await listIssues({
      state: args.state,
      scope: args.scope,
      assignee: args.mine ? id.ownerId : args.assignee,
      severity: args.severity,
      kind: args.kind,
      topic: args.topic,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: issues.length,
            issues: issues.map((i) => ({
              id: i.id,
              kind: i.kind,
              title: i.title,
              severity: i.severity,
              state: i.state,
              scope: i.scope,
              assignee: i.assignee,
              source: i.source,
              createdAt: i.createdAt,
            })),
          }),
        },
      ],
    };
  },
});
