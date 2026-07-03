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
import { coordWorkspaceId } from './log';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { getFleet, fleetSlugFromName } from '../../agent-fleets-store';
import { getFleetDeliveryOverrides } from './fleet-delivery';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import {
  listFederatedFleetMembers,
  type FederatedFleetMemberRow,
} from '../../sync/hyperbee/session-presence-store';
import {
  resolveFederatedFleetLeader,
  unionFederatedFleetMembers,
} from '../../fleet/federated-fleet-registry';
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
  async listFleetMembers(fleetSlug) {
    // The @fleet: DELIVERY audience: live members (coord_presence.fleet_slug label,
    // mig 407) MINUS those who set a per-member delivery override (D-001). Slugify so
    // `@fleet:Backend Team` resolves to the stored handle; workspace-scoped (the slug
    // is unique only per-workspace, mig 406).
    //   muted  → excluded entirely (no live `to`; history still pullable via coord:catch-up)
    //   digest → excluded from the live `to`; a terse coalesced notify is delivered
    //            separately in the send path (deliverFleetDigests)
    // NB: this is the deliverable audience, NOT a membership check — the catch-up gate
    // checks membership directly (fetchPresenceFleet) so a muted member still reads history.
    const slug = fleetSlugFromName(fleetSlug);
    const members = await liveFleetMemberIds(slug, coordWorkspaceId());
    // A session leading SEVERAL fleets carries only its newest fleet's label on
    // coord_presence.fleet_slug (the column is singular, mig 407), so the
    // presence fold silently drops the leader from every OTHER fleet's member
    // audience. The leader is definitionally a member: union in the durable
    // registry leader so `@fleet:<slug>` always reaches them. Overrides still
    // apply below — a leader who muted their own fleet stays muted.
    try {
      const fleet = await getFleet(coordWorkspaceId(), slug);
      const lead = fleet?.leaderOwnerId;
      if (lead && !members.includes(lead)) members.push(lead);
    } catch {
      /* registry unavailable — presence members alone */
    }
    const overrides = await getFleetDeliveryOverrides(slug);
    if (overrides.size === 0) return members;
    return members.filter((id) => {
      const mode = overrides.get(id);
      return mode !== 'muted' && mode !== 'digest';
    });
  },
  async listFleetLeader(fleetSlug) {
    // The current leader from the durable registry (agent_fleets.leader_owner_id) —
    // NOT liveness-gated, so an escalation reaches the lead even if they're offline
    // (it lands in their durable inbox for when they return). Null leader → no one.
    const fleet = await getFleet(coordWorkspaceId(), fleetSlugFromName(fleetSlug));
    return fleet?.leaderOwnerId ? [fleet.leaderOwnerId] : [];
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

/**
 * Canonicalize a single audience selector for durable storage / lookup: fleet
 * selectors are slugified (so `@fleet:Backend Team` and `@fleet:backend-team` key
 * the same history, matching how the resolver slugifies); every other selector is
 * stored as-typed (trimmed). Shared by the send path (which preserves the key on
 * the envelope) and the catch-up read (which queries by it), so write and read
 * always agree. (fleet-broadcast-audience-history-integration-2026-06-30 D-003.)
 */
export function canonicalizeAudienceSelector(sel: string): string {
  for (const prefix of ['@fleet-leader:', '@fleet:']) {
    if (sel.startsWith(prefix)) {
      const body = sel.slice(prefix.length).trim();
      return body ? `${prefix}${fleetSlugFromName(body)}` : sel;
    }
  }
  return sel.trim();
}

/**
 * The durable audience KEY for an envelope: the original `@`-selectors + `*` from
 * `to`, canonicalized + deduped. Plain ownerIds are omitted — they're already
 * queryable by `to`, so the audience key is exactly the selector provenance that
 * expandAudience would otherwise discard. Empty for a plain-id-only send.
 */
export function deriveAudienceKey(to: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of to) {
    if (t === '*') out.add('*');
    else if (t.startsWith('@')) out.add(canonicalizeAudienceSelector(t));
  }
  return [...out];
}
