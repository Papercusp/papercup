/**
 * coupled-topics-read.ts — the ASSEMBLY for P-023's coupled-topic feed: one
 * place that walks roster → couplings → peers' work-items → topics → feed.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-023 (rulings D-081 / D-082).
 *
 * ⚠ A CONSUMER OF THE UNION, NOT A SECOND COUPLING PATH (D-078 (b), D-081).
 * The peer set comes from `resolveCoupledPeers` — the ONE shared predicate
 * (`derived ∪ declared − suppressed`) that `coord:presence` already uses — so
 * this cannot drift from what `expanded[]` shows, and an agent that DECOUPLED a
 * peer stays decoupled here too. Re-deriving a private notion of "coupled" was
 * the obvious shortcut and is exactly what the ruling forbids.
 *
 * ⚠ PULL ONLY, ZERO WRITES (D-081 (c)). Recomputed per read; nothing is stored,
 * so the projection narrows on its own as coupling decays and there is no
 * cleanup path to forget. Push belongs to P-021 surprisal, in its own item.
 */
import { resolvePresenceScope, assemblePresenceSnapshot } from './presence-snapshot';
import { couplingSourcesFor } from './coupling-sources';
import { coupledTopicSourcesFor } from './coupled-topic-sources';
import { deriveCouplings } from '../../coord/coupling-derivation';
import { listCouplingsFor, resolveCoupledPeers } from '../../coord/couplings';
import { deriveCoupledTopics, type CoupledTopicFeed } from '../../coord/coupled-topics';

export interface CoupledTopicsReadCtx {
  workspaceId?: string | null;
  harnessSlug?: string | null;
}

/**
 * Everything the caller's COUPLED PEERS are working on, by topic.
 *
 * Fail-soft as a whole: this is an enrichment, and a caller asking for its
 * coupled topics must never be handed an error because one leg was unavailable
 * — an empty list is the honest degraded answer.
 */
export async function readCoupledTopics(
  selfOwnerId: string,
  ctx: CoupledTopicsReadCtx = {},
  opts: { withFeed?: boolean } = {},
): Promise<CoupledTopicFeed[]> {
  const self = selfOwnerId?.trim();
  if (!self) return [];

  try {
    const resolved = await resolvePresenceScope(ctx, {});
    const snapshot = await assemblePresenceSnapshot(resolved, {});
    const rosterOwnerIds = snapshot.active
      .map((r) => (r as { ownerId?: unknown }).ownerId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    const derived = await deriveCouplings(
      self,
      snapshot.active,
      couplingSourcesFor({
        selfOwnerId: self,
        rosterOwnerIds,
        ...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),
        ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      }),
    );
    const edges = await listCouplingsFor(self, ctx.workspaceId ?? undefined);
    const peers = resolveCoupledPeers(self, derived, edges);

    // `resolveCoupledPeers` returns the union's richer `CoupledPeer`; the topic
    // derivation only needs (ownerId, why), so it is narrowed here rather than
    // widening the pure module's input type to a union-specific shape.
    return await deriveCoupledTopics(
      self,
      peers.map((p) => ({ ownerId: p.ownerId, because: p.derivedBecause ?? p.reason ?? 'coupled' })),
      coupledTopicSourcesFor(),
      opts,
    );
  } catch {
    return [];
  }
}
