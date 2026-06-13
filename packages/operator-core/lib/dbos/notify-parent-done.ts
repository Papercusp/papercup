/**
 * notify-parent-done — the TS builtin behind the DBOS `afterDone` hook step
 * (promote-spawn-child-harness-2026-05-31 P-004).
 *
 * The retired bash run-loop resolved `hooks/builtins/afterDone.sh`
 * (libs/papercusp/packages/harness/hooks/builtins/afterDone.sh), which posted a
 * `Completion` message to the harness's parent on mission completion. The DBOS
 * finalize path only fired the PLUGIN hook — the parent-notification builtin was
 * never wired, so a spawned child finished silently and the parent agent never
 * learned its sub-work was done. This module is that builtin, ported:
 *
 *   - parent comes from PG (`harness_shared.projects.parent_slug` — the value
 *     `doScaffoldHarness` seals server-side), NOT from `.papercusp/config.json`
 *     (deprecated as a live config source).
 *   - "mission completion" in the per-feature DBOS world = the harness's queue
 *     DRAINING: this fires on a feature's DONE finalize only when no other
 *     non-terminal feature remains (terminal = passed/deprecated). Same
 *     semantics as the bash builtin, which ran when the run-loop's queue
 *     emptied — and it avoids spamming the parent once per feature.
 *   - the message rides the execute-action path (`dispatchAction` →
 *     `doSendMessage`) with the child as the caller, exactly like the bash
 *     builtin's bearer-authenticated POST: kind=`Completion`, addressed to the
 *     parent's inbox (`messages:inbox` surfaces it to the parent agent).
 *
 * A per-harness `hooks/afterDone.sh` still OVERRIDES this builtin entirely
 * (parity with the run.sh resolver) — the caller (orchestrator-runner's
 * afterDone step) only invokes this when the user hook didn't run.
 *
 * Best-effort: never throws; every outcome is reported in the result.
 */

import { getOrgPg } from '@papercusp/db-org';
import { dispatchAction } from '../execute-action';
import { activeWorkspaceId } from '../workspace-registry';

/** The org-PG tagged-template client type — for the optional test seam below. */
type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface NotifyParentResult {
  notified: boolean;
  parent?: string;
  /** Why nothing was sent: no_parent | queue_not_drained | send_failed | lookup_failed. */
  reason?: string;
  /** Non-terminal features still in the queue (when reason=queue_not_drained). */
  remaining?: number;
}

export async function notifyParentOnDone(opts: {
  harnessSlug: string;
  workspaceId?: string;
  /** The feature whose DONE finalize triggered this check — excluded from the
   *  drain count (its own status flip may not have landed yet). */
  featureId?: string;
  log?: (m: string) => void;
  /**
   * Test seam (DI): inject the org-PG client + the action dispatcher. Both
   * default to the real ones — production callers (orchestrator-runner's
   * afterDone step) pass neither. Lets the full branch matrix (no_parent /
   * queue_not_drained / drained→notify / send_failed / lookup_failed) be
   * unit-tested without PG or a global vi.mock.
   */
  deps?: { sql?: OrgSql; dispatch?: typeof dispatchAction };
}): Promise<NotifyParentResult> {
  const log = opts.log ?? (() => {});
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const dispatch = opts.deps?.dispatch ?? dispatchAction;

  let parent: string | null = null;
  try {
    const sql = opts.deps?.sql ?? getOrgPg().sql;
    const rows = await sql<{ parent_slug: string | null }[]>`
      SELECT parent_slug FROM harness_shared.projects
       WHERE slug = ${opts.harnessSlug} AND parent_slug IS NOT NULL
       LIMIT 1
    `;
    parent = rows[0]?.parent_slug ?? null;
    if (!parent) return { notified: false, reason: 'no_parent' };

    // Drained = no other feature is non-terminal. The triggering feature is
    // excluded — finalize can run before its own passed-flip is visible.
    const remainRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${opts.harnessSlug}
         AND feature_id  <> ${opts.featureId ?? ''}
         AND status NOT IN ('passed', 'deprecated')
    `;
    const remaining = remainRows[0]?.n ?? 0;
    if (remaining > 0) {
      return { notified: false, parent, reason: 'queue_not_drained', remaining };
    }
  } catch (e) {
    log(`[afterDone] parent/drain lookup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return { notified: false, reason: 'lookup_failed' };
  }

  try {
    const r = await dispatch(opts.harnessSlug, {
      op: 'send_message',
      to: [parent],
      kind: 'Completion',
      subject: `mission DONE: ${opts.harnessSlug}`,
      body:
        `Harness ${opts.harnessSlug} finished its queue` +
        (opts.featureId ? ` (last feature: ${opts.featureId})` : '') +
        '. All features are terminal (passed/deprecated).',
      reason: 'afterDone builtin: notifying parent harness of mission completion',
    });
    if (!r.ok) {
      log(`[afterDone] Completion send to ${parent} failed: ${r.error}${r.detail ? `: ${r.detail}` : ''}`);
      return { notified: false, parent, reason: 'send_failed' };
    }
    log(`[afterDone] notified parent ${parent}: mission DONE (${opts.harnessSlug})`);
    return { notified: true, parent };
  } catch (e) {
    log(`[afterDone] Completion send to ${parent} threw (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return { notified: false, parent, reason: 'send_failed' };
  }
}
