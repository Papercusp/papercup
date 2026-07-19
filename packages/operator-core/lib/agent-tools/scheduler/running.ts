/**
 * scheduler:running — the live-execution view of BEE RUNS
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * "What is the fleet executing right now, under which scheduling spec?" Every live **bee
 * run** — a bee executing a claimed work-item — with its bee, current item, claimed-since,
 * lease, heartbeat, last progress, the derived idle/blocked reason, and the claim-spec
 * `specId@revision` the bee is running under (null ⇒ DEFAULT ordering / no spec set). Read
 * off the LIVE state (the canonical fleet_assignment view + the per-bee spec store), never a
 * separate store.
 *
 * "Bee run", not "workflow" (D-007): the name avoids the DBOS-workflow + harness-pipeline
 * collision. Distinct from fleet:assignments (the full roster / bee load / orphaned-claim
 * detection across all claim kinds): this is the scheduler slice that adds the per-run
 * claim-spec each bee is executing under.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listBeeRuns, summarizeBeeRuns, applyHealthyLoopExemption } from '../../scheduler/bee-runs';
import { getLoopStatuses } from '../../harness/routines/loop';
import { deriveLoopMonitorState } from '../fleet/assignments';

export default defineTool({
  name: 'scheduler:running',
  profile: 'engineer',
  description:
    'The live-execution view of BEE RUNS: every live bee run (a bee executing a claimed work-item) with its bee, current item, claimed-since, lease, heartbeat, last progress, the derived idle/blocked reason, and the claim-spec specId@revision it runs under (null = DEFAULT ordering / no spec). Read off the live fleet state — "what is the fleet executing now, under which scheduling spec". A bee run, not a workflow (D-007).',
  guidance: {
    when: 'You (Mug / Kettle / a human) want to see what the fleet is actively executing RIGHT NOW and under which scheduling spec — the live-execution view of the scheduler. Filter by { harness } or { bee }.',
    notWhen:
      'Full fleet roster / bee load / orphaned-claim detection across ALL claim kinds (plan-item leases, assignments, presence) — use fleet:assignments. Claiming work — scheduler:get_next. Steering a bee — scheduler:set_claim_spec.',
    chaining:
      'scheduler:running (what is executing) → fleet:assignments { agent } (drill into a bee) → scheduler:set_claim_spec (re-steer it).',
    seeAlso: [
      'fleet:assignments (full fleet roster / orphaned-claim detection)',
      'scheduler:get_next (claim work)',
      'scheduler:set_claim_spec (re-steer a bee)',
    ],
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).optional().describe('Filter to one harness (the cup runs executing there).'),
    cup: z.string().max(120).optional().describe('Filter to one cup (its ownerId).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    // A READ — identity is used only to default the workspace scope, resolved SOFTLY so a
    // bare loopback caller (the dock, the IPC bridge) can read without a coord identity.
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
    // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
    // never leaks into the workspace filter as if it were a real workspace id
    // (see fleet:assignments' handler for the full incident writeup).
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    const runs0 = await listBeeRuns({ harness: args.harness, bee: args.cup, workspaceId });
    // EI-12359: give `stalled` bee runs the SAME healthy-loop exemption fleet:assignments
    // already applies (decorateLoopMonitorStates) — a batch-claiming bee whose engine loop
    // is actively monitored is not "abandoned" just because it hasn't checkpointed every
    // held item. Presentation-layer only; the underlying `stalled` SQL truth is untouched.
    const stalledBees = [...new Set(runs0.filter((r) => r.activity === 'stalled').map((r) => r.bee).filter(Boolean))];
    let runs = runs0;
    if (stalledBees.length > 0) {
      const loopStatuses = await getLoopStatuses(stalledBees);
      const hasHealthyMonitor = new Set(
        stalledBees.filter((b) => deriveLoopMonitorState(loopStatuses.get(b) ?? null, []) !== null),
      );
      if (hasHealthyMonitor.size > 0) runs = applyHealthyLoopExemption(runs0, hasHealthyMonitor);
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, summary: summarizeBeeRuns(runs), runs: runs.map(({ bee, ...rest }) => ({ cup: bee, ...rest })) }) },
      ],
    };
  },
});
