/**
 * hive-reports-store.integration.test.ts — the P-MOD moderation REPORT flow against
 * REAL Postgres (testcontainer + full migrated baseline incl. migration 318).
 *
 * Lane T1 of shared-hive-public-release-2026-06-22: the member→owner→resolve report
 * round-trip. The handler test (agent-tools/hive/moderation_resolve.test.ts) MOCKS the
 * store and hive-moderation.test.ts is pure, so the ACTUAL SQL — the ON CONFLICT upsert
 * (idempotent on report_id, status PRESERVED on a duplicate file), the open-queue read
 * (hive_reports_by_status, newest-first), the status filter, the resolve UPDATE, and the
 * explicit `WHERE workspace_id` scoping (the RLS backstop, D-004) — is only exercised here.
 *
 * The store functions take an injectable `sql`, so we hand them the testcontainer's admin
 * client (RLS-bypass, the operator's harness_admin equivalent).
 *
 * Run: cd packages/operator-core && npx vitest run lib/hive-reports-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import {
  fileReport,
  getReport,
  listReports,
  setReportStatus,
  type FileReportInput,
} from './hive-reports-store';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

const WS = 'ws-mod';
const HIVE = 'mod-hive';

function input(over: Partial<FileReportInput> = {}): FileReportInput {
  return {
    workspaceId: WS,
    potHomeSlug: HIVE,
    reporterGithubUserId: 4242,
    reporterGithubUsername: 'octocat',
    targetKind: 'content',
    targetRef: 'F-1',
    reportReason: 'spam',
    ...over,
  };
}

describe('hive-reports-store (integration — P-MOD report round-trip)', () => {
  it('fileReport writes status=open and round-trips every field (bigint id coerced to number)', async () => {
    const rec = await fileReport(
      input({ reportId: 'r-file', targetKind: 'member', targetRef: '99', reportReason: 'abuse' }),
      db.adminSql,
    );
    expect(rec).toMatchObject({
      workspaceId: WS,
      potHomeSlug: HIVE,
      reportId: 'r-file',
      reporterGithubUserId: 4242, // bigint column → number (not "4242")
      reporterGithubUsername: 'octocat',
      targetKind: 'member',
      targetRef: '99',
      reportReason: 'abuse',
      status: 'open',
    });
    expect(typeof rec.reporterGithubUserId).toBe('number');
    expect(typeof rec.createdAt).toBe('number');

    // getReport reflects the persisted row.
    const got = await getReport(WS, HIVE, 'r-file', db.adminSql);
    expect(got).toMatchObject({ reportId: 'r-file', status: 'open', targetKind: 'member' });
    // Unknown id → null.
    expect(await getReport(WS, HIVE, 'nope', db.adminSql)).toBeNull();
    // Null reason persists as null, not the string "null".
    const noReason = await fileReport(input({ reportId: 'r-noreason', reportReason: null }), db.adminSql);
    expect(noReason.reportReason).toBeNull();
  });

  it('fileReport is idempotent on report_id — duplicate updates the reason but PRESERVES a resolved status', async () => {
    await fileReport(input({ reportId: 'r-idem', reportReason: 'first' }), db.adminSql);
    // Owner resolves it.
    await setReportStatus(WS, HIVE, 'r-idem', 'actioned', db.adminSql);
    // A duplicate file of the SAME id (the federation re-delivery) must NOT reopen it.
    const dup = await fileReport(input({ reportId: 'r-idem', reportReason: 'second' }), db.adminSql);
    expect(dup.status).toBe('actioned'); // status NOT clobbered back to 'open'
    expect(dup.reportReason).toBe('second'); // reason DID update (ON CONFLICT DO UPDATE)

    // Exactly one row exists for that key (no second insert).
    const [{ n }] = (await db.adminSql.unsafe(
      `SELECT count(*)::int AS n FROM harness_shared.hive_reports
         WHERE workspace_id = $1 AND harness_slug = $2 AND report_id = $3`,
      [WS, HIVE, 'r-idem'],
    )) as unknown as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('listReports is the owner moderation queue: default = open only, newest-first', async () => {
    const hive = 'queue-hive';
    const mk = (id: string, reason: string) =>
      fileReport({ ...input({ reportId: id, reportReason: reason }), potHomeSlug: hive }, db.adminSql);
    await mk('q-old', 'old');
    await mk('q-mid', 'mid');
    await mk('q-new', 'new');
    // Deterministic ordering.
    await db.adminSql.unsafe(
      `UPDATE harness_shared.hive_reports SET created_at = CASE report_id
         WHEN 'q-old' THEN 1000 WHEN 'q-mid' THEN 2000 WHEN 'q-new' THEN 3000 END
       WHERE workspace_id = $1 AND harness_slug = $2`,
      [WS, hive],
    );

    const open = await listReports(WS, hive, {}, db.adminSql); // default status=open
    expect(open.map((r) => r.reportId)).toEqual(['q-new', 'q-mid', 'q-old']); // created_at DESC
    expect(open.every((r) => r.status === 'open')).toBe(true);
  });

  it('setReportStatus resolves a report — it leaves the open queue and lands in the filtered view', async () => {
    const hive = 'resolve-hive';
    await fileReport({ ...input({ reportId: 's-1' }), potHomeSlug: hive }, db.adminSql);
    await fileReport({ ...input({ reportId: 's-2' }), potHomeSlug: hive }, db.adminSql);

    const resolved = await setReportStatus(WS, hive, 's-1', 'dismissed', db.adminSql);
    expect(resolved).toMatchObject({ reportId: 's-1', status: 'dismissed' });
    expect(resolved!.updatedAt).toBeGreaterThanOrEqual(resolved!.createdAt);

    // Open queue no longer shows the resolved one.
    const open = await listReports(WS, hive, {}, db.adminSql);
    expect(open.map((r) => r.reportId)).toEqual(['s-2']);
    // Status filter surfaces it.
    const dismissed = await listReports(WS, hive, { status: 'dismissed' }, db.adminSql);
    expect(dismissed.map((r) => r.reportId)).toEqual(['s-1']);
    // status:null = full history (both rows).
    const all = await listReports(WS, hive, { status: null }, db.adminSql);
    expect(all.map((r) => r.reportId).sort()).toEqual(['s-1', 's-2']);

    // Resolving an unknown id is a no-op → null.
    expect(await setReportStatus(WS, hive, 'ghost', 'actioned', db.adminSql)).toBeNull();
  });

  it('reports are scoped per (workspace, hive) — the explicit WHERE keeps another workspace/hive out', async () => {
    await fileReport({ ...input({ reportId: 'iso' }), workspaceId: 'ws-A', potHomeSlug: 'iso-hive' }, db.adminSql);
    await fileReport({ ...input({ reportId: 'iso' }), workspaceId: 'ws-B', potHomeSlug: 'iso-hive' }, db.adminSql);

    const aOnly = await listReports('ws-A', 'iso-hive', { status: null }, db.adminSql);
    expect(aOnly.map((r) => r.workspaceId)).toEqual(['ws-A']);
    // A different hive in the same workspace doesn't leak in.
    const otherHive = await listReports('ws-A', 'other-hive', { status: null }, db.adminSql);
    expect(otherHive).toEqual([]);
    // getReport is workspace-scoped too: ws-B's row not visible from ws-A.
    expect(await getReport('ws-A', 'iso-hive', 'iso', db.adminSql)).toMatchObject({ workspaceId: 'ws-A' });
  });

  it('actioned vs dismissed are distinct terminal states the owner can filter independently', async () => {
    const hive = 'states-hive';
    await fileReport({ ...input({ reportId: 't-act' }), potHomeSlug: hive }, db.adminSql);
    await fileReport({ ...input({ reportId: 't-dis' }), potHomeSlug: hive }, db.adminSql);
    await setReportStatus(WS, hive, 't-act', 'actioned', db.adminSql);
    await setReportStatus(WS, hive, 't-dis', 'dismissed', db.adminSql);

    expect((await listReports(WS, hive, { status: 'actioned' }, db.adminSql)).map((r) => r.reportId)).toEqual(['t-act']);
    expect((await listReports(WS, hive, { status: 'dismissed' }, db.adminSql)).map((r) => r.reportId)).toEqual(['t-dis']);
    expect(await listReports(WS, hive, {}, db.adminSql)).toEqual([]); // nothing left open
  });
});
