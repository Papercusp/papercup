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
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setClaimSpec } from '../../scheduler/claim-spec-store';

/**
 * The roles that actually self-pull via scheduler:get_next, so a claim-spec STEERS them.
 * Every other role (the coding-FACTORY push-pipeline roles scoper/architect/worker/validator/…)
 * never calls get_next, so a spec set on it is INERT — the exact bee-vs-scoper conflation this guards
 * (coding-hive-bee-vs-coding-factory-scoper-2026-06-23).
 */
const SELF_PULLING_ROLES = new Set(['bee', 'queen']);

/**
 * Best-effort: resolve the role a `beeId` was spawned as, by looking it up in the nursery
 * (harness_shared.spawned_agents). `beeId` is the bee's session/owner id, which the nursery records
 * under ANY of spawn_id / session_owner / session_id (the fleet-assignment-view alias set), so match
 * all three. Returns null when no spawn row resolves (a plain session id with no nursery record, a
 * superuser, etc.) — the caller then skips the warning. Swallows every lookup error: a claim-spec
 * write must never fail on this advisory probe.
 */
async function lookupSpawnedRole(beeId: string): Promise<string | null> {
  try {
    const sql = getOrgPg().sql;
    const rows = (await sql`
      SELECT child_role
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${beeId} OR session_owner = ${beeId} OR session_id = ${beeId}
       ORDER BY started_at DESC
       LIMIT 1`) as Array<{ child_role: string | null }>;
    return rows[0]?.child_role ?? null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'scheduler:set_claim_spec',
  profile: 'engineer',
  description:
    "Queen: set/replace a bee's versioned claim spec (view.filter + rank). The bee's scheduler:get_next then pulls deterministically per this spec within the global floors. Re-steer a running bee by setting a new spec (the revision bumps; the bee picks it up on its next get_next) — not by micro-dispatching. Validates the spec; returns { ok, errors, revision }.",
  guidance: {
    when: "Handing work to a bee IS authoring its claim spec — this is THE dispatch surface, not micro-dispatch. A claim spec ONLY steers a self-pulling coding-HIVE worker: role=\"bee\" (or the queen). The coding hive = a queen + self-pulling bees (claim-spec / scheduler:get_next); the coding-FACTORY is a different model — a scoper→architect→worker PUSH pipeline whose roles get a FEATURE_ID pushed and never self-pull, so a spec set on a scoper/architect/worker is INERT. For a claim-spec self-pulling worker spawn role=\"bee\", NOT scoper. Encode a scoped VIEW (filter) + ORDERING (rank) over the work-item DAG: describe a LANE by property (plan/paths/tags/priority) for a standing, auto-inflowing, steal-able lane; reach for `id in [...]` ONLY to pin a fixed WAVE (hotfix/cutover/re-driving a known set — it is STATIC: no auto-inflow, no work-stealing). The bee self-pulls via get_next within the global floors. Re-steer a running bee by setting a new spec (the revision bumps; it picks it up on its next get_next), never by re-dispatching.",
    notWhen:
      'Steering a coding-FACTORY pipeline role (scoper/architect/worker/validator/…): those are PUSHED a FEATURE_ID and never call scheduler:get_next, so a spec on them is INERT — push the FEATURE_ID instead (and for a self-pulling worker, spawn role="bee"). Hand-picking each item for a bee (micro-dispatch) — encode the policy in the spec instead. A spec that selects on `id` ALONE for a STANDING lane is hand-listing in disguise (recorded as an id-pin) — write a property filter. Global hard floors (blocked/ready/dedup/cursed) cannot be set here — the resolver always enforces them.',
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

    // Best-effort bee-vs-scoper guard (coding-hive-bee-vs-coding-factory-scoper-2026-06-23): a claim
    // spec only STEERS a self-pulling role (role="bee", or the queen) that calls scheduler:get_next.
    // The observed mistake was setting claim-specs on a coding-FACTORY role (scoper/architect/worker/…),
    // which never calls get_next — the spec just sits there, INERT, and the agent never pulls. Resolve
    // the beeId's spawned role and, when it's a non-self-pulling role, attach a prominent `warning`.
    // Advisory ONLY (not a hard reject): the beeId may be a session id with no nursery row, or a queen.
    const spawnedRole = await lookupSpawnedRole(args.beeId);
    const out: Record<string, unknown> = { ...res };
    if (spawnedRole && !SELF_PULLING_ROLES.has(spawnedRole)) {
      out.warning =
        `beeId "${args.beeId}" was spawned as role="${spawnedRole}", which is NOT a self-pulling ` +
        'coding-hive role. Claim-specs steer self-pulling BEES (role="bee") that call scheduler:get_next; ' +
        `a "${spawnedRole}" never calls get_next, so this spec is INERT (it will never select any work). ` +
        'Did you mean to spawn a bee? — fleet:spawn { role:"bee", … }, then set this claim-spec on it.';
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
});
