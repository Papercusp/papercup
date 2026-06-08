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
    when: 'The user asks to launch an agent on a piece of work — "spawn a validator in <harness>", "put a worker on <feature>", "have a scoper break down X". The spawn is fire-and-forget: acknowledge the launch and check fleet:tree later.',
    notWhen: 'For answering a question you already know — spawning is for new work, not lookups. For the durable feature pipeline, file a work_item and let the harness autoloop dispatch it.',
    chaining: 'fleet:spawn → (later) fleet:tree { spawn_id } to watch → fleet:cancel { spawn_id } to abort.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  // D-002 (bee-capability-expansion-2026-06-08): spawning agents is PLACEMENT — a
  // Queen-only surface. The Queen calls this as role 'operator'; the worker-bee is
  // explicitly EXCLUDED. The bee joined COORD_ROLES in local-hive P-011 (so it could
  // coord:* / issues:* / improvements:capture), which inadvertently leaked this
  // placement tool to it via [...COORD_ROLES]. Filtering bee back out restores the
  // pre-bee allowlist and turns "only the brain spawns" from convention into a gate.
  agentRoles: COORD_ROLES.filter((r) => r !== 'bee'),
  args: z.object({
    harness: z.string().min(1).max(80).optional()
      .describe('Registry slug of the harness to spawn into. Optional only when exactly one harness is registered.'),
    role: z.string().min(1).max(64)
      .describe('Child agent role (e.g. validator, scoper, worker, reviewer).'),
    feature: z.string().max(120).optional().describe('Feature id the child should pick up.'),
    chunk: z.string().max(120).optional().describe('Chunk id. Required when role="worker".'),
    brief: z.string().max(2000).optional()
      .describe('Queen brief: situational overlay the bee is missing (cross-bee context, watch-fors, why-this-priority). P-060.'),
    extras: z.array(z.string().max(500)).max(16).optional()
      .describe('Extra KEY=value args passed to the child invoke.'),
    workspace: z.string().max(120).optional(),
  }),
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
      extras: args.extras,
      parentSpawnId,
      parentRole: ctx.role ?? 'operator',
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
