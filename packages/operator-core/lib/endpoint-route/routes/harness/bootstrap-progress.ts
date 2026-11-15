/**
 * Bootstrap-progress read endpoint — Phase 5b P-066 data source.
 *
 *   GET /api/harness/:slug/bootstrap-progress
 *
 * Returns:
 *   { progress: BootstrapProgressSnapshot | null }
 *
 * The snapshot drives BootstrapProgressIndicator. Null when the
 * substrate hasn't booted / no merge activity has been recorded for
 * the harness yet — the indicator renders nothing in that case.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 */

import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { getBootstrapProgress } from '../../../sync/hyperbee/bootstrap-progress';

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/bootstrap-progress',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const progress = getBootstrapProgress(workspaceId, slug);
    return Response.json({ progress });
  },
});

export default [get];
