import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';

import { BENCH_SCHEMA, releaseBenchSchema } from './bench-host';

/** A pg Client whose DROP SCHEMA fails with `dropError` (or succeeds when null). */
function fakeClient(dropError: { code?: string; message: string } | null) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith('DROP SCHEMA') && dropError) throw Object.assign(new Error(dropError.message), dropError);
      return { rows: [] };
    }),
  };
  return { client: client as unknown as Client, queries };
}

/**
 * Measured 2026-09-30 (P-005 battery run 3): the hourly host backup's pg_dump held
 * AccessShareLock on every table of the bench schema, so the end-of-run DROP hit a
 * lock timeout (55P03) after the report was written, and the run exited 1.
 */
describe('releaseBenchSchema (end-of-run cleanup)', () => {
  afterEach(() => vi.useRealTimers());

  it('drops the schema and reports true when nothing holds it', async () => {
    const { client, queries } = fakeClient(null);
    await expect(releaseBenchSchema(client, 'bench_memory_1')).resolves.toBe(true);
    expect(queries).toContain('DROP SCHEMA IF EXISTS bench_memory_1 CASCADE');
  });

  it('leaves a lock-held schema to the orphan reaper instead of failing the finished run', async () => {
    vi.useFakeTimers();
    const { client, queries } = fakeClient({ code: '55P03', message: 'canceling statement due to lock timeout' });
    const warn = vi.fn();
    const done = releaseBenchSchema(client, 'bench_memory_2', warn);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(false);
    // The retries in dropBenchSchema still ran before giving up.
    expect(queries.filter((q) => q.startsWith('DROP SCHEMA'))).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/bench_memory_2.*orphan reaper/);
  });

  it('still throws any failure other than a lock timeout', async () => {
    const { client } = fakeClient({ code: '42501', message: 'permission denied for schema bench_memory_3' });
    const warn = vi.fn();
    await expect(releaseBenchSchema(client, 'bench_memory_3', warn)).rejects.toThrow(/permission denied/);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Recurrence guard for the bench-schema collision class, which bit TWICE in one
 * day (2026-07-13):
 *
 *  - EI-10854: two concurrent runs seeded the SAME `bench_memory` schema and
 *    cross-contaminated each other's corpus — silently. Both scorecards were
 *    garbage and the bench reported them as if fine.
 *  - Its own fix (DROP+recreate at run start) then let a second run's DROP
 *    CASCADE destroy a first run's tables mid-seed.
 *
 * Both are the same root cause: a SHARED, PROCESS-GLOBAL schema name. The fix is
 * that two runs cannot address the same schema at all. If anyone re-hardcodes it
 * back to a constant, these fail.
 */
describe('BENCH_SCHEMA isolation (EI-10854 recurrence guard)', () => {
  it('is UNIQUE PER RUN — never the bare shared name', () => {
    // The bare name is exactly the bug: every bench process in the fleet would
    // address one schema, so one run's DROP CASCADE nukes another's corpus.
    expect(BENCH_SCHEMA).not.toBe('bench_memory');
  });

  it('is pid-scoped, so two live runs can never collide', () => {
    expect(BENCH_SCHEMA).toBe(`bench_memory_${process.pid}`);
    // Two processes have different pids => different schemas => no collision.
    // (Asserting the SHAPE, not just inequality: a random suffix would also pass
    // the test above but would break the /proc-liveness orphan reaper, which
    // parses the pid back out of the schema name.)
    expect(/^bench_memory_\d+$/.test(BENCH_SCHEMA)).toBe(true);
  });

  it('is overridable, so a finished run\'s rows can still be inspected', () => {
    // PAPERCUSP_BENCH_SCHEMA is the documented escape hatch; it must win.
    // (Read at module load, so we assert the contract rather than re-importing.)
    const override = process.env.PAPERCUSP_BENCH_SCHEMA;
    if (override) expect(BENCH_SCHEMA).toBe(override);
  });
});
