/**
 * plans/remote-seat-inventory.ts — pot-seat-pools-prose-ux-2026-07-18
 * P-007/P-013/P-014: resolves the pot-wide standing remote seat-offer
 * inventory (`RemoteSeatSummary`, see `launch-prompt.ts`) for the routing-gate
 * kickoff text. This is the IMPURE half — `launch-prompt.ts` stays
 * dependency-free (no DB import), so any DB/hive-scope read lives here and the
 * caller (bootstrap-su.ts today) awaits this before composing the kickoff.
 *
 * "The plan's pot is shared" = this workspace resolves to exactly one shared
 * Hive (resolveWorkspaceHiveScope kind==='one') — none/many never guesses.
 * "Seat-offers exist" reads harness_shared.p2p_work_offers pot-wide (kind
 * 'seat', status 'open') via the EXISTING offer-store read (offer-store.ts
 * listWorkOffers) — that read is already scoped by potHomeSlug with an
 * OPTIONAL fleetSlug filter, so it already returns every open seat-offer in
 * the pot regardless of which fleet a donor originally delegated to. Once
 * P-001 lands pot-scoped delegation (`potSlug`/`audience`, fleetSlug-less
 * rows), those rows land in the SAME table and are picked up here with no
 * change — this module needs no update when P-001 ships.
 *
 * Fail-soft by contract (mirrors offer-store-publish.ts / federation-scope.ts
 * discipline): any resolution error degrades to the "unshared/no offers"
 * summary — an inventory-check must never break a plan launch.
 */

import { resolveWorkspaceHiveScope } from '../coordination/federation-scope';
import { listWorkOffers } from '../../p2p/offer-store';
import type { RemoteSeatSummary } from './launch-prompt';

/** DI seam (federation-scope / offer-store-publish discipline) so unit tests
 *  run without PG. */
export interface RemoteSeatInventoryDeps {
  resolveScope?: typeof resolveWorkspaceHiveScope;
  listOffers?: typeof listWorkOffers;
}

const EMPTY_SUMMARY: RemoteSeatSummary = {
  potShared: false,
  donorCount: 0,
  totalSeats: 0,
};

/**
 * Resolve this workspace's pot-wide remote seat-offer inventory for the
 * routing-gate kickoff. `workspaceId` unresolved (null/undefined) or the
 * workspace's shared-Hive scope not exactly-one ⇒ `{ potShared:false, ... }`
 * (today's static option-C text, unchanged). Never throws.
 */
export async function resolveRemoteSeatInventory(
  workspaceId: string | null | undefined,
  deps: RemoteSeatInventoryDeps = {},
): Promise<RemoteSeatSummary> {
  if (!workspaceId) return EMPTY_SUMMARY;
  const resolveScope = deps.resolveScope ?? resolveWorkspaceHiveScope;
  const listOffers = deps.listOffers ?? listWorkOffers;
  try {
    const scope = await resolveScope(workspaceId);
    if (scope.kind !== 'one') return EMPTY_SUMMARY;
    const rows = await listOffers(workspaceId, scope.homeSlug, {
      kind: 'seat',
      status: 'open',
    });
    const donors = new Set<number>();
    let totalSeats = 0;
    for (const row of rows) {
      if (!row.record || row.record.kind !== 'seat' || !row.record.seat) continue;
      donors.add(row.publisherGithubUserId);
      totalSeats += row.record.seat.count;
    }
    return { potShared: true, donorCount: donors.size, totalSeats };
  } catch (e) {

    console.warn(
      `[remote-seat-inventory] resolve failed for ws=${workspaceId} (routing gate falls back to local-only text):`,
      e instanceof Error ? e.message : String(e),
    );
    return EMPTY_SUMMARY;
  }
}
