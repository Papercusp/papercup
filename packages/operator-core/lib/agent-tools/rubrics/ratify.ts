/**
 * rubrics:ratify — ratify a proposed rubric → status "active"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001). An active rubric is the shared
 * definition EVERY agent grades against, so the bar is higher than a one-off observation.
 *
 * D-001 GATE: the ratifying authority is the QUEEN/owner (fully autonomous — not a human
 * sign-off). v1 enforces this softly: the queen role is in COORD_ROLES, and superuser
 * callers bypass the role gate (so the owner/su can seed). Hardening the gate to
 * queen-only (via the autonomy policy) is a v2 follow-up; the intent is documented here.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { ratifyRubric } from '../../rubrics';

export default defineTool({
  name: 'rubrics:ratify',
  profile: 'engineer',
  description:
    'Ratify a proposed rubric → status "active" (D-001: the Queen/owner gate — an active rubric becomes the shared definition every agent grades against). Returns the activated rubric.',
  guidance: {
    when: 'You are the Queen/owner reviewing a proposed rubric and judge it a sound shared standard. Activating it makes every agent grade structured observations against it.',
    notWhen: 'Authoring or revising content — rubrics:propose. You are not the ratifying authority — leave it proposed and flag the Queen.',
    chaining: 'rubrics:list { status: "proposed" } → rubrics:get → rubrics:ratify.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ rubricId: z.string().min(1).describe('the rubric slug to activate') }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await ratifyRubric(args.rubricId, id.ownerId);
    if (!rubric) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'rubric not found' }) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rubric }) }] };
  },
});
