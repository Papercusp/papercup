/**
 * rubrics:get — one rubric in full, including every criterion (model + method + drift
 * markers + rating scale). The Overwatch scorecard and a structured observation grade
 * against these criteria (rubric-driven-observations-2026-06-20 P-002).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getRubric } from '../../rubrics';

export default defineTool({
  name: 'rubrics:get',
  profile: 'engineer',
  description:
    'Read one rubric in full — its criteria (each with key + model + method + drift markers + optional rating scale), default rating scale, and method_ref runbook. Grade against these: ratings[].criterion in a structured observation = a criteria[].key here.',
  guidance: {
    when: 'You have a rubric_id (from rubrics:list/search) and need its full criteria to grade against — e.g. Overwatch emitting the hive-coordination-health scorecard, or filing a structured observation.',
    notWhen: 'Scanning many — rubrics:list (summary rows).',
    chaining: 'rubrics:list → rubrics:get → grade each criterion (ratings[].criterion = criteria[].key) in your observation.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ rubricId: z.string().min(1).describe('the rubric slug, e.g. "hive-coordination-health"') }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const rubric = await getRubric(args.rubricId);
    if (!rubric) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'rubric not found' }) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rubric }) }] };
  },
});
