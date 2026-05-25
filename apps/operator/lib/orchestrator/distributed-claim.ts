/**
 * distributed-claim — orchestrator entry point for distributed claims.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-037.
 *
 * Single call orchestrator code makes to attempt a distributed claim:
 *
 *   const r = await attemptDistributedClaim({
 *     workspaceId, harnessSlug, feature_id, claimer_github_user_id,
 *   });
 *   if (r.reason === 'substrate-not-booted') {
 *     // fall back to legacy single-writer claim
 *   } else if (r.won) {
 *     // we won — schedule the worker
 *   }
 *
 * Composes:
 *   - getBootedHarness() to find the substrate handle
 *   - resolveMyPubkey() to extract our writer pubkey (hex)
 *   - buildClaimAutobaseHandle() to adapt to the orchestrator's interface
 *   - attemptClaimWithAudit() to run the claim + write audit
 *
 * If the substrate hasn't booted (flag off, boot failed, etc.) returns
 * a sentinel result with reason='substrate-not-booted' so the caller
 * can fall back cleanly. Validation errors propagate (caller bug).
 *
 * Pure logic — fake handles in tests via boot-all's test hooks.
 */

import { getBootedHarness } from '../sync/hyperbee/boot-all';
import {
  buildClaimAutobaseHandle,
} from './claim-handle-adapter';
import {
  attemptClaimWithAudit,
  type AttemptClaimResult,
} from './attempt-claim';
import type { BootedHarnessHandle } from '../sync/hyperbee/boot';

export interface AttemptDistributedClaimOpts {
  workspaceId: string;
  harnessSlug: string;
  feature_id: string;
  claimer_github_user_id: number;
  /** Override the table tag for claim ops. Default `'claims'`. */
  claimTable?: string;
  /** Override for tests; defaults to Date.now(). */
  now_ms?: number;
}

export type AttemptDistributedClaimResult =
  | (AttemptClaimResult & { reason: 'attempted'; my_pubkey: string })
  | {
      reason: 'substrate-not-booted';
      won: false;
      workspaceId: string;
      harnessSlug: string;
      feature_id: string;
    }
  | {
      reason: 'pubkey-unresolved';
      won: false;
      workspaceId: string;
      harnessSlug: string;
      feature_id: string;
    };

/**
 * Best-effort pubkey extraction from the booted substrate handle.
 * The substrate's Autobase exposes `local.key` as a Buffer of the
 * local writer's hypercore key. We hex-encode for the wire claim
 * record. Defensive: returns null if the field shape changes.
 */
export function resolveMyPubkey(
  booted: BootedHarnessHandle,
): string | null {
  try {
    const base = (booted.base as unknown as {
      base?: { local?: { key?: Buffer | Uint8Array } };
    }).base;
    const k = base?.local?.key;
    if (!k) return null;
    if (typeof (k as Buffer).toString === 'function') {
      // node Buffer or Uint8Array with the same API
      const hex = Buffer.from(k as Uint8Array).toString('hex');
      if (hex.length > 0) return hex;
    }
    return null;
  } catch {
    return null;
  }
}

export async function attemptDistributedClaim(
  opts: AttemptDistributedClaimOpts,
): Promise<AttemptDistributedClaimResult> {
  const booted = getBootedHarness(opts.workspaceId, opts.harnessSlug);
  if (!booted) {
    return {
      reason: 'substrate-not-booted',
      won: false,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
    };
  }
  const myPubkey = resolveMyPubkey(booted);
  if (!myPubkey) {
    return {
      reason: 'pubkey-unresolved',
      won: false,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
    };
  }
  let claimHandle;
  try {
    claimHandle = buildClaimAutobaseHandle({
      base: booted.base,
      myPubkey,
      table: opts.claimTable,
    });
  } catch {
    // Adapter construction failed (view shape unexpected). Treat as
    // substrate-not-booted so callers fall back cleanly.
    return {
      reason: 'substrate-not-booted',
      won: false,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      feature_id: opts.feature_id,
    };
  }
  const result = await attemptClaimWithAudit(claimHandle, {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    feature_id: opts.feature_id,
    claimer_github_user_id: opts.claimer_github_user_id,
    now_ms: opts.now_ms,
  });
  return {
    ...result,
    reason: 'attempted' as const,
    my_pubkey: myPubkey,
  };
}
