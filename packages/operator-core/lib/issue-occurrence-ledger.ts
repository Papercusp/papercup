/**
 * Shared canonical-issue occurrence seam (P-004).
 *
 * Both issue creation doors use this module after their existing candidate
 * generators run.  The canonical object is still a work-item; this module only
 * chooses the canonical candidate and appends the incoming report/evidence.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AdmissionIdentity } from './harness/improvements/digest';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export type IssueOccurrenceKind =
  | 'canonical-created'
  | 'duplicate'
  | 'coalesced'
  | 'promoted'
  | 'regression';

export interface CanonicalCandidate {
  id: string;
  title: string;
  /** False for an advisory-only candidate (for example a soft semantic hit). */
  eligible: boolean;
  similarity?: number;
}

/**
 * One deterministic selector shared by every admission door.  Exact stable
 * identity outranks fuzzy score; fuzzy ties are stable by id.
 */
export function selectCanonicalIssue(
  identity: AdmissionIdentity,
  candidates: readonly CanonicalCandidate[],
): CanonicalCandidate | null {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const exact = eligible
    .filter((candidate) => {
      const normalized = candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return identity.titleKey === `title:${normalized}`;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (exact.length > 0) return exact[0] ?? null;
  return eligible
    .slice()
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}

export interface RecordIssueOccurrenceInput {
  canonicalId: string;
  canonicalHarness?: string | null;
  reporter?: string | null;
  sourceTool: 'work_items:create' | 'improvements:capture' | 'system';
  reportKind: IssueOccurrenceKind;
  reportedTitle: string;
  evidence?: Record<string, unknown>;
  admissionIdentity?: AdmissionIdentity | null;
}

export interface RecordedIssueOccurrence {
  occurrenceId: number;
  workspaceId: string;
  canonicalHarness: string;
  canonicalId: string;
  reportKind: IssueOccurrenceKind;
  occurredAt: string;
}

/** Append one report. Failure is intentionally non-fatal to issue admission. */
export async function recordIssueOccurrence(
  input: RecordIssueOccurrenceInput,
  sqlOverride?: OrgSql,
): Promise<RecordedIssueOccurrence | null> {
  // Unit suites use injected recorders. Never let an unrelated pure test open PG.
  if (process.env.VITEST && !sqlOverride) return null;
  const sql = sqlOverride ?? getOrgPg().sql;
  try {
    const canonical = (await sql<Array<{
      workspace_id: string;
      harness_slug: string;
      feature_id: string;
    }>>`
      SELECT workspace_id, harness_slug, feature_id
        FROM harness_shared.work_items
       WHERE feature_id = ${input.canonicalId}
         ${input.canonicalHarness ? sql`AND harness_slug = ${input.canonicalHarness}` : sql``}
       ORDER BY created_ts DESC
       LIMIT 1
    `)[0];
    if (!canonical) return null;
    const evidence = JSON.stringify(input.evidence ?? {});
    const identity = input.admissionIdentity ? JSON.stringify(input.admissionIdentity) : null;
    const rows = await sql<Array<{ occurrence_id: string | number; occurred_at: Date | string }>>`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter,
         source_tool, report_kind, reported_title, evidence, admission_identity)
      VALUES
        (${canonical.workspace_id}, ${canonical.harness_slug}, ${canonical.feature_id},
         ${input.reporter ?? null}, ${input.sourceTool}, ${input.reportKind}, ${input.reportedTitle},
         ${evidence}::jsonb, ${identity}::jsonb)
      RETURNING occurrence_id, occurred_at
    `;
    const row = rows[0];
    return row
      ? {
          occurrenceId: Number(row.occurrence_id),
          workspaceId: canonical.workspace_id,
          canonicalHarness: canonical.harness_slug,
          canonicalId: canonical.feature_id,
          reportKind: input.reportKind,
          occurredAt: new Date(row.occurred_at).toISOString(),
        }
      : null;
  } catch {
    return null;
  }
}

export interface IssueOccurrenceCounts {
  canonicalClusters: number;
  rawOccurrences: number;
  duplicateOccurrences: number;
  units: {
    canonicalClusters: 'distinct canonical work-item ids with occurrences';
    rawOccurrences: 'append-only report rows';
    duplicateOccurrences: 'report rows not creating a canonical item';
  };
  writer: 'harness_shared.work_item_occurrences';
}

/** Exact, uncapped census for queue/leader reads. */
export async function readIssueOccurrenceCounts(
  args: { workspaceId: string; harnessSlug?: string | null; since?: string | null },
  sqlOverride?: OrgSql,
): Promise<IssueOccurrenceCounts> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = await sql<Array<{
    canonical_clusters: string | number;
    raw_occurrences: string | number;
    duplicate_occurrences: string | number;
  }>>`
    SELECT count(DISTINCT (canonical_harness_slug, canonical_work_item_id)) AS canonical_clusters,
           count(*)                                                        AS raw_occurrences,
           count(*) FILTER (WHERE report_kind <> 'canonical-created')      AS duplicate_occurrences
      FROM harness_shared.work_item_occurrences
     WHERE workspace_id = ${args.workspaceId}
       ${args.harnessSlug ? sql`AND canonical_harness_slug = ${args.harnessSlug}` : sql``}
       ${args.since ? sql`AND occurred_at > ${args.since}::timestamptz` : sql``}
  `;
  const row = rows[0];
  return {
    canonicalClusters: Number(row?.canonical_clusters ?? 0),
    rawOccurrences: Number(row?.raw_occurrences ?? 0),
    duplicateOccurrences: Number(row?.duplicate_occurrences ?? 0),
    units: {
      canonicalClusters: 'distinct canonical work-item ids with occurrences',
      rawOccurrences: 'append-only report rows',
      duplicateOccurrences: 'report rows not creating a canonical item',
    },
    writer: 'harness_shared.work_item_occurrences',
  };
}

