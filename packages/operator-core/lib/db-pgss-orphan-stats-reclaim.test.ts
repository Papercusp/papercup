/**
 * Unit tests for the pg_stat_statements orphan-entry reclaim sweep
 * (db-performance-remediation-2026-07-26 D-033 / P-020, WI-9313).
 *
 * The sweep is guard-heavy by design — it calls pg_stat_statements_reset() against the
 * live shared database — so these tests pin the GUARDS and the failure isolation rather
 * than the SQL text.
 *
 * The load-bearing test in this file is `never passes dbid = 0`. To
 * `pg_stat_statements_reset(userid, dbid, queryid, minmax_only)` a ZERO means "match
 * ALL", so `reset(0, 0, 0, false)` discards the ENTIRE statistics table. A sweep that
 * looped over its candidates without re-checking would therefore wipe every measurement
 * on the box the moment one row carried dbid = 0 — and it would look like a SUCCESSFUL
 * sweep in the log, which is what makes it worth a dedicated discrimination test rather
 * than a comment. That test feeds a dbid = 0 row straight into the candidate list
 * (simulating a future edit that drops the `WHERE dbid <> 0` from the query) and asserts
 * the in-loop guard still refuses it.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { reclaimOrphanPgssStatsOnce } from './db-pgss-orphan-stats-reclaim';

interface FakeCall {
  text: string;
  values: unknown[];
}

interface FakeOpts {
  extensionInstalled?: boolean;
  canReset?: boolean;
  entriesBefore?: number;
  entriesAfter?: number;
  capMax?: number;
  orphans?: Array<{ dbid: string; entries: string }>;
  /** dbids whose reset should throw. */
  failOn?: number[];
  /** dbids that turn out to STILL exist at reset time (the TOCTOU re-check). */
  stillExists?: number[];
}

/**
 * Minimal stand-in for the postgres.js tagged-template driver. Dispatches on distinctive
 * text so the tests do not depend on exact formatting. Most specific match first — the
 * reset statement also contains `pg_stat_statements`, so it must be tested before the
 * count/candidate branches.
 */
function makeFakeSql(opts: FakeOpts = {}) {
  const calls: FakeCall[] = [];
  const resetDbids: number[] = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });

    // ORDER MATTERS. The PRIVILEGE probe passes the function's name as a string literal
    // — `has_function_privilege(…, 'pg_stat_statements_reset(oid,…)', 'EXECUTE')` — so a
    // branch matching on `pg_stat_statements_reset` swallows it and the sweep looks like
    // it issued a reset it never issued. Match on each statement's unique output alias
    // instead of on the function name.
    if (text.includes('AS can_reset')) {
      return Promise.resolve([{ can_reset: opts.canReset ?? true }]);
    }
    if (text.includes('AS installed')) {
      return Promise.resolve([{ installed: opts.extensionInstalled ?? true }]);
    }
    if (text.includes('AS reset')) {
      const dbid = Number(values[0]);
      resetDbids.push(dbid);
      if (opts.failOn?.includes(dbid)) {
        return Promise.reject(new Error(`permission denied for function (dbid ${dbid})`));
      }
      // The statement's own `WHERE NOT EXISTS (… pg_database …)` yields NO row when the
      // database turns out to still exist, so nothing was reset.
      if (opts.stillExists?.includes(dbid)) return Promise.resolve([]);
      return Promise.resolve([{ reset: true }]);
    }
    if (text.includes('cap_max')) {
      return Promise.resolve([
        { entries: String(opts.entriesBefore ?? 9791), cap_max: String(opts.capMax ?? 10000) },
      ]);
    }
    if (text.includes('GROUP BY s.dbid')) {
      return Promise.resolve(opts.orphans ?? []);
    }
    // Fallback: the trailing after-count.
    return Promise.resolve([{ entries: String(opts.entriesAfter ?? 6488) }]);
  }) as unknown as postgres.Sql;

  return { sql, calls, resetDbids };
}

const orphans = (...rows: Array<[number, number]>) =>
  rows.map(([dbid, entries]) => ({ dbid: String(dbid), entries: String(entries) }));

describe('reclaimOrphanPgssStatsOnce', () => {
  describe('guards that must abort before any reset', () => {
    it('skips when pg_stat_statements is not installed', async () => {
      const { sql, resetDbids } = makeFakeSql({ extensionInstalled: false });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.skipped).toBe('extension-absent');
      expect(resetDbids).toEqual([]);
    });

    it('skips with a NAMED reason when the role lacks EXECUTE, rather than throwing', async () => {
      // harness_admin holds only pg_read_all_stats until migration 756 grants EXECUTE.
      // An inert sweep must say WHY: silence here is indistinguishable from a working
      // sweep that found nothing.
      const { sql, resetDbids } = makeFakeSql({
        canReset: false,
        orphans: orphans([16006737, 862]),
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.skipped).toBe('no-privilege');
      expect(resetDbids).toEqual([]);
    });

    it('reports no-orphans without resetting anything', async () => {
      const { sql, resetDbids } = makeFakeSql({ orphans: [] });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.skipped).toBe('no-orphans');
      expect(resetDbids).toEqual([]);
      expect(r.entriesReclaimed).toBe(0);
    });
  });

  describe('the dbid = 0 footgun', () => {
    it('NEVER passes dbid = 0 to pg_stat_statements_reset, even if a candidate row carries it', async () => {
      // Simulates a future edit dropping `WHERE s.dbid <> 0` from the candidate query.
      // reset(0, 0, 0, false) means "reset ALL databases" and would discard every
      // statistic on the box while logging a successful sweep.
      const { sql, resetDbids } = makeFakeSql({
        orphans: orphans([0, 5000], [16006737, 862], [15133518, 845]),
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);

      expect(resetDbids).not.toContain(0);
      // ...and the legitimate orphans are still swept, so the guard is narrow and not
      // just aborting the whole run.
      expect(resetDbids).toEqual([16006737, 15133518]);
      expect(r.reclaimed.map((x) => x.dbid)).toEqual([16006737, 15133518]);
      expect(r.entriesReclaimed).toBe(862 + 845);
    });

    it('calibration: the fake driver DOES record a dbid the sweep chooses to pass', async () => {
      // Without this, the assertion above would also pass if the fake never recorded
      // anything — i.e. if the test could not observe a reset at all.
      const { sql, resetDbids } = makeFakeSql({ orphans: orphans([16006737, 862]) });
      await reclaimOrphanPgssStatsOnce(sql);
      expect(resetDbids).toEqual([16006737]);
    });
  });

  describe('sweeping', () => {
    it('resets each orphaned dbid and totals the entries reclaimed', async () => {
      const { sql, resetDbids } = makeFakeSql({
        orphans: orphans([16006737, 862], [15133518, 845], [15841501, 531]),
        entriesBefore: 9791,
        entriesAfter: 7553,
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);

      expect(r.skipped).toBeUndefined();
      expect(resetDbids).toEqual([16006737, 15133518, 15841501]);
      expect(r.entriesReclaimed).toBe(862 + 845 + 531);
      expect(r.entriesBefore).toBe(9791);
      expect(r.entriesAfter).toBe(7553);
      expect(r.capMax).toBe(10000);
    });

    it('does not count a dbid whose database exists again at reset time', async () => {
      // The re-check lives in the same statement as the reset, so a database created
      // between the scan and the call keeps its live statistics.
      const { sql } = makeFakeSql({
        orphans: orphans([16006737, 862], [15133518, 845]),
        stillExists: [15133518],
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.reclaimed.map((x) => x.dbid)).toEqual([16006737]);
      expect(r.entriesReclaimed).toBe(862);
    });

    it('one failing reset never strands the rest', async () => {
      const { sql } = makeFakeSql({
        orphans: orphans([16006737, 862], [15133518, 845], [15841501, 531]),
        failOn: [15133518],
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);

      expect(r.reclaimed).toHaveLength(3);
      const failed = r.reclaimed.find((x) => x.dbid === 15133518);
      expect(failed?.error).toMatch(/permission denied/);
      // The failed one is excluded from the reclaimed total, the others are not.
      expect(r.entriesReclaimed).toBe(862 + 531);
    });

    it('dryRun issues no reset at all but still reports the candidates', async () => {
      const { sql, resetDbids } = makeFakeSql({
        orphans: orphans([16006737, 862], [15133518, 845]),
      });
      const r = await reclaimOrphanPgssStatsOnce(sql, { dryRun: true });

      expect(resetDbids).toEqual([]);
      expect(r.reclaimed.map((x) => x.dbid)).toEqual([16006737, 15133518]);
      expect(r.entriesAfter).toBe(r.entriesBefore);
    });

    it('honours maxDbidsPerRun and reports truncation', async () => {
      const { sql, resetDbids } = makeFakeSql({
        orphans: orphans([1, 10], [2, 9], [3, 8], [4, 7]),
      });
      const r = await reclaimOrphanPgssStatsOnce(sql, { maxDbidsPerRun: 2 });
      expect(resetDbids).toEqual([1, 2]);
      expect(r.truncated).toBe(true);
    });
  });

  describe('cap pressure reporting', () => {
    it('flags capStillPressured when the sweep did not relieve the cap', async () => {
      // The sweep must not MASK a genuinely undersized cap by partially relieving it —
      // pg_stat_statements.max is postmaster-context, so raising it is the other lever
      // and someone has to be told it is still needed.
      const { sql } = makeFakeSql({
        orphans: orphans([16006737, 100]),
        entriesBefore: 9900,
        entriesAfter: 9800,
        capMax: 10000,
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.capStillPressured).toBe(true);
    });

    it('does not flag pressure once the sweep brings occupancy down', async () => {
      const { sql } = makeFakeSql({
        orphans: orphans([16006737, 3303]),
        entriesBefore: 9791,
        entriesAfter: 6488,
        capMax: 10000,
      });
      const r = await reclaimOrphanPgssStatsOnce(sql);
      expect(r.capStillPressured).toBe(false);
    });
  });
});
