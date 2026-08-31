/**
 * Unit tests for the hot-statement seq-scan detector (EI-19312743681026041).
 *
 * The calibration block is the point of this file. A detector written after the fact is
 * worth nothing unless it would have caught the cases that motivated it, so migrations
 * 717 and 718 are encoded here with their MEASURED numbers and asserted to match. They
 * are paired with negative controls — a COUNT(*) aggregate, a bulk export, a point
 * lookup — because a predicate that flags everything would also "catch" both cases while
 * being useless. Both directions have to hold for the thresholds to mean anything.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  HOT_SEQ_SCAN_MIN_RELATION_BYTES,
  collectSeqScans,
  describeFinding,
  explainGeneric,
  extractCaller,
  isExplainable,
  matchesReadManyReturnFew,
  rankDeltas,
  resolveRelationSizes,
  runHotSeqScanDetectionOnce,
  sampleKey,
  type PgssBaseline,
  type PgssSampleEntry,
} from './hot-seq-scan-detector';

const THRESHOLDS = {
  minBlocksPerCall: 1_000,
  maxRowsPerCall: 1_000,
  minAmplification: 10,
};

const entry = (e: Partial<PgssSampleEntry> = {}): PgssSampleEntry => ({
  calls: 0,
  totalExecTimeMs: 0,
  rows: 0,
  sharedBlks: 0,
  statsSinceMs: 1_000,
  ...e,
});

// ---------------------------------------------------------------------------

describe('matchesReadManyReturnFew — calibration against the two real cases', () => {
  // Migration 717 (WI-6839): Scout's harness_plans sweeps seq-scanned and detoasted
  // 999 rows to return ~1. Measured 4,459 buffers per call.
  it('MATCHES migration 717 (4,459 blocks/call to return ~1 row)', () => {
    const c = { blocksPerCall: 4_459, rowsPerCall: 1, amplification: 4_459 };
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(true);
  });

  // Migration 718 (WI-6850): the pot frontier survey seq-scanned work_items (284 MB)
  // twice per call to return 0-700 rows. Measured 14,379 buffers per call. 700 rows is
  // its most FORGIVING reading — the case that comes closest to slipping through.
  it('MATCHES migration 718 at its most forgiving (14,379 blocks/call, 700 rows)', () => {
    const c = { blocksPerCall: 14_379, rowsPerCall: 700, amplification: 14_379 / 700 };
    expect(c.amplification).toBeGreaterThan(20); // ~20.5x, still 2x over the floor
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(true);
  });

  it('MATCHES migration 718 in its zero-row case', () => {
    const c = { blocksPerCall: 14_379, rowsPerCall: 0, amplification: 14_379 };
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(true);
  });

  // Negative controls. Without these the calibration above proves nothing: a predicate
  // that always returned true would pass every test written so far.
  it('does NOT match a legitimate COUNT(*) aggregate', () => {
    // Reads everything and returns one row ON PURPOSE. High amplification, but the work
    // is what the caller actually asked for. This is the case the ratio alone gets wrong.
    const c = { blocksPerCall: 900, rowsPerCall: 1, amplification: 900 };
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(false);
  });

  it('does NOT match a bulk export (reads many, RETURNS many)', () => {
    const c = { blocksPerCall: 20_000, rowsPerCall: 50_000, amplification: 0.4 };
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(false);
  });

  it('does NOT match an indexed point lookup', () => {
    const c = { blocksPerCall: 4, rowsPerCall: 1, amplification: 4 };
    expect(matchesReadManyReturnFew(c, THRESHOLDS)).toBe(false);
  });

  it('requires ALL THREE conditions, not any one of them', () => {
    // Blocks high + rows low but amplification below the floor cannot happen
    // arithmetically, so the meaningful check is that each condition can veto.
    expect(
      matchesReadManyReturnFew(
        { blocksPerCall: 999, rowsPerCall: 1, amplification: 999 },
        THRESHOLDS,
      ),
    ).toBe(false); // blocks below floor
    expect(
      matchesReadManyReturnFew(
        { blocksPerCall: 5_000, rowsPerCall: 1_001, amplification: 5 },
        THRESHOLDS,
      ),
    ).toBe(false); // rows above ceiling
  });
});

// ---------------------------------------------------------------------------

describe('rankDeltas', () => {
  const baseline = (entries: Record<string, PgssSampleEntry>, sampledAt = 10_000): PgssBaseline => ({
    sampledAt,
    entries: new Map(Object.entries(entries)),
  });

  it('differences two samples and ranks by exec-time delta descending', () => {
    const base = baseline({
      a: entry({ calls: 100, totalExecTimeMs: 100, rows: 100, sharedBlks: 100 }),
      b: entry({ calls: 100, totalExecTimeMs: 100, rows: 100, sharedBlks: 100 }),
    });
    const current = new Map<string, PgssSampleEntry>([
      ['a', entry({ calls: 200, totalExecTimeMs: 300, rows: 200, sharedBlks: 5_000 })],
      ['b', entry({ calls: 200, totalExecTimeMs: 900, rows: 200, sharedBlks: 200 })],
    ]);

    const { candidates } = rankDeltas(base, current, new Map(), { minCallsDelta: 10 });
    expect(candidates.map((c) => c.key)).toEqual(['b', 'a']); // 800ms before 200ms
    const a = candidates.find((c) => c.key === 'a')!;
    expect(a.callsDelta).toBe(100);
    expect(a.blocksPerCall).toBe(49); // 4900 / 100
    expect(a.rowsPerCall).toBe(1);
    expect(a.amplification).toBe(49);
  });

  // Trap 2. An entry evicted at the cap and recreated restarts its counters at zero, so
  // a naive subtraction reports its whole new lifetime as one window's work — a phantom
  // spike that sends someone chasing a statement that did nothing unusual.
  it('SKIPS an entry whose stats_since moved inside the window (phantom-spike guard)', () => {
    const base = baseline(
      { a: entry({ calls: 1_000, totalExecTimeMs: 1_000, statsSinceMs: 1_000 }) },
      10_000,
    );
    const current = new Map<string, PgssSampleEntry>([
      // Reset at t=9000, then climbed to 5,000 calls. Counters are LOWER than baseline
      // in no way that a value comparison would notice if it had climbed higher.
      ['a', entry({ calls: 5_000, totalExecTimeMs: 5_000, statsSinceMs: 9_000 })],
    ]);

    const { candidates, resetEntriesSkipped } = rankDeltas(base, current, new Map(), {
      minCallsDelta: 10,
    });
    expect(candidates).toHaveLength(0);
    expect(resetEntriesSkipped).toBe(1);
  });

  it('SKIPS an entry whose counters went backwards even if stats_since did not move', () => {
    const base = baseline({ a: entry({ calls: 1_000, sharedBlks: 5_000 }) });
    const current = new Map<string, PgssSampleEntry>([['a', entry({ calls: 10, sharedBlks: 20 })]]);
    const { candidates, resetEntriesSkipped } = rankDeltas(base, current, new Map(), {
      minCallsDelta: 1,
    });
    expect(candidates).toHaveLength(0);
    expect(resetEntriesSkipped).toBe(1);
  });

  // Regression: the guard must compare stats_since against the BASELINE'S OWN
  // stats_since (database vs database), never against the sampler's wall clock. An
  // earlier revision also dropped any entry whose stats_since was >= baseline.sampledAt,
  // which discarded every healthy entry the moment the database's clock ran ahead of the
  // operator host's — a silent false negative that reports an empty, healthy-looking run.
  it('KEEPS an entry whose stats_since is unchanged, even when it postdates the sample clock', () => {
    const base = baseline({ a: entry({ calls: 100, statsSinceMs: 5_000 }) }, /* sampledAt */ 0);
    const current = new Map<string, PgssSampleEntry>([
      ['a', entry({ calls: 1_100, sharedBlks: 2_000_000, statsSinceMs: 5_000 })],
    ]);
    const { candidates, resetEntriesSkipped } = rankDeltas(base, current, new Map(), {
      minCallsDelta: 10,
    });
    expect(resetEntriesSkipped).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].callsDelta).toBe(1_000);
  });

  it('ignores an entry with no baseline (no rate can be computed from one sample)', () => {
    const base = baseline({});
    const current = new Map<string, PgssSampleEntry>([['fresh', entry({ calls: 10_000 })]]);
    const { candidates } = rankDeltas(base, current, new Map(), { minCallsDelta: 1 });
    expect(candidates).toHaveLength(0);
  });

  it('drops candidates below minCallsDelta', () => {
    const base = baseline({ a: entry({ calls: 100 }) });
    const current = new Map<string, PgssSampleEntry>([['a', entry({ calls: 105 })]]);
    expect(rankDeltas(base, current, new Map(), { minCallsDelta: 10 }).candidates).toHaveLength(0);
    expect(rankDeltas(base, current, new Map(), { minCallsDelta: 5 }).candidates).toHaveLength(1);
  });

  it('carries the queryid out of the composite key', () => {
    const base = baseline({ '10:20:98765:true': entry({ calls: 0 }) });
    const current = new Map<string, PgssSampleEntry>([
      ['10:20:98765:true', entry({ calls: 100 })],
    ]);
    const { candidates } = rankDeltas(base, current, new Map(), { minCallsDelta: 1 });
    expect(candidates[0].queryid).toBe('98765');
  });
});

// ---------------------------------------------------------------------------

describe('collectSeqScans', () => {
  it('finds a top-level Seq Scan', () => {
    const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'work_items', 'Plan Rows': 6 } }];
    expect(collectSeqScans(plan)).toEqual([{ relation: 'work_items', planRows: 6 }]);
  });

  it('finds a Seq Scan nested under Plans (the real Gather shape)', () => {
    const plan = [
      {
        Plan: {
          'Node Type': 'Gather',
          Plans: [
            {
              'Node Type': 'Parallel Seq Scan', // NOT a match — different node type
              'Relation Name': 'ignored',
            },
            {
              'Node Type': 'Nested Loop',
              Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'harness_plans', 'Plan Rows': 1 }],
            },
          ],
        },
      },
    ];
    expect(collectSeqScans(plan)).toEqual([{ relation: 'harness_plans', planRows: 1 }]);
  });

  // A scan hidden in a CTE or subquery is exactly the composite case most likely to hide
  // one, so failing to descend here would make the detector quietly blind to it.
  it('descends into InitPlan and SubPlan members', () => {
    const plan = [
      {
        Plan: {
          'Node Type': 'Result',
          InitPlan: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'from_initplan', 'Plan Rows': 2 }],
          SubPlan: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'from_subplan', 'Plan Rows': 3 }],
        },
      },
    ];
    expect(collectSeqScans(plan).map((s) => s.relation).sort()).toEqual([
      'from_initplan',
      'from_subplan',
    ]);
  });

  it('returns nothing for an index-only plan', () => {
    const plan = [{ Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'work_items' } }];
    expect(collectSeqScans(plan)).toEqual([]);
  });

  it('tolerates malformed input rather than throwing', () => {
    expect(collectSeqScans(null)).toEqual([]);
    expect(collectSeqScans(undefined)).toEqual([]);
    expect(collectSeqScans('nonsense')).toEqual([]);
    expect(collectSeqScans({ 'Node Type': 'Seq Scan' })).toEqual([]); // no Relation Name
  });
});

// ---------------------------------------------------------------------------

describe('isExplainable', () => {
  it('accepts the statement shapes worth planning', () => {
    expect(isExplainable('SELECT * FROM t WHERE a = $1')).toBe(true);
    expect(isExplainable('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isExplainable('UPDATE t SET a = $1 WHERE b = $2')).toBe(true);
    expect(isExplainable('INSERT INTO t VALUES ($1)')).toBe(true);
    expect(isExplainable('DELETE FROM t WHERE a = $1')).toBe(true);
    expect(isExplainable('SELECT 1;')).toBe(true); // a single trailing ; is fine
  });

  it('accepts a statement behind a leading comment (this codebase tags some SQL)', () => {
    expect(isExplainable('/* fn:sweepPlans */ SELECT * FROM harness_plans')).toBe(true);
    expect(isExplainable('-- a line comment\nSELECT 1')).toBe(true);
  });

  it('rejects utility statements, which cannot be planned', () => {
    expect(isExplainable('SET application_name = $1')).toBe(false);
    expect(isExplainable('VACUUM ANALYZE t')).toBe(false);
    expect(isExplainable('CREATE INDEX CONCURRENTLY i ON t (a)')).toBe(false);
    expect(isExplainable('BEGIN')).toBe(false);
    expect(isExplainable('')).toBe(false);
  });

  // Statement text is interpolated into the EXPLAIN rather than bound, so this is the
  // guard that stops one normalized statement from becoming two.
  it('REJECTS multi-statement text so it can never be concatenated into EXPLAIN', () => {
    expect(isExplainable('SELECT 1; DROP TABLE t')).toBe(false);
    expect(isExplainable('SELECT 1; SELECT 2;')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('extractCaller', () => {
  it('recovers an identifier from a retained SQL comment', () => {
    expect(extractCaller('/* fn:sweepPlans */ SELECT 1')).toBe('fn:sweepPlans'.slice(3));
    expect(extractCaller('SELECT 1 /* potFrontierSurvey */')).toBe('potFrontierSurvey');
  });

  it('returns undefined rather than guessing when no comment is present', () => {
    // Naming the wrong module is worse than naming none: it sends the reader to a file
    // that never ran the query.
    expect(extractCaller('SELECT * FROM harness_shared.work_items WHERE a = $1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('sampleKey', () => {
  it('keys on the full pg_stat_statements identity tuple', () => {
    expect(sampleKey({ userid: 10, dbid: 20, queryid: 30, toplevel: true })).toBe('10:20:30:true');
  });

  it('distinguishes toplevel from nested entries with the same queryid', () => {
    const a = sampleKey({ userid: 10, dbid: 20, queryid: 30, toplevel: true });
    const b = sampleKey({ userid: 10, dbid: 20, queryid: 30, toplevel: false });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Database seams, against a fake `sql`.
// ---------------------------------------------------------------------------

interface FakeSqlPlan {
  installed?: boolean;
  pgss?: Record<string, unknown>[];
  relations?: { relname: string; nspname: string; bytes: string }[];
  explain?: unknown | (() => unknown);
}

/** Minimal stand-in for the `postgres` tagged-template client the module uses. */
function fakeSql(plan: FakeSqlPlan) {
  const calls = { explains: [] as string[] };
  const run = async (text: string): Promise<unknown[]> => {
    if (text.includes('pg_extension')) return [{ installed: plan.installed ?? true }];
    if (text.includes('pg_stat_statements')) return plan.pgss ?? [];
    if (text.includes('pg_total_relation_size')) return plan.relations ?? [];
    return [];
  };
  const sql = ((strings: TemplateStringsArray) => run(strings.join('?'))) as unknown as Record<
    string,
    unknown
  >;
  sql.begin = async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      unsafe: async (text: string) => {
        if (text.startsWith('EXPLAIN')) {
          calls.explains.push(text);
          const e = typeof plan.explain === 'function' ? (plan.explain as () => unknown)() : plan.explain;
          return [{ 'QUERY PLAN': e }];
        }
        return [];
      },
    };
    return cb(tx);
  };
  return { sql: sql as never, calls };
}

describe('resolveRelationSizes', () => {
  it('measures size in BYTES, never reltuples', async () => {
    const { sql } = fakeSql({
      relations: [{ relname: 'work_items', nspname: 'harness_shared', bytes: '298000000' }],
    });
    const out = await resolveRelationSizes(sql, ['work_items']);
    expect(out.get('work_items')).toEqual({
      schema: 'harness_shared',
      sizeBytes: 298_000_000,
      ambiguous: false,
    });
  });

  // Over-estimating fails loud (a spurious finding a human dismisses); under-estimating
  // fails silent, which is the defect this module exists to catch, missed again.
  it('assumes the LARGEST match for an ambiguous name and marks it ambiguous', async () => {
    const { sql } = fakeSql({
      relations: [
        { relname: 'work_items', nspname: 'scratch', bytes: '8192' },
        { relname: 'work_items', nspname: 'harness_shared', bytes: '298000000' },
      ],
    });
    const out = await resolveRelationSizes(sql, ['work_items']);
    expect(out.get('work_items')).toEqual({
      schema: 'harness_shared',
      sizeBytes: 298_000_000,
      ambiguous: true,
    });
  });

  it('short-circuits on an empty name list', async () => {
    const { sql } = fakeSql({});
    expect((await resolveRelationSizes(sql, [])).size).toBe(0);
  });
});

describe('explainGeneric', () => {
  it('uses GENERIC_PLAN and FORMAT JSON, inside a read-only transaction', async () => {
    const { sql, calls } = fakeSql({ explain: [{ Plan: { 'Node Type': 'Seq Scan' } }] });
    const out = await explainGeneric(sql, 'SELECT * FROM t WHERE a = $1', 3_000);
    expect(calls.explains[0]).toContain('GENERIC_PLAN');
    expect(calls.explains[0]).toContain('FORMAT JSON');
    expect(out).toEqual([{ Plan: { 'Node Type': 'Seq Scan' } }]);
  });

  // pgss truncates text at track_activity_query_size, so unparseable entries are
  // EXPECTED. One bad entry must never strand the rest of the run.
  it('returns null instead of throwing when the statement cannot be planned', async () => {
    const { sql } = fakeSql({
      explain: () => {
        throw new Error('syntax error at end of input');
      },
    });
    await expect(explainGeneric(sql, 'SELECT * FROM t WHERE', 3_000)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('runHotSeqScanDetectionOnce', () => {
  const pgssRow = (over: Record<string, unknown> = {}) => ({
    userid: 10,
    dbid: 20,
    queryid: 777,
    toplevel: true,
    query: 'SELECT * FROM harness_shared.work_items WHERE payload->>$1 = $2',
    calls: 1_000,
    total_exec_time: 500_000,
    rows: 1_000,
    shared_blks_hit: 14_379_000,
    shared_blks_read: 0,
    stats_since: new Date(1_000).toISOString(),
    ...over,
  });

  it('skips cleanly when the extension is absent', async () => {
    const { sql } = fakeSql({ installed: false });
    const r = await runHotSeqScanDetectionOnce(sql, { now: () => 100_000 });
    expect(r.skipped).toBe('extension-absent');
    expect(r.findings).toEqual([]);
  });

  // A rate needs two observations. Reporting anything from one sample would be the
  // lifetime-totals mistake the whole module exists to avoid.
  it('only samples on the first run, returning a baseline to carry forward', async () => {
    const { sql } = fakeSql({ pgss: [pgssRow()] });
    const r = await runHotSeqScanDetectionOnce(sql, { now: () => 100_000 });
    expect(r.skipped).toBe('no-baseline');
    expect(r.nextBaseline.entries.size).toBe(1);
    expect(r.nextBaseline.sampledAt).toBe(100_000);
  });

  // Resetting the clock every run would mean a short-cadence caller never accumulates a
  // measurable window, so the ORIGINAL baseline has to survive.
  it('KEEPS the original baseline when the window is too short', async () => {
    const original: PgssBaseline = {
      sampledAt: 99_000,
      entries: new Map([['10:20:777:true', entry({ calls: 1 })]]),
    };
    const { sql } = fakeSql({ pgss: [pgssRow()] });
    const r = await runHotSeqScanDetectionOnce(sql, {
      baseline: original,
      now: () => 100_000, // 1s window, under the 60s floor
    });
    expect(r.skipped).toBe('window-too-short');
    expect(r.nextBaseline).toBe(original);
  });

  it('reports a finding for a read-many-return-few statement seq-scanning a large table', async () => {
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([
        [
          '10:20:777:true',
          entry({ calls: 0, totalExecTimeMs: 0, rows: 0, sharedBlks: 0, statsSinceMs: 1_000 }),
        ],
      ]),
    };
    const { sql } = fakeSql({
      pgss: [pgssRow()],
      explain: [
        { Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'work_items', 'Plan Rows': 700 } },
      ],
      relations: [{ relname: 'work_items', nspname: 'harness_shared', bytes: '298000000' }],
    });

    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });

    expect(r.skipped).toBeUndefined();
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.queryid).toBe('777');
    expect(f.blocksPerCall).toBe(14_379); // the measured 718 number
    expect(f.rowsPerCall).toBe(1);
    expect(f.seqScans).toEqual([
      { relation: 'work_items', schema: 'harness_shared', sizeBytes: 298_000_000 },
    ]);
    expect(f.shareOfWindowTime).toBeCloseTo(1, 5);
  });

  it('does NOT report a seq scan on a relation below the size floor', async () => {
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([['10:20:777:true', entry()]]),
    };
    const { sql } = fakeSql({
      pgss: [pgssRow()],
      explain: [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'tiny', 'Plan Rows': 1 } }],
      relations: [
        { relname: 'tiny', nspname: 'public', bytes: String(HOT_SEQ_SCAN_MIN_RELATION_BYTES - 1) },
      ],
    });
    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });
    expect(r.findings).toEqual([]);
    expect(r.examined).toBe(1); // it WAS inspected — it just did not qualify
  });

  it('does NOT report a statement whose plan uses an index', async () => {
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([['10:20:777:true', entry()]]),
    };
    const { sql } = fakeSql({
      pgss: [pgssRow()],
      explain: [{ Plan: { 'Node Type': 'Index Scan', 'Relation Name': 'work_items' } }],
      relations: [{ relname: 'work_items', nspname: 'harness_shared', bytes: '298000000' }],
    });
    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });
    expect(r.findings).toEqual([]);
  });

  it('counts an unplannable statement without throwing or losing the run', async () => {
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([['10:20:777:true', entry()]]),
    };
    const { sql } = fakeSql({
      pgss: [pgssRow()],
      explain: () => {
        throw new Error('syntax error');
      },
    });
    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });
    expect(r.explainFailures).toBe(1);
    expect(r.findings).toEqual([]);
    expect(r.skipped).toBeUndefined();
  });

  it('skips a utility statement before it ever reaches EXPLAIN', async () => {
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([['10:20:777:true', entry()]]),
    };
    const { sql, calls } = fakeSql({ pgss: [pgssRow({ query: 'VACUUM harness_shared.work_items' })] });
    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });
    expect(r.notExplainable).toBe(1);
    expect(calls.explains).toHaveLength(0);
    expect(r.examined).toBe(0);
  });

  it('does not EXPLAIN a statement that fails the cheap arithmetic screen', async () => {
    // An indexed point lookup: high call count, trivial block usage. EXPLAINing every
    // statement would make a run cost thousands of plans instead of a couple of dozen.
    const baseline: PgssBaseline = {
      sampledAt: 0,
      entries: new Map([['10:20:777:true', entry()]]),
    };
    const { sql, calls } = fakeSql({
      pgss: [pgssRow({ shared_blks_hit: 3_000, rows: 1_000 })], // 3 blocks/call
    });
    const r = await runHotSeqScanDetectionOnce(sql, { baseline, now: () => 600_000 });
    expect(calls.explains).toHaveLength(0);
    expect(r.candidates).toBe(1);
    expect(r.examined).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('describeFinding', () => {
  it('leads with the cost and the relation', () => {
    const line = describeFinding({
      queryid: '777',
      key: '10:20:777:true',
      callsDelta: 1_000,
      totalExecTimeMsDelta: 500_000,
      rowsDelta: 1_000,
      sharedBlksDelta: 14_379_000,
      blocksPerCall: 14_379,
      rowsPerCall: 1,
      amplification: 14_379,
      shareOfWindowTime: 0.2698,
      seqScans: [{ relation: 'work_items', schema: 'harness_shared', sizeBytes: 298_000_000 }],
      queryText: 'SELECT ...',
    });
    expect(line).toContain('harness_shared.work_items (284 MB)');
    expect(line).toContain('14379 blocks/call');
    expect(line).toContain('27.0% of window exec time');
  });
});
