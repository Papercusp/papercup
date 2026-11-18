/**
 * bug-inflow.integration.test.ts — bug-inflow-one-problem-one-row-2026-10-18 R-6, exact counts.
 *
 * bug-inflow.test.ts pins the SHAPE of the work.bugInflow reading. This file pins the
 * COUNTS: it seeds a known population into harness_shared.work_items on a fully migrated
 * Postgres, runs the production tick writer (refreshBugInflowDaily, i.e. the real
 * BUG_INFLOW_REFRESH_SQL), reads the stored rows back through readBugInflowDaily, and
 * asserts every number.
 *
 * The population covers each rule the R-6 method states:
 *   - filed-per-day is bucketed by reporter source (payload.source, then a watchdog
 *     reporterKind, then filedByRole as role:<r>, else unattributed);
 *   - a row stamped duplicate_of counts in filed-per-day like any other filing, and in
 *     closed-per-day on the day it reaches a terminal status, under that status;
 *   - closed-per-day counts by close day, so a row filed before the window still counts;
 *   - observation-lane rows, other workspaces and non-issue kinds count nowhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  freezeBugScoreboardSource, persistBugScoreboardEvidence, readBugScoreboardSource,
  readBugScoreboardSourcePage, readStoredBugScoreboard,
  readBugInflowDaily, refreshBugInflowDaily,
} from './bug-inflow';
import { scoreboardFixture } from './bug-inflow.fixture';

const WS = 'ws-r6-exact';
const OTHER_WS = 'ws-r6-other';
const NOW = new Date('2026-10-20T12:00:00Z');
const at = (iso: string) => Date.parse(iso);

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

async function seed(row: {
  id: string;
  ws?: string;
  harness?: string;
  kind?: string;
  status?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  closedAt?: string;
  duplicateOf?: string;
}) {
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, workspace_id, title, status, item_kind, nature, payload,
       created_ts, closed_ts, duplicate_of, duplicate_source)
    VALUES (${row.harness ?? 'r6-h'}, ${row.id}, ${row.ws ?? WS}, ${`r6 ${row.id}`}, ${row.status ?? 'open'},
            ${row.kind ?? 'bug'}, 'work', ${db.adminSql.json((row.payload ?? {}) as never)},
            ${at(row.createdAt)}, ${row.closedAt ? at(row.closedAt) : null},
            ${row.duplicateOf ?? null}, ${row.duplicateOf ? 'agent' : null})`;
}

describe('R-6: the stored inflow rollup counts exactly what was filed and closed', () => {
  it('buckets filings by source and closes by status per UTC day, counting a duplicate_of row in both', async () => {
    // Filed on 2026-10-19: two watchdog, two role:su (one of them a duplicate, dropped the same day).
    await seed({ id: 'R6-A', payload: { source: 'watchdog' }, createdAt: '2026-10-19T03:00:00Z' });
    await seed({ id: 'R6-B', payload: { reporterKinds: ['watchdog', 'agent'] }, createdAt: '2026-10-19T04:00:00Z' });
    await seed({ id: 'R6-C', kind: 'change', payload: { filedByRole: 'su' }, createdAt: '2026-10-19T05:00:00Z' });
    await seed({
      id: 'R6-D', payload: { filedByRole: 'su' }, status: 'dropped', duplicateOf: 'R6-A',
      createdAt: '2026-10-19T06:00:00Z', closedAt: '2026-10-19T08:00:00Z',
    });
    // Filed BEFORE the window, closed inside it: counts as a close on 2026-10-19 only.
    await seed({ id: 'R6-H', status: 'done', createdAt: '2026-10-17T09:00:00Z', closedAt: '2026-10-19T10:00:00Z' });
    // Filed on 2026-10-20 with no attribution.
    await seed({ id: 'R6-I', kind: 'task', createdAt: '2026-10-20T01:00:00Z' });
    // Counted nowhere: an observation note, another workspace, a feature-family row.
    await seed({ id: 'R6-E', payload: { lane: 'observation', source: 'watchdog' }, createdAt: '2026-10-19T07:00:00Z' });
    await seed({ id: 'R6-F', ws: OTHER_WS, payload: { source: 'watchdog' }, createdAt: '2026-10-19T07:30:00Z' });
    await seed({ id: 'R6-G', kind: 'feature', payload: { source: 'watchdog' }, createdAt: '2026-10-19T07:45:00Z' });

    const written = await refreshBugInflowDaily(WS, { now: NOW, sql: db.adminSql });
    expect(written.days).toEqual(['2026-10-19', '2026-10-20']);

    const reading = await readBugInflowDaily(WS, { days: 2, now: NOW, sql: db.adminSql });
    expect(reading.assessment).toBe('measured');
    expect(reading.missingDays).toEqual([]);
    const byDay = new Map(reading.days.map((d) => [d.day, d]));

    expect(byDay.get('2026-10-19')).toMatchObject({
      filedTotal: 4,
      filedBySource: { watchdog: 2, 'role:su': 2 },
      closedTotal: 2,
      closedByStatus: { dropped: 1, done: 1 },
      net: 2,
    });
    expect(byDay.get('2026-10-20')).toMatchObject({
      filedTotal: 1,
      filedBySource: { unattributed: 1 },
      closedTotal: 0,
      closedByStatus: {},
      net: 1,
    });
    expect(reading.totals).toEqual({
      filed: 5,
      closed: 2,
      net: 3,
      filedBySource: { watchdog: 2, 'role:su': 2, unattributed: 1 },
      closedByStatus: { dropped: 1, done: 1 },
    });
  });
});

describe('R11 retained PostgreSQL source and receipt consumer', () => {
  const workspace = 'papercusp-workspace';
  const harness = 'papercusp';
  const sourceSeed = (id: string, extra: Partial<Parameters<typeof seed>[0]> = {}) => seed({
    id, ws: workspace, harness, createdAt: '2026-10-12T01:00:00Z', ...extra,
  });
  const clearSource = () => db.adminSql`DELETE FROM harness_shared.work_items
    WHERE workspace_id = ${workspace} AND harness_slug = ${harness}`;

  it('R11 scoreboard source-query continuation prove N-1 N N+1 decisive-tail consumer recovery permutations many batches and restart fairness', async () => {
    const n = 4;
    for (const count of [n - 1, n, n + 1, 10 * n + 1]) {
      for (const permutation of ['reverse', 'rotate']) {
        await clearSource();
        const ids = Array.from({ length: count }, (_, i) => i === count - 1
          ? `r11-zz-${'full-identity-'.repeat(30)}` : `r11-${String(i).padStart(4, '0')}`);
        const insertion = permutation === 'reverse' ? [...ids].reverse() : [...ids.slice(2), ...ids.slice(0, 2)];
        for (const id of insertion) await sourceSeed(id, { payload: {
          source: 'agent', decisive: id === ids[count - 1], completeRecord: 'x'.repeat(12_000),
        } });
        await sourceSeed('r11-observation', { payload: { lane: 'observation' } });
        await sourceSeed(`r11-other-workspace-${count}-${permutation}`, { ws: 'r11-foreign' });
        await sourceSeed(`r11-other-harness-${count}-${permutation}`, { harness: 'r11-foreign' });
        await sourceSeed('r11-change', { kind: 'change' });
        const frozen = await freezeBugScoreboardSource({ now: NOW, sql: db.adminSql });
        expect(frozen.totalRows).toBe(count);
        const first = await readBugScoreboardSourcePage(frozen.ref, { pageSize: n, sql: db.adminSql });
        expect(first.rows.map(r => r.itemId)).toEqual(ids.slice(0, n));
        expect(first.omitted).toBe(Math.max(0, count - n));
        expect(first.nextCursor === null).toBe(count <= n);

        // A new process needs only these serialized values. No in-memory iterator,
        // mutable keyset, insertion order or restart can change the frozen cohort.
        const restart = JSON.parse(JSON.stringify({ ref: frozen.ref, cursor: first.nextCursor }));
        await sourceSeed('r11-0000-before-cursor');
        const recovered = [...first.rows];
        let cursor: string | null = restart.cursor;
        while (cursor !== null) {
          const page = await readBugScoreboardSourcePage(restart.ref, { cursor, pageSize: n, sql: db.adminSql });
          recovered.push(...page.rows);
          expect(page.rowsRead + page.omitted).toBe(count);
          cursor = page.nextCursor;
        }
        expect(recovered.map(r => r.itemId)).toEqual(ids);
        expect(new Set(recovered.map(r => r.itemId)).size).toBe(count);
        const consumed = await readBugScoreboardSource(frozen.ref, { pageSize: n, sql: db.adminSql });
        expect(consumed).toMatchObject({ totalRows: count, rowsRead: count, omitted: 0, nextCursor: null });
        expect(consumed.rows.map(r => r.itemId)).toEqual(ids);
        const decisive = consumed.rows[count - 1];
        expect(decisive.record.payload).toMatchObject({ decisive: true, completeRecord: 'x'.repeat(12_000) });

        // A later freeze includes new rows even when they sort behind an old
        // cursor. The old cursor cannot be applied to the new snapshot.
        const next = await freezeBugScoreboardSource({ now: NOW, sql: db.adminSql });
        expect((await readBugScoreboardSource(next.ref, { pageSize: n, sql: db.adminSql })).rows.map(r => r.itemId))
          .toEqual([...ids, 'r11-0000-before-cursor'].sort());
        if (first.nextCursor) await expect(readBugScoreboardSourcePage(next.ref, {
          cursor: first.nextCursor, pageSize: n, sql: db.adminSql,
        })).rejects.toThrow(/cursor/);
      }
    }
    await expect(readBugScoreboardSourcePage('missing', { pageSize: 0, sql: db.adminSql })).rejects.toThrow(/pageSize/);
  });

  it('R11 assessor consumes actual persisted writer records and independent reconciliation artifacts across restart', async () => {
    await clearSource();
    const input = scoreboardFixture();
    for (const receipt of input.receipts) {
      const rows = receipt.metrics.reviewerWait!.rows as Array<{ itemId: string; filedAt: string }>;
      for (const row of rows) await sourceSeed(row.itemId, { createdAt: row.filedAt, payload: { source: 'agent' } });
    }
    const source = await freezeBugScoreboardSource({ now: NOW, sql: db.adminSql });
    expect(source.totalRows).toBe(14);
    // An independently written SQL aggregate checks the filed numerator on the
    // actual database population. Other event metrics remain synthetic fixtures;
    // this integration test does not authenticate live event-history continuity.
    const counts = await db.adminSql<{ day: string; n: number }[]>`
      SELECT to_char(to_timestamp(created_ts::numeric / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        count(*)::int AS n FROM harness_shared.work_items
      WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND item_kind = 'bug'
        AND lane IS DISTINCT FROM 'observation' GROUP BY 1 ORDER BY 1`;
    expect(counts).toHaveLength(7);
    for (const receipt of input.receipts) {
      expect(counts.find(c => c.day === receipt.windowStart.slice(0, 10))?.n)
        .toBe((receipt.metrics.filedPerDayBySource!.countsBySource as Record<string, number>).agent);
      Object.assign(receipt.source, { ref: source.ref, sha256: source.sha256, totalRows: 14, rowsRead: 14 });
      receipt.independent!.sourceHash = source.sha256;
    }
    const stored = await persistBugScoreboardEvidence(input, { sql: db.adminSql });
    const restartRef = JSON.parse(JSON.stringify(stored.manifestRef));
    const reading = await readStoredBugScoreboard(restartRef, { now: NOW, pageSize: 4, sql: db.adminSql });
    expect(reading).toMatchObject({ verdict: 'unknown', independentVerdict: 'unknown', checkedRuns: 7 });
    expect(reading.retainedReceiptRefs).toEqual(expect.arrayContaining(stored.receiptRefs));
    expect(reading.retainedReceiptRefs.filter(ref => ref.includes('/independent/'))).toHaveLength(7);
    expect(reading.reasons.join(' ')).toMatch(/authorship is unverified/);

    // The changed input cannot overwrite prior receipts or reset a failed day.
    input.receipts[6].metrics.shareReviewed!.denominator = 3;
    const broken = await persistBugScoreboardEvidence(input, { sql: db.adminSql });
    expect(broken.manifestRef).not.toBe(stored.manifestRef);
    expect((await readStoredBugScoreboard(broken.manifestRef, { now: NOW, sql: db.adminSql })).verdict).toBe('broken');
    expect((await readStoredBugScoreboard(stored.manifestRef, { now: NOW, sql: db.adminSql })).verdict).toBe('unknown');

    const independentRef = reading.retainedReceiptRefs.find(ref => ref.includes('/independent/'))!;
    await db.adminSql`UPDATE harness_shared.harness_text_artifacts SET content = '{}'
      WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND rel_path = ${independentRef}`;
    expect((await readStoredBugScoreboard(stored.manifestRef, { now: NOW, sql: db.adminSql })).verdict).toBe('unknown');
    await db.adminSql`DELETE FROM harness_shared.harness_text_artifacts
      WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND rel_path = ${source.ref}`;
    expect((await readStoredBugScoreboard(stored.manifestRef, { now: NOW, sql: db.adminSql })).verdict).toBe('unknown');
  }, 60_000);
});
