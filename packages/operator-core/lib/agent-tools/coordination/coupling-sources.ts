/**
 * coupling-sources.ts — the PRODUCTION reads behind P-013's querying coupling
 * signals (plan `unified-agent-state-plane-2026-07-27`, scoping ruling D-078).
 *
 * WHY A SEPARATE MODULE. `coord/coupling-derivation.ts` is pure and total: rows
 * in, `DerivedCoupling[]` out, no PG, no locks, no clock. That is what makes it
 * unit-testable without a database and what makes its no-widening guarantee hold
 * by construction. Keeping the IO here preserves that: this file is the only part
 * that touches a store, and it is injected as `CouplingDerivationSources` rather
 * than imported by the derivation.
 *
 * ⚠ EVERY READ HERE IS CALLER-SCOPED, BY CONSTRUCTION (D-044 / D-078 (c)).
 * Coupling may re-rank what a reader can ALREADY see and may never widen it:
 *   · held files — the caller's OWN coordination domain, restricted to ownerIds
 *     already on the caller's roster;
 *   · plan edges — the caller's OWN plan (the one its presence row declares);
 *   · recent partners — messages the caller itself sent or received.
 * `deriveCouplings` then filters every derived edge back through the roster, so
 * even a misbehaving source here cannot surface an agent the caller could not
 * already observe. Two independent guarantees, deliberately.
 *
 * ⚠ EVERY READ IS FAIL-SOFT AND BOUNDED. `coord:presence` is a hot poll surface;
 * a coupling signal is a nicety and the roster is not. Each source swallows its
 * own failure (the orchestrator also settles per leg) and each carries an
 * explicit row/time cap so a pathological workspace cannot turn a presence read
 * into a table scan.
 */
import type {
  CouplingDerivationSources,
  PlanBlockingEdge,
} from '../../coord/coupling-derivation';
import { fetchPresenceHeldFiles } from './presence-snapshot';
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { readPlanBySlug } from '../plans/source';

/** How far back a directed message still counts as a live working relationship.
 *  Deliberately short: this is "who am I working with RIGHT NOW", not history. */
export const COUPLING_EXCHANGE_WINDOW_MS = 30 * 60 * 1000;

/** Hard cap on the exchange scan — bounds a hot-path read on a busy workspace. */
export const COUPLING_EXCHANGE_ROW_CAP = 300;

/** Envelope shape this module reads out of the coord event log. */
interface ExchangeRow {
  from_owner: string | null;
  to_owners: unknown;
}

/**
 * Peers the caller exchanged a DIRECTED coord message with inside the window.
 *
 * ⚠ BROADCASTS ARE DROPPED HERE, at the source. A `to:['*']` message reaches the
 * whole fleet, so treating it as an exchange would couple every agent to every
 * other the moment anyone broadcasts — `expanded[]` would degrade into a copy of
 * the roster and `expandedBecause` would stop meaning anything. `human` is
 * dropped for the same reason it is never a roster peer.
 */
export async function fetchRecentCoordPartners(selfOwnerId: string): Promise<string[]> {
  const self = selfOwnerId.trim();
  if (!self || !coordHasPgFastPath()) return [];
  try {
    const sql = coordSql();
    const since = new Date(Date.now() - COUPLING_EXCHANGE_WINDOW_MS).toISOString();
    const rows = await sql<ExchangeRow[]>`
      SELECT body->>'from' AS from_owner, body->'to' AS to_owners
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND ts >= ${since}
         AND jsonb_typeof(body->'to') = 'array'
         AND (body->>'from' = ${self} OR jsonb_exists(body->'to', ${self}))
       ORDER BY ts DESC
       LIMIT ${COUPLING_EXCHANGE_ROW_CAP}
    `;
    const partners = new Set<string>();
    for (const r of rows) {
      const from = (r.from_owner ?? '').trim();
      const to = Array.isArray(r.to_owners) ? r.to_owners : [];
      const recipients: string[] = [];
      let broadcast = false;
      for (const raw of to) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (!id) continue;
        // `*` (everyone) and any `@selector:` audience are NOT evidence that these
        // two agents work together — the sender addressed a SET, not a person.
        if (id === '*' || id === 'human' || id.startsWith('@')) {
          broadcast = true;
          continue;
        }
        recipients.push(id);
      }
      if (broadcast) continue;
      if (from === self) {
        for (const id of recipients) if (id !== self) partners.add(id);
      } else if (from && recipients.includes(self)) {
        partners.add(from);
      }
    }
    return [...partners];
  } catch {
    return [];
  }
}

/**
 * The caller's own plan's `blocked-by` graph.
 *
 * Reuses `readPlanBySlug` (the same read the promotion run uses) rather than
 * hand-rolling SQL over `harness_plans` — that table is multi-tenant and keys on
 * (workspace_id, harness_slug, plan_slug), so a raw slug filter can silently hit
 * another tenant's row. Prefers the PG-canonical `row.items` and falls back to the
 * parsed markdown, exactly as plan-workitem-promotion-run.ts does (EI-14024).
 */
export async function fetchPlanBlockingEdges(
  planSlug: string,
  opts: { harnessSlug?: string | undefined; workspaceId?: string | undefined },
): Promise<PlanBlockingEdge[]> {
  const slug = planSlug.trim();
  if (!slug) return [];
  try {
    const read = await readPlanBySlug(slug, {
      ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    if (!read) return [];
    const items =
      read.row.items.length > 0
        ? read.row.items.map((i) => ({
            id: i.id,
            blockedBy: Array.isArray((i as { blockedBy?: unknown }).blockedBy)
              ? ((i as { blockedBy: string[] }).blockedBy ?? [])
              : [],
          }))
        : read.parsed.items.map((i) => ({ id: i.id, blockedBy: i.blockedBy ?? [] }));
    const edges: PlanBlockingEdge[] = [];
    for (const i of items) {
      if (i.id && i.blockedBy.length > 0) edges.push({ item: i.id, blockedBy: i.blockedBy });
    }
    return edges;
  } catch {
    return [];
  }
}

/**
 * Build the injected source set for one `coord:presence` read.
 *
 * `rosterOwnerIds` bounds the lock read to the agents this caller is already
 * being shown. `coordinationDomain` is absent unless the caller asked for detail
 * — in that case the lock-hold signal is simply unavailable and degrades to
 * nothing, which is correct: it must never become a reason to open a second DB
 * connection on the default presence path (P-003 keeps that path org-PG-only).
 */
export function couplingSourcesFor(opts: {
  selfOwnerId: string;
  rosterOwnerIds: string[];
  coordinationDomain?: string | undefined;
  harnessSlug?: string | undefined;
  workspaceId?: string | undefined;
}): CouplingDerivationSources {
  const domain = opts.coordinationDomain;
  return {
    ...(domain
      ? {
          heldFiles: async (): Promise<ReadonlyMap<string, readonly string[]>> =>
            fetchPresenceHeldFiles(opts.rosterOwnerIds, domain),
        }
      : {}),
    planEdges: (planSlug: string) =>
      fetchPlanBlockingEdges(planSlug, {
        harnessSlug: opts.harnessSlug,
        workspaceId: opts.workspaceId,
      }),
    recentPartners: () => fetchRecentCoordPartners(opts.selfOwnerId),
  };
}
