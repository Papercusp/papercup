/**
 * needs-human-work-items-source — the I/O half of the needs-human work-items
 * attention source (owner-inbox-single-pane-2026-07-17 P-005a).
 *
 * Reads needs-human work-items of EVERY kind — feature/chunk
 * (`status = 'needs-human'`) and bug/change/task (`payload.needsHuman`) — off
 * the single cross-kind `harness_shared.work_items` VIEW (unify-work-items
 * D-010(b)) rather than either per-kind reader, so neither family's dialect
 * is missed.
 *
 * Split out of the plans:attention handler so the read has a mockable module
 * path like every other attention source (operator-report-source,
 * triage-store, …). Inline `getOrgPg().sql` in the handler let the unit test
 * leak through to the live database: `vi.mock('@papercusp/db-org')` does not
 * reliably intercept a dynamic import fired inside the handler's Promise.all
 * fan-out (attention-parallel-db-org-mock-race-2026-07-17), and the hoisted
 * shared-import mitigation was not sufficient. Mock THIS module's path
 * instead — path-mocked helper modules are the pattern the rest of the
 * handler's sources already follow.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** One raw needs-human work-item row, as the attention mapper consumes it. */
export interface NeedsHumanWorkItemRow {
  feature_id: string;
  title: string | null;
  summary: string | null;
  harness_slug: string | null;
  item_kind: string | null;
  taken_by: string | null;
  /** Last-updated timestamp of the row — drives the Inbox card date
   *  (inbox-pane-active-scope-dates-filters-2026-07-19). */
  updated_ts: string | null;
}

export const NEEDS_HUMAN_LIMIT = 300;

export async function readNeedsHumanWorkItems(opts?: {
  workspaceId?: string;
  /** Restrict to one harness_slug; null/undefined = all. */
  harness?: string | null;
  limit?: number;
}): Promise<NeedsHumanWorkItemRow[]> {
  const { sql } = getOrgPg();
  const wid = opts?.workspaceId ?? activeWorkspaceId();
  const hf = opts?.harness ?? null;
  const limit = opts?.limit ?? NEEDS_HUMAN_LIMIT;
  return await sql<NeedsHumanWorkItemRow[]>`
    SELECT feature_id, title, summary, harness_slug, item_kind, taken_by, updated_ts
      FROM harness_shared.work_items
     WHERE (workspace_id = ${wid} OR workspace_id = 'default')
       AND (${hf}::text IS NULL OR harness_slug = ${hf})
       AND (
         status = 'needs-human'
         OR (
           item_kind IN ('bug', 'change', 'task')
           AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
         )
       )
     LIMIT ${limit}
  `;
}
