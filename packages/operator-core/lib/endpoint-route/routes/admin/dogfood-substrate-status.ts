/**
 * GET /api/admin/dogfood-substrate-status — substrate boot diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reports which harnesses have a live Hyperbee substrate handle in
 * the current process — verifying the boot orchestrator successfully
 * attached to each harness in the active workspace.
 *
 * Response:
 *   {
 *     enabled: boolean,        // always true — the substrate always boots (Stage 4d)
 *     booted: Array<{ workspaceId, harnessSlug }>,
 *     bootedCount: number,
 *   }
 *
 * Public read — no token. The list of harness slugs is already
 * discoverable from the workspace tree.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { listBootedHandles } from '../../../sync/hyperbee/boot-all';

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-status',
  // Admin-only substrate status (consumed by the verified admin insights UI);
  // gated per D3 auth posture (was 'public').
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    const booted = listBootedHandles();
    return Response.json({
      // Stage 4d: the substrate always boots (the opt-in gate was removed).
      enabled: true,
      booted,
      bootedCount: booted.length,
    });
  },
});

export default [get];
