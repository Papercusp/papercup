/**
 * pg-log-cheap-refresh-check.test.ts — EI-21918895581219651.
 *
 * THE DEFECT THIS PINS: `readLines`/`readEvents` cache a full per-(workspace,
 * surface) snapshot and re-fetch it on a TTL (`READLINES_CACHE_FULL_REFRESH_MS`
 * / `READEVENTS_CACHE_FULL_REFRESH_MS`, 5 min) so rare GC deletions eventually
 * fold out. That TTL branch used to run the FULL unbounded body-fetch
 * (`SELECT id, body, ts, msg_id ... ORDER BY id ASC`, no LIMIT) UNCONDITIONALLY
 * every time it fired — even though the GC that motivates it
 * (`message-log-gc` / `escalation-log-gc`) runs once a day. Measured live on
 * 2026-08-30: this exact query, on the `messages` surface, was a 389,455-row /
 * ~277MB parallel-seq-scan-and-sort taking 8.6s-32.9s, recurring roughly every
 * 5-10 minutes on a persistent process, growing forever with the log.
 *
 * THE FIX: on TTL expiry, first run a CHEAP indexed `SELECT count(*)` against
 * `coord_event_log_surface_id (workspace_id, surface, id)`. Appends (and, for
 * event surfaces, upserts) never lower the live count below what the cache
 * already holds — the delta leg folds those in on every call regardless of
 * this TTL — so a live count at or above the cached size means NOTHING was
 * deleted, and the full body-fetch is skipped entirely (only the TTL clock is
 * re-armed). A live count BELOW the cached size is the one signal a real
 * deletion happened, and only then does the full rebuild still run — so GC
 * deletions still fold out, just without paying for the common (no-deletion)
 * case every single tick.
 *
 * WHY A CALL-COUNT ASSERTION IS THE RIGHT GUARD HERE. The defect is invisible
 * to a return-value assertion alone — the WRONG (pre-fix) code returns exactly
 * the same envelopes as the fixed code; the only observable difference is HOW
 * MANY TIMES, and via WHICH query shape, the DB was asked. So every case below
 * asserts on the recorded call log (kind + count), not just on the returned
 * rows — a fix that silently regressed back to "always full-read on TTL
 * expiry" would still pass every rows-only assertion.
 *
 * Run: cd packages/coordination && npx vitest run src/event-log/pg-log-cheap-refresh-check.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { COORD_LOG_READ_PAGE_SIZE, PgCoordLog } from './pg-log';

/** One row as it would come back from postgres-js for the FULL/delta readers:
 *  int8 `id` arrives as a STRING under default postgres-js. */
interface FullReadRow {
  id: string;
  body: string;
  ts: Date;
  msg_id: string;
}

function makeRow(id: number, msgId: string, extra: Record<string, unknown> = {}): FullReadRow {
  return {
    id: String(id),
    body: JSON.stringify({ kind: 'message', ts: new Date(0).toISOString(), msg_id: msgId, ...extra }),
    ts: new Date(0),
    msg_id: msgId,
  };
}

type CallKind = 'count' | 'full-select' | 'delta-select' | 'other';

interface RecordedCall {
  kind: CallKind;
  text: string;
}

/**
 * A postgres-js stand-in that ROUTES each tagged-template call to one of three
 * scripted row sets by inspecting the assembled SQL text — unlike the shared
 * `makeFakeSql` pattern (pg-log-kind-predicate.test.ts), which always returns
 * the SAME rows for every call. This suite needs different call kinds to
 * return DIFFERENT shapes (a `count(*)` aggregate vs. full envelope rows), and
 * needs the FULL call history (not just the last call) to assert call counts.
 */
function makeRoutedFakeSql(script: {
  count: () => { n: number }[];
  fullSelect: () => FullReadRow[];
  deltaSelect: () => FullReadRow[];
}): { sql: Sql; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    // Every call site in pg-log.ts uses a flat template (no nested `sql`...``
    // fragments) for the three query shapes this suite touches, so the plain
    // joined text is enough to classify the call — no fragment splicing needed.
    const text = strings.join('?');
    let kind: CallKind;
    let rows: unknown[];
    if (text.includes('count(*)::int AS n')) {
      kind = 'count';
      rows = script.count();
    } else if (text.includes('ORDER BY id ASC') && !text.includes('id > ?')) {
      kind = 'full-select';
      rows = script.fullSelect();
    } else if (text.includes('id > ?')) {
      kind = 'delta-select';
      rows = script.deltaSelect();
    } else {
      kind = 'other';
      rows = [];
    }
    if (kind === 'full-select' && text.includes('LIMIT ?')) {
      rows = rows.slice(0, COORD_LOG_READ_PAGE_SIZE);
    }
    calls.push({ kind, text });
    return {
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
  };
  return { sql: tag as unknown as Sql, calls };
}

function countCalls(calls: RecordedCall[], kind: CallKind): number {
  return calls.filter((c) => c.kind === kind).length;
}

function makeLog(sql: Sql): PgCoordLog {
  return new PgCoordLog({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: 'ws-test' });
}

const TTL_ENV_MS = 1; // both TTL env overrides accept any positive finite value

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS = String(TTL_ENV_MS);
  process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS = String(TTL_ENV_MS);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS;
  delete process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS;
  delete process.env.PAPERCUSP_COORD_READLINES_CACHE;
  delete process.env.PAPERCUSP_COORD_READEVENTS_CACHE;
});

describe('PgCoordLog TTL re-check is a cheap COUNT, not an unconditional full re-read (EI-21918895581219651)', () => {
  describe('readLines (LINE surface, e.g. messages)', () => {
    it('the first call for a key always pays for exactly one full read — there is no cache to check yet', async () => {
      const fullRows = [makeRow(1, 'm1'), makeRow(2, 'm2')];
      const { sql, calls } = makeRoutedFakeSql({
        count: () => {
          throw new Error('a COUNT must never run before any cache entry exists');
        },
        fullSelect: () => fullRows,
        deltaSelect: () => [],
      });

      const out = await makeLog(sql).readLines('messages');

      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(countCalls(calls, 'count')).toBe(0);
      expect(out.map((e) => e.msg_id)).toEqual(['m1', 'm2']);
    });

    it('a TTL-expired re-check with an UNCHANGED live count skips the full body-fetch entirely — only a COUNT + the ordinary delta are issued', async () => {
      const fullRows = [makeRow(1, 'm1'), makeRow(2, 'm2')];
      let liveCount = fullRows.length;
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [{ n: liveCount }],
        fullSelect: () => fullRows,
        deltaSelect: () => [], // nothing new since the watermark
      });
      const log = makeLog(sql);

      await log.readLines('messages'); // primes the cache (1 full-select)
      calls.length = 0; // isolate what the SECOND call (the TTL-expired one) does

      vi.advanceTimersByTime(TTL_ENV_MS + 1); // force the TTL branch to fire
      const out = await log.readLines('messages');

      // THE ASSERTION THE PRE-FIX CODE FAILS: the TTL branch must NOT re-run
      // the full O(surface) body fetch when nothing was deleted.
      expect(countCalls(calls, 'full-select')).toBe(0);
      expect(countCalls(calls, 'count')).toBe(1);
      expect(countCalls(calls, 'delta-select')).toBe(1);
      // and the cached rows are still served correctly.
      expect(out.map((e) => e.msg_id)).toEqual(['m1', 'm2']);
    });

    it('a TTL-expired re-check with a DECREASED live count (a GC deletion) still pays for the full rebuild — deletions keep folding out', async () => {
      const fullRowsBefore = [makeRow(1, 'm1'), makeRow(2, 'm2'), makeRow(3, 'm3')];
      const fullRowsAfterGc = [makeRow(2, 'm2'), makeRow(3, 'm3')]; // m1's thread aged out
      let liveCount = fullRowsBefore.length;
      let full = fullRowsBefore;
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [{ n: liveCount }],
        fullSelect: () => full,
        deltaSelect: () => [],
      });
      const log = makeLog(sql);

      await log.readLines('messages'); // primes the cache with 3 rows
      calls.length = 0;

      // Simulate message-log-gc having deleted m1's thread between reads.
      liveCount = fullRowsAfterGc.length;
      full = fullRowsAfterGc;

      vi.advanceTimersByTime(TTL_ENV_MS + 1);
      const out = await log.readLines('messages');

      expect(countCalls(calls, 'count')).toBe(1);
      // The deletion WAS detected — the full rebuild must still run so the
      // GC'd row actually leaves the cache (not just the DB).
      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(out.map((e) => e.msg_id)).toEqual(['m2', 'm3']);
    });

    it('a TTL-expired re-check that skips the full body-fetch still folds in rows APPENDED since the last read, via the ordinary delta leg', async () => {
      const fullRows = [makeRow(1, 'm1')];
      let liveCount = fullRows.length;
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [{ n: liveCount }],
        fullSelect: () => fullRows,
        deltaSelect: () => [makeRow(2, 'm2')], // a NEW row appended since the watermark
      });
      const log = makeLog(sql);

      await log.readLines('messages');
      calls.length = 0;

      // A real append also grows the live count — appends never make it drop.
      liveCount = 2;

      vi.advanceTimersByTime(TTL_ENV_MS + 1);
      const out = await log.readLines('messages');

      expect(countCalls(calls, 'full-select')).toBe(0); // still skipped — no deletion
      expect(countCalls(calls, 'count')).toBe(1);
      expect(countCalls(calls, 'delta-select')).toBe(1);
      // The new row is NOT silently dropped by skipping the full fetch.
      expect(out.map((e) => e.msg_id)).toEqual(['m1', 'm2']);
    });

    it('the kill switch (PAPERCUSP_COORD_READLINES_CACHE=0) is untouched — it still runs the always-full read with no COUNT involved', async () => {
      process.env.PAPERCUSP_COORD_READLINES_CACHE = '0';
      const fullRows = [makeRow(1, 'm1')];
      const { sql, calls } = makeRoutedFakeSql({
        count: () => {
          throw new Error('the kill-switch path must never issue a COUNT');
        },
        fullSelect: () => fullRows,
        deltaSelect: () => [],
      });

      const out = await makeLog(sql).readLines('messages');

      expect(countCalls(calls, 'count')).toBe(0);
      expect(out.map((e) => e.msg_id)).toEqual(['m1']);
    });

    it('bounds a cache prime/rebuild with keyset pages while preserving the complete stream', async () => {
      const firstPage = Array.from({ length: COORD_LOG_READ_PAGE_SIZE }, (_, i) => makeRow(i + 1, `m${i + 1}`));
      const next = makeRow(COORD_LOG_READ_PAGE_SIZE + 1, `m${COORD_LOG_READ_PAGE_SIZE + 1}`);
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [],
        fullSelect: () => [...firstPage, next],
        deltaSelect: () => [next],
      });

      const out = await makeLog(sql).readLines('messages');

      expect(out).toHaveLength(COORD_LOG_READ_PAGE_SIZE + 1);
      expect(out.at(-1)?.msg_id).toBe(next.msg_id);
      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(countCalls(calls, 'delta-select')).toBe(1);
      expect(
        calls
          .filter((call) => call.kind === 'full-select' || call.kind === 'delta-select')
          .every((call) => call.text.includes('LIMIT ?')),
      ).toBe(true);
    });
  });

  describe('readEvents (EVENT surface, e.g. escalations)', () => {
    it('the first call for a key always pays for exactly one full read — there is no cache to check yet', async () => {
      const fullRows = [makeRow(1, 'e1'), makeRow(2, 'e2')];
      const { sql, calls } = makeRoutedFakeSql({
        count: () => {
          throw new Error('a COUNT must never run before any cache entry exists');
        },
        fullSelect: () => fullRows,
        deltaSelect: () => [],
      });

      const out = await makeLog(sql).readEvents('escalations');

      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(countCalls(calls, 'count')).toBe(0);
      expect(out.map((e) => e.msg_id)).toEqual(['e1', 'e2']);
    });

    it('a TTL-expired re-check with an UNCHANGED live count skips the full body-fetch entirely — only a COUNT + the ordinary delta are issued', async () => {
      const fullRows = [makeRow(1, 'e1'), makeRow(2, 'e2')];
      let liveCount = fullRows.length;
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [{ n: liveCount }],
        fullSelect: () => fullRows,
        deltaSelect: () => [],
      });
      const log = makeLog(sql);

      await log.readEvents('escalations');
      calls.length = 0;

      vi.advanceTimersByTime(TTL_ENV_MS + 1);
      const out = await log.readEvents('escalations');

      expect(countCalls(calls, 'full-select')).toBe(0);
      expect(countCalls(calls, 'count')).toBe(1);
      expect(countCalls(calls, 'delta-select')).toBe(1);
      expect(out.map((e) => e.msg_id)).toEqual(['e1', 'e2']);
    });

    it('a TTL-expired re-check with a DECREASED live count (an escalation-log-gc deletion) still pays for the full rebuild', async () => {
      const fullRowsBefore = [makeRow(1, 'e1'), makeRow(2, 'e2')];
      const fullRowsAfterGc = [makeRow(2, 'e2')];
      let liveCount = fullRowsBefore.length;
      let full = fullRowsBefore;
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [{ n: liveCount }],
        fullSelect: () => full,
        deltaSelect: () => [],
      });
      const log = makeLog(sql);

      await log.readEvents('escalations');
      calls.length = 0;

      liveCount = fullRowsAfterGc.length;
      full = fullRowsAfterGc;

      vi.advanceTimersByTime(TTL_ENV_MS + 1);
      const out = await log.readEvents('escalations');

      expect(countCalls(calls, 'count')).toBe(1);
      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(out.map((e) => e.msg_id)).toEqual(['e2']);
    });

    it('the kill switch (PAPERCUSP_COORD_READEVENTS_CACHE=0) is untouched — it still runs the always-full read with no COUNT involved', async () => {
      process.env.PAPERCUSP_COORD_READEVENTS_CACHE = '0';
      const fullRows = [makeRow(1, 'e1')];
      const { sql, calls } = makeRoutedFakeSql({
        count: () => {
          throw new Error('the kill-switch path must never issue a COUNT');
        },
        fullSelect: () => fullRows,
        deltaSelect: () => [],
      });

      const out = await makeLog(sql).readEvents('escalations');

      expect(countCalls(calls, 'count')).toBe(0);
      expect(out.map((e) => e.msg_id)).toEqual(['e1']);
    });

    it('bounds an event-surface cache prime/rebuild with keyset pages while preserving the complete stream', async () => {
      const firstPage = Array.from({ length: COORD_LOG_READ_PAGE_SIZE }, (_, i) => makeRow(i + 1, `e${i + 1}`));
      const next = makeRow(COORD_LOG_READ_PAGE_SIZE + 1, `e${COORD_LOG_READ_PAGE_SIZE + 1}`);
      const { sql, calls } = makeRoutedFakeSql({
        count: () => [],
        fullSelect: () => [...firstPage, next],
        deltaSelect: () => [next],
      });

      const out = await makeLog(sql).readEvents('escalations');

      expect(out).toHaveLength(COORD_LOG_READ_PAGE_SIZE + 1);
      expect(out.at(-1)?.msg_id).toBe(next.msg_id);
      expect(countCalls(calls, 'full-select')).toBe(1);
      expect(countCalls(calls, 'delta-select')).toBe(1);
      expect(
        calls
          .filter((call) => call.kind === 'full-select' || call.kind === 'delta-select')
          .every((call) => call.text.includes('LIMIT ?')),
      ).toBe(true);
    });
  });
});
