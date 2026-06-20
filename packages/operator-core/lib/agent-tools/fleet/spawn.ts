/**
 * fleet:spawn — launch one agent into a registered harness, tracked in the
 * durable nursery (Brief 4, agent-briefs-2026-06-05).
 *
 * The human-testable operator→spawn path: the operator chat brain calls this
 * (or emits the equivalent `<spawn>` tag), a psu/admin shell calls it directly,
 * and the projected HTTP route (`POST /api/agent-tools/fleet/spawn?superuser=1`)
 * gives a curl-able admin trigger. All of them land in the same
 * `spawnAgentInHarness` engine → harness_shared.spawned_agents → visible in
 * fleet:tree and cancellable with fleet:cancel.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'fleet:spawn',
  profile: 'engineer',
  description:
    'Spawn one agent of a role into a registered harness (project). Returns a spawn_id immediately; the run is tracked durably in the nursery — watch it with fleet:tree, stop it with fleet:cancel. role="worker" requires chunk.',
  guidance: {
    when: 'The user asks to launch an agent on a piece of work — "spawn a validator in <harness>", "put a worker on <feature>", "have a scoper break down X". The spawn is fire-and-forget: acknowledge the launch and check fleet:tree later. Pick a `tier` per task (quick/standard/deep/max — see the arg rubric); omit it for routine work at the role default.',
    notWhen: 'For answering a question you already know — spawning is for new work, not lookups. For the durable feature pipeline, file a work_item and let the harness autoloop dispatch it.',
    chaining: 'fleet:spawn → (later) fleet:tree { spawn_id } to watch → fleet:cancel { spawn_id } to abort.',
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
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee' && r !== 'sentinel' && r !== 'overwatch'),
  args: z.object({
    harness: z.string().min(1).max(80).optional()
      .describe('Registry slug of the harness to spawn into. Optional only when exactly one harness is registered.'),
    role: z.string().min(1).max(64)
      .describe(
        'Child agent role. The generic operator-world worker is "bee" — the default for placing a ranked task + brief (NO chunk needed). ' +
        "Coding-pipeline roles (scoper, architect, worker, validator, reviewer, debugger, documenter, curator) apply only inside a kind:'harness' coding harness; " +
        'role="worker" additionally REQUIRES a chunk (spawn a scoper first to chunk the feature). ' +
        'Other spawnable specialists: sentinel, security-reviewer, infra-reviewer, ui-qa, crosscheck, auditor, planner, release-manager. ' +
        'Plugin roles are "<plugin>:<role>". There is NO "engineer" role — an unknown name is rejected with the full valid list (EI-392).',
      ),
    feature: z.string().max(120).optional().describe('Feature id the child should pick up.'),
    chunk: z.string().max(120).optional().describe('Chunk id. Required when role="worker".'),
    brief: z.string().max(2000).optional()
      .describe('Queen brief: situational overlay the bee is missing (cross-bee context, watch-fors, why-this-priority). P-060.'),
    tier: z.string().max(40).optional()
      .describe('Model tier for THIS spawn, by name from the user-defined menu — see the MODEL TIERS list in your Runtime context for the live names + the user\'s per-tier when-to-use guidance (default menu: quick < standard < deep < max). Resolved to a model spec clamped to [role default floor, role ceiling] — a tier can escalate a role, never downgrade it. Omit = the role\'s standing default. An unknown name fails loud listing the valid menu.'),
    model: z.string().max(80).optional()
      .describe('Direct per-spawn model spec `<modelId>[:<effort>]` (e.g. "opus:high") — operator/human escape hatch that bypasses the tier menu (still recorded on the nursery row). Prefer `tier`. When both are set, model wins.'),
    extras: z.array(z.string().max(500)).max(16).optional()
      .describe('Extra KEY=value args passed to the child invoke.'),
    workspace: z.string().max(120).optional(),
    idempotency_key: z.string().min(1).max(200).optional()
      .describe('Dedupe key for retries (EI-73): pass the SAME key when retrying a spawn that may have already landed (e.g. after a timeout) — a match returns the original spawn_id with deduped:true instead of launching a second agent.'),
  // FAIL-LOUD on unknown arg keys (EI-72). zod's default z.object() STRIPS keys it
  // doesn't recognize: when the Queen sent the (then-new) `brief` to a host still
  // running pre-brief code, the unknown key was silently dropped and 5 task-less
  // bees booted and exited 'done'. `.strict()` makes the projection-layer validator
  // (standardValidate in define-tool.ts) reject any unrecognized key with
  // `invalid_args` — so a newer-field caller against an older serving host gets a
  // loud error instead of a silently no-op'd fleet. Placement is the highest-stakes
  // surface to fail loud on; keep this schema closed as new fields are added.
  }).strict(),
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
    if (tier && ctx.role === 'queen') {
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
    const res = await spawnAgentInHarness({
      workspaceId,
      harness: args.harness ?? null,
      role: args.role,
      featureId: args.feature ?? null,
      chunkId: args.chunk ?? null,
      brief: args.brief ?? null,
      // The queen's model lever is tier NAMES only (propose/dispose split) —
      // a raw model spec from role=queen is ignored in favor of her tier.
      tier,
      modelSpec: ctx.role === 'queen' ? null : args.model ?? null,
      extras: args.extras,
      parentSpawnId,
      parentRole: ctx.role ?? 'operator',
      idempotencyKey: args.idempotency_key ?? null,
      // Coordination-token attribution (B-TOK-4): a fleet:spawn'd agent's turn runs
      // because it was placed by a coordinating agent (the Queen / operator) — a
      // coordination trigger. Stamps turn_trigger on the run's usage sample.
      turnTrigger: 'coord-wake',
    });
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
            next: res.ok
              ? 'fleet:tree { spawn_id } to watch; fleet:cancel { spawn_id } to abort.'
              : res.awaitEvent
                ? `over ceiling — events:await { event: "${res.awaitEvent}" }, end your turn, retry this fleet:spawn on wake.`
                : 'fix the input and retry — the failed attempt is recorded in the nursery.',
          }),
        },
      ],
    };
  },
});
