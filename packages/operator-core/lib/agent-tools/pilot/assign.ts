/** pilot:assign — preview or safely materialize a directed-pair pilot cohort. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { materializePilotCohort } from '../../pilot-cohort.js';
import { COORD_ROLES } from '../coordination/roles.js';

const participant = z.object({
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(['solo', 'director', 'implementer']),
  windowStartMs: z.number().int().positive(),
});

const candidate = z.object({
  id: z.string().min(1),
  tier: z.enum(['trivial', 'substantive', 'high-risk']),
  stratum: z.string().min(1).optional(),
  participants: z.array(participant).min(1).max(2).optional(),
});

export default defineTool({
  name: 'pilot:assign',
  profile: 'engineer',
  description:
    'Preview or materialize the seeded, permuted-block assignment for the directed-pair 3-arm pilot. confirm is false by default. A confirmed cohort fails closed unless A/B carry one solo participant, C carries director+implementer sessions, and any B assignment has a terminal live probe whose testedSha equals deployedSha. Writes the auditable pilotArm/seed/stratum/block/participant-window payload stamp, then re-derives it; a failed multi-row write rolls back its pilot keys.',
  guidance: {
    when: 'Preparing or starting a real directed-pair pilot cohort. Preview first, record the seed, bind exact participant session ids + claim-window starts, then confirm only after the arm-B live probe passes.',
    notWhen:
      'Hand-picking arms, assigning trivial/high-risk work, or grading/collecting completed results (pilot:collect). Never use generic payload edits to bypass this gate.',
    chaining:
      'pilot:assign { confirm:false } → run/verify the arm-B probe → pilot:assign { same seed/candidates, confirm:true } → execute items → blinded scorecards:emit → pilot:collect.',
    seeAlso: ['pilot:collect', 'scorecards:emit', 'work_items:get'],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    seed: z.string().min(1).max(200),
    candidates: z.array(candidate).min(1).max(200),
    harness: z.string().max(80).optional(),
    probeItemId: z.string().min(1).max(120).optional(),
    confirm: z.boolean().optional().describe('false/omitted = read-only preview; true = gated materialization'),
  }),
  async handler(args) {
    const result = await materializePilotCohort(args);
    return { data: result };
  },
});
