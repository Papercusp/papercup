/** Shared identity for the transaction-scoped advisory lock protecting one plan. */
export const PLAN_ADVISORY_LOCK_NAMESPACE = 'harness_plans';

export function planAdvisoryLockKey(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): string {
  return `${workspaceId}:${harnessSlug}:${planSlug}`;
}
