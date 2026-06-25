/**
 * GET /api/admin/dogfood-substrate-boot-history — boot event log.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reads the in-process boot-history buffer. Used to debug flaky
 * boots (which harness took how long, which one threw, etc.).
 * Public read.
 *
 *   query:
 *     ?workspace_id=ws-1      filter to one workspace
 *     ?harness_slug=papercup  filter to one harness
 *     ?kinds=boot_fail,close  comma-separated list
 *     ?limit=N (default 50, capped at 500)
 *
 * Response: { entries: BootHistoryEntry[], depth: number }
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  bootHistoryDepth,
  listBootHistory,
  type BootHistoryKind,
} from '../../../sync/hyperbee/boot-history';

const VALID_KINDS: ReadonlyArray<BootHistoryKind> = [
  'boot_start',
  'boot_ok',
  'boot_fail',
  'close',
  'peer_connected',
  'swarm_join_failed',
  'peer_rejected',
  'peer_rate_limited',
  'peer_capped',
  'peer_revoked',
  'announce_admitted',
  'announce_pending',
  'announce_rejected',
  'announce_error',
  'merge_error',
  'rekey_grant_failed',
  'rekey_grant_skipped',
  'rekey_boundary_skipped',
];

const get = defineTool({
  method: 'GET',
  path: '/admin/dogfood-substrate-boot-history',
  // Admin-only substrate boot history (verified admin insights UI); gated per D3 (was 'public').
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    const workspaceId = url.searchParams.get('workspace_id') ?? undefined;
    const harnessSlug = url.searchParams.get('harness_slug') ?? undefined;
    const rawKinds = url.searchParams.get('kinds');
    const kinds = rawKinds
      ? (rawKinds.split(',').filter((k) =>
          (VALID_KINDS as ReadonlyArray<string>).includes(k),
        ) as BootHistoryKind[])
      : undefined;
    const rawLimit = Number.parseInt(
      url.searchParams.get('limit') ?? '50',
      10,
    );
    const limit = Math.max(
      1,
      Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 50),
    );

    const entries = listBootHistory({
      workspaceId,
      harnessSlug,
      kinds,
      limit,
    });

    return Response.json({
      entries,
      depth: bootHistoryDepth(),
    });
  },
});

export default [get];
