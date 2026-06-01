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
 * booted yet for this harness — the orchestrator then falls back to the
 * legacy single-writer claim.
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
 *
 * STAGE-5 TODO (papercusp-substrate-model-b-rewrite-2026-05-31): Stage 4a
 * replaced the boot handle's Autobase (`base`) with a per-peer own-log +
 * read-merge driver. The claim path still expects an Autobase view
 * (`claim-handle-adapter` reads `base.base.view`), so until Stage 5 rewrites
 * the claim wiring onto the own-log this resolver returns null whenever the
 * booted handle no longer carries `base` — the orchestrator falls back to the
 * legacy single-writer claim, exactly as it does when the substrate isn't
 * booted. This keeps boot.ts + the orchestrator compiling without faking an
 * Autobase the substrate no longer has.
 */
export function getClaimHandleForHarness(
  opts: GetClaimHandleOpts,
): ClaimAutobaseHandle | null {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!booted) return null;
  // Model B handles no longer expose an Autobase `base`. Detect the legacy
  // shape defensively; absent it, defer to Stage 5 (return null → legacy claim).
  const base = (booted as unknown as { base?: AdapterOpts['base'] }).base;
  if (!base) return null;
  const adapterOpts: AdapterOpts = {
    base,
    myPubkey: opts.myPubkey,
    table: opts.claimTable,
  };
  try {
    return buildClaimAutobaseHandle(adapterOpts);
  } catch {
    return null;
  }
}
