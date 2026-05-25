/**
 * get-claim-handle — Phase 6 P-037 lookup helper.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * The single call orchestrator code makes when it wants to claim a
 * feature on a harness:
 *
 *   const handle = getClaimHandleForHarness({ workspaceId, harnessSlug, myPubkey });
 *   if (!handle) return { won: false, reason: 'substrate-not-booted' };
 *   const result = await attemptClaimWithAudit(handle, ...);
 *
 * Composes boot-all's getBootedHarness() with claim-handle-adapter's
 * buildClaimAutobaseHandle(). Returns null if the substrate hasn't
 * booted yet (substrate boot is gated behind the
 * PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1 flag — without it, the
 * orchestrator should fall back to legacy single-writer claim).
 *
 * Pure logic — no PG, no FS. Tests inject fake substrate handles via
 * the boot-all test hooks.
 */

import { getBootedHarness } from '../sync/hyperbee/boot-all';
import {
  buildClaimAutobaseHandle,
  type AdapterOpts,
} from './claim-handle-adapter';
import type { ClaimAutobaseHandle } from './feature-claim';

export interface GetClaimHandleOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Our local writer's pubkey (hex) — typically the Autobase writer
   * pubkey for our peer. */
  myPubkey: string;
  /** Override the table tag for claim ops. Default `'claims'`. */
  claimTable?: string;
}

/**
 * Resolve a ClaimAutobaseHandle for the (workspace, harness) pair.
 * Returns null when the substrate hasn't booted for this harness.
 */
export function getClaimHandleForHarness(
  opts: GetClaimHandleOpts,
): ClaimAutobaseHandle | null {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!booted) return null;
  const adapterOpts: AdapterOpts = {
    base: booted.base,
    myPubkey: opts.myPubkey,
    table: opts.claimTable,
  };
  try {
    return buildClaimAutobaseHandle(adapterOpts);
  } catch {
    return null;
  }
}
