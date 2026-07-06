/**
 * fleet:capacity — the Queen's SOURCE-side read of the shared inference-capacity oracle
 * (queen-capacity-aware-dispatch-2026-06-22 P-003, the dispatch counterpart to the gateway's SINK-side
 * priority tiers). It projects the live gateway `/stats` (the SHARED capacity oracle, D-007) into a
 * placement-decision read-model: the bee-tier `dispatchBudget` (spare slots = cap − inFlight − queued),
 * the per-tier caps, pool saturation (utilization / paused / queue), `healthyAccounts`, and a clamped
 * `recommendedHeadroom` for a proposed fresh-spawn count.
 *
 * It does NOT fork any logic: the read-model (`buildCapacityReport`) + the saturation curve live in the
 * `fleet/capacity-dispatch` domain module that `place_batch` already enforces automatically (so what the
 * Queen READS here matches what the placement path DOES), and the signal is the same `fetchGatewayHeadroom`
 * projection the `/admin` surface renders. Read-only; gateway-unreachable ⇒ a fail-safe "no clamp" report.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parsePriorityTierMap } from '@papercusp/papercusp-shared/agent';
import { COORD_ROLES } from '../coordination/roles';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { buildCapacityReport } from '../../fleet/capacity-dispatch';

// Re-exported so existing importers (tests, the queen-brief gather) can reach the read-model via either path.
export { buildCapacityReport, type CapacityReport } from '../../fleet/capacity-dispatch';

export default defineTool({
  name: 'fleet:capacity',
  description:
    'Read live inference-pool capacity for placement decisions (the gateway /stats oracle): the bee-tier dispatchBudget (spare slots = cap − inFlight − queued), per-tier caps, pool utilization / paused / queue depth, healthyAccounts, and the reserved tier-1 floor. Pass `headroom` (a proposed fresh-spawn count) to get it clamped to spare capacity. Returns {ok, ...CapacityReport}. Gateway-unreachable ⇒ a fail-safe no-clamp report.',
  guidance: {
    when: 'Before a placement round, to size how many FRESH cups to spawn: place up to dispatchBudget when scarce (top-ranked first), broadly when abundant. Re-read each cycle — capacity moves.',
    notWhen: 'Inspecting the gateway pool config / confirming a hot-reload — that is gateway:status. Editing the pool — accounts:* + gateway:reload.',
    chaining: 'fleet:capacity { headroom: <cups you want to place> } → fleet:place_batch (which ALSO clamps automatically under QUEEN_CAPACITY_DISPATCH; this tool lets you reason about it first).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    headroom: z.number().int().min(0).max(10000).optional().describe('A proposed fresh-spawn count to clamp to spare capacity.'),
  }),
  async handler(args) {
    let clampArmed = false;
    try {
      const [{ FLAGS }, { getFlag }] = await Promise.all([import('@papercusp/flags'), import('@papercusp/flags/server')]);
      clampArmed = await getFlag(FLAGS.QUEEN_CAPACITY_DISPATCH, 'system').catch(() => false);
    } catch {
      /* flags unavailable → report clampArmed:false (best-effort) */
    }
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1500 });
    const tierMap = parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP);
    const report = buildCapacityReport(hr, { clampArmed, headroom: args.headroom, tierMap });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...report }) }] };
  },
});
