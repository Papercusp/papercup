/**
 * Real-Postgres proof for P-004's canonical issue occurrence ledger.
 *
 * The production writer binds JSON.stringify(value)::jsonb through getOrgPg's
 * raw serializer seam. This fixture uses that same serializer configuration,
 * so server-side jsonb operators catch both sql.json regressions and accidental
 * double encoding.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import { applyMigrationForTest } from '../test/_pg-helpers';
import {
  readIssueOccurrenceCounts,
  recordIssueOccurrence,
  type IssueOccurrenceKind,
} from './issue-occurrence-ledger';

const WORKSPACE = 'ws-occurrence-ledger';
const HARNESS = 'papercusp';
const CANONICAL_ID = 'EI-OCCURRENCE-CANONICAL';
const MIGRATION = join(
  __dirname,
  '../../../libs/papercusp/libs/db/sql/831-issue-occurrence-ledger.sql.DRAFT',
);

describe('issue occurrence ledger (real PG, migration 831)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const before = await db.adminSql<{ exists: boolean }[]>`
      SELECT to_regclass('harness_shared.work_item_occurrences') IS NOT NULL AS exists
    `;
    expect(before[0]?.exists).toBe(false);
    await applyMigrationForTest(db.adminSql, MIGRATION);
    const after = await db.adminSql<{ exists: boolean }[]>`
      SELECT to_regclass('harness_shared.work_item_occurrences') IS NOT NULL AS exists
    `;
    expect(after[0]?.exists).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.adminSql`TRUNCATE harness_shared.work_item_occurrences RESTART IDENTITY`;
    await db.adminSql`
      DELETE FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE} AND feature_id = ${CANONICAL_ID}
    `;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
      VALUES
        (${WORKSPACE}, ${HARNESS}, ${CANONICAL_ID}, 'bug', 'canonical issue', 'open', 1, 1)
    `;
  });

  it('appends every outcome losslessly and reports exact canonical/occurrence units', async () => {
    const kinds: IssueOccurrenceKind[] = ['canonical-created', 'duplicate', 'coalesced', 'promoted'];
    for (const [sequence, reportKind] of kinds.entries()) {
      const recorded = await recordIssueOccurrence(
        {
          canonicalId: CANONICAL_ID,
          canonicalHarness: HARNESS,
          reporter: `su-${sequence}`,
          sourceTool: reportKind === 'canonical-created' ? 'work_items:create' : 'improvements:capture',
          reportKind,
          reportedTitle: `report ${sequence}`,
          evidence: {
            sequence,
            nested: { value: `evidence-${sequence}` },
            refs: ['WI-1', 'EI-2'],
          },
          admissionIdentity: {
            schemaVersion: 'admission-identity-v1',
            titleKey: `title:report ${sequence}`,
          },
        },
        db.adminSql,
      );
      expect(recorded).toMatchObject({
        canonicalId: CANONICAL_ID,
        canonicalHarness: HARNESS,
        reportKind,
      });
    }

    const rows = await db.adminSql<{
      report_kind: IssueOccurrenceKind;
      evidence_type: string;
      nested_value: string;
      identity_type: string;
      title_key: string;
    }[]>`
      SELECT report_kind,
             jsonb_typeof(evidence) AS evidence_type,
             evidence->'nested'->>'value' AS nested_value,
             jsonb_typeof(admission_identity) AS identity_type,
             admission_identity->>'titleKey' AS title_key
        FROM harness_shared.work_item_occurrences
       ORDER BY occurrence_id
    `;
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.report_kind)).toEqual(kinds);
    expect(rows.map((row) => row.evidence_type)).toEqual(['object', 'object', 'object', 'object']);
    expect(rows.map((row) => row.identity_type)).toEqual(['object', 'object', 'object', 'object']);
    expect(rows[2]).toMatchObject({ nested_value: 'evidence-2', title_key: 'title:report 2' });

    const counts = await readIssueOccurrenceCounts(
      { workspaceId: WORKSPACE, harnessSlug: HARNESS },
      db.adminSql,
    );
    expect(counts).toEqual({
      canonicalClusters: 1,
      rawOccurrences: 4,
      duplicateOccurrences: 3,
      units: {
        canonicalClusters: 'distinct canonical work-item ids with occurrences',
        rawOccurrences: 'append-only report rows',
        duplicateOccurrences: 'report rows not creating a canonical item',
      },
      writer: 'harness_shared.work_item_occurrences',
    });
  });
});
