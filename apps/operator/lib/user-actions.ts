/**
 * Server-side wrapper for long-running user-initiated actions. Writes a row to
 * harness_shared.user_actions with status='running' on entry; updates with
 * 'succeeded' (+ summary/detailUrl) or 'failed' (+ error_text) on exit.
 *
 * Drives the OperatorActionLog UI panel via Zero. Designed to be a one-line
 * wrap of any existing action endpoint:
 *
 *   harness.post('/:slug/replan', (c) => recordUserAction(c.req.param('slug'), 'replan',
 *     async () => {
 *       const { invocationId } = invokeScoperBackground(project, 'replan');
 *       return { invocationId, response: c.json({ ok: true, invocationId }) };
 *     }));
 *
 * For background-job actions (replan, cleanup, snapshot.create), the wrapper
 * captures the invocationId and stamps it onto the row; the job's completion
 * handler updates status when it finishes (see updateUserAction).
 */

import { getOrgPg, generated } from '@restart/db-org';
import { eq } from 'drizzle-orm';
import { ensureUserActionsTable } from './ensure-schema';
import { activeWorkspaceId } from './workspace-registry';
import { notifySyncInvalidate } from './sync-sse';

const t = generated.user_actionsInHarness_shared;

export type ActionKind =
  | 'replan'
  | 'cleanup'
  | 'consolidate'
  | 'snapshot.create'
  | 'snapshot.fork'
  | 'snapshot.publish'
  | 'plugin.install'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'branch.action'
  | 'expert.dispatch';

export interface ActionResult<T = unknown> {
  /** One-line user-facing summary string. */
  summary: string;
  /** Optional URL the OperatorActionLog row should link to. */
  detailUrl?: string;
  /** Optional invocation_id for async jobs that finish later. */
  invocationId?: string;
  /** The actual response value forwarded back to the route handler's caller. */
  result: T;
}

interface RecordOpts {
  /** When true, the row stays in 'running' status; caller is expected to
   *  finish the row later via updateUserAction(). Default false (auto-complete). */
  async?: boolean;
  actor?: string;
}

/**
 * Wrap an action. The fn receives the row id so it can pass it through to
 * a background job that will call updateUserAction() on completion.
 */
export async function recordUserAction<T>(
  slug: string,
  kind: ActionKind,
  fn: (id: number) => Promise<ActionResult<T>>,
  opts: RecordOpts = {},
): Promise<T> {
  await ensureUserActionsTable();
  const { db } = getOrgPg();
  const now = Date.now();
  const inserted = await db
    .insert(t)
    .values({
      harness_slug: slug,
      kind,
      status: 'running',
      started_at: now,
      actor: opts.actor ?? null,
      workspace_id: activeWorkspaceId(),
    })
    .returning({ id: t.id });
  const id = Number(inserted[0].id);

  try {
    const out = await fn(id);
    if (opts.async) {
      // Caller will finalize via updateUserAction; just stamp invocationId
      // and any detailUrl now so the running row is fully linked.
      await db
        .update(t)
        .set({
          invocation_id: out.invocationId ?? null,
          detail_url: out.detailUrl ?? null,
          summary: out.summary,
        })
        .where(eq(t.id, BigInt(id)));
    } else {
      await db
        .update(t)
        .set({
          status: 'succeeded',
          summary: out.summary,
          detail_url: out.detailUrl ?? null,
          invocation_id: out.invocationId ?? null,
          finished_at: Date.now(),
        })
        .where(eq(t.id, BigInt(id)));
    }
    void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
    return out.result;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await db
      .update(t)
      .set({
        status: 'failed',
        error_text: msg.slice(0, 1000),
        finished_at: Date.now(),
      })
      .where(eq(t.id, BigInt(id)));
    void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
    throw err;
  }
}

/**
 * Finalize an async action started with `{ async: true }`. Background jobs
 * (scoper-result poll, snapshot capture worker) call this when the work
 * actually finishes.
 */
export async function updateUserAction(args: {
  id: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary?: string;
  detailUrl?: string;
  errorText?: string;
}): Promise<void> {
  await ensureUserActionsTable();
  const { db, sql: rawSql } = getOrgPg();
  // COALESCE on the existing column requires either a raw sql snippet or
  // a conditional set; drizzle's set object doesn't have a built-in
  // COALESCE primitive. Use sql.raw for the COALESCE merges.
  const rows = await db
    .update(t)
    .set({
      status: args.status,
      summary: args.summary !== undefined ? args.summary : rawSql`${t.summary}` as any,
      detail_url: args.detailUrl !== undefined ? args.detailUrl : rawSql`${t.detail_url}` as any,
      error_text: args.errorText ?? null,
      finished_at: Date.now(),
    })
    .where(eq(t.id, BigInt(args.id)))
    .returning({ harness_slug: t.harness_slug });
  const slug = rows[0]?.harness_slug;
  if (slug) void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
}
