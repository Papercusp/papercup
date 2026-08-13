/**
 * dev:dogfood_substrate_status — substrate diagnostic for SU shells.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Exposes the same shape as /api/admin/dogfood-substrate-health
 * via the MCP tool surface so SU shells (Claude Code, OMP, Codex)
 * can query the substrate without going through HTTP.
 *
 * Wraps `getInProcessSubstrateStatus` with a PG-backed
 * `resolveClaimStats` so claim error rates feed into the verdict.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getInProcessSubstrateStatus } from '../../sync/hyperbee/in-process-status';
import { getBootedHarness } from '../../sync/hyperbee/boot-all';
import { getCachedRemoteBootedHandles } from '../../sync/hyperbee/cluster-booted-handles-sync';
import { getPgBootedHandlesSnapshotFallback } from '../../sync/hyperbee/substrate-booted-handles-pg';
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
import {
  loadSubstrateDrainStats,
  type SubstrateDrainStat,
} from '../../sync/hyperbee/load-drain-stats';
import { getOrgPg } from '@papercusp/db-org';

/**
 * WI-37387: the composer's `resolveDrainStats` seam DEFAULTS to zero-drain
 * (`in-process-status.ts` ZERO_DRAIN) because that module is pure/PG-free, and
 * this tool used to leave it defaulted at every call site. That is not a missing
 * nicety — per the seam's own doc-comment it "is what flips a stuck
 * (captured-but-not-federating) harness off 'healthy'", so omitting it made the
 * drain leg of the verdict structurally unable to fire: every harness reported
 * `undrainedCount: 0` and "no issues detected" regardless of the real backlog
 * (measured live: papercusp at 34,491 undrained rows still rendered healthy).
 *
 * The HTTP route this tool's description claims to mirror
 * (`build-federation-status.ts`) and `run-drain-reconcile.ts` both wire it, so
 * agent callers were getting a strictly weaker verdict than HTTP callers.
 *
 * NB scope: the map is keyed `${workspace_id}::${harness_slug}` and BOTH parts
 * matter — `substrate_outbox` is multi-tenant and the same slug exists under
 * more than one workspace (papercusp is live under both `papercusp-workspace`
 * and `default`), so a slug-only lookup would silently mix tenants.
 */
const ZERO_DRAIN: SubstrateDrainStat = { undrainedCount: 0, oldestUndrainedAgeMs: null };

const ownLogProbeSchema = z.object({
  workspaceId: z.string().min(1),
  harnessSlug: z.string().min(1),
  index: z.number().int().nonnegative(),
});

type OwnLogProbe = z.infer<typeof ownLogProbeSchema>;

/**
 * Attach one exact indexed own-log read to the existing status diagnostic.
 * The in-process handle reads its already-open Corestore; a relocated handle's
 * `OwnLog.get` routes over the bounded `substrate:getOwnLogOp` RPC. Either way,
 * this never opens a second Corestore or joins transport just to inspect a row.
 */
async function attachOwnLogProbe<T extends object>(status: T, probe?: OwnLogProbe): Promise<T | (T & { ownLogProbe: unknown })> {
  if (!probe) return status;
  const handle = getBootedHarness(probe.workspaceId, probe.harnessSlug);
  if (!handle) {
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: false,
        reason: 'booted harness handle is not available in this process',
      },
    };
  }
  try {
    const op = await handle.ownLog.get(probe.index);
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: true,
        keyHex: handle.ownLog.keyHex,
        length: handle.ownLog.length,
        op,
      },
    };
  } catch (error) {
    return {
      ...status,
      ownLogProbe: {
        ...probe,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * EI-19327550671915579: when the cheap sync path (this process's own boot map,
 * or the node:cluster IPC cache) didn't reach the substrate owner, fall back to
 * the cross-SERVICE PG snapshot — the leg that actually reaches a request-only
 * host under the dedicated-bg-host topology, where node:cluster IPC can never
 * apply at all (bg-host is a separate systemd service). Re-runs the pure sync
 * composer with the PG-derived snapshot handed in as a plain closure, so
 * `getInProcessSubstrateStatus` itself never has to become async.
 */
async function withPgBootedHandlesFallback(
  status: ReturnType<typeof getInProcessSubstrateStatus>,
  recompute: (resolveRemoteBootedHandles: () => ReturnType<typeof getCachedRemoteBootedHandles>) => ReturnType<typeof getInProcessSubstrateStatus>,
): Promise<ReturnType<typeof getInProcessSubstrateStatus>> {
  if (status.reachedSubstrateOwner) return status;
  const pg = await getPgBootedHandlesSnapshotFallback();
  if (!pg) return status;
  return recompute(() => pg);
}

export default defineTool({
  name: 'dev:dogfood_substrate_status',
  profile: 'engineer',
  description:
    'Hyperbee substrate diagnostic: booted harnesses, per-row health verdict, workspace summary. The substrate is always active (no flag gate). Mirrors /api/admin/dogfood-substrate-health.',
  capability: 'intel:read',
  guidance: {
    when: `Investigating substrate boot state, claim error rates, or workspace-level dogfood health. The substrate always boots, so run this any time after the operator has started.`,
    notWhen: `For per-harness Insights or feature-level data, use the harness:* tools. This is the dogfood substrate layer specifically.`,
    chaining: `Pair with reading the agent-insights/substrate-flag-flip-runbook page for what to do if verdicts come back degraded/unhealthy.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({ ownLogProbe: ownLogProbeSchema.optional() }),
  async handler(args) {
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    // WI-37387: prefetch drain stats ONCE, before the first compose, so every
    // call site below can resolve them synchronously. `loadSubstrateDrainStats`
    // swallows a missing table into an empty map, so this degrades to honest
    // zero-drain rather than throwing the diagnostic read.
    const drainByKey = await loadSubstrateDrainStats({ runQuery }).catch(
      () => new Map<string, SubstrateDrainStat>(),
    );
    const resolveDrainStats = (ws: string, slug: string): SubstrateDrainStat =>
      drainByKey.get(`${ws}::${slug}`) ?? ZERO_DRAIN;
    let status = await Promise.resolve(
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        resolveDrainStats,
        // EI-8816: on a request-only cluster worker, listBootedHandles() is always
        // empty (the substrate boots only on the primary) — fall back to the
        // primary's cached broadcast rather than silently reporting bootedCount:0.
        resolveRemoteBootedHandles: getCachedRemoteBootedHandles,
      }),
    );
    status = await withPgBootedHandlesFallback(status, (resolveRemoteBootedHandles) =>
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        resolveDrainStats,
        resolveRemoteBootedHandles,
      }),
    );
    // Second pass: for any booted harness, refresh the stats with the
    // real PG numbers and re-derive the verdict. Done in a second pass
    // so the in-process composer stays sync + PG-free.
    if (status.harnesses.length > 0) {
      const realStats = await Promise.all(
        status.harnesses.map(async (h) => ({
          key: `${h.workspaceId}::${h.harnessSlug}`,
          stats: await loadClaimAttemptStats({
            workspace_id: h.workspaceId,
            harness_slug: h.harnessSlug,
            runQuery,
          }).catch(() => ({ total: 0, won: 0, lost: 0, error: 0 })),
        })),
      );
      const statsByKey = new Map(realStats.map((s) => [s.key, s.stats]));
      let refreshed = getInProcessSubstrateStatus({
        resolveClaimStats: (wsId, slug) =>
          statsByKey.get(`${wsId}::${slug}`) ?? {
            total: 0,
            won: 0,
            lost: 0,
            error: 0,
          },
        resolveDrainStats,
        resolveRemoteBootedHandles: getCachedRemoteBootedHandles,
      });
      refreshed = await withPgBootedHandlesFallback(refreshed, (resolveRemoteBootedHandles) =>
        getInProcessSubstrateStatus({
          resolveClaimStats: (wsId, slug) =>
            statsByKey.get(`${wsId}::${slug}`) ?? {
              total: 0,
              won: 0,
              lost: 0,
              error: 0,
            },
          resolveDrainStats,
          resolveRemoteBootedHandles,
        }),
      );
      const output = await attachOwnLogProbe(refreshed, args.ownLogProbe);
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
      };
    }
    const output = await attachOwnLogProbe(status, args.ownLogProbe);
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
    };
  },
});
