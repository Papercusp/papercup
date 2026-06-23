/**
 * readiness-reconcile.ts — drift detector for the MAINTAINED readiness sidecar
 * (work-item-deps-and-readiness-2026-06-22 P-005 / D-007).
 *
 * Migration 379 added `harness_shared.work_item_blocked`: PRESENCE of a
 * (workspace_id, harness_slug, feature_id) row = the feature item is NOT ready
 * (has >=1 unsatisfied blocks-edge); ABSENCE = ready. It is kept exact by the
 * wir_* DB triggers. The ORACLE — the ground truth those triggers MUST agree
 * with — is the SQL function `harness_shared.work_item_is_blocked(harness, feature)`
 * (the same inline NOT EXISTS predicate the scheduler claim uses as its fallback).
 *
 * Because the sidecar is trigger-maintained, a trigger bug can leave it out of
 * sync with the oracle. Two drift directions, both dangerous for the scheduler:
 *
 *   • MISSING — a feature is blocked per the oracle but has NO sidecar row. The
 *     sidecar says "ready", so the indexed-anti-join claim hands out blocked work.
 *     This is the dangerous-stale direction (a blocked item looks ready).
 *   • EXTRA — a sidecar row exists for an item that is NOT actually blocked per
 *     the oracle (incl. rows for non-feature / non-existent items). The sidecar
 *     says "blocked", so a ready item is never claimed and STARVES.
 *
 * `reconcileReadiness` reports both in ONE round-trip — a FULL OUTER JOIN between
 * the live sidecar and the oracle's blocked-feature set. It does NOT repair the
 * sidecar; it is a detector the scheduler/health surface reads so it can refuse
 * to silently hand out (or starve) work while the triggers are wrong.
 *
 * FEATURE family = harness_shared.work_items rows with
 * item_kind NOT IN ('bug','change','task') — exactly the set the sidecar covers.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

/** One (workspace_id, harness_slug, feature_id) sidecar key. */
export interface ReadinessKey {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
}

export interface ReadinessReconcileResult {
  /** missing.length + extra.length — total sidecar-vs-oracle disagreements. */
  drift: number;
  /**
   * Feature items the oracle says are BLOCKED but that have NO sidecar row
   * (the sidecar wrongly looks ready → the claim hands out blocked work).
   */
  missing: ReadinessKey[];
  /**
   * Sidecar rows whose item is NOT actually blocked per the oracle (a ready item
   * wrongly looks blocked → it starves). Includes sidecar rows for items that
   * are not feature-family or no longer exist — neither is in the oracle set.
   */
  extra: ReadinessKey[];
}

/**
 * Detect drift between the maintained `work_item_blocked` sidecar and the
 * `work_item_is_blocked()` oracle over the feature family, in one round-trip.
 *
 * @param sql org admin postgres handle; defaults to `getOrgPg().sql` (the same
 *   way other operator-core modules acquire it). Pass an explicit handle in
 *   tests (the integration test points it at a testcontainer DB).
 */
export async function reconcileReadiness(sql: Sql = getOrgPg().sql): Promise<ReadinessReconcileResult> {
  // ORACLE set = feature items the predicate says are blocked.
  // SIDECAR set = the current work_item_blocked rows.
  // A FULL OUTER JOIN on the (workspace_id, harness_slug, feature_id) key splits
  // the symmetric difference into the two drift directions:
  //   • oracle row present, sidecar NULL  → MISSING (dangerous-stale: looks ready)
  //   • sidecar row present, oracle NULL  → EXTRA   (starving: looks blocked)
  // One pass, set-based — no per-item probe.
  const rows = await sql<
    Array<{
      direction: 'missing' | 'extra';
      workspace_id: string;
      harness_slug: string;
      feature_id: string;
    }>
  >`
    WITH oracle AS (
      SELECT f.workspace_id, f.harness_slug, f.feature_id
        FROM harness_shared.work_items f
       WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
         AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id)
    ),
    sidecar AS (
      SELECT wb.workspace_id, wb.harness_slug, wb.feature_id
        FROM harness_shared.work_item_blocked wb
    )
    SELECT
      CASE WHEN o.feature_id IS NULL THEN 'extra' ELSE 'missing' END AS direction,
      COALESCE(o.workspace_id, s.workspace_id) AS workspace_id,
      COALESCE(o.harness_slug, s.harness_slug) AS harness_slug,
      COALESCE(o.feature_id,   s.feature_id)   AS feature_id
      FROM oracle o
      FULL OUTER JOIN sidecar s
        ON  s.workspace_id = o.workspace_id
        AND s.harness_slug = o.harness_slug
        AND s.feature_id   = o.feature_id
     WHERE o.feature_id IS NULL OR s.feature_id IS NULL
     ORDER BY direction, workspace_id, harness_slug, feature_id
  `;

  const missing: ReadinessKey[] = [];
  const extra: ReadinessKey[] = [];
  for (const r of rows) {
    const key: ReadinessKey = {
      workspace_id: r.workspace_id,
      harness_slug: r.harness_slug,
      feature_id: r.feature_id,
    };
    if (r.direction === 'missing') missing.push(key);
    else extra.push(key);
  }

  return { drift: missing.length + extra.length, missing, extra };
}
