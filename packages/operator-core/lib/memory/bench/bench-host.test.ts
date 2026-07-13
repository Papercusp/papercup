import { describe, expect, it } from 'vitest';

import { BENCH_SCHEMA } from './bench-host';

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
