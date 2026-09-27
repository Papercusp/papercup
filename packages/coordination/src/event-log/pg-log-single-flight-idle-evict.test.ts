/**
 * pg-log-single-flight-idle-evict.test.ts — host-memory-reduction-2026-09-27 P-005 (D-010/D-011).
 *
 * THE DEFECT THIS PINS: `readLines`/`readEvents` cache EVERY envelope of a
 * (workspace, surface) per process. Measured 2026-09-27: one full read of
 * `messages` (536k rows) retained ~2 GB of V8 heap in papercusp-bg-host, and it
 * stayed resident for the process lifetime even after the reader that primed it
 * went quiet. Two properties bound that:
 *
 *   - SINGLE-FLIGHT: callers that arrive while a cold read is in flight await
 *     that read instead of each issuing their own. Without it, N concurrent
 *     cold callers each page the whole surface into Node at once.
 *   - IDLE EVICTION: an entry nobody reads for PAPERCUSP_COORD_LOG_CACHE_IDLE_MS
 *     is dropped. A reader that keeps reading keeps it warm, so the WI-3937
 *     furnace protection is unchanged for real hot readers.
 *
 * Both defects are invisible to a return-value assertion: the pre-fix code
 * returns the same envelopes. So, like pg-log-cheap-refresh-check.test.ts,
 * every case asserts on the recorded SQL call log (kind + count).
 *
 * Run: cd packages/coordination && npx vitest run src/event-log/pg-log-single-flight-idle-evict.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { PgCoordLog } from './pg-log';

interface Row {
  id: string;
  body: string;
  ts: Date;
  msg_id: string;
}

function makeRow(id: number, msgId: string): Row {
  return {
    id: String(id),
    body: JSON.stringify({ kind: 'message', ts: new Date(0).toISOString(), msg_id: msgId }),
    ts: new Date(0),
    msg_id: msgId,
  };
}

type CallKind = 'full-select' | 'delta-select' | 'other';

/**
 * A postgres-js stand-in that classifies each call by its SQL text and records
 * it. A FULL select (the first keyset page: no `id > ?`) resolves only when
 * `releaseFull()` is called, so a test can hold a cold read in flight while a
 * second caller arrives.
 */
function makeGatedFakeSql(rows: Row[]) {
  const calls: CallKind[] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    const kind: CallKind = !text.includes('ORDER BY id ASC')
      ? 'other'
      : text.includes('id > ?')
        ? 'delta-select'
        : 'full-select';
    calls.push(kind);
    const result = kind === 'full-select' ? gate.then(() => rows) : Promise.resolve([]);
    return { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result.then(res, rej) };
  };
  return {
    sql: tag as unknown as Sql,
    calls,
    count: (kind: CallKind) => calls.filter((c) => c === kind).length,
    releaseFull: () => release(),
    /** Re-arm the gate so the NEXT full select is held again. */
    regate: () => {
      gate = new Promise<void>((r) => (release = r));
    },
  };
}

function makeLog(sql: Sql): PgCoordLog {
  return new PgCoordLog({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: 'ws-test' });
}

const IDLE_MS = 1_000;

beforeEach(() => {
  process.env.PAPERCUSP_COORD_LOG_CACHE_IDLE_MS = String(IDLE_MS);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PAPERCUSP_COORD_LOG_CACHE_IDLE_MS;
});

describe('PgCoordLog cold reads are single-flight (P-005 / D-011)', () => {
  it('readLines: two concurrent cold callers issue ONE full read and both get the rows', async () => {
    const fake = makeGatedFakeSql([makeRow(1, 'm1'), makeRow(2, 'm2')]);
    const log = makeLog(fake.sql);

    const a = log.readLines('messages');
    const b = log.readLines('messages');
    // Let both callers get past ensureSchema and reach the cold-read branch
    // while the first full read is still held.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fake.count('full-select')).toBe(1);

    fake.releaseFull();
    const [outA, outB] = await Promise.all([a, b]);

    expect(fake.count('full-select')).toBe(1);
    expect(outA.map((e) => e.msg_id)).toEqual(['m1', 'm2']);
    expect(outB.map((e) => e.msg_id)).toEqual(['m1', 'm2']);
    // Each caller still gets its own array (the fresh-copy contract).
    expect(outA).not.toBe(outB);
  });

  it('control: with the cache kill switch (no single-flight) the same two callers issue TWO full reads', async () => {
    // Proves the instrument above can SEE a second read: without this, a
    // harness that serialised or swallowed calls would pass the case above vacuously.
    process.env.PAPERCUSP_COORD_READLINES_CACHE = '0';
    try {
      const fake = makeGatedFakeSql([makeRow(1, 'm1')]);
      const log = makeLog(fake.sql);
      const both = Promise.all([log.readLines('messages'), log.readLines('messages')]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      fake.releaseFull();
      await both;
      expect(fake.count('full-select')).toBe(2);
    } finally {
      delete process.env.PAPERCUSP_COORD_READLINES_CACHE;
    }
  });

  it('readEvents: two concurrent cold callers issue ONE full read', async () => {
    const fake = makeGatedFakeSql([makeRow(1, 'e1')]);
    const log = makeLog(fake.sql);

    const a = log.readEvents('escalations');
    const b = log.readEvents('escalations');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    fake.releaseFull();
    const [outA, outB] = await Promise.all([a, b]);

    expect(fake.count('full-select')).toBe(1);
    expect(outA.map((e) => e.msg_id)).toEqual(['e1']);
    expect(outB.map((e) => e.msg_id)).toEqual(['e1']);
  });

  it('a failed cold read rejects every waiter and is not cached — the next call retries', async () => {
    const calls: CallKind[] = [];
    let fail = true;
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      const kind: CallKind = text.includes('id > ?') ? 'delta-select' : 'full-select';
      calls.push(kind);
      const result = fail ? Promise.reject(new Error('connection terminated')) : Promise.resolve([makeRow(1, 'm1')]);
      return { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result.then(res, rej) };
    };
    const log = makeLog(tag as unknown as Sql);

    const results = await Promise.allSettled([log.readLines('messages'), log.readLines('messages')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls.filter((c) => c === 'full-select')).toHaveLength(1);

    fail = false;
    const out = await log.readLines('messages');
    expect(out.map((e) => e.msg_id)).toEqual(['m1']);
    expect(calls.filter((c) => c === 'full-select')).toHaveLength(2);
  });
});

describe('PgCoordLog drops a cache entry nobody reads (P-005 / D-011)', () => {
  it('readLines: an entry idle past PAPERCUSP_COORD_LOG_CACHE_IDLE_MS is evicted, so the next call re-reads in full', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fake = makeGatedFakeSql([makeRow(1, 'm1')]);
    fake.releaseFull();
    const log = makeLog(fake.sql);

    await log.readLines('messages');
    expect(fake.count('full-select')).toBe(1);

    vi.advanceTimersByTime(IDLE_MS + 1);
    await log.readLines('messages');

    // Evicted: a second full read, not a delta off a retained snapshot.
    expect(fake.count('full-select')).toBe(2);
    expect(fake.count('delta-select')).toBe(0);
  });

  it('readLines: a reader that keeps reading keeps its entry warm (control — the eviction is idle-only)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fake = makeGatedFakeSql([makeRow(1, 'm1')]);
    fake.releaseFull();
    const log = makeLog(fake.sql);

    await log.readLines('messages');
    // Read every 0.6 × IDLE_MS for 3 × IDLE_MS in total: never idle for a whole window.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(IDLE_MS * 0.6);
      await log.readLines('messages');
    }

    expect(fake.count('full-select')).toBe(1);
    expect(fake.count('delta-select')).toBe(5);
  });

  it('readEvents: an idle entry is evicted too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fake = makeGatedFakeSql([makeRow(1, 'e1')]);
    fake.releaseFull();
    const log = makeLog(fake.sql);

    await log.readEvents('escalations');
    vi.advanceTimersByTime(IDLE_MS + 1);
    await log.readEvents('escalations');

    expect(fake.count('full-select')).toBe(2);
  });
});
