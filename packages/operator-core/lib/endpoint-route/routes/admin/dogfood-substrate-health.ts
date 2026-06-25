/**
 * GET /api/admin/dogfood-substrate-health — per-harness verdict.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Aggregates flag state + boot map + per-harness claim stats + per-
 * harness bootstrap progress into a single
 * { workspaceId, harnessSlug, verdict, reasons }[] envelope.
 *
 * Used by monitoring scripts + the admin diagnostic page. Public read.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listBootedHandles } from '../../../sync/hyperbee/boot-all';
import { listBootstrapProgress } from '../../../sync/hyperbee/bootstrap-progress';
import { loadSubstrateDrainStats } from '../../../sync/hyperbee/load-drain-stats';
import { loadClaimAttemptStats } from '../../../orchestrator/load-claim-attempts';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthVerdict,
} from '../../../sync/hyperbee/health';
import { summariseWorkspaceSubstrate } from '../../../sync/hyperbee/summary';

interface HarnessHealthRow {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-health',
  // Admin-only substrate health (verified admin insights UI); gated per D3 (was 'public').
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    // Stage 4d: the substrate always boots (the opt-in gate was removed).
    const flagEnabled = true;
    const booted = listBootedHandles();
    const progress = listBootstrapProgress();
    const progressByKey = new Map<
      string,
      ReturnType<typeof listBootstrapProgress>[number]
    >();
    for (const p of progress) {
      progressByKey.set(`${p.workspaceId}::${p.harnessSlug}`, p);
    }

    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const drainByKey = await loadSubstrateDrainStats({ runQuery });

    const rows: HarnessHealthRow[] = await Promise.all(
      booted.map(async (h) => {
        const stats = await loadClaimAttemptStats({
          workspace_id: h.workspaceId,
          harness_slug: h.harnessSlug,
          runQuery,
        });
        const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
        const drainStats = drainByKey.get(`${h.workspaceId}::${h.harnessSlug}`) ?? {
          undrainedCount: 0,
          oldestUndrainedAgeMs: null,
        };
        const { verdict, reasons } = assessHarnessSubstrateHealth({
          flagEnabled,
          handlePresent: true,
          claimStats: stats,
          bootstrapProgress: bp ?? null,
          drainStats,
        });
        return {
          workspaceId: h.workspaceId,
          harnessSlug: h.harnessSlug,
          verdict,
          reasons,
        };
      }),
    );

    // Zero booted harnesses is the idle ground state. The substrate is
    // always-on (the flag was removed), so there is no workspace-level
    // "disabled" verdict to synthesise and no phantom placeholder row:
    // `harnesses: []` lets the UI render its empty state ("No shared
    // harnesses booted yet"), and the summary reports worstVerdict
    // 'healthy' — nothing is wrong, there is simply nothing booted.
    const summary = summariseWorkspaceSubstrate(flagEnabled, rows);
    return Response.json({
      flagEnabled,
      summary,
      harnesses: rows,
    });
  },
});

export default [get];
