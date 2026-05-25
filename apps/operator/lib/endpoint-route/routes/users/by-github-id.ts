/**
 * User profile read endpoint — Phase 8 P-072.
 *
 *   GET /api/users/github/:id
 *   query: ?limit_activity=N (default 30, capped at 100)
 *
 * Returns UserProfileData for the numeric github_user_id. Wraps
 * loadUserProfile + loadUserRecentActivity (which is called inside
 * loadUserProfile, so the activity field comes for free).
 *
 * viewer_github_user_id is resolved from the session via
 * getSessionUserOrDefault so the privacy filter (Q-2) reflects who
 * is actually viewing the profile, not just the API caller.
 *
 * Public route — no auth required (P-072 marketplace publishedBy
 * deep-link is a use case). Privacy filter limits what shared-private
 * harness rows leak.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-072.
 */

import { getOrgPg } from '@restart/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { loadUserProfile } from '@/lib/user-profile/load';
import { getSessionUserOrDefault } from '@/lib/auth';

async function viewerGithubUserId(): Promise<number | null> {
  try {
    const user = await getSessionUserOrDefault();
    const ghId = (user as { github_user_id?: number | string | null })?.github_user_id;
    if (typeof ghId === 'number' && Number.isFinite(ghId)) return ghId;
    if (typeof ghId === 'string') {
      const parsed = Number.parseInt(ghId, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

const get = defineTool({
  method: 'GET',
  path: '/users/github/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const idParam = ctx.params.id as string;
    const numericId = Number.parseInt(idParam, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return Response.json(
        { error: 'invalid id', id: idParam },
        { status: 400 },
      );
    }
    const viewerId = await viewerGithubUserId();
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const profile = await loadUserProfile({
      github_user_id: numericId,
      viewer_github_user_id: viewerId,
      runQuery,
    });
    return Response.json({ profile });
  },
});

export default [get];
