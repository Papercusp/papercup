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
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

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
  /** The row's lifecycle status. Selected so the shape can EXPRESS finishedness:
   *  before WI-5981 this column was not read at all, so no consumer downstream was
   *  even capable of filtering a completed item out of the owner's inbox. */
  status: string | null;
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
    SELECT feature_id, title, summary, harness_slug, item_kind, taken_by, updated_ts, status
      FROM harness_shared.work_items
     WHERE (workspace_id = ${wid} OR workspace_id = 'default')
       AND (${hf}::text IS NULL OR harness_slug = ${hf})
       -- WI-5981: a FINISHED item must never demand the owner's attention. Without
       -- this, every row that ever carried payload.needsHuman stayed in the inbox
       -- forever: measured live on papercusp 2026-07-26, 161 of 249 matching rows
       -- (65%) were already terminal (done 143 · dropped 11 · closed 7), so ~2 of
       -- every 3 cards in the owner's decision feed were completed work. The tier
       -- mapper scores these 'decision', and the Inbox scope predicate keeps every
       -- Decision REGARDLESS OF AGE, so nothing downstream could ever age them out.
       -- DERIVE the set from ANY_FAMILY_TERMINAL_STATES (both families are read
       -- here) — never re-list the words: EI-18653071581558556 is the same bug
       -- class, where a hand-copied union drifted and scored ~88% of finished
       -- units as phantom failures. The 'needs-human' status is not terminal, so
       -- the feature-family leg below is unaffected.
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       AND (
         status = 'needs-human'
         OR (
           item_kind IN ('bug', 'change', 'task')
           AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true'
         )
       )
     -- Deterministic newest-first under the cap. The bare LIMIT had no ORDER BY,
     -- so once the row count crossed NEEDS_HUMAN_LIMIT the retained subset was
     -- whatever Postgres happened to return — real owner decisions would vanish
     -- silently and unreproducibly. (At 249 rows we were already at 83% of the
     -- cap, and the 161 terminal rows above were what would have pushed it over.)
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT ${limit}
  `;
}
