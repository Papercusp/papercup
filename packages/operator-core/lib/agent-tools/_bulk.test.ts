/**
 * Unit tests for the shared keyed-array bulk I/O contract (_bulk.ts).
 * bulk-endpoint-standardization-2026-06-21.
 */
import { describe, it, expect } from 'vitest';
import { toList, mergeIds, runBulk, mergeBulkEnvelopes } from './_bulk';

describe('_bulk', () => {
  it('toList normalizes scalar / array / nullish', () => {
    expect(toList(undefined)).toEqual([]);
    expect(toList(null)).toEqual([]);
    expect(toList('x')).toEqual(['x']);
    expect(toList(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('mergeIds merges single + many, dedups, preserves order', () => {
    expect(mergeIds('a', ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeIds(undefined, ['x', 'x'])).toEqual(['x']);
    expect(mergeIds('only', undefined)).toEqual(['only']);
    expect(mergeIds(undefined, undefined)).toEqual([]);
  });

  it('runBulk collects per-item results + counts and self-describes keys', async () => {
    const env = await runBulk(['ok1', 'ok2'], async (id) => ({ ok: true as const, id, value: id.toUpperCase() }));
    expect(env.ok).toBe(true);
    expect(env.counts).toEqual({ ok: 2, failed: 0 });
    expect(env.results).toEqual([
      { ok: true, id: 'ok1', value: 'OK1' },
      { ok: true, id: 'ok2', value: 'OK2' },
    ]);
  });

  it('runBulk treats a returned {ok:false} as a failure (not only throws)', async () => {
    const env = await runBulk(['a'], async (id) => ({ ok: false as const, id, error: 'nope' }));
    expect(env.ok).toBe(false);
    expect(env.counts).toEqual({ ok: 0, failed: 1 });
    expect(env.results[0]).toMatchObject({ ok: false, id: 'a', error: 'nope' });
  });

  it('runBulk: a thrown error never aborts the batch and (with keyOf) still carries its key', async () => {
    const env = await runBulk(
      ['ok1', 'boom', 'ok2'],
      async (id) => {
        if (id === 'boom') throw new Error('kaboom');
        return { ok: true as const, id };
      },
      { keyOf: (id) => ({ id }) },
    );
    expect(env.ok).toBe(false);
    expect(env.counts).toEqual({ ok: 2, failed: 1 });
    expect(env.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(env.results[1]).toEqual({ ok: false, id: 'boom', error: 'kaboom' });
  });

  it('runBulk bounds opt-in concurrency and preserves input-correlated result order', async () => {
    let active = 0;
    let peak = 0;
    const env = await runBulk(
      [1, 2, 3, 4, 5, 6],
      async (id) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, id % 2 === 0 ? 2 : 6));
        active -= 1;
        return { ok: true as const, id };
      },
      { maxConcurrency: 3 },
    );

    expect(peak).toBe(3);
    expect(env.results.map((result) => result.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(env.counts).toEqual({ ok: 6, failed: 0 });
  });

  it('empty input → empty envelope', async () => {
    const env = await runBulk([], async () => ({ ok: true as const }));
    expect(env).toEqual({ ok: true, results: [], counts: { ok: 0, failed: 0 } });
  });
});

/**
 * The envelope's `ok` is DERIVED from its items — EI-23737206446729041.
 *
 * This envelope used to hard-code `ok: true` ("the batch ran") while computing `failed`
 * one line above and discarding it, so a partial failure was reported as a truthy result.
 * The measured cost: a `coord:send` carrying an owner report returned envelope `ok:true`
 * with `results[0].ok === false`; the caller branched on the envelope, recorded the report
 * as SENT, and the report did not exist.
 *
 * Why the ENVELOPE and not per-item reading is the rail: `ok` is the field every caller
 * branches on, so the obvious `if (res.ok)` has to be correct on its own. Guidance saying
 * "read the per-item verdict" makes correctness a thing each call site must REMEMBER, and a
 * `projection.pick` that omits the error field can hide the per-item truth entirely from the
 * context-constrained caller most likely to project. Per the derived-truth ladder, the
 * envelope is a second copy of a truth the items already own: DERIVE it, never restate it.
 */
describe('_bulk envelope ok is the conjunction of results[].ok', () => {
  const cases = [
    { name: 'all succeed → ok:true', flags: [true, true, true], expected: true },
    { name: 'one fails among many → ok:false', flags: [true, false, true], expected: false },
    { name: 'all fail → ok:false', flags: [false, false], expected: false },
    { name: 'single failure → ok:false', flags: [false], expected: false },
    { name: 'single success → ok:true', flags: [true], expected: true },
  ] as const;

  for (const { name, flags, expected } of cases) {
    it(name, async () => {
      const env = await runBulk([...flags], async (ok, i) => ({ ok, id: `i${i}` }));
      expect(env.ok).toBe(expected);
      // The invariant, stated independently of the table: truthy envelope ⟺ zero failures.
      expect(env.ok).toBe(env.counts.failed === 0);
    });
  }

  it('an empty batch is vacuously ok (no item failed)', async () => {
    const env = await runBulk([], async () => ({ ok: true as const }));
    expect(env.ok).toBe(true);
    expect(env.counts.failed).toBe(0);
  });

  it('REGRESSION: ok:true can never coexist with a failed item, however the failure arose', async () => {
    // Both failure channels at once — a returned {ok:false} AND a thrown error.
    const env = await runBulk(
      ['fine', 'returns-false', 'throws'],
      async (id) => {
        if (id === 'throws') throw new Error('kaboom');
        return { ok: id !== 'returns-false', id };
      },
      { keyOf: (id) => ({ id }) },
    );

    const anyItemFailed = env.results.some((r) => !r.ok);
    expect(anyItemFailed).toBe(true);
    expect(env.ok).toBe(false);
    expect(env.counts).toEqual({ ok: 1, failed: 2 });
  });
});

/**
 * REGRESSION (WI-10002111 / R-2): a tool that accepts several addressing modes runs one runBulk per
 * mode and merges them. The merged envelope's `ok` must be DERIVED from the merged counts — not
 * inherited from the first constituent (processes:kill once spread envs[0], so a clean first batch
 * reported ok:true beside a later batch's failures).
 */
describe('mergeBulkEnvelopes derives ok from the merged counts', () => {
  it('REGRESSION: a clean first envelope cannot mask a later envelope\'s failure', async () => {
    const clean = await runBulk(['a'], async () => ({ ok: true as const }));
    const dirty = await runBulk(['b', 'c'], async (id) => ({ ok: id !== 'c' }));
    expect(clean.ok).toBe(true);
    const merged = mergeBulkEnvelopes([clean, dirty]);
    expect(merged.counts).toEqual({ ok: 2, failed: 1 });
    expect(merged.ok).toBe(false);
    expect(merged.ok).toBe(merged.counts.failed === 0);
    expect(merged.results).toHaveLength(3);
  });

  it('all-clean merge stays ok:true and an empty merge is vacuously ok', async () => {
    const a = await runBulk([1], async () => ({ ok: true as const }));
    const b = await runBulk([2, 3], async () => ({ ok: true as const }));
    expect(mergeBulkEnvelopes([a, b]).ok).toBe(true);
    expect(mergeBulkEnvelopes([]).ok).toBe(true);
  });
});
