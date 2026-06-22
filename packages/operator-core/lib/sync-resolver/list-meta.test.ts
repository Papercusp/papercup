/**
 * list-meta.test.ts — the flat-row "_meta on row[0]" total convention. Pure; no
 * PG/React. Proves attach is non-mutating + merges, read falls back to length,
 * and the count label never lets the downloaded length read as the total.
 */
import { describe, expect, it } from 'vitest';
import { attachListMeta, readListMeta, readListTotal, listCountLabel } from './list-meta';

interface Row { id: string }
const rows = (): Row[] => [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('attachListMeta', () => {
  it('stashes meta on row[0] only and does not mutate the input', () => {
    const input = rows();
    const out = attachListMeta(input, { total: 42 });
    expect((out[0] as { _meta?: { total?: number } })._meta).toEqual({ total: 42 });
    expect((out[1] as { _meta?: unknown })._meta).toBeUndefined();
    // input untouched (row[0] is a clone)
    expect((input[0] as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('merges with existing _meta rather than clobbering it', () => {
    const seeded = [{ id: 'a', _meta: { byKind: { bug: 1 } } }, { id: 'b' }];
    const out = attachListMeta(seeded, { total: 7 });
    expect((out[0] as { _meta?: Record<string, unknown> })._meta).toEqual({ byKind: { bug: 1 }, total: 7 });
  });

  it('is a no-op on an empty array (nothing to carry metadata on)', () => {
    const empty: Row[] = [];
    expect(attachListMeta(empty, { total: 0 })).toBe(empty);
  });
});

describe('readListMeta / readListTotal', () => {
  it('reads the stashed total', () => {
    const out = attachListMeta(rows(), { total: 99 });
    expect(readListMeta(out)?.total).toBe(99);
    expect(readListTotal(out)).toBe(99);
  });

  it('falls back to the downloaded length when no _meta is present', () => {
    expect(readListTotal(rows())).toBe(3);
    expect(readListMeta(rows())).toBeUndefined();
  });

  it('handles null/undefined safely', () => {
    expect(readListTotal(null)).toBe(0);
    expect(readListTotal(undefined)).toBe(0);
    expect(readListMeta(null)).toBeUndefined();
  });
});

describe('listCountLabel', () => {
  it('shows "N of TOTAL" when the read was capped', () => {
    expect(listCountLabel(300, 404)).toBe('300 of 404');
  });
  it('shows just the total when nothing was truncated', () => {
    expect(listCountLabel(404, 404)).toBe('404');
  });
  it('falls back to the shown count when total is unknown', () => {
    expect(listCountLabel(12, undefined)).toBe('12');
  });
});
