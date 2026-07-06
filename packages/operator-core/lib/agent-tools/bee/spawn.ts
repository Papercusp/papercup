/**
 * cup:spawn — launch one agent into a registered harness, tracked in the
 * durable nursery (Brief 4, agent-briefs-2026-06-05).
 *
 * The human-testable operator→spawn path: the operator chat brain calls this
 * (or emits the equivalent `<spawn>` tag), a psu/admin shell calls it directly,
 * and the projected HTTP route (`POST /api/agent-tools/bee/spawn?superuser=1`)
 * gives a curl-able admin trigger. All of them land in the same
 * `spawnAgentInHarness` engine → harness_shared.spawned_agents → visible in
 * fleet:tree and cancellable with fleet:cancel.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { softText, clampText, LIMITS } from '../limits';

function inferSingleWorkItemId(text: string | null | undefined): string | null {
  const matches = [...(text ?? '').matchAll(/\b(?:WI|F)-\d+\b/g)].map((m) => m[0]);
  return matches[0] ?? null;
}

export default defineTool({
  name: 'cup:spawn',
  profile: 'engineer',
  description:
    'Spawn one background agent into a harness and return its spawn_id immediately. This is for autonomous-loop workers, not visible desktop terminals; use fleet:launch-on-plan for a desktop fleet on a plan. The run is tracked durably in the nursery, visible in fleet:tree, and stoppable with fleet:cancel. role="worker" requires chunk.',
  guidance: {
    when: 'Use to place a background autonomous worker on new work: a cup, validator, scoper, architect, worker, or another supported role in a harness. Prefer role="cup" for self-pulling claim-spec work; factory roles are handed explicit feature/chunk work.',
    notWhen:
      'Not for visible desktop terminals on a plan (fleet:launch-on-plan), simple lookups, or work that should just enter the durable work-item pipeline. Unsure which spawn tool you want? See the decision table: /internal/docs/agent-insights/desktop-fleet-vs-loop-bee.',
    chaining: 'cup:spawn → (later) fleet:tree { spawn_id } to watch → fleet:cancel { spawn_id } to abort.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  // D-002 (bee-capability-expansion-2026-06-08): spawning agents is PLACEMENT — a
  // Queen-only surface. The Queen calls this as role 'queen' (the registered
  // placement decider, EI-286 follow-up) or 'operator'; the worker-bee is
  // explicitly EXCLUDED. The bee joined COORD_ROLES in local-hive P-011 (so it could
  // coord:* / issues:* / improvements:capture), which inadvertently leaked this
  // placement tool to it via [...COORD_ROLES]. Filtering bee back out restores the
  // pre-bee allowlist and turns "only the brain spawns" from convention into a gate.
  // Also exclude the sentinel: it WATCHES the fleet (fleet:assignments/tree), it
  // does not PLACE agents — placement is the Queen's, the sentinel raises alarms
  // (unify-launch-mechanics D-004). Same carve-out as bee. Overwatch excluded too
  // (overwatch-role-2026-06-15 D-001): it NUDGES the Queen to re-place, never places.
  agentRoles: COORD_ROLES.filter((r) => r !== 'cup' && r !== 'papercup' && r !== 'kettle'),
  args: z
    .object({
      harness: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Registry slug of the harness to spawn into. Optional only when exactly one harness is registered.'),
      role: z
        .string()
        .min(1)
        .max(64)
        .describe(
          'Child agent role. The generic operator-world worker is "cup" — the default for placing a ranked task + brief (NO chunk needed). ' +
            "Coding-pipeline roles (scoper, architect, worker, validator, reviewer, debugger, documenter, curator) apply only inside a kind:'harness' coding harness; " +
            'role="worker" additionally REQUIRES a chunk (spawn a scoper first to chunk the feature). ' +
            'Other spawnable specialists: sentinel, security-reviewer, infra-reviewer, ui-qa, crosscheck, auditor, planner, release-manager. ' +
            'Plugin roles are "<plugin>:<role>". There is NO "engineer" role — an unknown name is rejected with the full valid list (EI-392).',
        ),
      feature: z.string().max(120).optional().describe('Feature id the child should pick up.'),
      chunk: z.string().max(120).optional().describe('Chunk id. Required when role="worker".'),
      brief: softText(LIMITS.BRIEF)
        .optional()
        .describe(
          'Mug brief: situational overlay the cup is missing (cross-cup context, watch-fors, why-this-priority). P-060. Auto-truncated to 16000 chars if longer.',
        ),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          'Place this cup in a NAMED fleet (the durable, color-coded group). Pass the fleet NAME or slug — it is created if absent (you become its leader) and the cup joins as a member at launch: grouped under that fleet in the roster + its terminal recolored to the fleet scheme, with NO brief directive needed. Use ONE fleet per plan/initiative, reused across waves. Omit for an ungrouped cup.',
        ),
      tier: z
        .string()
        .max(40)
        .optional()
        .describe(
          "Model tier for THIS spawn, by name from the user-defined menu — see the MODEL TIERS list in your Runtime context for the live names + the user's per-tier when-to-use guidance (default menu: quick < standard < deep < max). Resolved to a model spec clamped to [role default floor, role ceiling] — a tier can escalate a role, never downgrade it. Omit = the role's standing default. An unknown name fails loud listing the valid menu.",
        ),
      model: z
        .string()
        .max(80)
        .optional()
        .describe(
          'Direct per-spawn model spec `<modelId>[:<effort>]` (e.g. "opus:high") — operator/human escape hatch that bypasses the tier menu (still recorded on the nursery row). Prefer `tier`. When both are set, model wins.',
        ),
      account: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "account-routing-3-options: how THIS spawn's model calls are routed. One of three: " +
            'a POOL ACCOUNT ID → hard-pin to it via the inference gateway (no failover); ' +
            '"auto" → route through the gateway, which auto-selects an available account + fails over; ' +
            '"default" → skip the gateway entirely (system credential, direct egress). ' +
            'Omit = the standing fleet behavior (gateway auto-route when the pool is on). ' +
            'ANNOUNCE the choice to the owner per the persona spawn-disclosure rule.',
        ),
      extras: z
        .array(z.string().max(500))
        .max(16)
        .optional()
        .describe('Extra KEY=value args passed to the child invoke.'),
      workspace: z.string().max(120).optional(),
      idempotency_key: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Dedupe key for retries (EI-73): pass the SAME key when retrying a spawn that may have already landed (e.g. after a timeout) — a match returns the original spawn_id with deduped:true instead of launching a second agent.',
        ),
      // FAIL-LOUD on unknown arg keys (EI-72). zod's default z.object() STRIPS keys it
      // doesn't recognize: when the Queen sent the (then-new) `brief` to a host still
      // running pre-brief code, the unknown key was silently dropped and 5 task-less
      // bees booted and exited 'done'. `.strict()` makes the projection-layer validator
      // (standardValidate in define-tool.ts) reject any unrecognized key with
      // `invalid_args` — so a newer-field caller against an older serving host gets a
      // loud error instead of a silently no-op'd fleet. Placement is the highest-stakes
      // surface to fail loud on; keep this schema closed as new fields are added.
    })
    .strict(),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    // An unscoped (superuser) identity carries workspaceId='*' — never record a
    // nursery row under the wildcard: it would escape the real workspace's
    // ceiling ledger AND announce slot-frees on `spawn-slot:freed:*`, which no
    // real waiter watches (EI-112). Resolve '*' to the active workspace instead.
    const actorWs = actor.workspaceId && actor.workspaceId !== '*' ? actor.workspaceId : null;
    const workspaceId = args.workspace ?? actorWs ?? activeWorkspaceId();
    // Dynamic import (like operator/converse.ts): operator-spawn statically pulls
    // dbos/orchestrator-runner → orchestrator-workflow, which registers the
    // featurePipeline DBOS workflow at module load. A static import here loads that
    // chain at tool-mount time (before startDbos), and the second load via
    // bootstrap's specifier-space then throws "Operation .featurePipeline is
    // already registered" — killing the whole DBOS boot (durable pipelines dead).
    const { spawnAgentInHarness } = await import('../../fleet/operator-spawn');
    // P-005 kill-switch (QUEEN_TIER_SELECTION, default ON): with the flag OFF a
    // queen-supplied tier is dropped — her spawns run at the role's standing
    // default. Human/operator tier picks are honored regardless.
    let tier = args.tier ?? null;
    if (tier && ctx.role === 'mug') {
      const [{ FLAGS }, { getFlag }] = await Promise.all([
        import('@papercusp/flags'),
        import('@papercusp/flags/server'),
      ]);
      if (!(await getFlag(FLAGS.QUEEN_TIER_SELECTION, 'system'))) tier = null;
    }
    // Lineage: link to the caller ONLY when it's itself a real nursery node (a
    // spawned agent's owner == its spawnId, shaped `s-…`). A human/operator/SU
    // caller's ownerId is a session id, not a spawn row — linking to it would
    // make the new row an orphan (getSubtree anchors on a real parent), so such
    // spawns are ROOTS. Inspect either with fleet:tree { spawn_id: <returned id> }.
    const ownerId = actor.ownerId ?? '';
    const parentSpawnId = /^s-/.test(ownerId) ? ownerId : null;
    const brief = clampText(args.brief, LIMITS.BRIEF) ?? null;
    const workItemId = args.feature ?? (args.role === 'cup' ? inferSingleWorkItemId(brief) : null);
    let reservedSpawnId: string | null = null;
    let reservedWorkItemId: string | null = null;
    if (args.role === 'cup' && workItemId) {
      const { claimWorkItem } = await import('../../work-items');
      reservedSpawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const claim = await claimWorkItem(workItemId, reservedSpawnId, { harness: args.harness ?? undefined });
      if (!claim) {
        // WI-1670: an id EXPLICITLY named via `feature` is a deliberate ask — fail
        // loud, the caller should learn it wasn't honored (the pre-existing
        // behavior). An id merely INFERRED from free-text `brief` prose
        // (inferSingleWorkItemId is a best-effort regex over whatever WI-/F- token
        // appears FIRST in the text — including one the caller mentioned only to
        // say "skip this") is a heuristic convenience, not a pin: when that
        // inferred id is already live-claimed by someone else, the whole spawn
        // used to wedge on it every retry (same brief text → same extracted id →
        // same rejection), even though role="bee" is documented as
        // self-pulling. Degrade instead: drop the inferred id and spawn the bee
        // task-less so it self-pulls its own work via scheduler:get_next /
        // work_items:claim_next once it boots, rather than rejecting the spawn
        // over a claim it was never explicitly asked to reserve.
        if (args.feature) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  spawn_id: reservedSpawnId,
                  harness: args.harness ?? null,
                  project_dir: null,
                  error: `spawn rejected: work item ${workItemId} could not be claimed for the new bee`,
                  next: 'inspect the work item holder/state, release stale ownership if appropriate, then retry cup:spawn.',
                }),
              },
            ],
          };
        }
        // Fall through task-less: reservedSpawnId/reservedWorkItemId stay as-is
        // (spawnId still uses the pre-minted reservedSpawnId; featureId/itemId
        // fall back to null since reservedWorkItemId was never set below).
      } else {
        reservedWorkItemId = workItemId;
      }
    }
    // Named-fleet placement (fleet-color-schemes): resolve the fleet (create-if-
    // absent, so the Queen need not fleet:create first — she becomes its leader)
    // + its bound scheme, and thread it so the bee auto-joins (presence label) +
    // recolors its terminal at launch, with NO brief directive. Best-effort: a
    // resolve error just spawns the bee ungrouped.
    let fleetPlacement: { slug: string; role: string; bg: string; fg: string; cursor: string } | null = null;
    // WI-1764 #2: nudge at the moment of confusion. If the `fleet` param names a
    // fleet that did NOT already exist, a BEE spawn just materialised it — which is
    // exactly the mistake that spun up 3 background bees when the caller meant
    // visible desktop members. Still create it (bees can be color-grouped), but flag
    // the substrate so a mis-aimed "launch a fleet" screams instead of silently
    // succeeding. A `fleet` that already existed = deliberate grouping → no advisory.
    let fleetAutoCreated = false;
    if (args.fleet) {
      try {
        const { fleetSlugFromName, createFleetIfAbsent, resolveFleetScheme } = await import('../../agent-fleets-store');
        const fleetSlug = fleetSlugFromName(args.fleet);
        const { record, created } = await createFleetIfAbsent({
          workspaceId,
          fleetSlug,
          title: args.fleet,
          owner: ownerId || null,
          leaderOwnerId: ownerId || null,
        });
        fleetAutoCreated = created;
        const scheme = resolveFleetScheme(record);
        fleetPlacement = {
          slug: fleetSlug,
          role: 'member',
          bg: scheme.bg,
          fg: scheme.fg,
          cursor: scheme.cursor,
        };
      } catch {
        fleetPlacement = null; // fleet resolve failed → spawn ungrouped (best-effort)
      }
    }
    const res = await spawnAgentInHarness({
      workspaceId,
      harness: args.harness ?? null,
      role: args.role,
      spawnId: reservedSpawnId ?? undefined,
      featureId: reservedWorkItemId ?? args.feature ?? null,
      itemId: reservedWorkItemId ?? args.feature ?? null,
      chunkId: args.chunk ?? null,
      brief,
      // The queen's model lever is tier NAMES only (propose/dispose split) —
      // a raw model spec from role=queen is ignored in favor of her tier.
      tier,
      modelSpec: ctx.role === 'mug' ? null : (args.model ?? null),
      // account-routing-3-options: explicit per-spawn routing (pool-id pin / auto / default). Honored
      // for any caller role — the Queen places, but routing is operational, not a model lever.
      accountOverride: args.account ?? null,
      extras: args.extras,
      parentSpawnId,
      parentRole: ctx.role ?? 'operator',
      idempotencyKey: args.idempotency_key ?? null,
      // Coordination-token attribution (B-TOK-4): a cup:spawn'd agent's turn runs
      // because it was placed by a coordinating agent (the Queen / operator) — a
      // coordination trigger. Stamps turn_trigger on the run's usage sample.
      turnTrigger: 'coord-wake',
      fleet: fleetPlacement,
    });
    if (!res.ok && reservedWorkItemId) {
      const { releaseWorkItem } = await import('../../work-items');
      await releaseWorkItem(reservedWorkItemId, { harness: args.harness ?? undefined }).catch(() => {});
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: res.ok,
            spawn_id: res.spawnId,
            harness: res.harness,
            project_dir: res.projectDir,
            error: res.error,
            // Over-ceiling (D-004): never drop or busy-wait — sleep on this key
            // and retry the same spawn on wake (a slot-free announces it).
            ...(res.awaitEvent ? { await_event: res.awaitEvent } : {}),
            ...(res.deduped ? { deduped: true } : {}),
            // WI-1764 #2: loud advisory when this bee-spawn auto-created its fleet.
            ...(fleetAutoCreated && res.ok
              ? {
                  fleet_advisory: `⚠ Created fleet "${args.fleet}" from a BEE spawn — these are autonomous-loop bees (queen↔bee nursery), NOT visible desktop su agents. If you meant desktop members on a plan, fleet:cancel this + use fleet:launch-on-plan instead.`,
                }
              : {}),
            next: res.ok
              ? 'fleet:tree { spawn_id } to watch; fleet:cancel { spawn_id } to abort.'
              : res.awaitEvent
                ? `over ceiling — events:await { event: "${res.awaitEvent}" }, end your turn, retry this cup:spawn on wake.`
                : 'fix the input and retry — the failed attempt is recorded in the nursery.',
          }),
        },
      ],
    };
  },
});
