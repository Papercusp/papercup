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

/**
 * The PG read that feeds the pure detector (unified-work-item-ledger P-009). Counts,
 * per STARTED + non-archived plan in the workspace, its OPEN plan-items (the JSONB
 * `items` array, status NOT done/dropped) and its work-items (by `source_plan_slug`,
 * ANY state — a single ever-minted work-item, even since completed, proves promotion
 * ran, so this is the conservative "promotion never produced placeable work" signal
 * and not a per-item gap detector). The detector then keeps only plans with open
 * items + zero work-items.
 *
 * Gated by `papercusp-plan-workitem-promotion`: while promotion is dark it produces
 * nothing by design, so firing would be pure noise → return a 'dark' note and no
 * signals. Now that the flag is ON, a finding means promotion genuinely broke for
 * that plan (the recurrence guard for the P-003 silent-zero class).
 *
 * One workspace-scoped query, LIMITed — cheap enough for the per-tick watchdog.
 */
export async function collectZeroPromotionSignals(
  workspaceId: string,
): Promise<{ signals: ZeroPromotionFinding[]; note?: string }> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const { systemDistinctId } = await import('../../flag-distinct-id');
  const enabled = await getFlag(FLAGS.PLAN_WORKITEM_PROMOTION, systemDistinctId());
  if (!enabled) return { signals: [], note: 'dark: papercusp-plan-workitem-promotion OFF' };

  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; plan_slug: string; open_items: number; work_items: number }[]
  >`
    WITH started AS (
      SELECT harness_slug, plan_slug, items
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND op_status = 'started'
         AND COALESCE(archived, false) = false
    ),
    open_counts AS (
      SELECT s.harness_slug, s.plan_slug,
             COUNT(*) FILTER (
               WHERE COALESCE(it->>'status', 'todo') NOT IN ('done', 'dropped')
             )::int AS open_items
        FROM started s
        LEFT JOIN LATERAL jsonb_array_elements(COALESCE(s.items, '[]'::jsonb)) it ON true
       GROUP BY s.harness_slug, s.plan_slug
    ),
    wi_counts AS (
      SELECT source_plan_slug AS plan_slug, harness_slug, COUNT(*)::int AS work_items
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug IS NOT NULL
       GROUP BY source_plan_slug, harness_slug
    )
    SELECT o.harness_slug, o.plan_slug, o.open_items,
           COALESCE(w.work_items, 0) AS work_items
      FROM open_counts o
      LEFT JOIN wi_counts w
        ON w.plan_slug = o.plan_slug AND w.harness_slug = o.harness_slug
     WHERE o.open_items > 0
     ORDER BY o.open_items DESC
     LIMIT 50
  `;
  const counts: PlanPromotionCount[] = rows.map((r) => ({
    planSlug: r.plan_slug,
    harnessSlug: r.harness_slug,
    openItemCount: Number(r.open_items),
    workItemCount: Number(r.work_items),
  }));
  return { signals: detectZeroPromotion(counts) };
}
