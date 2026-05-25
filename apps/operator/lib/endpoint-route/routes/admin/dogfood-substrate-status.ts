/**
 * GET /api/admin/dogfood-substrate-status — substrate boot diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reports which harnesses have a live Hyperbee substrate handle in
 * the current process. Useful for verifying PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE
 * took effect and the boot orchestrator successfully attached to each
 * harness in the active workspace.
 *
 * Response:
 *   {
 *     enabled: boolean,        // PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE === '1'
 *     booted: Array<{ workspaceId, harnessSlug }>,
 *     bootedCount: number,
 *   }
 *
 * Public read — no token. The list of harness slugs is already
 * discoverable from the workspace tree.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { listBootedHandles } from '@/lib/sync/hyperbee/boot-all';

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-status',
  auth: 'public',
  async handler() {
    const booted = listBootedHandles();
    return Response.json({
      enabled: process.env.PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE === '1',
      booted,
      bootedCount: booted.length,
    });
  },
});

export default [get];
