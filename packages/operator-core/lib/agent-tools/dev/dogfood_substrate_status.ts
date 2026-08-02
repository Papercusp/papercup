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
import { getCachedRemoteBootedHandles } from '../../sync/hyperbee/cluster-booted-handles-sync';
import { getPgBootedHandlesSnapshotFallback } from '../../sync/hyperbee/substrate-booted-handles-pg';
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
import { getOrgPg } from '@papercusp/db-org';

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
  args: z.object({}),
  async handler() {
    const { sql } = getOrgPg();
    let status = await Promise.resolve(
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        // EI-8816: on a request-only cluster worker, listBootedHandles() is always
        // empty (the substrate boots only on the primary) — fall back to the
        // primary's cached broadcast rather than silently reporting bootedCount:0.
        resolveRemoteBootedHandles: getCachedRemoteBootedHandles,
      }),
    );
    status = await withPgBootedHandlesFallback(status, (resolveRemoteBootedHandles) =>
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
        resolveRemoteBootedHandles,
      }),
    );
    // Second pass: for any booted harness, refresh the stats with the
    // real PG numbers and re-derive the verdict. Done in a second pass
    // so the in-process composer stays sync + PG-free.
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
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
          resolveRemoteBootedHandles,
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(refreshed) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(status) }],
    };
  },
});
