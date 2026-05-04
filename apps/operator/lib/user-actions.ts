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

import { getOrgPg } from '@restart/db-org';
import { ensureUserActionsTable } from './ensure-schema';

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
  const { sql } = getOrgPg();
  const now = Date.now();
  const inserted = (await sql`
    INSERT INTO harness_shared.user_actions
      (harness_slug, kind, status, started_at, actor)
    VALUES (${slug}, ${kind}, 'running', ${now}, ${opts.actor ?? null})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = Number(inserted[0].id);

  try {
    const out = await fn(id);
    if (opts.async) {
      // Caller will finalize via updateUserAction; just stamp invocationId
      // and any detailUrl now so the running row is fully linked.
      await sql`
        UPDATE harness_shared.user_actions
        SET invocation_id = ${out.invocationId ?? null},
            detail_url    = ${out.detailUrl ?? null},
            summary       = ${out.summary}
        WHERE id = ${id}
      `;
    } else {
      await sql`
        UPDATE harness_shared.user_actions
        SET status        = 'succeeded',
            summary       = ${out.summary},
            detail_url    = ${out.detailUrl ?? null},
            invocation_id = ${out.invocationId ?? null},
            finished_at   = ${Date.now()}
        WHERE id = ${id}
      `;
    }
    return out.result;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await sql`
      UPDATE harness_shared.user_actions
      SET status      = 'failed',
          error_text  = ${msg.slice(0, 1000)},
          finished_at = ${Date.now()}
      WHERE id = ${id}
    `;
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
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.user_actions
    SET status      = ${args.status},
        summary     = COALESCE(${args.summary ?? null}, summary),
        detail_url  = COALESCE(${args.detailUrl ?? null}, detail_url),
        error_text  = ${args.errorText ?? null},
        finished_at = ${Date.now()}
    WHERE id = ${args.id}
  `;
}
