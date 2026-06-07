/**
 * change-feed-deps.ts — the production WIRING of the Change Feed readers
 * to actual database sources (work_items, gym_proposals, plan runs).
 *
 * Mirrors the fleet-signals / deps pattern: inject minimal reader contracts
 * so the core `change-feed` normalizer stays pure + testable. The production
 * builder wires the real PG queries.
 */

import type { ChangeFeedEntry, ChangeFeedReaders } from './change-feed';
import { getOperatorDb } from '../db-tools/get-operator-db';

/**
 * Fetch work-item completions: items that reached a terminal status.
 * Reads from the work_items table (union of harness_features_consolidated
 * and engineer_issues), filtering for done/resolved/closed states.
 */
async function fetchWorkItemCompletions(): Promise<ChangeFeedEntry[]> {
  const db = await getOperatorDb();
  const rows = await db.query(
    `
    SELECT
      COALESCE(feature_id, id) AS item_id,
      harness_slug,
      COALESCE(title, '') AS title,
      status,
      to_timestamp(taken_at / 1000.0) AT TIME ZONE 'UTC' AS ts,
      FALSE AS user_requested
    FROM harness_shared.work_items
    WHERE status IN ('done', 'passed', 'resolved', 'closed')
      AND taken_at IS NOT NULL
    ORDER BY taken_at DESC
    LIMIT 500
    `,
    []
  );

  return rows.map((r: any) => ({
    id: `wi:${r.item_id}`,
    kind: 'completion' as const,
    title: r.title || `Completed: ${r.item_id}`,
    detail: `Status: ${r.status}`,
    harness: r.harness_slug || undefined,
    workItemId: r.item_id,
    ref: `wi:${r.item_id}`,
    ts: (r.ts as Date).toISOString(),
    userRequested: r.user_requested,
  }));
}

/**
 * Fetch gym proposals: prompt changes that were accepted / rejected.
 * Reads from gym_proposals, filtering for terminal status.
 */
async function fetchGymProposals(): Promise<ChangeFeedEntry[]> {
  const db = await getOperatorDb();
  const rows = await db.query(
    `
    SELECT
      id,
      harness_slug,
      role,
      status,
      decided_at,
      to_timestamp(decided_at::double precision / 1000.0) AT TIME ZONE 'UTC' AS ts
    FROM harness_shared.gym_proposals
    WHERE status IN ('accepted', 'rejected', 'superseded')
      AND decided_at IS NOT NULL
    ORDER BY decided_at DESC
    LIMIT 500
    `,
    []
  );

  return rows.map((r: any) => ({
    id: `gym:${r.id}`,
    kind: 'proposal' as const,
    title: `${r.status === 'accepted' ? 'Accepted' : 'Rejected'} prompt for ${r.role}`,
    detail: `Status: ${r.status}`,
    harness: r.harness_slug || undefined,
    ref: `gym:${r.id}`,
    ts: (r.ts as Date).toISOString(),
    userRequested: false,
  }));
}

/**
 * Fetch plan runs: plans that finished executing.
 * Reads from harness_plan_items with status='done'.
 */
async function fetchPlanRuns(): Promise<ChangeFeedEntry[]> {
  const db = await getOperatorDb();
  const rows = await db.query(
    `
    SELECT
      slug,
      title,
      status,
      finished_at,
      harness_slug
    FROM harness_shared.harness_plans
    WHERE status = 'done'
      AND finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 500
    `,
    []
  );

  return rows.map((r: any) => ({
    id: `plan:${r.slug}`,
    kind: 'plan-run' as const,
    title: `Plan completed: ${r.title || r.slug}`,
    harness: r.harness_slug || undefined,
    ref: `plan:${r.slug}`,
    ts: (r.finished_at as Date).toISOString(),
    userRequested: false,
  }));
}

/**
 * Build the production ChangeFeedReaders that queries the database.
 * Each reader is wrapped in defensive error handling so one bad query
 * doesn't kill the entire feed.
 */
export function buildChangeFeedReaders(): ChangeFeedReaders {
  return {
    async workItemCompletions() {
      return fetchWorkItemCompletions();
    },
    async gymProposals() {
      return fetchGymProposals();
    },
    async planRuns() {
      return fetchPlanRuns();
    },
  };
}
