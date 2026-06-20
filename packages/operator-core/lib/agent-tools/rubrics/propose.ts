/**
 * rubrics:propose — propose (idempotent upsert) a rubric → status "proposed"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001). Any agent may propose; the
 * Queen/owner ratifies it active (rubrics:ratify). Re-proposing the same rubric_id
 * updates its content.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { proposeRubric } from '../../rubrics';

const criterion = z.object({
  key: z.string().min(1).describe('stable kebab id; an observation rating references this'),
  title: z.string().min(1),
  model: z.string().min(1).describe('how this criterion is supposed to work (the MODEL)'),
  method: z.string().min(1).describe('how to investigate it (signals / queries — the METHOD)'),
  ratingScale: z.array(z.string()).optional().describe('per-criterion override of the rubric default scale'),
  driftMarkers: z.string().describe('what degraded / broken looks like'),
});

export default defineTool({
  name: 'rubrics:propose',
  profile: 'engineer',
  description:
    'Propose a rubric (the shared standard for a system characteristic) → status "proposed". Any agent may propose — typically on noticing a cluster of free-text observations about one characteristic with no rubric. The Queen/owner ratifies it active (rubrics:ratify). Idempotent on rubric_id (re-propose updates the content).',
  guidance: {
    when: 'You see a recurring characteristic worth grading consistently and no rubric covers it. Author the criteria (each: model + how-to-investigate + drift markers); reference an agent-insights runbook via methodRef for the long-form method.',
    notWhen: 'A one-off finding — file a free-text observation instead. Activating an existing proposed rubric — rubrics:ratify. Check rubrics:search first to avoid a duplicate.',
    chaining: 'rubrics:search (dedup) → rubrics:propose → rubrics:ratify (Queen/owner).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricId: z.string().min(1).max(120).describe('slug, e.g. "hive-coordination-health"'),
    characteristic: z.string().min(1).max(120).describe('umbrella domain, e.g. "hive-coordination"'),
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    criteria: z.array(criterion).min(1).describe('the per-characteristic gradeable items'),
    ratingScale: z
      .array(z.string())
      .optional()
      .describe('default scale shared by criteria (omit → ["healthy","degraded","broken","unknown"])'),
    methodRef: z.string().max(200).optional().describe('agent-insights runbook slug for the long-form method'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await proposeRubric({
      rubricId: args.rubricId,
      characteristic: args.characteristic,
      title: args.title,
      description: args.description,
      criteria: args.criteria,
      ratingScale: args.ratingScale,
      methodRef: args.methodRef,
      by: id.ownerId,
      status: 'proposed',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rubric }) }] };
  },
});
