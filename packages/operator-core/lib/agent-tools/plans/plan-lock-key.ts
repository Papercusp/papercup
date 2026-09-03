import type { Sql, TransactionSql } from 'postgres';

/** Shared identity for the transaction-scoped advisory lock protecting one plan. */
export const PLAN_ADVISORY_LOCK_NAMESPACE = 'harness_plans';

export function planAdvisoryLockKey(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): string {
  return `${workspaceId}:${harnessSlug}:${planSlug}`;
}

/** PG error raised when a statement is canceled by `lock_timeout`. */
export const PLAN_LOCK_TIMEOUT_CODE = '55P03';

/** Default acquisition budget for the plan advisory lock, in ms. */
export const PLAN_ADVISORY_LOCK_BUDGET_MS = 5_000;

/**
 * Either client that takes this lock: `withPlanLock` runs inside `withWorkspace`'s `Sql`, and the
 * dependency-admission wrapper accepts a `TransactionSql` (and test tagged-SQL shims).
 */
export type PlanAdvisoryLockSql = Sql | TransactionSql;

/**
 * The one way to take a plan's advisory lock — a BOUNDED BLOCKING acquire (WI-2143102).
 *
 * Both writers of `harness_plans` key on `(hashtext('harness_plans'), hashtext(<plan key>))`, and
 * before this they took it two incompatible ways, which is a starvation machine rather than a
 * fairness accident:
 *
 *   - `withPlanLock` polled `pg_try_advisory_xact_lock` every 50ms against a ~5s budget. A TRY
 *     acquire never joins the lock's wait queue.
 *   - `withPlanDependencyAdmissionTransaction` took the blocking `pg_advisory_xact_lock`, and
 *     `withWorkspace` sets no `lock_timeout`, so it waited without any bound at all.
 *
 * PostgreSQL hands a released lock straight to the head of its WAIT QUEUE. So while even one
 * blocking waiter is queued, the lock is never observably free to a poller: the holder's COMMIT
 * and the next grant are one atomic step, with no window for a `try` to land in. The poller is
 * therefore starved BY CONSTRUCTION — not unlucky — no matter how long its budget, while the
 * blocking waiters pin one org-app pool connection each for as long as the convoy lasts.
 * Measured 2026-09-03 02:33–02:40Z on `byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`: 18–21
 * operator backends continuously queued on that exact key, oldest waiter 59 minutes, and the plan
 * row's `updated_at` an hour stale — a full hour of total contention that committed nothing.
 *
 * So both callers now come through here and get the SAME discipline: JOIN the queue (fair, and
 * the grant cannot be missed) with a BOUND (a waiter can never pin a pooled connection
 * indefinitely). The cap is `SET LOCAL`, so it dies with the transaction and can never leak onto
 * the pooled connection, and it is reset once the lock is held — it bounds the ACQUISITION, never
 * whatever the caller does while holding it, which is the pre-existing behaviour.
 *
 * On timeout this THROWS the PG `55P03`; it deliberately does not swallow it, because a
 * lock_timeout aborts the transaction and no further statement could run in it anyway. Catch it
 * OUTSIDE the transaction (as `withPlanLock` does, converting it to `busy`).
 */
export async function acquirePlanAdvisoryLock(
  tx: PlanAdvisoryLockSql,
  lockKey: string,
  budgetMs: number = PLAN_ADVISORY_LOCK_BUDGET_MS,
): Promise<void> {
  const capMs = Math.max(1, Math.floor(budgetMs));
  await tx`SELECT set_config('lock_timeout', ${String(capMs)}, true)`;
  await tx`
    SELECT pg_advisory_xact_lock(hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}), hashtext(${lockKey}))
  `;
  // Held. Restore the un-capped wait for the rest of the transaction — these transactions
  // carried no lock_timeout before this change, and re-using the acquisition cap as a general
  // statement cap would be a second, unrelated behaviour change smuggled in with this one.
  await tx`SELECT set_config('lock_timeout', '0', true)`;
}
