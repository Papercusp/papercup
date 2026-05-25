/**
 * Harness Insights — JSON endpoint for Phase 8 P-073.
 *
 *   GET /api/harness/:slug/insights
 *   query: ?activity_limit=N (default 20, capped at 100)
 *
 * Returns full InsightsTabProps for the harness. Public read.
 * Defensive per loaders: missing tables yield zeros / empty arrays
 * so the response is always 200-shaped.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-073.
 */

import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessInsights } from '@/lib/harness-insights/load-all';
import { getSessionUserOrDefault } from '@/lib/auth';

async function viewerGithubUserId(): Promise<number> {
  try {
    const user = await getSessionUserOrDefault();
    const ghId = (user as { github_user_id?: number | string | null })?.github_user_id;
    if (typeof ghId === 'number' && Number.isFinite(ghId)) return ghId;
    if (typeof ghId === 'string') {
      const parsed = Number.parseInt(ghId, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/insights',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const rawLimit = Number.parseInt(
      url.searchParams.get('activity_limit') ?? '20',
      10,
    );
    const activityLimit = Math.max(
      1,
      Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 20),
    );
    const viewerId = await viewerGithubUserId();
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const props = await loadHarnessInsights({
      workspace_id: workspaceId,
      harness_slug: slug,
      viewer_github_user_id: viewerId,
      runQuery,
      activityLimit,
    });
    return Response.json({ insights: props });
  },
});

export default [get];
