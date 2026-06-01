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
import { listBootedHandles } from '@/lib/sync/hyperbee/boot-all';
import { listBootstrapProgress } from '@/lib/sync/hyperbee/bootstrap-progress';
import { loadClaimAttemptStats } from '@/lib/orchestrator/load-claim-attempts';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthVerdict,
} from '@/lib/sync/hyperbee/health';
import { summariseWorkspaceSubstrate } from '@/lib/sync/hyperbee/summary';

interface HarnessHealthRow {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-health',
  auth: 'public',
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

    const rows: HarnessHealthRow[] = await Promise.all(
      booted.map(async (h) => {
        const stats = await loadClaimAttemptStats({
          workspace_id: h.workspaceId,
          harness_slug: h.harnessSlug,
          runQuery,
        });
        const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
        const { verdict, reasons } = assessHarnessSubstrateHealth({
          flagEnabled,
          handlePresent: true,
          claimStats: stats,
          bootstrapProgress: bp ?? null,
        });
        return {
          workspaceId: h.workspaceId,
          harnessSlug: h.harnessSlug,
          verdict,
          reasons,
        };
      }),
    );

    // Add a workspace-level row when the flag is OFF (no harnesses
    // booted, but the disabled state itself is the verdict).
    if (rows.length === 0) {
      rows.push({
        workspaceId: '',
        harnessSlug: '',
        ...assessHarnessSubstrateHealth({
          flagEnabled,
          handlePresent: false,
        }),
      });
    }

    const summary = summariseWorkspaceSubstrate(
      flagEnabled,
      // The fallback row's workspaceId/slug are empty strings — drop
      // those so the summary reflects only real per-harness verdicts.
      rows.filter((r) => r.workspaceId !== '' && r.harnessSlug !== ''),
    );
    return Response.json({
      flagEnabled,
      summary,
      harnesses: rows,
    });
  },
});

export default [get];
