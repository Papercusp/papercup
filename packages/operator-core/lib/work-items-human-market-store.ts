/** E3 uses the existing work_items row and its CDC; no separate jobs table. */
import type { getOrgPg } from '@papercusp/db-org';
import { boundedOrgTxn } from './pg-bounded-txn';
import { admittedWhereSql } from './work-items-admission';
import { CLAIM_SUBJECT_BASELINE_KEY } from './claim-subject-baseline';
import {
  claimHumanMarketJob, humanAssignee, readHumanMarketJob, submitHumanMarketJob,
} from './work-items-human-market';

type Sql = ReturnType<typeof getOrgPg>['sql'];
export interface HumanMarketItem {
  id: string;
  state: string;
  assignee: string | null;
  payload: Record<string, unknown>;
}
interface Row {
  feature_id: string;
  status: string;
  taken_by: string | null;
  payload: Record<string, unknown>;
}
const itemFromRow = (row: Row): HumanMarketItem => ({
  id: row.feature_id, state: row.status, assignee: row.taken_by, payload: row.payload,
});
interface Scope { workspaceId: string; harness: string; id: string }

function requireScope(scope: Scope): void {
  if (!scope.workspaceId.trim() || scope.workspaceId === '*' || !scope.harness.trim() || scope.harness === '*') {
    throw new Error('market_scope_required');
  }
}

async function readItem(sql: Sql, scope: Scope): Promise<HumanMarketItem | null> {
  requireScope(scope);
  const rows = await sql<Row[]>`
    SELECT feature_id, status, taken_by, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
       AND feature_id = ${scope.id}
       AND COALESCE(origin, 'local') = 'local'
       AND ${admittedWhereSql(sql)}
       AND payload->>'humanWork' IS NOT NULL
       AND claim_hold IS NOT TRUE`;
  return rows[0] ? itemFromRow(rows[0]) : null;
}

export async function getHumanMarketItem(scope: Scope): Promise<HumanMarketItem | null> {
  return boundedOrgTxn((sql) => readItem(sql, scope));
}

/**
 * Only an authenticated HTTP session supplies userId. The offer version comes
 * from the terms the person saw. CAS also compares the entire stored offer,
 * lifecycle and holder, so editing terms without bumping version cannot race
 * this write. Unrelated payload keys are merged in PostgreSQL, never replaced.
 */
export async function actOnHumanMarketItem(input: Scope & {
  userId: string;
  version: number;
  action: 'claim' | 'submit';
  result?: string;
}): Promise<HumanMarketItem> {
  return boundedOrgTxn(async (sql) => {
    const before = await readItem(sql, input);
    if (!before) throw new Error('market_offer_required');
    const job = readHumanMarketJob(before);
    if (!job) throw new Error('market_offer_required');
    if (job.version !== input.version) throw new Error('market_offer_changed');
    const at = new Date().toISOString();
    const next = input.action === 'claim'
      ? claimHumanMarketJob(before, input.userId, at)
      : submitHumanMarketJob(before, input.userId, input.result ?? '', at);
    if (next.version === job.version) return before;
    const claiming = input.action === 'claim';
    const rows = await sql<Row[]>`
      UPDATE harness_shared.work_items
         SET payload = COALESCE(payload, '{}'::jsonb)
               || jsonb_build_object('humanWork', ${JSON.stringify(next)}::text::jsonb)
               || CASE WHEN ${claiming} THEN jsonb_build_object(
                    ${CLAIM_SUBJECT_BASELINE_KEY}::text, jsonb_build_object(
                      'kind', item_kind, 'title', COALESCE(title, ''),
                      'summary', COALESCE(summary, ''), 'body', COALESCE(summary, ''),
                      'watchdogKey', CASE WHEN jsonb_typeof(payload->'watchdogKey') = 'string'
                        THEN payload->>'watchdogKey' ELSE NULL END),
                    'claim_history_post_id', COALESCE((
                      SELECT max(id) FROM harness_shared.coord_thread_posts
                       WHERE workspace_id = ${input.workspaceId}), 0))
                  ELSE '{}'::jsonb END,
             status = 'wip', taken_by = ${humanAssignee(input.userId)},
             taken_at = CASE WHEN ${claiming} THEN now() ELSE taken_at END,
             last_progress_at = now(), updated_ts = ${Date.now()}
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness}
         AND feature_id = ${input.id}
         AND status = ${before.state}
         AND taken_by IS NOT DISTINCT FROM ${before.assignee}
         AND payload->'humanWork' = ${JSON.stringify(before.payload.humanWork)}::text::jsonb
         AND COALESCE(origin, 'local') = 'local'
         AND ${admittedWhereSql(sql)}
         AND claim_hold IS NOT TRUE
      RETURNING feature_id, status, taken_by, payload`;
    if (!rows[0]) throw new Error('market_offer_changed');
    // The canonical base-table trigger captures this write under the existing
    // family-specific wire name and invalidates the work-item sync queries.
    return itemFromRow(rows[0]);
  });
}
