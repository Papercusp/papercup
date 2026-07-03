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
import { resolveClaimSpecWorkspace, setClaimSpec } from '../../scheduler/claim-spec-store';
import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';

/**
 * The coding-FACTORY push-pipeline roles: each is HANDED a FEATURE_ID by the orchestrator
 * spine (NEXT_SCOPER/NEXT_ARCHITECT/… all carry `FEATURE_ID=`) and NEVER calls
 * scheduler:get_next, so a claim-spec set on one is INERT — the exact bee-vs-scoper conflation
 * this advisory guards (coding-hive-bee-vs-coding-factory-scoper-2026-06-23).
 *
 * This is deliberately the INVERSE of a self-pulling allowlist (the prior `{bee,queen}` denylist).
 * A self-puller is a coding-hive bee, the queen, OR an su fleet LEADER/MEMBER instructed to pull
 * via get_next (su-loop-capability-parity P-001/P-003) — plus a plain su session with no nursery
 * row. NONE of those appear here, so none trip the advisory: the fix for the false-positive that
 * fired 'INERT spec' on every SU fleet member. We warn ONLY for a spawned role that is a genuine
 * factory push-role. Mirrors FACTORY_PIPELINE_ROLES in fleet/operator-spawn.ts; kept local (and
 * inclusive of `worker`, which that set omits because it validates a worker via chunk-presence
 * instead) because a worker also never self-pulls, so a spec on one is equally inert.
 */
const FACTORY_PUSH_ROLES = new Set([
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'documenter',
  'curator',
  'director',
]);

/**
 * Pure advisory decision (unit-testable without the nursery): given the target's spawned role
 * (from lookupSpawnedRole — or null when no spawn row resolves: a plain su session, an su fleet
 * member launched as a bare collaborator, a queen), return the prominent INERT-spec warning ONLY
 * when the role is a coding-FACTORY push role. A null/unknown role, a bee/queen, or an su fleet
 * leader/member returns null — no false-positive on every SU fleet member (su-loop-capability-parity
 * P-003). Exported for the advisory unit test.
 */
export function claimSpecInertWarning(beeId: string, spawnedRole: string | null): string | null {
  if (!spawnedRole || !FACTORY_PUSH_ROLES.has(spawnedRole)) return null;
  return (
    `beeId "${beeId}" was spawned as role="${spawnedRole}", a coding-FACTORY push-pipeline role ` +
    'that is HANDED a FEATURE_ID and never calls scheduler:get_next — so this claim-spec is INERT ' +
    '(it will never select any work). Claim-specs steer SELF-PULLING agents: a coding-hive bee ' +
    '(role="bee"), the queen, or an su fleet leader/member instructed to pull via get_next. ' +
    'Did you mean to push a FEATURE_ID to this factory role, or to steer a self-puller instead?'
  );
}

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
    "Steer a SELF-PULLING agent — a coding-hive bee, the queen, or an su fleet member — by setting/replacing its versioned claim spec (view.filter + rank). The agent's scheduler:get_next then pulls deterministically per this spec within the global floors. Re-steer a running puller by setting a new spec (the revision bumps; it's picked up on the next get_next) — not by micro-dispatching. Validates the spec; returns { ok, errors, revision }.",
  guidance: {
    when:
      'Steer a SELF-PULLING agent that calls scheduler:get_next: a coding-hive bee, the queen, or an su fleet member. Set a property-filtered view plus rank for a standing lane; use `id in [...]` only for a static pinned wave. Re-steer by bumping the spec, not by micro-dispatching.',
    notWhen:
      'A coding-FACTORY push role (scoper/architect/worker/validator): it is handed a FEATURE_ID and never calls get_next, so a spec is inert. Not for hand-picked micro-dispatch, or for overriding global floors (blocked/ready/dedup/cursed) — the resolver enforces those.',
    chaining: 'scheduler:set_claim_spec → the puller applies it on the next scheduler:get_next.',
    seeAlso: [
      'scheduler:get_next (the puller pulls per this spec)',
      'scheduler:running (what is executing now)',
      'fleet:assignments (drill into a member/bee)',
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
    // WI-1564 (LIVE-1 D5): thread the caller's workspace — omitting it landed
    // the row under DEFAULT_COORD_WORKSPACE 'default', whose (workspace, hive)
    // outbox handle no drain serves, so a hive-scoped spec NEVER federated.
    // The reader (scheduler:get_next) resolves through the SAME helper.
    const res = await setClaimSpec({
      beeId: args.beeId,
      workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
      spec: args.spec,
      updatedBy: ident.ownerId,
      hiveSlug,
    });

    // Best-effort inert-spec guard (coding-hive-bee-vs-coding-factory-scoper-2026-06-23): a claim
    // spec only STEERS a SELF-PULLING agent (a coding-hive bee, the queen, or an su fleet
    // leader/member instructed to pull) that calls scheduler:get_next. The observed mistake was
    // setting claim-specs on a coding-FACTORY role (scoper/architect/worker/…), which never calls
    // get_next — the spec just sits there, INERT. Resolve the beeId's spawned role and, when it's a
    // factory push-role, attach a prominent `warning`. Advisory ONLY (not a hard reject): the beeId
    // may be a session id with no nursery row, a queen, or an su fleet member — none of which warn
    // (su-loop-capability-parity P-003: no false-positive on every SU fleet member).
    const spawnedRole = await lookupSpawnedRole(args.beeId);
    const out: Record<string, unknown> = { ...res };
    const roleWarning = claimSpecInertWarning(args.beeId, spawnedRole);
    if (roleWarning) {
      // Append — never clobber the store's WI-1564 strand warning.
      out.warning = out.warning ? `${out.warning as string}\n${roleWarning}` : roleWarning;
    }
    return { data: out };
  },
});
