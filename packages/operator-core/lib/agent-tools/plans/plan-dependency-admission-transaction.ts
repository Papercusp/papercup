/**
 * Dependency admission for raw harness_plans writers that cannot use
 * withPlanLock's standard content upsert (federation projections, recomposition,
 * and other column-specialized storage paths).
 *
 * The callback runs under the SAME advisory transaction lock as withPlanLock.
 * The live body/status/op_status read and the caller's write therefore form one
 * serialized before/after decision rather than a stale preflight. Test tagged-SQL
 * shims without `begin` run inline; production postgres.Sql clients always take
 * the transaction branch.
 */

import type { Sql, TransactionSql } from 'postgres';
import { parsePlan } from '@papercusp/plan-parser';
import {
  isExecutablePlanCandidate,
  validatePlanCandidateDependencyTransition,
  type PlanCandidateDependencyVerdict,
} from './plan-candidate-dependencies';
import { PLAN_ADVISORY_LOCK_NAMESPACE, planAdvisoryLockKey } from './plan-lock-key';

export type PlanDependencyAdmissionSql = Sql | TransactionSql;

export interface PlanDependencyAdmissionTransactionArgs {
  sql: PlanDependencyAdmissionSql;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  candidateContent: string;
  /** Canonical structured lifecycle when it can differ from markdown. */
  candidateStatus?: string | null;
}

export type PlanDependencyAdmissionTransactionResult<T> =
  | { admitted: true; verdict: PlanCandidateDependencyVerdict; value: T }
  | { admitted: false; verdict: PlanCandidateDependencyVerdict };

function executableOpStatus(
  lifecycleStatus: string | null | undefined,
  opStatus: string | null | undefined,
): string | null {
  const normalized = opStatus ?? null;
  return isExecutablePlanCandidate(lifecycleStatus, normalized)
    ? (normalized ?? 'started')
    : normalized;
}

/** Run one specialized plan write under canonical dependency admission. */
export async function withPlanDependencyAdmissionTransaction<T>(
  args: PlanDependencyAdmissionTransactionArgs,
  write: (tx: PlanDependencyAdmissionSql) => Promise<T>,
): Promise<PlanDependencyAdmissionTransactionResult<T>> {
  const run = async (tx: PlanDependencyAdmissionSql): Promise<PlanDependencyAdmissionTransactionResult<T>> => {
    const lockKey = planAdvisoryLockKey(args.workspaceId, args.harnessSlug, args.planSlug);
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
        hashtext(${lockKey})
      )
    `;

    // to_jsonb keeps this compatible with historical-schema integration fixtures
    // that intentionally predate op_status while reading the real column in
    // production. Missing there means null, never a fabricated executable state.
    const rows = await tx<
      Array<{ content: string; status: string | null; op_status: string | null }>
    >`
      SELECT p.content,
             p.status,
             to_jsonb(p) ->> 'op_status' AS op_status
        FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${args.workspaceId}
         AND p.harness_slug = ${args.harnessSlug}
         AND p.plan_slug = ${args.planSlug}
       LIMIT 1
    `;
    const live = rows[0] ?? null;
    const locator = `plan://${args.harnessSlug}/${args.planSlug}`;
    const before = live ? parsePlan(live.content, { filePath: locator }) : null;
    const after = parsePlan(args.candidateContent, { filePath: locator });
    const beforeOpStatus = executableOpStatus(live?.status, live?.op_status);
    const afterStatus = args.candidateStatus ?? after.frontmatter.status ?? null;
    const afterOpStatus = executableOpStatus(afterStatus, live?.op_status);
    const verdict = validatePlanCandidateDependencyTransition(
      before,
      after,
      beforeOpStatus,
      afterOpStatus,
    );
    if (verdict.state === 'rejected') return { admitted: false, verdict };
    return { admitted: true, verdict, value: await write(tx) };
  };

  if ('begin' in args.sql && typeof args.sql.begin === 'function') {
    return args.sql.begin((tx) => run(tx));
  }
  return run(args.sql);
}
