/**
 * bug-inflow.test.ts — the stored inflow-vs-closes rollup behind the work.bugInflow cell
 * (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6).
 *
 * R-6 acceptance: "The inflow state cell returns filed-per-day by source and
 * closed-per-day from stored values without a live aggregate query." So these tests pin
 * (1) the reader issues ONE SELECT on bug_inflow_daily and never touches work_items,
 * (2) the shaping keeps per-source and per-status counts and never fills a missing day
 * with zero, (3) freshness is an explicit assessment, and (4) the cell is registered
 * against the read-only resolver tool with that assessment.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BUG_INFLOW_READ_SQL,
  BUG_INFLOW_REFRESH_SQL,
  BUG_INFLOW_STALE_AFTER_MS,
  BUG_INFLOW_TABLE,
  formatBugInflowLine,
  readBugInflowDaily,
  refreshBugInflowDaily,
  shapeBugInflow,
  type BugInflowRow,
  type BugInflowScoreboardInput,
} from './bug-inflow';
import { BUILTIN_CELLS, WORK_BUG_INFLOW_CELL } from '../../cell-registrations';
import { validateCellSpec } from '../../cell-registry';

const NOW = new Date('2026-10-20T12:00:00Z');

function row(day: string, over: Partial<BugInflowRow> = {}): BugInflowRow {
  return {
    day,
    filed_total: 10,
    filed_by_source: { watchdog: 6, 'role:su': 4 },
    closed_total: 7,
    closed_by_status: { done: 5, dropped: 2 },
    computed_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    ...over,
  } as BugInflowRow;
}

function fakeSql(rows: unknown[]) {
  const unsafe = vi.fn(async (_q: string, _p: unknown[]) => rows);
  return { sql: { unsafe } as never, unsafe };
}

describe('shapeBugInflow — stored rows to the cell reading', () => {
  it('sums filed by source and closed by status across stored days, newest first', () => {
    const r = shapeBugInflow([
      row('2026-10-20'),
      row('2026-10-19', { filed_total: 3, filed_by_source: { watchdog: 3 }, closed_total: 9, closed_by_status: { done: 9 } }),
    ], { now: NOW, windowDays: 2 });
    expect(r.assessment).toBe('measured');
    expect(r.reasons).toEqual([]);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-19']);
    expect(r.days[0]).toMatchObject({ filedTotal: 10, closedTotal: 7, net: 3 });
    expect(r.totals).toEqual({
      filed: 13,
      closed: 16,
      net: -3,
      filedBySource: { watchdog: 9, 'role:su': 4 },
      closedByStatus: { done: 14, dropped: 2 },
    });
    expect(r.missingDays).toEqual([]);
    expect(r.storage).toBe(BUG_INFLOW_TABLE);
  });

  it('lists a day with no stored row in missingDays and never counts it as zero', () => {
    const r = shapeBugInflow([row('2026-10-20'), row('2026-10-18')], { now: NOW, windowDays: 3 });
    expect(r.missingDays).toEqual(['2026-10-19']);
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-18']);
    expect(r.days.some((d) => d.day === '2026-10-19')).toBe(false);
  });

  it('is unmeasured with no stored rows (0 must not read as "no inflow")', () => {
    const r = shapeBugInflow([], { now: NOW, windowDays: 7 });
    expect(r.assessment).toBe('unmeasured');
    expect(r.days).toEqual([]);
    expect(r.missingDays).toHaveLength(7);
    expect(r.reasons[0]).toMatch(/no stored row/);
    expect(r.computedAt).toBeNull();
  });

  it('is stale when today has no stored row', () => {
    const r = shapeBugInflow([row('2026-10-19')], { now: NOW, windowDays: 2 });
    expect(r.assessment).toBe('stale');
    expect(r.reasons.join(' ')).toMatch(/no stored row for today \(2026-10-20\)/);
  });

  it('is stale when the newest row is older than the staleness bound', () => {
    const old = new Date(NOW.getTime() - BUG_INFLOW_STALE_AFTER_MS - 60_000).toISOString();
    const r = shapeBugInflow([row('2026-10-20', { computed_at: old })], { now: NOW, windowDays: 1 });
    expect(r.assessment).toBe('stale');
    expect(r.ageMs).toBeGreaterThan(BUG_INFLOW_STALE_AFTER_MS);
  });
});

describe('readBugInflowDaily — stored values only', () => {
  it('issues one SELECT on bug_inflow_daily and no aggregate over work_items', async () => {
    const { sql, unsafe } = fakeSql([row('2026-10-20')]);
    const r = await readBugInflowDaily('ws-1', { days: 7, now: NOW, sql });
    expect(unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = unsafe.mock.calls[0];
    expect(query).toBe(BUG_INFLOW_READ_SQL);
    expect(query).toMatch(/^\s*SELECT\b/);
    expect(query).toContain(BUG_INFLOW_TABLE);
    expect(query).not.toMatch(/work_items/);
    expect(query).not.toMatch(/\b(count|sum)\s*\(/i);
    expect(params).toEqual(['ws-1', '2026-10-14', '2026-10-20']);
    expect(r.assessment).toBe('measured');
  });

  it('clamps the window to 1..30 days', async () => {
    const { sql, unsafe } = fakeSql([]);
    await readBugInflowDaily('ws-1', { days: 400, now: NOW, sql });
    expect(unsafe.mock.calls[0][1]).toEqual(['ws-1', '2026-09-21', '2026-10-20']);
  });
});

describe('refreshBugInflowDaily — the tick writer', () => {
  it('recomputes today and yesterday by default with matching day and epoch-ms bounds', async () => {
    const { sql, unsafe } = fakeSql([{ day: '2026-10-19' }, { day: new Date('2026-10-20T00:00:00Z') }]);
    const out = await refreshBugInflowDaily('ws-1', { now: NOW, sql });
    const [query, params] = unsafe.mock.calls[0];
    expect(query).toBe(BUG_INFLOW_REFRESH_SQL);
    expect(query).toMatch(/ON CONFLICT \(workspace_id, day\) DO UPDATE/);
    expect(query).toMatch(/lane IS DISTINCT FROM 'observation'/);
    expect(params).toEqual([
      'ws-1', '2026-10-19', '2026-10-21',
      Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z'),
    ]);
    expect(out.days).toEqual(['2026-10-19', '2026-10-20']);
  });
});

describe('formatBugInflowLine — the fleet brief line', () => {
  it('shows filed by top source next to closed by status and the net', () => {
    const line = formatBugInflowLine(shapeBugInflow([row('2026-10-20')], { now: NOW, windowDays: 1 }));
    expect(line).toBe('bug inflow 1d: filed 10 (watchdog 6, role:su 4) vs closed 7 (done 5, dropped 2) · net +3 · 2026-10-20: filed 10 / closed 7');
  });

  it('says unmeasured instead of printing zeros', () => {
    expect(formatBugInflowLine(shapeBugInflow([], { now: NOW, windowDays: 7 }))).toMatch(/^bug inflow: unmeasured — /);
  });

  it('carries the stale reason inline', () => {
    expect(formatBugInflowLine(shapeBugInflow([row('2026-10-19')], { now: NOW, windowDays: 2 }))).toMatch(/⚠ stale: no stored row for today/);
  });
});

describe('work.bugInflow cell registration', () => {
  it('is a built-in that validates with zero rejections', () => {
    expect(BUILTIN_CELLS).toContain(WORK_BUG_INFLOW_CELL);
    expect(validateCellSpec(WORK_BUG_INFLOW_CELL)).toEqual([]);
  });

  it('polls the read-only improvements:bug-inflow resolver and assesses every reading outcome', () => {
    expect(WORK_BUG_INFLOW_CELL.changeSignal).toEqual({ kind: 'poll', tool: 'improvements:bug-inflow', path: 'inflow' });
    expect(WORK_BUG_INFLOW_CELL.assessment?.path).toBe('assessments.bugInflow');
    expect(Object.keys(WORK_BUG_INFLOW_CELL.assessment?.codes ?? {}).sort()).toEqual(['measured', 'stale', 'unmeasured']);
  });
});

// R11 fixtures model host-resolved evidence, never actual live qualification.
const R11_REGISTRY_HASH = '050a169d8e6ddabc2f2e00f54a1807216191bab254756568c12b1a484147c262';
const R11_DAY = 86_400_000;

function scoreboardFixture(): BugInflowScoreboardInput {
  const start = Date.parse('2026-10-12T00:00:00Z');
  const closure = { 'packages/operator-core/lib/harness/improvements/bug-inflow.ts': 'f'.repeat(64) };
  const authors = ['implementation-a', 'proof-author'];
  const receipts = Array.from({ length: 7 }, (_, i) => {
    const day = start + i * R11_DAY;
    const actualFireAt = new Date(day + 2 * R11_DAY + 60_000).toISOString();
    const metrics = {
      filedPerDayBySource: { countsBySource: { agent: 2 } },
      closedPerDay: { ordinary: 3, cleanup: 1, fold: 2, reopenedOrdinary: 1, adjustedOrdinary: 2 },
      shareReviewed: { numerator: 2, denominator: 2, onTimeNumerator: 2, onTimeDenominator: 2 },
      shareBypassed: { numerator: 0, denominator: 2, routes: {}, reasons: {} },
      reviewerWait: {
        rows: [1, 2].map(n => ({
          itemId: `fixture-${i}-${n}`,
          filedAt: new Date(day + n * 3_600_000).toISOString(),
          decidedAt: new Date(day + (n + 1) * 3_600_000).toISOString(),
          waitMs: 3_600_000,
          flaggedAt: new Date(day + n * 3_600_000).toISOString(),
          dueAt: new Date(day + (n + 48) * 3_600_000).toISOString(),
        })),
        pending: 0, rightCensored: 0, missing: 0,
      },
      mergesPerDay: { committed: 2, duplicate: 2, alreadyFolded: 1, protected: 0, failed: 0 },
      claimableCount: { count: 1, population: 4, protected: 1, held: 1, blocked: 1, unknown: 0 },
    };
    const sourceHash = (i + 1).toString(16).repeat(64);
    return {
      id: `fixture-run-${i}`, epochId: 'fixture-epoch', routineId: 'fixture-daily-routine',
      windowStart: new Date(day).toISOString(), windowEnd: new Date(day + R11_DAY).toISOString(),
      expectedFireAt: new Date(day + 2 * R11_DAY).toISOString(), actualFireAt,
      measuredAt: new Date(Date.parse(actualFireAt) + 5_000).toISOString(),
      registryHash: R11_REGISTRY_HASH, originalClockHash: 'c'.repeat(64),
      runtime: { buildSha: 'a'.repeat(40), closure },
      source: {
        ref: `fixture-source-${i}`, sha256: sourceHash, complete: true,
        totalRows: 20, rowsRead: 20, omitted: 0, nextCursor: null, cohortSize: 2,
      },
      writerQueryHash: 'd'.repeat(64), writerAggregateRefs: ['fixture:writer-aggregate'], metrics,
      independent: {
        artifactRef: `fixture-independent-${i}`, authorId: 'assessor-external',
        lineage: { eligible: true, checkedAgainst: authors, receiptRef: `fixture-lineage-${i}` },
        sourceHash, registryHash: R11_REGISTRY_HASH, queryHash: 'e'.repeat(64), aggregateRefs: ['fixture:independent-aggregate'],
        closure, originalClockHash: 'c'.repeat(64), complete: true, omitted: 0,
        metrics: structuredClone(metrics),
      },
    };
  });
  return {
    registryHash: R11_REGISTRY_HASH, implementationAuthors: authors, activeEpochId: 'fixture-epoch',
    epochHistory: {
      complete: true, omitted: 0, nextCursor: null,
      epochs: [{
        id: 'fixture-epoch', candidateSha: 'a'.repeat(40), activatedAt: new Date(start).toISOString(),
        closure, originalClockHash: 'c'.repeat(64), disposition: 'active', artifactRef: 'fixture-epoch-artifact',
      }],
    },
    cadence: {
      routineId: 'fixture-daily-routine', firstWindowStart: new Date(start).toISOString(),
      intervalMs: R11_DAY, maxDelayMs: 300_000, maxRuntimeMs: 300_000,
    },
    receipts,
  };
}

function assessScoreboard(scoreboard: BugInflowScoreboardInput) {
  const reading = shapeBugInflow([row('2026-10-20')], { now: NOW, windowDays: 1, scoreboard });
  expect(reading.conformance).toBeDefined();
  return reading.conformance.r11;
}

describe('R11 retained scoreboard assessment', () => {
  it('R11 seven expected daily fires numerically reconcile the exact papercusp bug population', () => {
    const result = assessScoreboard(scoreboardFixture());
    expect(result).toMatchObject({ verdict: 'healthy', independentVerdict: 'healthy', checkedRuns: 7 });
    expect(result.retainedReceiptRefs).toHaveLength(7);
    expect(result.reasons).toEqual([]);
    expect(shapeBugInflow([], { now: NOW, windowDays: 7 }).conformance.r11.verdict).toBe('unknown');
  });

  it('R11 freezes all seven original metric definitions and rejects missing keys or shared recomputation paths', () => {
    const wrongRegistry = scoreboardFixture();
    wrongRegistry.registryHash = '0'.repeat(64);
    expect(assessScoreboard(wrongRegistry).verdict).toBe('unknown');
    for (const key of Object.keys(scoreboardFixture().receipts[0].metrics)) {
      const missing = scoreboardFixture();
      delete missing.receipts[0].metrics[key as keyof typeof missing.receipts[0]['metrics']];
      expect(assessScoreboard(missing).verdict).toBe('unknown');
    }
    const shared = scoreboardFixture();
    shared.receipts[3].independent!.queryHash = shared.receipts[3].writerQueryHash;
    expect(assessScoreboard(shared).independentVerdict).toBe('unknown');
    const sharedAggregate = scoreboardFixture();
    sharedAggregate.receipts[2].independent!.aggregateRefs = sharedAggregate.receipts[2].writerAggregateRefs;
    expect(assessScoreboard(sharedAggregate).independentVerdict).toBe('unknown');
    const equallyWrong = scoreboardFixture();
    equallyWrong.receipts[5].metrics.shareReviewed!.denominator = 3;
    equallyWrong.receipts[5].independent!.metrics.shareReviewed!.denominator = 3;
    expect(assessScoreboard(equallyWrong).verdict).toBe('broken');
    const invalidWindow = scoreboardFixture();
    invalidWindow.cadence.firstWindowStart = 'not-an-instant';
    expect(assessScoreboard(invalidWindow).verdict).toBe('unknown');
    const incompleteSource = scoreboardFixture();
    incompleteSource.receipts[6].source.nextCursor = 'remaining-source-page';
    expect(assessScoreboard(incompleteSource).verdict).toBe('unknown');
  });

  it('R11 rejects each possible corrupted day independently including an otherwise unsampled day', () => {
    for (let day = 0; day < 7; day++) {
      const input = scoreboardFixture();
      input.receipts[day].metrics.shareReviewed!.denominator = 3;
      const result = assessScoreboard(input);
      expect(result.verdict, `corrupted day ${day}`).toBe('broken');
      expect(result.retainedReceiptRefs).toHaveLength(7);
    }
    for (let day = 0; day < 7; day++) {
      const missing = scoreboardFixture();
      missing.receipts.splice(day, 1);
      expect(assessScoreboard(missing).verdict).toBe('unknown');
    }
  });

  it('R11 epoch recovery requires a repaired candidate and Decision while retaining failed windows and original clocks', () => {
    const input = scoreboardFixture();
    const active = input.epochHistory.epochs[0];
    input.epochHistory.epochs.unshift({
      ...structuredClone(active), id: 'failed-epoch', disposition: 'failed', artifactRef: 'fixture-failed-epoch-artifact',
    });
    active.previousEpochId = 'failed-epoch';
    expect(assessScoreboard(input).verdict).not.toBe('healthy');
    active.candidateSha = 'b'.repeat(40);
    active.closure = { 'packages/operator-core/lib/harness/improvements/bug-inflow.ts': '0'.repeat(64) };
    active.repair = { decisionRef: 'fixture-plan#D-001', evidenceRef: 'fixture-repair-evidence' };
    for (const receipt of input.receipts) {
      receipt.runtime = { buildSha: active.candidateSha, closure: active.closure };
      receipt.independent!.closure = active.closure;
    }
    expect(assessScoreboard(input)).toMatchObject({ verdict: 'healthy', adverseEpochRefs: ['fixture-failed-epoch-artifact'] });
    input.epochHistory.epochs.splice(0, 1);
    expect(assessScoreboard(input).verdict).toBe('unknown');
  });

  it('R11 independent evidence rejects absent self-authored partial and mismatched artifact receipts', () => {
    const changes = [
      (r: BugInflowScoreboardInput['receipts'][number]) => { delete r.independent; },
      (r: BugInflowScoreboardInput['receipts'][number]) => { r.independent!.authorId = 'implementation-a'; },
      (r: BugInflowScoreboardInput['receipts'][number]) => { r.independent!.complete = false; },
      (r: BugInflowScoreboardInput['receipts'][number]) => { r.independent!.sourceHash = '0'.repeat(64); },
      (r: BugInflowScoreboardInput['receipts'][number]) => { r.independent!.artifactRef = ''; },
      (r: BugInflowScoreboardInput['receipts'][number]) => { r.independent!.lineage.checkedAgainst = []; },
    ];
    for (const change of changes) {
      const input = scoreboardFixture();
      change(input.receipts[2]);
      expect(assessScoreboard(input).independentVerdict).toBe('unknown');
    }
  });

  it('R11 candidate closure containment accepts only unrelated advances and retains every adverse epoch and original deadline', () => {
    const unrelated = scoreboardFixture();
    unrelated.receipts[4].runtime.buildSha = 'b'.repeat(40);
    expect(assessScoreboard(unrelated).verdict).toBe('healthy');
    unrelated.receipts[4].runtime.closure = { changed: '0'.repeat(64) };
    expect(assessScoreboard(unrelated).verdict).toBe('broken');
    const resetClock = scoreboardFixture();
    resetClock.receipts[6].originalClockHash = '0'.repeat(64);
    expect(assessScoreboard(resetClock).verdict).toBe('broken');
    const late = scoreboardFixture();
    late.receipts[1].actualFireAt = new Date(Date.parse(late.receipts[1].expectedFireAt) + 300_001).toISOString();
    expect(assessScoreboard(late).verdict).toBe('broken');
  });
});
