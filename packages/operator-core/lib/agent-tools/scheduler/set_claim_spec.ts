/**
 * scheduler:set_claim_spec — the Queen's steer-don't-dispatch lever
 * (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The Queen expresses her scheduling judgment for a bee as a versioned claim SPEC
 * (view.filter + rank, from the prioritization-primitive vocabulary). The bee's
 * scheduler:get_next then deterministically pulls per this spec within the global floors.
 * Re-steering a running bee is a spec bump (the revision increments) — not micro-dispatch.
 * The spec is validated (validateClaimSpec) before it is stored (mig 372 bee_claim_specs);
 * global hard floors (blocked/ready/dedup) are NOT spec-settable — the resolver always enforces them.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setClaimSpec } from '../../scheduler/claim-spec-store';

export default defineTool({
  name: 'scheduler:set_claim_spec',
  profile: 'engineer',
  description:
    "Queen: set/replace a bee's versioned claim spec (view.filter + rank). The bee's scheduler:get_next then pulls deterministically per this spec within the global floors. Re-steer a running bee by setting a new spec (the revision bumps; the bee picks it up on its next get_next) — not by micro-dispatching. Validates the spec; returns { ok, errors, revision }.",
  guidance: {
    when: "You are the Queen steering a bee: encode WHICH work and in WHAT order as the bee's claim spec, then let the bee self-pull via get_next. To re-prioritize a running bee, set a new spec.",
    notWhen:
      'Hand-picking each item for a bee (micro-dispatch) — encode the policy in the spec instead. Global hard floors (blocked/ready/dedup) cannot be set here — the resolver always enforces them.',
    chaining: "scheduler:set_claim_spec (you) → the bee's scheduler:get_next pulls per the spec.",
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    beeId: z.string().min(1).describe('the bee to steer (its session/owner id)'),
    spec: z
      .record(z.string(), z.unknown())
      .describe(
        'the claim spec: { specVersion, specId, revision, view:{ filter }, rank:{ mode, terms }, limits? } — validated by validateClaimSpec',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const res = await setClaimSpec({ beeId: args.beeId, spec: args.spec, updatedBy: ident.ownerId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
