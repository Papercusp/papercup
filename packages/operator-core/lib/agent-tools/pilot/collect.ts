/** pilot:collect — assemble real cohort observations and the D-022 report. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry.js';
import { collectPilotCohort, DEFAULT_PILOT_RUBRIC } from '../../pilot-cohort.js';
import { COORD_ROLES } from '../coordination/roles.js';

export default defineTool({
  name: 'pilot:collect',
  profile: 'engineer',
  description:
    'Collect a completed directed-pair pilot cohort from canonical work-item, scorecard and usage ledgers and build the D-022 report. Verifies the seeded assignment, requires one complete post-assignment scorecard from a non-participant grader, attributes cost to every stamped participant session inside its claim window (two costs for arm C), and returns explicit gaps instead of fabricating zero cost or a floor score.',
  guidance: {
    when: 'Pilot items are terminal and have blinded rubric scorecards; you need per-item ArmObservation rows plus per-arm score, interval, wall-clock, cost and rare-event summaries.',
    notWhen:
      'Assigning/stamping a cohort (pilot:assign), emitting grades (scorecards:emit), or reading unfinished items as outcomes.',
    chaining:
      'pilot:assign → execute/complete → scorecards:emit with subject.ref=<item id> → pilot:collect → record the verdict in the plan and drive the adaptive tier gate.',
    seeAlso: ['pilot:assign', 'scorecards:emit', 'scorecards:list'],
  },
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    itemIds: z.array(z.string().min(1)).min(1).max(200),
    harness: z.string().max(80).optional(),
    rubricRef: z.string().min(1).max(120).optional().default(DEFAULT_PILOT_RUBRIC),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const result = await collectPilotCohort({
      workspaceId,
      itemIds: args.itemIds,
      harness: args.harness,
      rubricRef: args.rubricRef,
    });
    return { data: result };
  },
});
