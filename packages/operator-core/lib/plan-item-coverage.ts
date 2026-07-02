/**
 * plan-item coverage — rolls a plan item's "is anyone working this?" up from the
 * work-items LINKED to it AND any direct plan-item claim, so the plans:* readers
 * surface coverage instead of leaving a `todo` item looking unworked when a linked
 * work-item is in flight (or already done).
 *
 * THE GAP THIS CLOSES. A plan item and a work-item are two parallel claim systems
 * bridged only by a coord_links edge (rel in fixes|relates|duplicates, dst_kind=
 * plan_item — written by work_items:link / the forward edge on work_items:create).
 * Nothing rolled the work-item's claim/liveness back onto the plan item, so
 * `plans:items actionable=true` happily returned items that a linked WI was already
 * fixing → double-starts. This module fuses BOTH signals into one coverage level.
 *
 * TWO SIGNALS, ONE READ each (mirrors issue-blocks-merge.ts's hoisted-batch shape):
 *   1. coord_links work→plan_item edges + the linked work-item's TERMINAL state
 *      (issue: resolved|closed ; feature: passed|deprecated) — ONE query.
 *   2. the canonical fleet_assignment view (listFleetAssignments) — ONE read — for
 *      BOTH the linked work-items' LIVE activity (progressing|alive|stalled|dead)
 *      AND any direct plan_item_claim on the item itself.
 * Both are globally-keyed by the plan_item ref ('<slug>#<item>', globally unique),
 * so the multi-plan readers hoist getAllPlanItemCoverage() out of their plan loop.
 *
 * STALENESS. Like the issue-block overlay, this rides plans:items' 45s SWR cache —
 * the live-claim leg can lag a claim/release by up to that window. Acceptable for
 * the "don't double-start" use: the terminal/edge leg (the load-bearing part) is
 * exact, and a 45s-stale "someone's on it" only ever errs toward not double-starting.
 *
 * "Actively worked" ≡ activity progressing|alive (claimed by a LIVE holder). A
 * stalled/dead claim is RECLAIMABLE and deliberately does NOT count as covered —
 * the same truth fleet:assignments enforces (agent-activity-liveness-truth).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { listFleetAssignments, deriveActivity } from './fleet/assignments';
import { planItemRef, PLAN_ITEM_KIND } from './issue-blocks-merge';
import type { ItemActivity } from './item-activity';

/** The link rels that count a work-item as ADDRESSING a plan item. `blocks` is NOT
 *  here — that's the issue-block overlay (todo→blocked), a different relationship. */
export const COVERAGE_RELS = ['fixes', 'relates', 'duplicates'] as const;

/** Terminal (work-done) states per family — the cross-family ALL_TERMINAL set
 *  (work-items.ts: issue terminal = resolved|closed; feature terminal = passed|deprecated). */
const ISSUE_TERMINAL = new Set<string>(['resolved', 'closed']);
const FEATURE_TERMINAL = new Set<string>(['passed', 'deprecated']);

/** An activity that means a LIVE holder currently has the item (counts as covered). */
function isLiveActivity(a: ItemActivity): boolean {
  return a === 'progressing' || a === 'alive';
}

export type CoverageLevel =
  | 'none' // no linked work-item AND no direct claim → genuinely unworked
  | 'unclaimed' // links exist but every one is open + un-held (filed, nobody on it / stalled / dead)
  | 'partial' // some linked work is live-held (or a direct claim) but not all open links are
  | 'full' // every non-terminal linked work-item is live-held (or a bare direct claim)
  | 'complete'; // ≥1 link and EVERY linked work-item is terminal (the work is done)

export interface CoverageWorkLink {
  /** WI-/EI-/F- id of the linked work-item. */
  workItemId: string;
  rel: string;
  /** The linked work-item is in a terminal (done) state. */
  terminal: boolean;
  /** Live activity from the fleet view ('free' when no live claim row). */
  activity: ItemActivity;
  /** Holder ownerId when live-held (progressing|alive), else null. */
  holder: string | null;
}

export interface PlanItemCoverage {
  /** '<slug>#<item>'. */
  ref: string;
  links: CoverageWorkLink[];
  /** A LIVE plan_item_claim sits directly on the item. */
  directlyClaimed: boolean;
  directHolder: string | null;
  directActivity: ItemActivity | null;
  level: CoverageLevel;
  /** Distinct holder ids actively on it (live links + a live direct claim). */
  workers: string[];
}

/**
 * Pure coverage classifier (unit-testable, no I/O). `links` carry each linked
 * work-item's terminal flag + live activity; `directlyClaimed` is whether a LIVE
 * plan-item claim sits on the item. See {@link CoverageLevel} for the bands.
 */
export function classifyCoverage(
  links: Pick<CoverageWorkLink, 'terminal' | 'activity'>[],
  directlyClaimed: boolean,
): CoverageLevel {
  if (links.length === 0) return directlyClaimed ? 'full' : 'none';
  const nonTerminal = links.filter((l) => !l.terminal);
  // Every linked work-item is done → the plan item's work is complete (don't restart).
  if (nonTerminal.length === 0) return 'complete';
  const anyLive = directlyClaimed || nonTerminal.some((l) => isLiveActivity(l.activity));
  if (!anyLive) return 'unclaimed';
  // Fully covered iff every still-open linked work-item is live-held.
  if (nonTerminal.every((l) => isLiveActivity(l.activity))) return 'full';
  return 'partial';
}

/**
 * One coverage COLLISION (EI-6074): a plan item that is directly claimed by one
 * principal while a LINKED live work-item covering the SAME deliverable is held by
 * a DIFFERENT principal — two distinct principals both working the same thing
 * (the "WI-X ≡ P-Y" duplicate). This is the cross-claim-table redundancy the
 * per-type dedup floor can't see: a work-item claim and the plan-item claim it
 * implements live in different tables and are never cross-checked, so
 * orphaned/stalled both read 0 while two live bees run the same work.
 *
 * Deliberately NARROW — it fires ONLY when a DIRECT plan-item claim coexists with a
 * differently-held linked work-item. Legitimate parallel decomposition (several
 * distinct linked work-items, each held by a different bee, with NO direct plan-item
 * claim) is NOT a collision: those are different deliverables under one plan item.
 */
export interface CoverageCollision {
  /** '<slug>#<item>'. */
  ref: string;
  /** The principal holding the direct plan-item claim on the item. */
  directHolder: string;
  /** The DISTINCT principals holding linked live work-item claims on the same
   *  deliverable (each holder !== directHolder). */
  workItemHolders: { workItemId: string; holder: string }[];
  /** All distinct principals in the collision (directHolder + workItemHolders). */
  principals: string[];
}

/**
 * Detect coverage collisions across a coverage map (EI-6074). Pure; no I/O.
 * Returns, for each plan item that is directly claimed AND has a linked live
 * work-item held by a DIFFERENT principal, the colliding ref + principals — so a
 * reader (fleet:assignments) can surface "two distinct principals both resolve to
 * the same deliverable" as a coordination-collision, alongside orphaned/stalled.
 *
 * Note `PlanItemCoverage.links[].holder` is populated ONLY for LIVE (progressing|
 * alive) work-item claims (see getAllPlanItemCoverage), so a stalled/dead linked
 * claim — which is reclaimable, not a live duplicate — never counts as a collision.
 */
export function coverageCollisions(cov: Iterable<PlanItemCoverage>): CoverageCollision[] {
  const out: CoverageCollision[] = [];
  for (const c of cov) {
    if (!c.directlyClaimed || !c.directHolder) continue;
    const workItemHolders = c.links
      .filter((l): l is CoverageWorkLink & { holder: string } => l.holder != null && l.holder !== c.directHolder)
      .map((l) => ({ workItemId: l.workItemId, holder: l.holder }));
    if (workItemHolders.length === 0) continue;
    const principals = [...new Set([c.directHolder, ...workItemHolders.map((w) => w.holder)])];
    out.push({ ref: c.ref, directHolder: c.directHolder, workItemHolders, principals });
  }
  return out;
}

/** Lean wire shape attached per plan item (omit empty arrays to keep payload small). */
export interface CompactCoverage {
  level: CoverageLevel;
  workers?: string[];
  links?: { id: string; rel: string; activity: ItemActivity; terminal: boolean }[];
}

export function compactCoverage(cov: PlanItemCoverage): CompactCoverage {
  return {
    level: cov.level,
    ...(cov.workers.length ? { workers: cov.workers } : {}),
    ...(cov.links.length
      ? {
          links: cov.links.map((l) => ({
            id: l.workItemId,
            rel: l.rel,
            activity: l.activity,
            terminal: l.terminal,
          })),
        }
      : {}),
  };
}

interface CoverageLinkRow {
  dst_ref: string;
  rel: string;
  src_kind: string;
  src_ref: string;
  issue_state: string | null;
  feature_status: string | null;
  feature_id: string | null;
}

/**
 * Every plan item with ≥1 work→plan_item edge OR a live direct claim, keyed by the
 * coord_links dst_ref ('<plan_slug>#<item_id>') → its fused coverage. ONE coord_links
 * query + ONE fleet_assignment read, so multi-plan readers hoist it out of their plan
 * loop (the issue-blocks-merge pattern). Pure read; never throws on empty.
 */
export async function getAllPlanItemCoverage(): Promise<Map<string, PlanItemCoverage>> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();

  // 1. work→plan_item edges + the linked work-item's terminal state. NOTE: unlike the
  //    issue-BLOCK edge (issues:link → coord DEFAULT workspace), work_items:link writes
  //    the work→plan edge into the CALLER's workspace, so these edges are spread across
  //    workspaces — we must NOT filter coord_links by a fixed workspace (that silently
  //    dropped every edge). The plan_item dst_ref ('<slug>#<item>') is GLOBALLY unique,
  //    so an unfiltered match is collision-safe and the harness-scoped reader only ever
  //    looks up the refs of plans it lists. engineer_issues joins on the globally-unique
  //    issue_id (EI-2760). A feature_id is unique only per (workspace, harness), so the
  //    feature join is pinned to the active workspace (getWorkItem's F-B3 rule) on the
  //    harness-qualified '<harness>#<id>' src_ref — a cross-workspace feature link just
  //    resolves to null state (treated non-terminal, the safe direction).
  const linkRows = await sql<CoverageLinkRow[]>`
    SELECT l.dst_ref, l.rel, l.src_kind, l.src_ref,
           i.state      AS issue_state,
           f.status     AS feature_status,
           f.feature_id AS feature_id
      FROM harness_shared.coord_links l
      LEFT JOIN harness_shared.engineer_issues i
        ON l.src_kind = 'issue' AND i.issue_id = l.src_ref
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON l.src_kind = 'feature'
       AND (f.harness_slug || '#' || f.feature_id) = l.src_ref
       AND f.workspace_id = ${ws}
     WHERE l.rel IN ('fixes', 'relates', 'duplicates')
       AND l.dst_kind = ${PLAN_ITEM_KIND}
     ORDER BY l.dst_ref, l.src_ref`;

  // 2. live claims (work-item AND plan-item) from the canonical view — one read.
  const fleet = await listFleetAssignments({ workspaceId: null, activeOnly: true });
  const wiActivity = new Map<string, { activity: ItemActivity; holder: string | null }>();
  const directClaim = new Map<string, { activity: ItemActivity; holder: string | null }>();
  for (const r of fleet) {
    if (r.source === 'work_item_claim' && r.workItemId) {
      wiActivity.set(r.workItemId, { activity: deriveActivity(r), holder: r.agentId });
    } else if (r.source === 'plan_item_claim' && r.planSlug && r.itemId) {
      directClaim.set(planItemRef(r.planSlug, r.itemId), {
        activity: deriveActivity(r),
        holder: r.agentId,
      });
    }
  }

  // Group links by plan-item ref, joining each to its live activity.
  const byRef = new Map<string, CoverageWorkLink[]>();
  for (const row of linkRows) {
    const workItemId = row.src_kind === 'issue' ? row.src_ref : (row.feature_id ?? row.src_ref);
    const terminal =
      (row.issue_state != null && ISSUE_TERMINAL.has(row.issue_state)) ||
      (row.feature_status != null && FEATURE_TERMINAL.has(row.feature_status));
    const live = wiActivity.get(workItemId);
    const activity: ItemActivity = live?.activity ?? 'free';
    const holder = isLiveActivity(activity) ? (live?.holder ?? null) : null;
    const arr = byRef.get(row.dst_ref) ?? [];
    arr.push({ workItemId, rel: row.rel, terminal, activity, holder });
    byRef.set(row.dst_ref, arr);
  }

  // Assemble coverage for the union of refs that have a link OR a direct claim.
  const out = new Map<string, PlanItemCoverage>();
  const refs = new Set<string>([...byRef.keys(), ...directClaim.keys()]);
  for (const ref of refs) {
    const links = byRef.get(ref) ?? [];
    const direct = directClaim.get(ref) ?? null;
    const directlyClaimed = Boolean(direct && isLiveActivity(direct.activity));
    const level = classifyCoverage(links, directlyClaimed);
    const workers = new Set<string>();
    for (const l of links) if (l.holder) workers.add(l.holder);
    if (directlyClaimed && direct?.holder) workers.add(direct.holder);
    out.set(ref, {
      ref,
      links,
      directlyClaimed,
      directHolder: direct?.holder ?? null,
      directActivity: direct?.activity ?? null,
      level,
      workers: [...workers],
    });
  }
  return out;
}
