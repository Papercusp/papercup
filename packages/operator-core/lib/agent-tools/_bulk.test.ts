/**
 * Unit tests for the shared keyed-array bulk I/O contract (_bulk.ts).
 * bulk-endpoint-standardization-2026-06-21.
 */
import { describe, it, expect } from 'vitest';
import { toList, mergeIds, runBulk } from './_bulk';

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
    expect(env.counts).toEqual({ ok: 2, failed: 1 });
    expect(env.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(env.results[1]).toEqual({ ok: false, id: 'boom', error: 'kaboom' });
  });

  it('empty input → empty envelope', async () => {
    const env = await runBulk([], async () => ({ ok: true as const }));
    expect(env).toEqual({ ok: true, results: [], counts: { ok: 0, failed: 0 } });
  });
});
