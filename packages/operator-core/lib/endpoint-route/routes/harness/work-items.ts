/**
 * GET /api/harness/:slug/work-items — the harness's UNIFIED work items
 * (blueprint-aware-harness-ui-2026-06-09 P-010 — the features/issues view ported onto
 * the unified `work_items` surface, unify-work-items D-001).
 *
 * Returns the merged feature-family {feature,research-task,chunk} + issue-family
 * {bug,change,task} items for the harness, carrying the dimensions the old per-kind
 * FeaturesPanel/IssuesPanel lacked: `kind`/`family`, `assignee` + `assignedBy` (the
 * claim), `severity`, `priority`, `rank`. Thin wrapper over `listWorkItems` (the
 * canonical, already-tested facade) — workspace-agnostic when a harness is given.
 *
 * NOT YET surfaced (follow-up, needs joins the WorkItem facade doesn't carry):
 *   - blueprint/spine position (which role/stage) — a harness_shared.spawned_agents join;
 *   - plan-item linkage — a coord_links / plan-items join.
 */
import { listWorkItems, isWorkItemKind } from '../../../work-items';
import { defineTool } from '@papercusp/agent-mcp';

const getWorkItems = defineTool({
  method: 'GET',
  path: '/harness/:slug/work-items',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const kindParam = url.searchParams.get('kind');
    const kind = kindParam && isWorkItemKind(kindParam) ? kindParam : undefined;
    const state = url.searchParams.get('state') || undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 500);
    try {
      const workItems = await listWorkItems({ harness: slug, kind, state, limit });
      return Response.json({ harness: slug, count: workItems.length, workItems });
    } catch (e) {
      return Response.json({ error: `work-items list failed: ${(e as Error).message}` }, { status: 500 });
    }
  },
});

export default [getWorkItems];
