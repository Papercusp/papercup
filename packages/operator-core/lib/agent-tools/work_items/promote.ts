/**
 * work_items:promote — give a non-pipeline work-item (a filed bug/change) a feature
 * pipeline run (D-005). Mints an F-FIX feature (reusing mintFixFeatureRow), links
 * it, and records the linkage. A feature-family work-item already IS a pipeline
 * work-item — no-op.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { promoteToPipeline } from '../../work-items';

export default defineTool({
  name: 'work_items:promote',
  profile: 'engineer',
  description: 'Promote a bug/change work-item into a feature pipeline run (mints an F-FIX feature in the target harness and links it). An operator-scope item needs an explicit harness.',
  guidance: {
    when: 'A filed bug/change is ready to be worked by the pipeline.',
    notWhen: 'It is a passing idea (leave it filed) or already a feature.',
    chaining: 'work_items:create { kind:"bug" } → work_items:promote { harness } → the pipeline picks up the feature.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    harness: z.string().max(80).optional().describe('target harness (required for an operator-scope item)'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const res = await promoteToPipeline(args.id, { harness: args.harness, actor: ident.ownerId });
    return { content: [{ type: 'text' as const, text: JSON.stringify('error' in res ? { ok: false, error: res.error } : { ok: true, ...res }) }] };
  },
});
