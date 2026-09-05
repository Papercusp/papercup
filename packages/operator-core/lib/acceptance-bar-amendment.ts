/**
 * Cross-plan transaction primitive for post-start acceptance BAR amendments.
 *
 * A BAR is stored on an acceptance-rubric plan, while its lifecycle pins and
 * discharge map live on the subject plan.  Updating only one of those rows is
 * therefore not an amendment: readers can observe a rubric revision that the
 * subject still claims it has not adopted (or vice versa).  This helper keeps
 * the two advisory locks in one deterministic order and runs the caller's
 * mutation in the same database transaction.
 */
import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';

export type AcceptanceBarAmendmentSql = Sql | TransactionSql;

export interface AcceptanceBarAmendmentPlan {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface AcceptanceBarAmendmentTransactionArgs {
  /** Both the subject plan and acceptance-rubric plan. */
  plans: readonly AcceptanceBarAmendmentPlan[];
  /** Bounded lock wait, matching the ordinary withPlanLock write seam. */
  ttlSec?: number;
}

/**
 * Acquire all plan locks in a stable `(workspace, harness, slug)` order, then
 * invoke `work` inside one transaction.  Duplicate plans are collapsed before
 * locking, so a caller cannot deadlock itself by naming the same plan twice.
 */
export async function withAcceptanceBarAmendmentTransaction<T>(
  args: AcceptanceBarAmendmentTransactionArgs,
  work: (tx: AcceptanceBarAmendmentSql) => Promise<T>,
): Promise<T> {
  if (!args.plans.length) throw new Error('acceptance_bar_amendment: at least one plan is required');
  const plans = [...new Map(args.plans.map((plan) => [
    `${plan.workspaceId}\0${plan.harnessSlug}\0${plan.planSlug}`,
    plan,
  ])).values()].sort((a, b) =>
    `${a.workspaceId}\0${a.harnessSlug}\0${a.planSlug}`.localeCompare(
      `${b.workspaceId}\0${b.harnessSlug}\0${b.planSlug}`,
    ),
  );
  const workspaceId = plans[0]!.workspaceId;
  if (plans.some((plan) => plan.workspaceId !== workspaceId)) {
    throw new Error('acceptance_bar_amendment: plans must share one workspace');
  }
  const budgetMs = (args.ttlSec ?? 5) * 1000;
  return withWorkspace(workspaceId, async (tx) => {
    for (const plan of plans) {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(plan.workspaceId, plan.harnessSlug, plan.planSlug),
        budgetMs,
      );
    }
    return work(tx);
  });
}

/** The deterministic key used when a caller omits an explicit replay token. */
export function acceptanceBarAmendmentKey(parts: {
  rubricId: string;
  subjectPlan: string;
  actorId: string;
  reason: string;
  priorRubricRevision: number;
  nextBarHashes: readonly string[];
}): string {
  // Keep this helper dependency-free.  The caller supplies the hash material
  // already produced by the canonical rubric writer; a NUL-delimited tuple is
  // stable across JSON key ordering and cannot collide at field boundaries.
  const material = [
    parts.rubricId.trim(),
    parts.subjectPlan.trim(),
    parts.actorId.trim(),
    parts.reason.trim(),
    String(parts.priorRubricRevision),
    ...[...parts.nextBarHashes].sort(),
  ].join('\0');
  return createHash('sha256').update(material).digest('hex');
}
