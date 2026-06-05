/**
 * audience-host.ts — the PG-backed wiring of the pure audience resolver
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 *
 * Mirrors topics.ts: constructs the capability stores over the org embedded-pg
 * handle and adapts them to the small `AudienceResolvers` port `expandAudience`
 * needs. Kept separate from the pure ./audience core so that core stays
 * dependency-free + unit-testable, and from messages.ts so the send path takes a
 * single import.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PgEntitySubscriptionStore, PgLinkStore } from '@papercusp/coordination/capabilities';
import { listPresence } from './presence';
import type { ActivePresence, AudienceMode, AudienceResolvers } from './audience';

const storeOpts = {
  getSql: () => getOrgPg().sql,
  // Schema is defined by migration 123; the host seam is a no-op.
  ensureSchema: async () => {},
};
const subStore = new PgEntitySubscriptionStore(storeOpts);
const linkStore = new PgLinkStore(storeOpts);

export const hostAudienceResolvers: AudienceResolvers = {
  async listTargetSubscribers(targetKind, targetRef) {
    const rows = await subStore.listTargetSubscribers(targetKind, targetRef);
    return rows.map((r) => r.subscriber_id);
  },
  async listActivePresence(): Promise<ActivePresence[]> {
    const recs = await listPresence();
    const active: ActivePresence[] = [];
    for (const r of recs) {
      if (r.stale || r.revoked) continue;
      active.push({ ownerId: r.ownerId, planSlug: r.currentPlanSlug, files: r.currentFiles });
    }
    return active;
  },
  async listTaggedTopics(objectKind, objectRef) {
    // Best-effort: a links-query failure must never drop the whole emission.
    try {
      const links = await linkStore.listOut({ kind: objectKind, ref: objectRef }, { rel: 'tagged' });
      return links.filter((l) => l.dst.kind === 'topic').map((l) => l.dst.ref);
    } catch {
      return [];
    }
  },
};

/**
 * The fleet-wide kill-switch (D-005): `PAPERCUSP_COORD_EMIT_SCOPE=broadcast`
 * makes every selector collapse back to `['*']` — an instant revert to the
 * legacy global broadcast without a code change, for the case where scoping
 * ever starves real coordination. Default (`scoped`, or unset) honors watchers.
 */
export function audienceMode(): AudienceMode {
  return process.env.PAPERCUSP_COORD_EMIT_SCOPE === 'broadcast' ? 'broadcast' : 'scoped';
}
