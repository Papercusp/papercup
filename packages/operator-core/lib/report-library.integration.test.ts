/**
 * report-library.integration.test.ts — the owner-facing Reports library store
 * (`harness_shared.report_library`, migration 1166) against real Postgres.
 *
 * Plan reports-library-2026-09-15, P-002 (integration tier). Mirrors
 * code-recipes-store.integration.test.ts: the module is transport-agnostic (every
 * fn TAKES the `sql` handle), so the org-fixture's admin (RLS-bypass) client is
 * passed directly — no db-org mock.
 *
 * `createOrgTestDb()` runs the real boot-path migration runner, so 1166 is applied
 * as part of the full set; it is then RE-APPLIED idempotently below so this
 * coverage stays bound to the production migration file rather than to whatever
 * the baseline happens to contain.
 *
 * Covers the P-002 acceptance clauses:
 *   SPEC-P-002-publish-returns-id     · a stable id that resolves on a later get
 *   SPEC-P-002-body-cap-refused       · >512 KB refused WITH overage, nothing stored
 *   SPEC-P-002-supersede-lineage      · supersedes inherits the predecessor lineage
 *   SPEC-P-002-retire-is-soft         · retired_at set, body still resolvable
 *   SPEC-P-002-visible-to-matrix      · the exact R-7 grant matrix
 *   SPEC-P-002-store-integration-test · this file, against migration-applied PG
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseGoalOwnerReportSnapshot, serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { goalOwnerReportFixture } from '../test/fixtures/goal-owner-report';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  REPORT_BODY_MAX_BYTES,
  ReportBodyTooLargeError,
  getReport,
  listReportLineage,
  listReports,
  publishReport,
  retireReport,
  type ReportOrigin,
  type ReportViewer,
} from './report-library';

const { createOrgTestDb } = await import('../test/_org-test-db');
const here = dirname(fileURLToPath(import.meta.url));
const reportMigration = join(
  here, '..', '..', '..', 'libs', 'papercusp', 'libs', 'db', 'sql', '1166-report-library.sql',
);
const snapshotMigration = join(dirname(reportMigration), '1353-report-library-goal-snapshot.sql');

/** A fresh workspace per test, so no test can see another's rows. */
let wsSeq = 0;
const nextWs = (): string => `rl-ws-${Date.now()}-${++wsSeq}`;

const AGENT_1: ReportOrigin = {
  harnessSlug: 'pot-a', authorOwnerId: 'agent-1', authorSessionRef: 'sess-1',
};

describe('report_library store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Bind this coverage to the production migration, not just the baseline.
    expect(existsSync(reportMigration), `migration missing at ${reportMigration}`).toBe(true);
    await db.adminSql.unsafe(readFileSync(reportMigration, 'utf8')).simple();
    // Exercise the draft before arming, and the armed production file afterward.
    await db.adminSql.unsafe(readFileSync(existsSync(snapshotMigration) ? snapshotMigration : `${snapshotMigration}.DRAFT`, 'utf8')).simple();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('REPORT-EXACT-IDENTITY-P001: round-trips the complete pinned GOAL fixture after a successor', async () => {
    const workspaceId = nextWs();
    const snapshot = goalOwnerReportFixture(workspaceId);
    const body = serializeGoalOwnerReportSnapshot(snapshot);
    expect(body.length).toBeGreaterThan(600);
    const original = await publishReport(db.adminSql, { workspaceId, title: 'GOAL snapshot', goalOwnerReport: snapshot, visibility: 'workspace' }, AGENT_1);
    const successorSnapshot = { ...snapshot, observedAt: '2026-10-03T10:05:00.000Z' };
    const successor = await publishReport(db.adminSql, { workspaceId, title: 'New observation', goalOwnerReport: successorSnapshot, supersedes: original.reportId }, AGENT_1);
    expect(successor.lineageId).toBe(original.lineageId);
    expect(successor.bodySha256).not.toBe(original.bodySha256);
    const pinned = await getReport(db.adminSql, workspaceId, original.reportId, { ownerId: 'reader' });
    expect(pinned).toMatchObject({ workspaceId, reportId: original.reportId, subject: { kind: 'goal', ref: snapshot.goalId }, bodyMd: body, goalOwnerReport: snapshot, bodySha256: createHash('sha256').update(body, 'utf8').digest('hex') });
    expect(pinned!.goalOwnerReport).toEqual(snapshot);
    for (const wall of snapshot.ownerWalls) expect(pinned!.bodyMd).toContain(wall.exactAction);
    expect(pinned!.bodyMd).toContain('completion unverified');
    expect(pinned!.bodyMd).toContain('Successful mutation: work_items:complete');
    expect(pinned!.bodyMd).toContain('Unknown: legacy-spend');
    expect(await getReport(db.adminSql, 'different-workspace', original.reportId)).toBeNull();
    await retireReport(db.adminSql, workspaceId, original.reportId);
    expect((await getReport(db.adminSql, workspaceId, original.reportId))!.bodyMd).toBe(body);
    await expect(db.adminSql`UPDATE harness_shared.report_library SET body_md = 'substitution' WHERE workspace_id = ${workspaceId} AND report_id = ${original.reportId}`).rejects.toThrow('immutable');
    await expect(db.adminSql`UPDATE harness_shared.report_library SET goal_owner_report = NULL WHERE workspace_id = ${workspaceId} AND report_id = ${original.reportId}`).rejects.toThrow('immutable');
  });

  it('refuses malformed snapshots and workspace/subject/body substitutions before publication', async () => {
    const workspaceId = nextWs();
    const snapshot = goalOwnerReportFixture(workspaceId);
    const base = { workspaceId, title: 'GOAL snapshot', goalOwnerReport: snapshot };
    expect(parseGoalOwnerReportSnapshot(snapshot)).toEqual(snapshot);
    for (const change of [
      { goalOwnerReport: { ...snapshot, workspaceId: 'other' } },
      { subject: { kind: 'goal' as const, ref: 'wrong-goal' } },
      { bodyMd: 'caller substitute' },
      { goalOwnerReport: { ...snapshot, observedAt: '2026-02-30T10:00:00.000Z' } },
      { goalOwnerReport: { ...snapshot, ownerWalls: [{ ...snapshot.ownerWalls[0]!, exactAction: '' }] } },
      { goalOwnerReport: { ...snapshot, cost: { ...snapshot.cost, spentCents: null, unknownReason: undefined } } },
    ]) await expect(publishReport(db.adminSql, { ...base, ...change })).rejects.toThrow('invalid report');
    expect(await listReports(db.adminSql, { workspaceId })).toEqual([]);
  });

  it('SPEC-P-002-publish-returns-id: publish returns a stable id that resolves on a later get', async () => {
    const workspaceId = nextWs();
    const bodyMd = '# Audit\n\n```mermaid\ngraph TD; A-->B;\n```\n\nBody text.';
    const published = await publishReport(
      db.adminSql,
      {
        workspaceId,
        title: 'Storewolf architecture audit',
        summary: 'What the transformer service actually does.',
        bodyMd,
        kind: 'audit',
        subject: { kind: 'repo', ref: 'storewolf', label: 'Storewolf' },
        visibility: 'workspace',
        tags: ['architecture', 'storewolf'],
      },
      AGENT_1,
    );

    expect(published.reportId).toMatch(/^rpt_/);
    // Lineage self-roots when nothing is superseded.
    expect(published.lineageId).toBe(published.reportId);
    expect(published.supersedesReportId).toBeNull();

    const fetched = await getReport(db.adminSql, workspaceId, published.reportId);
    expect(fetched).not.toBeNull();
    // The body round-trips byte-for-byte — mermaid fences included.
    expect(fetched!.bodyMd).toBe(bodyMd);
    expect(fetched!.title).toBe('Storewolf architecture audit');
    expect(fetched!.tags).toEqual(['architecture', 'storewolf']);
  });

  it('R-2: origin is server-stamped and independent of subject and visibility', async () => {
    const workspaceId = nextWs();
    // Written in pot-a, ABOUT something external, readable workspace-wide: all
    // three axes carry different values at once.
    const r = await publishReport(
      db.adminSql,
      {
        workspaceId,
        title: 'External dependency review',
        subject: { kind: 'external', ref: 'https://example.invalid/spec', label: 'Vendor spec' },
        visibility: 'workspace',
      },
      AGENT_1,
    );
    expect(r.origin).toEqual({
      harnessSlug: 'pot-a', authorOwnerId: 'agent-1', authorSessionRef: 'sess-1',
    });
    expect(r.subject).toEqual({
      kind: 'external', ref: 'https://example.invalid/spec', label: 'Vendor spec',
    });
    expect(r.visibility).toBe('workspace');

    // A subject that is not `none` must actually name something.
    await expect(
      publishReport(
        db.adminSql,
        { workspaceId, title: 'Unanchored', subject: { kind: 'plan' } },
        AGENT_1,
      ),
    ).rejects.toThrow(/subject\.ref is required/);
  });

  it('SPEC-P-002-body-cap-refused: an over-cap body is refused with its overage and nothing is stored', async () => {
    const workspaceId = nextWs();

    // Calibration: a body EXACTLY at the cap is accepted, so the refusal below is
    // a real boundary and not a test that would pass against any limit at all.
    const atCap = 'x'.repeat(REPORT_BODY_MAX_BYTES);
    const ok = await publishReport(
      db.adminSql, { workspaceId, title: 'At the cap', bodyMd: atCap }, AGENT_1,
    );
    expect((await getReport(db.adminSql, workspaceId, ok.reportId))!.bodyMd).toHaveLength(
      REPORT_BODY_MAX_BYTES,
    );

    const over = 'x'.repeat(REPORT_BODY_MAX_BYTES + 17);
    const err = await publishReport(
      db.adminSql, { workspaceId, title: 'Over the cap', bodyMd: over }, AGENT_1,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReportBodyTooLargeError);
    const typed = err as ReportBodyTooLargeError;
    // The overage is REPORTED, not guessed at by the caller.
    expect(typed.overageBytes).toBe(17);
    expect(typed.limitBytes).toBe(REPORT_BODY_MAX_BYTES);
    expect(typed.message).toContain('17 bytes over');

    // "Refused rather than stored truncated": the refusal wrote NOTHING. Without
    // this assertion a silently-truncated insert would still pass the throw check.
    const rows = await listReports(db.adminSql, { workspaceId });
    expect(rows.map((r) => r.title)).toEqual(['At the cap']);
  });

  it('SPEC-P-002-supersede-lineage: a redone report inherits its predecessor lineage and collapses the list', async () => {
    const workspaceId = nextWs();
    const v1 = await publishReport(
      db.adminSql,
      { workspaceId, title: 'Transformer audit v1', bodyMd: 'first pass', visibility: 'workspace' },
      AGENT_1,
    );
    const v2 = await publishReport(
      db.adminSql,
      {
        workspaceId, title: 'Transformer audit v2', bodyMd: 'second pass',
        visibility: 'workspace', supersedes: v1.reportId,
      },
      AGENT_1,
    );
    const v3 = await publishReport(
      db.adminSql,
      {
        workspaceId, title: 'Transformer audit v3', bodyMd: 'third pass',
        visibility: 'workspace', supersedes: v2.reportId,
      },
      AGENT_1,
    );

    // The whole chain shares v1's lineage, even at the third hop.
    expect(v2.lineageId).toBe(v1.lineageId);
    expect(v3.lineageId).toBe(v1.lineageId);
    expect(v3.supersedesReportId).toBe(v2.reportId);

    // The library shows ONE entry — the latest.
    const listed = await listReports(db.adminSql, { workspaceId });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.reportId).toBe(v3.reportId);

    // ...with the history reachable, and every superseded body still resolvable.
    const history = await listReportLineage(db.adminSql, workspaceId, v1.lineageId);
    expect(history.map((r) => r.reportId)).toEqual([v3.reportId, v2.reportId, v1.reportId]);
    expect((await getReport(db.adminSql, workspaceId, v1.reportId))!.bodyMd).toBe('first pass');

    // Uncollapsed, all three rows are visible.
    const flat = await listReports(db.adminSql, { workspaceId, collapseLineage: false });
    expect(flat).toHaveLength(3);

    // Superseding an unknown id is an error, never a silently orphaned lineage.
    await expect(
      publishReport(
        db.adminSql, { workspaceId, title: 'Orphan', supersedes: 'rpt_does-not-exist' }, AGENT_1,
      ),
    ).rejects.toThrow(/cannot supersede/);
  });

  it('SPEC-P-002-retire-is-soft: retiring hides from the list but leaves the body resolvable', async () => {
    const workspaceId = nextWs();
    const r = await publishReport(
      db.adminSql,
      { workspaceId, title: 'Stale digest', bodyMd: 'still readable', visibility: 'workspace' },
      AGENT_1,
    );

    const retired = await retireReport(db.adminSql, workspaceId, r.reportId);
    expect(retired!.retiredAt).not.toBeNull();

    // Gone from the default list...
    expect(await listReports(db.adminSql, { workspaceId })).toHaveLength(0);
    // ...still in it when asked for...
    expect(await listReports(db.adminSql, { workspaceId, includeRetired: true })).toHaveLength(1);
    // ...and STILL RESOLVABLE BY ID with its body intact: a citation keeps working.
    const still = await getReport(db.adminSql, workspaceId, r.reportId);
    expect(still!.bodyMd).toBe('still readable');
    expect(still!.retiredAt).toBe(retired!.retiredAt);

    // Idempotent: re-retiring preserves the original timestamp.
    const again = await retireReport(db.adminSql, workspaceId, r.reportId);
    expect(again!.retiredAt).toBe(retired!.retiredAt);

    expect(await retireReport(db.adminSql, workspaceId, 'rpt_missing')).toBeNull();
  });

  it('SPEC-P-002-visible-to-matrix: visibleTo grants exactly workspace + own-pot + authored', async () => {
    const workspaceId = nextWs();
    const inPotA: ReportOrigin = { harnessSlug: 'pot-a', authorOwnerId: 'agent-1' };
    const inPotB: ReportOrigin = { harnessSlug: 'pot-b', authorOwnerId: 'agent-2' };

    const wsWide = await publishReport(
      db.adminSql, { workspaceId, title: 'A workspace', visibility: 'workspace' }, inPotA);
    const potA = await publishReport(
      db.adminSql, { workspaceId, title: 'B pot-a', visibility: 'pot' }, inPotA);
    const potB = await publishReport(
      db.adminSql, { workspaceId, title: 'C pot-b', visibility: 'pot' }, inPotB);
    const ownerB = await publishReport(
      db.adminSql, { workspaceId, title: 'D owner pot-b', visibility: 'owner' }, inPotB);
    const ownerA = await publishReport(
      db.adminSql, { workspaceId, title: 'E owner pot-a', visibility: 'owner' }, inPotA);

    const visibleTitles = async (viewer: ReportViewer): Promise<string[]> =>
      (await listReports(db.adminSql, { workspaceId, viewer })).map((r) => r.title).sort();

    // A bystander agent in pot-a: workspace reports + its OWN pot's pot-reports.
    // Not pot-b's, and not either `owner` report — it authored neither.
    expect(await visibleTitles({ ownerId: 'agent-3', potSlug: 'pot-a' }))
      .toEqual(['A workspace', 'B pot-a']);

    // The author in pot-a also gets its OWN `owner`-visibility report back.
    expect(await visibleTitles({ ownerId: 'agent-1', potSlug: 'pot-a' }))
      .toEqual(['A workspace', 'B pot-a', 'E owner pot-a']);

    // The pot-b author: workspace + pot-b's pot-report + the owner report it wrote.
    expect(await visibleTitles({ ownerId: 'agent-2', potSlug: 'pot-b' }))
      .toEqual(['A workspace', 'C pot-b', 'D owner pot-b']);

    // The human owner sees everything.
    expect(await visibleTitles({ isOwner: true })).toEqual(
      ['A workspace', 'B pot-a', 'C pot-b', 'D owner pot-b', 'E owner pot-a'],
    );

    // A viewer with neither identity sees workspace reports only — the `FALSE`
    // branches, which a NULL comparison would otherwise turn into a silent grant.
    expect(await visibleTitles({})).toEqual(['A workspace']);

    // The same gate applies to a single-report read, not just the list.
    const stranger: ReportViewer = { ownerId: 'agent-3', potSlug: 'pot-a' };
    expect(await getReport(db.adminSql, workspaceId, wsWide.reportId, stranger)).not.toBeNull();
    expect(await getReport(db.adminSql, workspaceId, potA.reportId, stranger)).not.toBeNull();
    expect(await getReport(db.adminSql, workspaceId, potB.reportId, stranger)).toBeNull();
    expect(await getReport(db.adminSql, workspaceId, ownerA.reportId, stranger)).toBeNull();
    expect(await getReport(db.adminSql, workspaceId, ownerB.reportId, stranger)).toBeNull();
    // ...and the owner-visibility report IS readable by the owner.
    expect(await getReport(db.adminSql, workspaceId, ownerB.reportId, { isOwner: true }))
      .not.toBeNull();
  });

  it('lists by subject, kind, origin and tags — the three axes filter independently', async () => {
    const workspaceId = nextWs();
    const about = { kind: 'plan' as const, ref: 'reports-library-2026-09-15' };
    await publishReport(db.adminSql, {
      workspaceId, title: 'About the plan', kind: 'review', subject: about,
      visibility: 'workspace', tags: ['phase-1', 'store'],
    }, AGENT_1);
    await publishReport(db.adminSql, {
      workspaceId, title: 'About something else', kind: 'review',
      subject: { kind: 'plan', ref: 'other-plan' }, visibility: 'workspace',
    }, AGENT_1);
    await publishReport(db.adminSql, {
      workspaceId, title: 'Written elsewhere', kind: 'audit', subject: about, visibility: 'workspace',
    }, { harnessSlug: 'pot-z', authorOwnerId: 'agent-9' });

    const bySubject = await listReports(db.adminSql, { workspaceId, subject: about });
    expect(bySubject.map((r) => r.title).sort()).toEqual(['About the plan', 'Written elsewhere']);

    expect((await listReports(db.adminSql, { workspaceId, kind: 'audit' })).map((r) => r.title))
      .toEqual(['Written elsewhere']);

    expect((await listReports(db.adminSql, { workspaceId, originHarnessSlug: 'pot-z' }))
      .map((r) => r.title)).toEqual(['Written elsewhere']);

    // `tags` is contains-ALL, so a subset matches and an absent tag excludes.
    expect((await listReports(db.adminSql, { workspaceId, tags: ['store'] })).map((r) => r.title))
      .toEqual(['About the plan']);
    expect(await listReports(db.adminSql, { workspaceId, tags: ['store', 'absent'] }))
      .toHaveLength(0);
  });
});
