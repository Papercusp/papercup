/**
 * Read-side column projection shared by the two physical work-item families.
 *
 * The result `projection` argument is normally a post-handler reduction, but
 * callers that select only a small work-item field should not make Postgres
 * return and postgres-js parse the entire JSONB payload first. Keep the
 * storage policy here so issue and feature readers cannot drift.
 */

export type WorkItemPayloadProjection = 'full' | 'none' | 'completionEvidence' | 'fleetMetrics';

/**
 * Fleet metrics read authority from the row, not the structured close receipt.
 * Keep every control/matcher key (including future keys) and omit only these
 * archival envelopes. This projection must never feed a completion/cohort audit.
 */
export const FLEET_METRIC_ARCHIVE_KEYS = [
  '_completionEvidence', 'toolFailureProbation', 'freshnessEnvelope',
  'admissionIdentity', '_claimSubjectBaseline', 'admissionReview',
  '_assumptions', 'toolFailureSignature',
] as const;

export interface WorkItemReadOptions {
  /**
   * Issue-family body projection. Feature-family summaries are kept because
   * they are part of that table's canonical row shape.
   */
  includeBody?: boolean;
  /**
   * `none` returns a typed NULL payload; `completionEvidence` returns only the
   * `_completionEvidence` member, wrapped under the original payload key so
   * existing mappers preserve terminal-evidence semantics.
   */
  payloadProjection?: WorkItemPayloadProjection;
}

const PAYLOAD_COLUMN = /(^|,\s*)payload(\s*,)/;

/**
 * Project returned columns in a canonical column allowlist.
 * WHERE predicates may still read the physical payload; this helper changes
 * the SELECT projection and keeps the original row arity/key.
 */
export function projectWorkItemColumns(
  columns: string,
  projection: WorkItemPayloadProjection = 'full',
): string {
  if (projection === 'full') return columns;
  if (projection === 'fleetMetrics') {
    const keys = FLEET_METRIC_ARCHIVE_KEYS.map(key => `'${key}'`).join(', ');
    // These issue-only metadata fields are not mapped into WorkItem. Reading
    // them would repeatedly detoast the original payload for no metric input.
    // Full/detail readers retain them; this policy is for the metric source only.
    for (const key of ['source', 'signal_origin', 'found_during', 'linked_feature_id']) {
      columns = columns.replace(new RegExp(`(^|,\\s*)${key}(\\s*,)`), `$1NULL::text AS ${key}$2`);
    }
    // Scalar/array/JSON-null payloads retain their exact legacy shape. Subtracting
    // object keys from a scalar can throw, and silently normalizing it hides bugs.
    return columns.replace(PAYLOAD_COLUMN,
      `$1(CASE WHEN jsonb_typeof(payload) = 'object' THEN payload - ARRAY[${keys}]::text[] ELSE payload END) AS payload$2`);
  }
  const replacement =
    projection === 'none'
      ? 'NULL::jsonb AS payload'
      : "jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload";
  return columns.replace(PAYLOAD_COLUMN, `$1${replacement}$2`);
}
