/**
 * scheduler:get_next — the bee's spec-driven self-select (hybrid-bee-scheduler-work-stealing-2026-06-22).
 *
 * The bee calls get_next; the resolver loads the bee's Queen-issued claim spec (mig 372
 * bee_claim_specs; DEFAULT_CLAIM_SPEC when none) and atomically claims the single next eligible
 * work-item: the GLOBAL FLOORS (ready/blocking, lease, admission, swarm-affinity, dedup) AND the
 * spec's view.filter, ordered by the spec's rank, FOR UPDATE SKIP LOCKED. The spec can only
 * narrow + reorder within the floors (D-002); it can never claim a blocked/taken item.
 *
 * The richer sibling of work_items:claim_next (which is plain oldest-first, spec-blind): here the
 * Queen's scheduling judgment, expressed as the bee's spec, decides WHICH item; pickup stays the
 * bee's (self-selection, the blackboard result).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getNextForBee } from '../../scheduler/claim-spec-store';

export default defineTool({
  name: 'scheduler:get_next',
  profile: 'engineer',
  description:
    'Bee self-select via your Queen-issued claim SPEC: atomically claim the next eligible work-item — the global floors (ready/blocking, lease, admission, dedup) AND your spec.view.filter, ordered by spec.rank, SKIP LOCKED. No spec set ⇒ the default ordering (== work_items:claim_next). Returns the claimed item + the spec revision that selected it, or null.',
  guidance: {
    when: 'You are a coding-HIVE bee (role="bee") picking up your next item — call this instead of scanning the raw frontier or self-prioritizing. Scheduling is your Queen\'s judgment expressed as your claim spec; the pickup is yours. The coding hive = a queen + self-pulling bees (claim-spec / get_next). NOTE the contrast: the coding-FACTORY is a different model — a scoper→architect→worker PUSH pipeline whose roles are HANDED a FEATURE_ID and never call get_next. So a claim-spec self-pulling worker is role="bee", NOT scoper; only a bee/queen self-pulls here.',
    notWhen:
      'You are a coding-FACTORY pipeline role (scoper/architect/worker/validator/…): you are PUSHED a FEATURE_ID by the orchestrator spine and do NOT self-pull — never call get_next. Claiming a SPECIFIC item by id — that is work_items:claim. Plain oldest-first self-select with NO per-bee spec — work_items:claim_next.',
    chaining:
      'scheduler:get_next → work_items:set_state (progress) → work_items:release. Your Queen re-steers you via scheduler:set_claim_spec (the spec revision bumps; you pick it up on your next get_next).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    heldPaths: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('paths you already hold open — the affinity rank-term input (default: none)'),
    states: z.array(z.string()).max(20).optional().describe('claimable states (default ["todo"])'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // SCHEDULER_SPEC_CLAIM kill-switch (default ON; fail-open): OFF ⇒ ignore the bee's stored
    // spec and claim by the DEFAULT ordering (a no-breakage degrade to claim_next behavior).
    const specOn = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ident.ownerId).catch(() => true);
    const res = await getNextForBee({
      beeId: ident.ownerId,
      harness: args.harness,
      heldPaths: args.heldPaths,
      states: args.states,
      ignoreStoredSpec: !specOn,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            res
              ? { ok: true, workItem: res.workItem, claimedUnder: res.claimedUnder }
              : { ok: false, error: 'no claimable work-item matched your spec within the floors' },
          ),
        },
      ],
    };
  },
});
