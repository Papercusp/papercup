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
import { loadClaimAttemptStats } from '../../orchestrator/load-claim-attempts';
import { getOrgPg } from '@papercusp/db-org';

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
    const status = await Promise.resolve(
      getInProcessSubstrateStatus({
        resolveClaimStats: () => ({ total: 0, won: 0, lost: 0, error: 0 }),
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
      const refreshed = getInProcessSubstrateStatus({
        resolveClaimStats: (wsId, slug) =>
          statsByKey.get(`${wsId}::${slug}`) ?? {
            total: 0,
            won: 0,
            lost: 0,
            error: 0,
          },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(refreshed) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(status) }],
    };
  },
});
