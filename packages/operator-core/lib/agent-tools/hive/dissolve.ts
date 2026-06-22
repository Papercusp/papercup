/**
 * hive:dissolve — tear down a local hive (hive-tool-namespace-2026-06-08 P-005,
 * D-002/D-006). The durable inverse of hive:create.
 *
 * Steps (idempotent; each tolerant of already-done):
 *   1. clear the per-slug hive time-wake routine → the Queen won't re-wake (an
 *      in-flight Queen turn finishes naturally; event-wake subs are
 *      workspace-scoped, not per-hive, so they're left to avoid clobbering
 *      sibling hives — known limitation).
 *   2. cancel every live bee in the hive's home harness (+ its subtree).
 *   3. deregister the home harness from the workspace registry.
 *   3.5. tear down the hive's learning loop — the dark gym autoloop row, the
 *      inactive scout routine, and the gym:<hive>/scout:<hive> governor
 *      registrants provisionHiveLearningLoop laid down at hive:create
 *      (per-hive-learning-loops-2026-06-14 P-021; D-003). Best-effort: a failure
 *      WARNS but never fails the dissolve. Without it per-hive routines leak past
 *      dissolve.
 *   3.6. release the hive's leased sandbox desktop (capability:computer) if any —
 *      kill the in-process Xvfb child + free the display (inverse of
 *      ensureHiveDesktop). Idempotent + best-effort (WARNS, never fails dissolve).
 *   4. OPTIONALLY drop the harness PG schema (default keep — deregister only).
 *
 * ROOT-ONLY (D-002) + confirm-gated (destructive). Does NOT call
 * deploy:teardown_hive — destroying a deployed cloud frame is a separate step.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { listFleetAssignments } from '../../fleet/assignments';
import { cancelSubtree } from '../../fleet/nursery';
import { clearHiveTimeWake } from '../../hive/wake';
import { dropHarnessSchema } from '../../scaffold-harness-schema';
import { removeHarnessFromWorkspace } from '../../harness-membership';
import { removeAllHiveMembers } from '../../hive-membership-store';
import { requireHiveTier } from '../../hive/member-tier-gate';
import { teardownHiveLearningLoop } from '../../hive/provision-learning-loop';
import { releaseHiveDesktop } from '../computer/desktop-lease';
import { resolveHive } from './_resolve';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:dissolve',
  profile: 'engineer',
  description:
    "Tear down a local hive (root-only, destructive — pass confirm:true): clear the Queen's wake so she won't re-wake, cancel every live bee + its subtree, and deregister the home harness. Optionally drop the harness PG schema (default keep). Idempotent. Does NOT destroy a deployed cloud frame — that is deploy:teardown_hive.",
  guidance: {
    when: 'Permanently tearing down a local hive — stop the Queen, cancel its bees, deregister it. Operator/user only.',
    notWhen:
      'Destroying a deployed cloud frame (the Queen/member execution planes) — deploy:teardown_hive. Pausing a hive without tearing down — hive:declare-wake { mode:none }. From a bee — not allowed.',
    chaining: 'hive:get { slug } to inspect before; deploy:teardown_hive first if the hive is deployed to a Swarm.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The hive's home-harness slug."),
    confirm: z
      .boolean()
      .optional()
      .describe('Required true — hive:dissolve is destructive (stops the Queen, cancels bees, deregisters the harness).'),
    dropSchema: z
      .boolean()
      .optional()
      .describe('Also DROP the harness PG schema (harness_<slug> CASCADE). Default false — keep the data, just deregister.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    // Root-only enforcement (D-002).
    const actor = resolveAgentIdentity(ctx);
    if (actor.source === 'fleet-spawn') {
      return text({
        ok: false,
        error: 'hive_dissolve_root_only',
        message: 'hive:dissolve cannot be called from a bee (a spawned/parented agent). Only the operator/user dissolves a hive.',
      });
    }
    if (!args.confirm) {
      return text({
        ok: false,
        error: 'confirm_required',
        message:
          'hive:dissolve is destructive — pass confirm:true to proceed. It clears the Queen wake, cancels all bees, and deregisters the home harness (dropSchema:true also drops its PG schema).',
      });
    }

    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hive = await resolveHive(args.slug, workspaceId);
    if (!hive) {
      return text({
        ok: false,
        error: 'hive_not_found',
        message: `No kind:'hive' harness '${args.slug}' in this workspace (already dissolved?). Use hive:list to see the hives.`,
      });
    }

    // B11 / P-014 owner-action gate: only an owner-tier member (admin|maintain on
    // the hive's repo, re-derived LIVE from GitHub — never federated state) may
    // dissolve a SHARED hive. Composes with the root-only/confirm gates above; a
    // SOLO/unbound hive is a no-op (the local owner keeps owner tier).
    const gate = await requireHiveTier({ workspaceId, hiveSlug: hive.slug, minTier: 'owner' });
    if (!gate.ok) {
      return text({
        ok: false,
        error: 'insufficient_tier',
        message: gate.message ?? 'You lack owner-tier access to this hive.',
        tier: gate.tier,
        reason: gate.reason,
      });
    }

    const { sql } = getOrgPg();
    const steps: Record<string, unknown> = {};

    // 1. Stop the Queen re-waking (per-slug time-wake routine).
    try {
      await clearHiveTimeWake(sql, hive.slug);
      steps.wakeCleared = true;
    } catch (e) {
      steps.wakeCleared = false;
      steps.wakeError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }

    // 2. Cancel every live bee in the hive's home harness (+ subtree).
    const rows = await listFleetAssignments({ workspaceId, harness: hive.slug });
    const beeIds = [
      ...new Set(rows.filter((r) => r.holderAlive && r.agentId).map((r) => r.agentId as string)),
    ];
    const cancelledSpawns: string[] = [];
    for (const beeId of beeIds) {
      try {
        const res = await cancelSubtree(sql, {
          workspaceId,
          rootSpawnId: beeId,
          reason: 'hive:dissolve',
          actor,
        });
        const { abortLocalSpawn } = await import('../../fleet/operator-spawn');
        for (const c of res.cancelled) {
          cancelledSpawns.push(c.spawnId);
          abortLocalSpawn(c.spawnId);
        }
      } catch (e) {
        console.warn(`[hive:dissolve] cancel bee ${beeId} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    steps.cancelledSpawns = cancelledSpawns;

    // 2.5. Delete the hive's membership records (G24 — shared-hive-public-release-
    // 2026-06-22). dissolve previously left harness_shared.hive_members rows behind,
    // so a dissolved hive's members lingered and kept federating. Delete them all
    // (done BEFORE deregister, while the substrate is still live): the mig-189
    // capture trigger enqueues a `del` per local-origin row → federates a membership
    // tombstone so peers' read-merge drops the departed members. Best-effort: a
    // failure WARNS but never fails the dissolve (same contract as 3.5/3.6).
    try {
      steps.membershipRowsDropped = await removeAllHiveMembers(workspaceId, hive.slug, sql);
    } catch (e) {
      steps.membershipRowsDropped = 0;
      steps.membershipError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[hive:dissolve] hive_members teardown for ${hive.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3. Deregister the home harness.
    const dereg = await removeHarnessFromWorkspace(workspaceId, hive.slug);
    steps.deregistered = dereg.changed;

    // 3.5. Tear down the hive's learning loop (the inverse of provisionHiveLearning-
    // Loop at hive:create — dark gym autoloop row, inactive scout routine, and the
    // gym:<hive>/scout:<hive> governor registrants). Best-effort: a failure WARNS
    // but never fails the dissolve (P-021 / D-003). Without it per-hive routines
    // leak past dissolve and a stale scout routine could re-arm.
    try {
      const loop = await teardownHiveLearningLoop({ sql, workspaceId, hiveSlug: hive.slug });
      steps.learningLoopTornDown = true;
      steps.learningLoop = loop;
    } catch (e) {
      steps.learningLoopTornDown = false;
      steps.learningLoopError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[hive:dissolve] learning-loop teardown for ${hive.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 3.6. Release the hive's leased sandbox desktop, if any (capability:computer /
    // computer-tool-plan 2.4 — the inverse of ensureHiveDesktop). The Xvfb child lives in
    // THIS operator loop; releaseHiveDesktop kills it + frees the display. Idempotent +
    // best-effort: a no-op when the hive never leased a desktop, and a failure WARNS but
    // never fails the dissolve (same contract as the learning-loop teardown above).
    try {
      await releaseHiveDesktop(hive.slug);
      steps.desktopReleased = true;
    } catch (e) {
      steps.desktopReleased = false;
      steps.desktopError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.warn(
        `[hive:dissolve] desktop release for ${hive.slug} failed (dissolve unaffected): ${e instanceof Error ? e.message : e}`,
      );
    }

    // 4. Optional schema drop (default keep).
    if (args.dropSchema) {
      try {
        await dropHarnessSchema(hive.slug);
        steps.schemaDropped = true;
      } catch (e) {
        steps.schemaDropped = false;
        steps.schemaError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
    } else {
      steps.schemaDropped = false;
    }

    return text({ ok: true, slug: hive.slug, ...steps });
  },
});
