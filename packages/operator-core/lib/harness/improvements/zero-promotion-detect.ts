/**
 * Zero-promotion detector (unified-work-item-ledger-2026-06-21 P-009).
 *
 * The recurrence guard for the promotion gap (P-003): a plan that is started +
 * eligible and carries OPEN plan-items but has ZERO work-items means plan→work-item
 * promotion silently stopped producing placeable work — the exact failure that left
 * the Queen idle before P-003. This module is the PURE detection core (a filter over
 * per-plan counts); it has NO I/O, so it is fully unit-testable.
 *
 * Wiring (DEFERRED to attended — see the plan D-004/P-009 note): a watchdog
 * collector in `defaultPapercuspCollectors` (watchdog.ts) that, ONLY when the
 * `papercusp-plan-workitem-promotion` flag is ON (early-return [] when OFF so it is
 * inert while promotion is dark), queries started+eligible plans with their
 * open-item + work-item counts and feeds them here. Registering it also requires
 * adding `'zero-promotion'` to the WatchdogSource union. Kept out of the live
 * watchdog until the flag is activated, so it can't fire on every started plan
 * while promotion is intentionally dark.
 */

/** Per-plan counts the detector reasons over (one row per started+eligible plan). */
export interface PlanPromotionCount {
  planSlug: string;
  harnessSlug: string;
  /** Plan-items that are NOT done/dropped (what promotion would mint work for). */
  openItemCount: number;
  /** Work-items whose source_plan_slug is this plan (any non-terminal state). */
  workItemCount: number;
}

/** A zero-promotion finding, shaped to map directly onto a WatchdogSignal at the
 *  (attended) collector site. Its own type so this pure module needs no import
 *  from the large watchdog.ts (and no dependency on the WatchdogSource union). */
export interface ZeroPromotionFinding {
  source: 'zero-promotion';
  /** dedup key — the plan slug. */
  key: string;
  title: string;
  body: string;
  severity: 'major';
  /** harness:<slug> so triage keys off the owning hive. */
  scope: string;
  findingClass: 'promotion:zero-conversion';
}

/**
 * Find plans that are started+eligible with open items but ZERO work-items. Pure:
 * the caller supplies the counts (read from PG behind the promotion flag). A plan
 * with no open items, or with at least one work-item, is healthy → no finding.
 */
export function detectZeroPromotion(plans: readonly PlanPromotionCount[]): ZeroPromotionFinding[] {
  return plans
    .filter((p) => p.openItemCount > 0 && p.workItemCount === 0)
    .map((p) => ({
      source: 'zero-promotion' as const,
      key: p.planSlug,
      title: `Started plan has open items but zero work-items: ${p.planSlug}`,
      body:
        `Plan ${p.planSlug} (${p.harnessSlug}) has ${p.openItemCount} open plan-item(s) but 0 work-items. ` +
        `plan→work-item promotion is not producing placeable work, so the Queen has nothing to place from it ` +
        `(unified-work-item-ledger P-003/P-009).`,
      severity: 'major' as const,
      scope: `harness:${p.harnessSlug}`,
      findingClass: 'promotion:zero-conversion' as const,
    }));
}
