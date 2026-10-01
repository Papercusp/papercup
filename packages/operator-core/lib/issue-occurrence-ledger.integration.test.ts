/**
 * Real-Postgres proof for P-004's canonical issue occurrence ledger.
 *
 * The production writer binds JSON.stringify(value)::jsonb through getOrgPg's
 * raw serializer seam. This fixture uses that same serializer configuration,
 * so server-side jsonb operators catch both sql.json regressions and accidental
 * double encoding.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import {
  readIssueAdmissionPressure,
  readIssueOccurrenceCounts,
  readRecurringInstanceEvidence,
  recordIssueOccurrence,
  type IssueOccurrenceKind,
} from './issue-occurrence-ledger';

const WORKSPACE = 'ws-occurrence-ledger';
const HARNESS = 'papercusp';
const CANONICAL_ID = 'EI-OCCURRENCE-CANONICAL';

describe('issue occurrence ledger (real PG, migration 831)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // createOrgTestDb clones an empty-to-head migration-runner template keyed
    // by the migration-set hash. Presence here proves migration 831 applied on
    // the production boot path; reapplying it would only test idempotency.
    const migrated = await db.adminSql<{ exists: boolean }[]>`
      SELECT to_regclass('harness_shared.work_item_occurrences') IS NOT NULL AS exists
    `;
    expect(migrated[0]?.exists).toBe(true);
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

  it('reads exact rolling pressure from the occurrence writer and canonical stock writer', async () => {
    for (let sequence = 0; sequence < 12; sequence += 1) {
      await recordIssueOccurrence(
        {
          canonicalId: CANONICAL_ID,
          canonicalHarness: HARNESS,
          reporter: 'su-concentrated',
          sourceTool: 'work_items:create',
          reportKind: 'coalesced',
          reportedTitle: `concentrated report ${sequence}`,
        },
        db.adminSql,
      );
    }

    const pressure = await readIssueAdmissionPressure(
      { canonicalId: CANONICAL_ID, canonicalHarness: HARNESS },
      db.adminSql,
    );
    expect(pressure).toMatchObject({
      active: true,
      mode: 'coalesce',
      rawOccurrences: 12,
      duplicateOccurrences: 12,
      canonicalClusters: 1,
      canonicalStock: 1,
      emitters: 1,
      writers: {
        flow: 'harness_shared.work_item_occurrences',
        stock: 'harness_shared.work_items',
      },
      cap: 'none — exact SQL aggregates',
    });
  });

  describe('readRecurringInstanceEvidence (EI-23768242440859949)', () => {
    const MARKER = 'recurrence-evidence:';
    const ARGS = { workspaceId: WORKSPACE, windowDays: 7, minRows: 3, minReporters: 2, limit: 50, proposedMarker: MARKER };

    async function seedItem(
      id: string,
      opts: { severity?: string; assignee?: string | null; lane?: string | null; status?: string } = {},
    ): Promise<void> {
      // `lane` is a GENERATED column (payload->>'lane'): it can only be set through the payload.
      const payload = JSON.stringify({
        _ei: { severity: opts.severity ?? 'minor' },
        ...(opts.lane ? { lane: opts.lane } : {}),
      });
      await db.adminSql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, payload, created_ts, updated_ts)
        VALUES
          (${WORKSPACE}, ${HARNESS}, ${id}, 'bug', ${`item ${id}`}, ${opts.status ?? 'open'},
           ${opts.assignee ?? null}, ${payload}::jsonb, 1, 1)
      `;
    }

    async function seedOccurrences(id: string, reporters: Array<string | null>, ageDays = 0): Promise<void> {
      for (const [i, reporter] of reporters.entries()) {
        await db.adminSql`
          INSERT INTO harness_shared.work_item_occurrences
            (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool,
             report_kind, reported_title, occurred_at)
          VALUES
            (${WORKSPACE}, ${HARNESS}, ${id}, ${reporter}, 'improvements:capture',
             'duplicate', ${`report ${i}`}, now() - make_interval(days => ${ageDays}::int))
        `;
      }
    }

    beforeEach(async () => {
      await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WORKSPACE} AND feature_id LIKE 'EI-REC-%'`;
      await db.adminSql`DELETE FROM harness_shared.coord_thread_posts WHERE workspace_id = ${WORKSPACE} AND thread_id LIKE 'issue-thread-EI-REC-%'`;
    });

    it('returns only open, unassigned, non-observation minor/nit items with enough independent in-window evidence, ranked and idempotent', async () => {
      // Qualifies: 4 rows / 3 reporters (the top rank).
      await seedItem('EI-REC-TOP');
      await seedOccurrences('EI-REC-TOP', ['su-a', 'su-b', 'su-c', 'su-a']);
      // Qualifies: 3 rows / 2 reporters, a nit (ranks below TOP).
      await seedItem('EI-REC-NIT', { severity: 'nit' });
      await seedOccurrences('EI-REC-NIT', ['su-a', 'su-b', 'su-a']);
      // Rows >= minRows but ONE reporter: a single loud emitter is not independent evidence.
      await seedItem('EI-REC-ONE');
      await seedOccurrences('EI-REC-ONE', ['su-a', 'su-a', 'su-a', 'su-a']);
      // NULL reporters are not independent reporters.
      await seedItem('EI-REC-NULL');
      await seedOccurrences('EI-REC-NULL', [null, null, null, 'su-a']);
      // Evidence entirely OUTSIDE the window.
      await seedItem('EI-REC-OLD');
      await seedOccurrences('EI-REC-OLD', ['su-a', 'su-b', 'su-c'], 30);
      // Excluded by the item's own state.
      await seedItem('EI-REC-ASSIGNED', { assignee: 'su-owner' });
      await seedOccurrences('EI-REC-ASSIGNED', ['su-a', 'su-b', 'su-c']);
      await seedItem('EI-REC-OBS', { lane: 'observation' });
      await seedOccurrences('EI-REC-OBS', ['su-a', 'su-b', 'su-c']);
      await seedItem('EI-REC-CRIT', { severity: 'critical' });
      await seedOccurrences('EI-REC-CRIT', ['su-a', 'su-b', 'su-c']);
      await seedItem('EI-REC-DONE', { status: 'done' });
      await seedOccurrences('EI-REC-DONE', ['su-a', 'su-b', 'su-c']);

      const slate = await readRecurringInstanceEvidence(ARGS, db.adminSql);
      expect(slate.map((r) => r.id)).toEqual(['EI-REC-TOP', 'EI-REC-NIT']);
      expect(slate[0]).toMatchObject({ harness: HARNESS, severity: 'minor', rows: 4, reporters: 3 });
      expect(slate[1]).toMatchObject({ severity: 'nit', rows: 3, reporters: 2 });
      expect(Number.isNaN(Date.parse(slate[0]!.firstAt))).toBe(false);
      expect(Date.parse(slate[0]!.lastAt)).toBeGreaterThanOrEqual(Date.parse(slate[0]!.firstAt));

      // `limit` bounds the slate AFTER ranking, so the strongest evidence survives.
      const capped = await readRecurringInstanceEvidence({ ...ARGS, limit: 1 }, db.adminSql);
      expect(capped.map((r) => r.id)).toEqual(['EI-REC-TOP']);

      // Idempotence: once the marker comment lands on the thread the item drops out,
      // so a re-run never re-posts; an unrelated comment does not suppress it.
      await db.adminSql`
        INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, author_id, body)
        VALUES (${WORKSPACE}, 'issue-thread-EI-REC-TOP', 'recurrence-escalation', ${`${MARKER} proposed severity minor→major (NOT applied).`}),
               (${WORKSPACE}, 'issue-thread-EI-REC-NIT', 'su-someone', 'an unrelated comment')
      `;
      const after = await readRecurringInstanceEvidence(ARGS, db.adminSql);
      expect(after.map((r) => r.id)).toEqual(['EI-REC-NIT']);
    });
  });
});
