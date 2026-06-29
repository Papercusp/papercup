/**
 * GET /api/admin/dogfood-substrate-boot-history — boot event log.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Reads the in-process boot-history buffer. Used to debug flaky
 * boots (which harness took how long, which one threw, etc.).
 *
 * SUBSTRATE_SIDECAR mode (shared-hive-member-content-federation-2026-06-20):
 * when the sidecar flag is ON, `bootHarnessSubstrate` + the merge/admission/epoch
 * engine run in the SIDECAR process, so the real boot events land in the
 * sidecar's ring and THIS (main) process's ring is empty ({entries:[],depth:0}).
 * The route proxies to the sidecar over the same JSON-RPC IPC the boot path uses
 * (`substrate:getBootHistory`); any IPC failure (sidecar down, or the boot fell
 * back to in-process) degrades to the local ring. The `source` field names which
 * ring answered.
 *
 *   query:
 *     ?workspace_id=ws-1      filter to one workspace
 *     ?harness_slug=papercup  filter to one harness
 *     ?kinds=boot_fail,close  comma-separated list
 *     ?limit=N (default 50, capped at 500)
 *
 * Response: { entries: BootHistoryEntry[], depth: number, source: 'main' | 'sidecar' | 'main-fallback' }
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  bootHistoryDepth,
  listBootHistory,
  type BootHistoryEntry,
  type BootHistoryKind,
  type ListBootHistoryOpts,
} from '../../../sync/hyperbee/boot-history';
import { getSubstrateIpcClient } from '../../../sync/hyperbee/substrate-ipc-client';

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

interface BootHistoryPayload {
  entries: BootHistoryEntry[];
  depth: number;
}

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

    const opts: ListBootHistoryOpts = { workspaceId, harnessSlug, kinds, limit };

    // SUBSTRATE_SIDECAR on ⇒ the real ring lives in the sidecar; proxy to it.
    // Any IPC failure (sidecar down / boot fell back in-process) degrades to the
    // local ring so the route never errors.
    const useSidecar = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system').catch(() => false);
    if (useSidecar) {
      try {
        const remote = await getSubstrateIpcClient().call<BootHistoryPayload>(
          'substrate:getBootHistory',
          opts,
        );
        return Response.json({ entries: remote.entries, depth: remote.depth, source: 'sidecar' });
      } catch {
        return Response.json({
          entries: listBootHistory(opts),
          depth: bootHistoryDepth(),
          source: 'main-fallback',
        });
      }
    }

    return Response.json({
      entries: listBootHistory(opts),
      depth: bootHistoryDepth(),
      source: 'main',
    });
  },
});

export default [get];
