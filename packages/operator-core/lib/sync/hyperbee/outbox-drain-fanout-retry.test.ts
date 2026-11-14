/**
 * outbox-drain-fanout-retry.test.ts — shared-reference-system-2026-11-13 P-003
 * (closes EI-28590608042464896).
 *
 * Before P-003 the drain caught a failed/timed-out fan-out, logged it and stamped
 * drained_at unconditionally, so the subscriber notification was lost for good while
 * the row looked delivered. These tests pin the repaired contract:
 *   - a failed fan-out still drains the row (federation progresses) but the SAME
 *     mark-drained UPDATE persists a pending fan-out retry;
 *   - a pre-1632 outbox (42703) falls back to the plain stamp instead of stalling;
 *   - retryPendingFanouts re-runs due fan-outs independently of federation, clears on
 *     success, backs off on failure and gives up loudly at the attempt cap;
 *   - GC never deletes a row whose fan-out retry is pending.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drainOutboxOnce,
  retryPendingFanouts,
  fanoutRetryDelayMs,
  FANOUT_MAX_ATTEMPTS,
  FANOUT_RETRY_BASE_MS,
  FANOUT_RETRY_MAX_DELAY_MS,
} from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

interface Call {
  sql: string;
  values: unknown[];
}

type Result = unknown[] & { count?: number };

function empty(): Result {
  const r = [] as Result;
  r.count = 0;
  return r;
}

/** Recording postgres.Sql fake. `undrained` is served once to the drain's batch
 *  SELECT; `due` once to the retry sweep's SELECT; `failOn` makes a matching
 *  statement throw (used to simulate a pre-1632 outbox). */
function fakePg(opts: { undrained?: unknown[]; due?: unknown[]; failOn?: (sql: string) => Error | null } = {}) {
  const calls: Call[] = [];
  let servedUndrained = false;
  let servedDue = false;
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ');
    calls.push({ sql, values });
    const err = opts.failOn?.(sql);
    if (err) throw err;
    if (/SELECT id, table_name/.test(sql)) {
      if (servedUndrained) return empty();
      servedUndrained = true;
      return (opts.undrained ?? []) as Result;
    }
    if (/fanout_retry_at <=/.test(sql)) {
      if (servedDue) return empty();
      servedDue = true;
      return (opts.due ?? []) as Result;
    }
    return empty();
  };
  return { pg: tag as unknown as Parameters<typeof drainOutboxOnce>[1], calls };
}

function fakeHandle(): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append: async () => {},
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

/** `harness_features_consolidated` is a MAPPED outbox table. An unmapped one (e.g.
 *  `work_items`) is skipped by outboxRowToLocalWriteOp as forward-compat, so the drain
 *  would never reach fan-out and every assertion below would read 0 drained rows. */
function outboxRow(id: number, key: string) {
  return { id, table_name: 'harness_features_consolidated', op: 'put' as const, key, row: { id: key }, ts: id, op_hlc: null };
}

function pgError(code: string, message: string): Error {
  const e = new Error(message);
  (e as unknown as { code: string }).code = code;
  return e;
}

const NOW = 1_800_000_000_000;

const markDrainedCalls = (calls: Call[]) => calls.filter((c) => /SET drained_at/.test(c.sql));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P-003 drain: a failed fan-out is not marked delivered', () => {
  it('drains the row and persists a pending retry in the SAME mark-drained UPDATE', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pg, calls } = fakePg({ undrained: [outboxRow(1, 'wi-1')] });
    const fanout = vi.fn(async () => {
      throw new Error('subscriber insert failed');
    });

    const drained = await drainOutboxOnce(fakeHandle(), pg, { fanout, now: NOW });

    expect(drained).toBe(1); // federation still progresses
    const marks = markDrainedCalls(calls);
    expect(marks).toHaveLength(1);
    expect(marks[0].sql).toContain('fanout_retry_at');
    expect(marks[0].sql).toContain('fanout_attempts = fanout_attempts + 1');
    expect(marks[0].values).toContain(NOW + FANOUT_RETRY_BASE_MS);
    expect(marks[0].values).toContain('subscriber insert failed');
  });

  it('a successful fan-out writes the plain drained stamp with no retry state', async () => {
    const { pg, calls } = fakePg({ undrained: [outboxRow(1, 'wi-1')] });
    const fanout = vi.fn(async () => undefined);

    await drainOutboxOnce(fakeHandle(), pg, { fanout, now: NOW });

    const marks = markDrainedCalls(calls);
    expect(marks).toHaveLength(1);
    expect(marks[0].sql).not.toContain('fanout_retry_at');
  });

  it('falls back to the plain stamp on a pre-1632 outbox (42703) instead of stalling federation', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pg, calls } = fakePg({
      undrained: [outboxRow(1, 'wi-1')],
      failOn: (sql) =>
        /SET drained_at/.test(sql) && /fanout_retry_at/.test(sql)
          ? pgError('42703', 'column "fanout_retry_at" does not exist')
          : null,
    });
    const fanout = vi.fn(async () => {
      throw new Error('boom');
    });

    const drained = await drainOutboxOnce(fakeHandle(), pg, { fanout, now: NOW });

    expect(drained).toBe(1);
    const marks = markDrainedCalls(calls);
    expect(marks).toHaveLength(2);
    expect(marks[1].sql).not.toContain('fanout_retry_at');
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('migration 1632'))).toBe(true);
  });

  it('a non-schema mark-drained failure still propagates (the row is retried by the drain, not swallowed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pg } = fakePg({
      undrained: [outboxRow(1, 'wi-1')],
      failOn: (sql) => (/SET drained_at/.test(sql) ? pgError('57014', 'canceling statement') : null),
    });
    const fanout = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(drainOutboxOnce(fakeHandle(), pg, { fanout, now: NOW })).rejects.toThrow('canceling statement');
  });

  it('runs the retry sweep after federation work when a fan-out consumer is configured', async () => {
    const { pg, calls } = fakePg({ undrained: [] });
    await drainOutboxOnce(fakeHandle(), pg, { fanout: vi.fn(async () => undefined), now: NOW });
    expect(calls.some((c) => /fanout_retry_at <=/.test(c.sql))).toBe(true);
  });

  it('does not run the retry sweep without a fan-out consumer', async () => {
    const { pg, calls } = fakePg({ undrained: [] });
    await drainOutboxOnce(fakeHandle(), pg, { now: NOW });
    expect(calls.some((c) => /fanout_retry_at <=/.test(c.sql))).toBe(false);
  });

  it('GC never deletes a row whose fan-out retry is still pending', async () => {
    const { pg, calls } = fakePg({ undrained: [] });
    await drainOutboxOnce(fakeHandle(), pg, { now: NOW });
    const gc = calls.find((c) => /DELETE FROM harness_shared\.substrate_outbox/.test(c.sql));
    expect(gc).toBeDefined();
    expect(gc!.sql).toContain("->> 'fanout_retry_at') IS NULL");
  });
});

describe('P-003 retryPendingFanouts', () => {
  const dueRow = (attempts: number) => ({
    id: 7,
    table_name: 'work_items',
    op: 'put' as const,
    key: 'wi-7',
    row: { id: 'wi-7' },
    fanout_attempts: attempts,
  });

  it('re-runs a due fan-out and clears the retry state on success', async () => {
    const { pg, calls } = fakePg({ due: [dueRow(1)] });
    const fanout = vi.fn(async () => undefined);

    const r = await retryPendingFanouts(fakeHandle(), pg, { fanout, now: NOW });

    expect(fanout).toHaveBeenCalledWith({ id: 7, table_name: 'work_items', op: 'put', key: 'wi-7', row: { id: 'wi-7' } });
    expect(r).toEqual({ retried: 1, succeeded: 1, rescheduled: 0, gaveUp: 0 });
    const clear = calls.find((c) => /SET fanout_retry_at = NULL/.test(c.sql));
    expect(clear?.sql).toContain('fanout_last_error = NULL');
  });

  it('reschedules a failed retry with exponential backoff and records the error', async () => {
    const { pg, calls } = fakePg({ due: [dueRow(2)] });
    const fanout = vi.fn(async () => {
      throw new Error('still failing');
    });

    const r = await retryPendingFanouts(fakeHandle(), pg, { fanout, now: NOW });

    expect(r).toEqual({ retried: 1, succeeded: 0, rescheduled: 1, gaveUp: 0 });
    const upd = calls.find((c) => /UPDATE harness_shared\.substrate_outbox/.test(c.sql));
    expect(upd!.values).toEqual([NOW + fanoutRetryDelayMs(3), 3, 'still failing', 7]);
  });

  it('gives up loudly at the attempt cap and keeps the last error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pg, calls } = fakePg({ due: [dueRow(FANOUT_MAX_ATTEMPTS - 1)] });
    const fanout = vi.fn(async () => {
      throw new Error('permanent');
    });

    const r = await retryPendingFanouts(fakeHandle(), pg, { fanout, now: NOW });

    expect(r).toEqual({ retried: 1, succeeded: 0, rescheduled: 0, gaveUp: 1 });
    const upd = calls.find((c) => /SET fanout_retry_at = NULL/.test(c.sql));
    expect(upd!.values).toEqual([FANOUT_MAX_ATTEMPTS, 'permanent', 7]);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('GAVE UP'))).toBe(true);
  });

  it('returns zeros on a pre-1632 outbox instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pg } = fakePg({
      failOn: (sql) => (/fanout_retry_at <=/.test(sql) ? pgError('42703', 'column does not exist') : null),
    });

    const r = await retryPendingFanouts(fakeHandle(), pg, { fanout: vi.fn(async () => undefined), now: NOW });

    expect(r).toEqual({ retried: 0, succeeded: 0, rescheduled: 0, gaveUp: 0 });
  });

  it('a retry-state write failure is logged and the remaining due rows are still processed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let writes = 0;
    const { pg } = fakePg({
      due: [dueRow(1), { ...dueRow(1), id: 8, key: 'wi-8' }],
      failOn: (sql) => (/SET fanout_retry_at = NULL/.test(sql) && writes++ === 0 ? new Error('write lost') : null),
    });
    const fanout = vi.fn(async () => undefined);

    const r = await retryPendingFanouts(fakeHandle(), pg, { fanout, now: NOW });

    expect(fanout).toHaveBeenCalledTimes(2);
    expect(r.retried).toBe(2);
    expect(r.succeeded).toBe(1);
  });
});

describe('P-003 fanoutRetryDelayMs', () => {
  it('doubles from the base per failed attempt and is capped', () => {
    expect(fanoutRetryDelayMs(1)).toBe(FANOUT_RETRY_BASE_MS);
    expect(fanoutRetryDelayMs(2)).toBe(FANOUT_RETRY_BASE_MS * 2);
    expect(fanoutRetryDelayMs(4)).toBe(FANOUT_RETRY_BASE_MS * 8);
    expect(fanoutRetryDelayMs(50)).toBe(FANOUT_RETRY_MAX_DELAY_MS);
  });
});
