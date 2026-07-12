/**
 * Post-compaction memory re-prime.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-003b, decisions D-002/D-005).
 *
 * Called by the session-recovery-brief endpoint — the read the
 * SessionStart[source=compact] hook fetches — so it fires EXACTLY ONCE per
 * compaction. That makes it the session's epoch boundary:
 *
 *   1. `bumpSessionEpoch` (P-002): the compaction generation advances, the
 *      per-session surfaced-ledger resets, and the WHOLE memory pool becomes
 *      injectable again — which is exactly what a wiped context needs.
 *   2. The FULL re-prime runs through the launch-profile resolver at rung 0
 *      (held work-item titles are the most-specific statement of what the
 *      session was ACTUALLY doing — better than any launch-time signal) and
 *      the one admission pipeline, stamping the NEW epoch under port
 *      'compact' so the next turn-start delta dedups against it.
 *
 * Best-effort/never-throws: a failure returns null and the carry brief
 * lands without the memory block. The epoch bump deliberately happens FIRST
 * — a compaction happened whether or not recall succeeds.
 */

import { getOrgPg } from '@papercusp/db-org';
import { bumpSessionEpoch } from './session-epoch-ledger';
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';
import { activeWorkspaceId } from '../workspace-registry';
import { getSessionUserOrDefault } from '../auth';

export interface CompactReprimeInput {
  ownerId: string;
  workspaceId?: string;
  /** Held work-item titles + harness slugs (from the carry brief). */
  heldItems: ReadonlyArray<{ title: string | null; harness: string | null }>;
  fleetSlug?: string | null;
}

/** The heading the recovery hook's anchor will carry the block under. */
export const COMPACT_REPRIME_HEADING = 'Memory re-prime (post-compaction, epoch reset)';

/** Most common non-null harness among the held items — the harness dim. */
export function dominantHarness(
  heldItems: ReadonlyArray<{ harness: string | null }>,
): string | null {
  const counts = new Map<string, number>();
  for (const { harness } of heldItems) {
    if (harness) counts.set(harness, (counts.get(harness) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [slug, n] of counts) {
    if (n > bestN) {
      best = slug;
      bestN = n;
    }
  }
  return best;
}

export async function buildCompactReprimeBlock(
  input: CompactReprimeInput,
): Promise<string | null> {
  if (!input.ownerId) return null;
  try {
    const { sql } = getOrgPg();
    // 1) The epoch boundary — always, even if recall below fails.
    await bumpSessionEpoch(sql, input.ownerId);

    // 2) Rung-0 resolve + re-prime, stamping the NEW epoch.
    const profile = resolveLaunchProfile({
      harnessSlug: dominantHarness(input.heldItems),
      fleetSlug: input.fleetSlug ?? null,
      heldCheckpointTitles: input.heldItems
        .map((i) => i.title)
        .filter((t): t is string => typeof t === 'string' && t.length > 0),
    });
    if (profile.queries.length === 0) return null;

    const user = await getSessionUserOrDefault().catch(() => null);
    return await buildLaunchMemoryBlock({
      profile,
      userId: user?.id ?? null,
      workspaceId: input.workspaceId || activeWorkspaceId(),
      session: { sessionId: input.ownerId, port: 'compact' },
      heading: COMPACT_REPRIME_HEADING,
    });
  } catch {
    return null;
  }
}
