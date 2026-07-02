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
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';

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
    when: "THE dispatch surface for a SELF-PULLING coding-HIVE worker (role=\"bee\", or the queen) that calls scheduler:get_next — not micro-dispatch. coding-FACTORY roles (scoper/architect/worker) are PUSHED a FEATURE_ID and never self-pull, so a spec on them is INERT — spawn role=\"bee\" for a self-puller. Encode a scoped VIEW (filter) + ORDERING (rank) over the work-item DAG: a property filter (plan/paths/tags/priority) for a standing, auto-inflowing, steal-able lane; `id in [...]` ONLY to pin a STATIC wave (hotfix/cutover — no auto-inflow, no stealing). Re-steer by setting a NEW spec (revision bumps; the bee picks it up on its next get_next), never by re-dispatching.",
    notWhen:
      "A coding-FACTORY role (scoper/architect/worker/validator) — PUSHED a FEATURE_ID, never calls get_next, so a spec is INERT; push the FEATURE_ID. Micro-dispatching hand-picked items, or selecting on `id` ALONE for a STANDING lane (hand-listing in disguise) — write a property filter. Global floors (blocked/ready/dedup/cursed) are always resolver-enforced, not set here.",
    chaining: "scheduler:set_claim_spec (you) → the bee's scheduler:get_next pulls per the spec.",
    seeAlso: [
      'scheduler:get_next (the bee pulls per this spec)',
      'scheduler:running (what is executing now)',
      'fleet:assignments (drill into a bee)',
    ],
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
    // P-016 (cross-machine-coord-parity): federate the spec when the queen is in a
    // single shared-hive workspace, so a bee pulling on ANOTHER machine sees it.
    // ctx harness wins (a harness-scoped queen); else the workspace's one shared
    // hive; else null (operator-scope / local-only — today's behavior). Best-effort:
    // a scope-resolve failure degrades to local (never blocks the spec write).
    let hiveSlug: string | null = null;
    try {
      const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
      const ctxHarness =
        typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*'
          ? ctxHarnessRaw
          : undefined;
      if (ctxHarness) hiveSlug = ctxHarness;
      else if (ident.workspaceId && ident.workspaceId !== '*') {
        const scope = await resolveWorkspaceHiveScope(ident.workspaceId);
        if (scope.kind === 'one') hiveSlug = scope.homeSlug;
      }
    } catch {
      hiveSlug = null;
    }
    const res = await setClaimSpec({ beeId: args.beeId, spec: args.spec, updatedBy: ident.ownerId, hiveSlug });

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
