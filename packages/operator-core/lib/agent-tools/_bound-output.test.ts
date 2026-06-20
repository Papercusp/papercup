import { describe, it, expect } from 'vitest';
import { boundRowField } from './_bound-output';

describe('boundRowField (EI-1597 — shared high-fanout read-tool bound)', () => {
  it('returns a short field unchanged, no truncation flags', () => {
    const rows = [{ id: 'a', body: 'short' }];
    const out = boundRowField(rows, 'body', 100, 10_000);
    expect(out[0]).toEqual(rows[0]);
    expect('body_truncated' in out[0]).toBe(false);
  });

  it('excerpts a long field to the cap + stamps <field>_truncated/_full_chars', () => {
    const long = 'x'.repeat(600);
    const out = boundRowField([{ id: 'a', body: long }], 'body', 200, 10_000);
    const r = out[0] as { body: string; body_truncated?: true; body_full_chars?: number };
    expect(r.body.length).toBe(200); // n=1 → min(200, 10000) = 200
    expect(r.body_truncated).toBe(true);
    expect(r.body_full_chars).toBe(600);
  });

  it('keeps the TOTAL field text bounded by the budget at any row count', () => {
    const n = 500;
    const rows = Array.from({ length: n }, (_, i) => ({ id: `${i}`, body: 'y'.repeat(1000) }));
    const out = boundRowField(rows, 'body', 200, 10_000);
    const total = out.reduce((s, r) => s + (typeof r.body === 'string' ? r.body.length : 0), 0);
    expect(total).toBeLessThanOrEqual(10_000);
    expect((out[0].body as string).length).toBe(Math.floor(10_000 / n)); // 20
  });

  it('works on an arbitrary field name and preserves other fields', () => {
    const rows = [{ id: 'a', summary: 'z'.repeat(500), state: 'open' }];
    const out = boundRowField(rows, 'summary', 120, 8_000);
    const r = out[0] as { id: string; summary: string; state: string; summary_truncated?: true };
    expect(r.id).toBe('a');
    expect(r.state).toBe('open');
    expect(r.summary.length).toBe(120);
    expect(r.summary_truncated).toBe(true);
  });

  it('handles empty list + non-string field value', () => {
    expect(boundRowField([], 'body', 100, 1000)).toEqual([]);
    const out = boundRowField([{ id: 'a', body: null }], 'body', 100, 1000);
    expect(out[0]).toEqual({ id: 'a', body: null }); // non-string → treated as '' → unchanged
  });
});
