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
import {
  buildCapacityReport,
  deriveEdgeThrottleEvidence,
  type AccountPoolAvailability,
  type EdgeThrottleSnapshotEntry,
} from '../../fleet/capacity-dispatch';
import { activeWorkspaceId } from '../../workspace-registry';

// Re-exported so existing importers (tests, the queen-brief gather) can reach the read-model via either path.
export { buildCapacityReport, type CapacityReport } from '../../fleet/capacity-dispatch';

/** The provider bee/cup work routes to — the one `dispatchBudget` is measured for (EI-12282). */
const BEE_PROVIDER = 'claude';

/**
 * EI-18683773458136367: process-local memory of the LAST read's per-account edge-throttle state, so
 * `deriveEdgeThrottleEvidence` can tell a re-arming cooldown (deadline advancing, penalty climbing —
 * a backoff-loop bug) from one genuinely counting down. Deliberately ephemeral (in-memory, not
 * persisted) — this is a live diagnostic heuristic over consecutive `fleet:capacity` reads within one
 * process's lifetime, not a durable record; a restart just means the first post-restart read has no
 * prior snapshot to compare against (rearming reports `undefined` until a second read lands).
 */
const lastEdgeThrottleSnapshot = new Map<string, EdgeThrottleSnapshotEntry>();

/**
 * Best-effort snapshot of REAL account-pool availability for the bee provider (accounts:status), used to
 * cross-check the gateway's queue-slot dispatchBudget. Returns undefined on any read failure (fail-safe —
 * a missing cross-check leaves the report byte-identical to before this fix).
 */
async function readBeeProviderAvailability(): Promise<AccountPoolAvailability | undefined> {
  try {
    const ws = activeWorkspaceId();
    const { accountStatus } = await import('../../deployment/account-pool-store');
    const rows = (await accountStatus(ws)).filter((r) => r.provider === BEE_PROVIDER);
    if (rows.length === 0) return undefined;

    // EI-18683773458136367: derive the shared-egress / re-arm evidence that gates whether the
    // "down egress proxy, escalate to the owner" claim is actually supportable (see capacity-dispatch.ts).
    const snapshotPrefix = `${ws ?? ''}::`;
    const prevSnapshot = new Map(
      [...lastEdgeThrottleSnapshot]
        .filter(([key]) => key.startsWith(snapshotPrefix))
        .map(([key, v]) => [key.slice(snapshotPrefix.length), v] as const),
    );
    const { sharedEgress, rearming, nextSnapshot } = deriveEdgeThrottleEvidence(
      rows.map((r) => ({
        id: r.id,
        edgeThrottled: r.edgeThrottled,
        edgeThrottleResetAt: r.edgeThrottleResetAt,
        penaltyCount: r.rate.penaltyCount,
        egressIdentity: r.egress?.proxyUrl ?? r.egress?.localAddress ?? undefined,
      })),
      prevSnapshot,
    );
    // Replace this workspace's slice wholesale — an account that drops out of throttle and later
    // re-enters should NOT be compared against a stale, unrelated prior episode.
    for (const key of [...lastEdgeThrottleSnapshot.keys()]) {
      if (key.startsWith(snapshotPrefix)) lastEdgeThrottleSnapshot.delete(key);
    }
    for (const [id, v] of nextSnapshot) lastEdgeThrottleSnapshot.set(`${snapshotPrefix}${id}`, v);

    return {
      provider: BEE_PROVIDER,
      total: rows.length,
      available: rows.filter((r) => r.available).length,
      // A truly-usable account can serve AND is not in an edge-throttle cooldown (a bare-429/IP wall).
      usable: rows.filter((r) => r.available && !r.edgeThrottled).length,
      // EI-18664933641195210: break out WHY unusable accounts are unusable, so a poolExhausted advice
      // can name egress-throttle (owner-infra) vs usage-wall (just wait) instead of lumping both into
      // one vague "walled/rate-paused/edge-throttled" phrase that reads as generic quota exhaustion.
      edgeThrottledCount: rows.filter((r) => r.edgeThrottled).length,
      usageWalledCount: rows.filter((r) => r.usageWalled).length,
      edgeThrottledSharedEgress: sharedEgress,
      edgeThrottledRearming: rearming,
    };
  } catch {
    return undefined;
  }
}

export default defineTool({
  name: 'fleet:capacity',
  description:
    'Read live inference-pool capacity for placement decisions (the gateway /stats oracle): the bee-tier dispatchBudget (spare slots = cap − inFlight − queued), per-tier caps, pool utilization / paused / queue depth, healthyAccounts, and the reserved tier-1 floor. Cross-checks dispatchBudget against REAL account-pool availability and sets `poolExhausted:true` (with factor 0) when the pool has zero usable accounts despite spare queue slots — heed that flag before spawning. Pass `headroom` (a proposed fresh-spawn count) to get it clamped to spare capacity. Returns {ok, ...CapacityReport}. Gateway-unreachable ⇒ a fail-safe no-clamp report.',
  guidance: {
    when: 'Before a placement round, to size how many FRESH cups to spawn: place up to dispatchBudget when scarce (top-ranked first), broadly when abundant. Re-read each cycle — capacity moves.',
    notWhen: 'Inspecting the gateway pool config / confirming a hot-reload — that is gateway:status. Editing the pool — accounts:* + gateway:reload.',
    chaining: 'fleet:capacity { headroom: <cups you want to place> } → fleet:place_batch (which ALSO clamps automatically under MUG_CAPACITY_DISPATCH; this tool lets you reason about it first).',
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
      clampArmed = await getFlag(FLAGS.MUG_CAPACITY_DISPATCH, 'system').catch(() => false);
    } catch {
      /* flags unavailable → report clampArmed:false (best-effort) */
    }
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1500 });
    const tierMap = parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP);
    // EI-12282: cross-check the gateway's queue-slot dispatchBudget against REAL account-pool availability
    // (accounts:status). The gateway's own `healthyAccounts` can be split-brain-stale and report spare bee
    // slots while every claude account is usage-walled/edge-throttled — a false-green that kills fresh cups
    // on their first inference call. Best-effort: any read failure ⇒ skip the cross-check (fail-safe).
    const accountAvailability = await readBeeProviderAvailability();
    const report = buildCapacityReport(hr, { clampArmed, headroom: args.headroom, tierMap, accountAvailability });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...report }) }] };
  },
});
