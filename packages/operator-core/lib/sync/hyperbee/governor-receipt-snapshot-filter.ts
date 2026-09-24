/**
 * P-530 — serializable policy for removing retired resource-governor receipts
 * from an own-log snapshot without inventing deletes in the source log.
 *
 * The live-key census is taken after `maxSourceIndexExclusive` is captured. A
 * row below that boundary is therefore safe to omit only when it was absent
 * from PostgreSQL at the census. Anything appended at or beyond the boundary
 * is retained, which closes the insert-after-census race without a database
 * lookup per folded row.
 */

export const ENGINEER_ISSUES_SNAPSHOT_TABLE = 'engineer-issues';

export interface GovernorReceiptSnapshotFilter {
  /** Own-log length captured immediately before the PostgreSQL census. */
  maxSourceIndexExclusive: number;
  /** Qualified `<storage-harness>/<WI-or-EI-id>` rows still present in work_items. */
  liveQualifiedKeys: readonly string[];
}

export interface GovernorReceiptSnapshotContext {
  table: string;
  hbKey: string;
  /** Physical source-log index of the op (or snapshot chunk) being folded. */
  sourceIndex?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True only for the retired work_items-backed governor receipt wire shape. */
export function isLegacyGovernorReceiptSnapshotValue(value: unknown): boolean {
  const row = record(value);
  const payload = record(row?.payload);
  return record(payload?.resource_governor) !== null;
}

/**
 * Fail-safe drop decision. Bare legacy keys, malformed values, rows without a
 * measured source index, post-census appends, non-receipts, and currently-live
 * receipt keys are all retained.
 */
export function shouldDropGovernorReceiptSnapshotRow(
  value: unknown,
  context: GovernorReceiptSnapshotContext,
  filter: GovernorReceiptSnapshotFilter,
  liveQualifiedKeys: ReadonlySet<string> = new Set(filter.liveQualifiedKeys),
): boolean {
  if (context.table !== ENGINEER_ISSUES_SNAPSHOT_TABLE) return false;
  if (!Number.isSafeInteger(context.sourceIndex) || context.sourceIndex! < 0) return false;
  if (context.sourceIndex! >= filter.maxSourceIndexExclusive) return false;
  // Pre-829 bare keys cannot identify a physical row safely. Keep them.
  if (context.hbKey.indexOf('/') <= 0) return false;
  if (!isLegacyGovernorReceiptSnapshotValue(value)) return false;
  return !liveQualifiedKeys.has(context.hbKey);
}
