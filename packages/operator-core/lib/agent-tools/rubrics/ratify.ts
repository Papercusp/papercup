/**
 * rubrics:ratify — ratify one OR many proposed rubrics → status "active"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21). An active rubric is the shared
 * definition EVERY agent grades against, so the bar is higher than a one-off observation.
 *
 * D-001 GATE: the ratifying authority is the QUEEN/owner (fully autonomous — not a human
 * sign-off). v1 enforces this softly: the queen role is in COORD_ROLES, and superuser
 * callers bypass the role gate (so the owner/su can seed). Hardening the gate to
 * queen-only (via the autonomy policy) is a v2 follow-up; the intent is documented here.
 *
 * Bulk by default (the house keyed-array contract): ratify ONE inline ({ rubricId
 * }), MANY (rubricIds:[…]) → { ok, results:[{ ok, rubricId, rubric? | error }],
 * counts }. Each result self-describes its rubricId; one not-found id never fails
 * the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { ratifyRubric } from '../../rubrics';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'rubrics:ratify',
  profile: 'engineer',
  description:
    'Ratify one OR many proposed rubrics → status "active" (D-001: the Queen/owner gate — an active rubric becomes the shared definition every agent grades against). Single: { rubricId }. Many: { rubricIds:[…] }. Returns { ok, results:[{ ok, rubricId, rubric? | error }], counts } — correlate by rubricId, not by position; a not-found id never fails the rest.',
  guidance: {
    when: 'You are the Queen/owner reviewing proposed rubric(s) and judge them sound shared standards. Activating one makes every agent grade structured observations against it. Ratify several at once via rubricIds:[…].',
    notWhen: 'Authoring or revising content — rubrics:propose. You are not the ratifying authority — leave it proposed and flag the Queen.',
    chaining: 'rubrics:list { status: "proposed" } → rubrics:get → rubrics:ratify { rubricIds:[…] }. Bulk: single | rubricIds[] → { ok, results, counts }; correlate by rubricId not position; one failure never fails the rest.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      rubricId: z.string().min(1).optional().describe('single-ratify shorthand: the rubric slug to activate'),
      rubricIds: z.array(z.string().min(1)).min(1).max(100).optional().describe('rubric slugs to activate (1–100)'),
    })
    .refine((a) => Boolean(a.rubricId) || (a.rubricIds?.length ?? 0) > 0, {
      message: 'pass `rubricId` (one) or `rubricIds` (many)',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.rubricId, args.rubricIds);
    const env = await runBulk(
      ids,
      async (rubricId) => {
        const rubric = await ratifyRubric(rubricId, id.ownerId);
        return rubric
          ? { ok: true as const, rubricId, rubric }
          : { ok: false as const, rubricId, error: 'rubric not found' };
      },
      { keyOf: (rubricId) => ({ rubricId }) },
    );
    return bulkContent(env);
  },
});
