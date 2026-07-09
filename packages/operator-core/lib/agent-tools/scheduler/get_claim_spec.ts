/**
 * scheduler:get_claim_spec — the READ verb for the claim-spec store (EI-7678).
 *
 * Claim specs were write-only from the tool surface: verifying a bee's or fleet's CURRENT
 * spec/revision meant grepping source for the zod grammar or hand-rolling a raw
 * `bee_claim_specs` query. A leader who just called scheduler:set_claim_spec had no
 * tool-surface way to confirm the re-steer actually landed before relying on it. Trivial read
 * projection over claim-spec-store's getClaimSpecRecord (bee spec → fleet spec → DEFAULT).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveClaimSpecWorkspace, getClaimSpecRecord, fleetSpecBeeKey } from '../../scheduler/claim-spec-store';

export default defineTool({
  name: 'scheduler:get_claim_spec',
  profile: 'engineer',
  description:
    'Read the CURRENT claim spec for a bee or fleet: { source, spec, revision, updatedBy, updatedAt, harnessSlug, fleetSlug? }. `source` tells you which row actually answered — "bee" (a per-bee spec, always wins), "fleet" (inherited via membership, no per-bee override), or "default" (neither exists — DEFAULT_CLAIM_SPEC/oldest-first applies). The read counterpart to scheduler:set_claim_spec — confirm a re-steer landed before relying on it, instead of grepping source or guessing.',
  guidance: {
    when:
      'You just called scheduler:set_claim_spec and want to confirm the write landed (right revision, right filter/rank) — or you want to know WHAT spec a bee/fleet is currently running under before re-steering it. Pass exactly one of cupId | fleet.',
    notWhen:
      'Setting/replacing a spec — scheduler:set_claim_spec. What is executing right now under which spec (the live-execution view across many bees) — scheduler:running. Full fleet roster / orphaned-claim detection — fleet:assignments.',
    chaining: 'scheduler:get_claim_spec (confirm current) → scheduler:set_claim_spec (re-steer) → scheduler:get_claim_spec (confirm the bump landed).',
    seeAlso: [
      'scheduler:set_claim_spec (write/re-steer a spec)',
      'scheduler:running (live-execution view across many bees)',
      'fleet:assignments (full fleet roster)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      cupId: z.string().min(1).optional().describe('the cup to read (its session/owner id) — exactly one of cupId | fleet'),
      fleet: z.string().min(1).optional().describe('a fleet slug — reads the fleet-level sentinel spec directly (not a member\'s inherited view)'),
      workspace: z.string().max(120).optional().describe('override the workspace partition (default: resolved from your identity)'),
    })
    .refine((a) => Boolean(a.cupId) !== Boolean(a.fleet), {
      message: 'pass exactly ONE of cupId (read one cup, with fleet inheritance) or fleet (read a fleet\'s own sentinel spec)',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const workspaceId = resolveClaimSpecWorkspace(args.workspace ?? ident.workspaceId);
    const targetBeeId = args.fleet ? fleetSpecBeeKey(args.fleet.trim()) : (args.cupId as string);
    const record = await getClaimSpecRecord({ cupId: targetBeeId, workspaceId });
    return { data: { ok: true, ...record } };
  },
});
