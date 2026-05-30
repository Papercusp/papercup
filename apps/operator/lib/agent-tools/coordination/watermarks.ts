/**
 * watermarks.ts — operator host adapter for per-agent "last-read" pointers.
 *
 * Backend: `PgWatermarkStore` over the org embedded-pg handle —
 * `harness_shared.coord_watermarks`, one mutable row per (workspace, owner),
 * workspace-scoped like the sibling coord tables (coord-channels-pg-port
 * P-006 / D-001 / D-003). The value shape + pure merge stay in
 * @papercusp/coordination/core; the store does the read-modify-write
 * (single-writer-per-owner, so no lock — the same invariant the old fs
 * adapter relied on). The original function surface is preserved so all
 * callers + the turn-start hook are unchanged.
 *
 * agent-coordination-architecture-v2 §7.2.
 */

import { getOrgPg } from '@restart/db-org';
import { ensureCoordWatermarksTable } from '@/lib/ensure-schema';
import { PgWatermarkStore } from '@papercusp/coordination/watermark-store';
import { emptyWatermark, type Watermark } from '@papercusp/coordination/core';

export { emptyWatermark };
export type { Watermark };

const store = new PgWatermarkStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: ensureCoordWatermarksTable,
});

/**
 * Read an agent's watermark. A never-written owner reads as an empty
 * watermark ("never read anything").
 */
export async function readWatermark(ownerId: string): Promise<Watermark> {
  return store.read(ownerId);
}

/**
 * Merge `patch` into the agent's watermark and persist it. Omitted fields
 * keep their current value; `subscriptions_fired` is *replaced* when
 * supplied, not appended — the caller owns dedup.
 */
export async function writeWatermark(
  ownerId: string,
  patch: Partial<Watermark>,
): Promise<Watermark> {
  return store.write(ownerId, patch);
}
