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
import { fetchWakeability } from '../coordination/presence-wakeability';

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
 * Pure advisory decision (unit-testable without PG): EI-6079 — `fleet:assignments`
 * can show a bee as alive/present (a fresh nursery heartbeat, or presence written
 * at launch) while it has NOT YET registered a live `coord:inbox-wake:<id>` await
 * (e.g. a just-spawned session still in its launch→first-await window — the
 * `recorded` sessionState in presence-wakeability.ts) or has already lost it (a
 * dead/reaped row). Either way, `scheduler:set_claim_spec` steering that bee looks
 * like it worked (the spec write itself always succeeds — the resolver doesn't
 * care whether anyone will ever apply it), but a SUBSEQUENT `coord:send { wake:
 * "required" }` warm-inject silently returns `woken:0`: the placement layer
 * believes warm reuse is available when the wake layer cannot actually reach the
 * session. Surfacing that mismatch HERE, at spec-set time, is the earliest point
 * a caller can catch it — instead of discovering it only after a wake attempt
 * fails. Advisory only (mirrors claimSpecInertWarning): never blocks the write,
 * since the bee may simply not have reached its first await YET and will be
 * wakeable moments later.
 */
export function claimSpecWakeabilityWarning(beeId: string, wakeable: boolean | null): string | null {
  if (wakeable !== false) return null; // true, or unknown (null) — never cry wolf on a lookup miss
  return (
    `beeId "${beeId}" has NO live coord:inbox-wake standing await right now — a subsequent ` +
    'coord:send { wake:"required" } warm-inject to this bee will return woken:0 even though ' +
    "fleet:assignments may show it alive (EI-6079: a fresh spawn hasn't reached its first await " +
    'yet, or the session already ended/was reaped). The spec is stored regardless (it applies ' +
    'whenever the bee next calls scheduler:get_next), but do not rely on warm-injecting THIS bee ' +
    'until coord:presence shows it wakeable — relaunch/re-check instead of assuming reuse.'
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
  args: z
    .object({
      beeId: z
        .string()
        .min(1)
        .optional()
        .describe('the bee to steer (its session/owner id) — exactly one of beeId | fleet'),
      fleet: z
        .string()
        .min(1)
        .optional()
        .describe(
          'a FLEET slug to steer as a whole (fleet-scheduler-hardening P-002): stores the spec under the fleet:<slug> sentinel; every member WITHOUT a per-bee spec inherits it on their next get_next (bee spec → fleet spec → default). The standing-lane lever for fleet relaunches — fresh members inherit the lane with no per-bee re-authoring. A per-bee spec always wins over the fleet spec.',
        ),
      spec: z
        .record(z.string(), z.unknown())
        .describe(
          'the claim spec: { specVersion, specId, revision, view:{ filter }, rank:{ mode, terms }, limits? } — validated by validateClaimSpec. ' +
            'CONCRETE SHAPES (EI-4832 — get these wrong and the write is rejected): ' +
            'specVersion is the STRING "1.0" (not "1" or a number). ' +
            'view.filter is an ARRAY of LEAF predicates { field, op, value } — NOT nested { field: { op: value } }; ' +
            'field is an item field (priority|tags|kind|risk_tier|paths|plan|plan_item|age|redundancy|est_cost|assignee|id — NOT blocked/cursed, those are floors the resolver always ANDs in); ' +
            'op is one of = | != | < | <= | > | >= | in | contains | glob. ' +
            'rank.mode is "lexicographic" (each term breaks ties in order) or "weighted" (a single weighted sum — every term then needs a numeric `weight`). ' +
            'rank.terms is an ARRAY of { expr, dir } — NOT { field, order }; expr is a bare item field (e.g. "priority") or a function term (affinity(bee.held_paths,item.paths) | model_fit(bee.model,item) | tag_weight(tags) | redundancy_need); dir is "asc" or "desc". ' +
            'EXAMPLE: { specVersion:"1.0", specId:"bc-general", revision:1, view:{ filter:[{ field:"kind", op:"in", value:["bug","change"] }] }, rank:{ mode:"lexicographic", terms:[{ expr:"priority", dir:"asc" }, { expr:"age", dir:"desc" }] } }.',
        ),
    })
    .refine((a) => Boolean(a.beeId) !== Boolean(a.fleet), {
      message: 'pass exactly ONE of beeId (steer one bee) or fleet (steer the whole fleet via inheritance)',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // Fleet target (P-002): validate the fleet exists (mirrors WI-1408 — a typo'd slug
    // must fail loud, not store a spec no member will ever inherit), then store under
    // the sentinel key. Membership-spec resolution happens bee-side in getClaimSpec.
    let targetBeeId = args.beeId as string;
    if (args.fleet) {
      const fleetSlug = args.fleet.trim();
      const wsForFleet =
        ident.workspaceId && ident.workspaceId !== '*' ? ident.workspaceId : undefined;
      const { getFleet } = await import('../../agent-fleets-store');
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const record = await getFleet(wsForFleet ?? activeWorkspaceId(), fleetSlug);
      if (!record) {
        return {
          data: {
            ok: false,
            errors: [
              `fleet \`${fleetSlug}\` does not exist in this workspace — a fleet-level spec for it would never be inherited (check the slug, or create the fleet first)`,
            ],
          },
        };
      }
      const { fleetSpecBeeKey } = await import('../../scheduler/claim-spec-store');
      targetBeeId = fleetSpecBeeKey(fleetSlug);
    }
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
      beeId: targetBeeId,
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
    // (Skipped for a FLEET target — the sentinel key is not a spawned agent.)
    const spawnedRole = args.fleet ? null : await lookupSpawnedRole(targetBeeId);
    const out: Record<string, unknown> = { ...res };
    const roleWarning = args.fleet ? null : claimSpecInertWarning(targetBeeId, spawnedRole);
    if (roleWarning) {
      // Append — never clobber the store's WI-1564 strand warning.
      out.warning = out.warning ? `${out.warning as string}\n${roleWarning}` : roleWarning;
    }

    // EI-6079: best-effort wakeability check, same advisory-only posture as the
    // role warning above — a lookup failure or unknown result NEVER warns (null
    // reads as "don't know", not "not wakeable"), so this can never cry wolf on a
    // transient PG hiccup or a resolution the wakeability query doesn't cover.
    if (!args.fleet) {
      let wakeable: boolean | null = null;
      try {
        wakeable = (await fetchWakeability([targetBeeId])).get(targetBeeId)?.wakeable ?? null;
      } catch {
        wakeable = null;
      }
      const wakeWarning = claimSpecWakeabilityWarning(targetBeeId, wakeable);
      if (wakeWarning) {
        out.warning = out.warning ? `${out.warning as string}\n${wakeWarning}` : wakeWarning;
      }
    }

    return { data: out };
  },
});
