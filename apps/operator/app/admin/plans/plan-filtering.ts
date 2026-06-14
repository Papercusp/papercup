/**
 * Shared plan filter/search predicate.
 *
 * Extracted from PlanRail so the rail list and the bucket-tab count
 * badges (PlanBucketTabs) apply the EXACT same filtering — the only
 * difference is the bucket filter, which callers layer on top via
 * `bucketOf`. Keeping this pure + in one place means the badge counts
 * can never drift from what the rail actually shows.
 *
 * Deliberately bucket-agnostic: status/bucket is NOT filtered here.
 */

import type { PlanListRow } from './plans-api';
import { withinDateWindow, type DateWindow } from './PlanFilters';

/** The owner saved-view lens (shared-hive-collaboration P-002): all plans,
 *  only mine, or only others'. Keyed on the viewer's plan-owner email. */
export const OWNER_VIEWS = ['all', 'mine', 'others'] as const;
export type OwnerView = (typeof OWNER_VIEWS)[number];

export interface PlanFilterState {
  date: DateWindow | null;
  owner: string | null;
  /** P-002 saved-view: 'all' (default) | 'mine' | 'others'. */
  view: OwnerView;
  /** The viewer's plan-owner email (git config user.email), or null when
   *  unresolvable — then 'mine'/'others' degrade to no-op (show all). */
  viewerEmail: string | null;
  archived: boolean;
  legacy: boolean;
  inbox: boolean;
  actionable: boolean;
  /** Only plans the Scout loop routed (origin 'scout', ledger-derived server-side). */
  scout: boolean;
}

/**
 * Apply every plan filter EXCEPT the bucket filter, then the search
 * query. `searchHitSlugs` unions in server-side cross-plan body matches
 * so a search for body-only text still surfaces the plan (same union the
 * rail used previously).
 */
export function applyPlanFilters(
  plans: PlanListRow[],
  f: PlanFilterState,
  query: string,
  searchHitSlugs?: ReadonlySet<string>,
): PlanListRow[] {
  let working = plans;
  // P-002 owner saved-view (keyed on the viewer's email). Degrades to no-op when
  // the viewer email is unknown, so 'mine'/'others' never hide everything blindly.
  if (f.viewerEmail) {
    const me = f.viewerEmail.toLowerCase();
    if (f.view === 'mine') working = working.filter((p) => (p.owner ?? '').toLowerCase() === me);
    else if (f.view === 'others') working = working.filter((p) => !!p.owner && p.owner.toLowerCase() !== me);
  }
  if (f.owner) working = working.filter((p) => p.owner === f.owner);
  if (f.date) working = working.filter((p) => withinDateWindow(p.updated, f.date));
  working = working.filter((p) => (f.archived ? p.archived : !p.archived));
  if (f.legacy) working = working.filter((p) => p.isLegacy);
  if (f.inbox) {
    working = working.filter((p) => ((p.itemCounts ?? {})['needs-human'] ?? 0) > 0);
  }
  if (f.actionable) {
    working = working.filter((p) => ((p.itemCounts ?? {}).todo ?? 0) > 0);
  }
  if (f.scout) {
    working = working.filter((p) => p.origin === 'scout');
  }
  const needle = query.trim().toLowerCase();
  if (!needle) return working;
  return working.filter(
    (p) =>
      (p.title ?? '').toLowerCase().includes(needle) ||
      p.slug.toLowerCase().includes(needle) ||
      (searchHitSlugs?.has(p.slug) ?? false),
  );
}
