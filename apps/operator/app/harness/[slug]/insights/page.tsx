/**
 * /harness/[slug]/insights — standalone Insights view.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-073.
 *
 * SSR page that calls loadHarnessInsights + renders InsightsTab with
 * real PG-derived data. The InsightsTab is composed standalone here
 * (full-bleed, no chrome) so the page works today without depending
 * on the existing harness chrome's DockView wiring.
 *
 * P-073g (force-route on first visit) belongs in the sidebar router,
 * not this page.
 */

import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { InsightsTab } from '../../insights/InsightsTab';
import { loadHarnessInsights } from '../../../../lib/harness-insights/load-all';
import { getSessionUserOrDefault } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

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

export default async function InsightsPage({ params }: PageProps) {
  const { slug } = await params;
  if (!slug) {
    return (
      <div style={{ padding: 32 }}>
        <p>Missing harness slug.</p>
      </div>
    );
  }
  const workspaceId = activeWorkspaceId();
  const viewerId = await viewerGithubUserId();
  const { sql } = getOrgPg();
  const runQuery = async <T,>(
    query: string,
    paramsArr: unknown[],
  ): Promise<T[]> => {
    return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
  };
  const insights = await loadHarnessInsights({
    workspace_id: workspaceId,
    harness_slug: slug,
    viewer_github_user_id: viewerId,
    runQuery,
  });
  return <InsightsTab {...insights} />;
}
