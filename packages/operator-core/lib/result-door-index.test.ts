import { describe, expect, it } from 'vitest';

import { buildSpillIndex, findDominantList, indexLine } from './result-door-index';

/** plan agent-epistemics-2026-08-02 P-003. */
describe('buildSpillIndex — answers "which of these do I care about"', () => {
  it('indexes a nested list, one line per entry, with identity + status', () => {
    const text = JSON.stringify({
      ok: true,
      counts: { ok: 3 },
      results: [
        { id: 'WI-7001', state: 'open', summary: 'x'.repeat(400) },
        { id: 'WI-7002', state: 'done', summary: 'y'.repeat(400) },
        { id: 'WI-7003', state: 'wip', summary: 'z'.repeat(400) },
      ],
    });
    const idx = buildSpillIndex(text) ?? '';
    expect(idx).toContain('# INDEX — 3 entries');
    expect(idx).toContain('[0] id=WI-7001 · state=open');
    expect(idx).toContain('[1] id=WI-7002 · state=done');
    expect(idx).toContain('[2] id=WI-7003 · state=wip');
    // It IDENTIFIES, it does not summarise — the 400-char bodies must not ride along.
    expect(idx).not.toContain('xxxx');
    expect(idx.length).toBeLessThan(400);
  });

  it('prefers the LONGEST object list, not the first one it meets', () => {
    const text = JSON.stringify({
      content: [{ type: 'text' }, { type: 'text' }, { type: 'text' }],
      results: Array.from({ length: 9 }, (_, i) => ({ id: `R-${i}`, state: 'open' })),
    });
    const idx = buildSpillIndex(text) ?? '';
    expect(idx).toContain('# INDEX — 9 entries');
    expect(idx).toContain('id=R-8');
  });

  it('caps a long value rather than letting one entry dominate the index', () => {
    const line = indexLine({ title: 'T'.repeat(300), state: 'open' }, 0) ?? '';
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line).toContain('…');
  });

  it('falls back through the identity keys when there is no id', () => {
    expect(indexLine({ slug: 'my-plan', status: 'active' }, 4)).toBe('  [4] slug=my-plan · status=active');
    expect(indexLine({ path: 'lib/a.ts' }, 0)).toBe('  [0] path=lib/a.ts');
  });
});

describe('buildSpillIndex — SILENT when an index would not help', () => {
  it('returns null for non-JSON (TOON, prose, a truncated body) instead of throwing', () => {
    for (const t of ['format: toon\nrows[2]{a,b}:\n 1,2', 'just some prose', '', '{ not valid json', '[1,2,']) {
      expect(buildSpillIndex(t)).toBeNull();
    }
  });

  it('returns null for a list too short to need an index', () => {
    expect(buildSpillIndex(JSON.stringify({ results: [{ id: 'A' }, { id: 'B' }] }))).toBeNull();
  });

  it('returns null when entries carry no recognisable identity — a list of [0] [1] [2] answers nothing', () => {
    const text = JSON.stringify({ rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }, { a: 7, b: 8 }] });
    expect(buildSpillIndex(text)).toBeNull();
  });

  it('returns null when only a minority of entries are identifiable', () => {
    const text = JSON.stringify({
      rows: [{ id: 'A' }, { a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
    });
    expect(buildSpillIndex(text)).toBeNull();
  });

  it('ignores an array that is mostly scalars with one stray object', () => {
    expect(findDominantList(['a', 'b', 'c', 'd', { id: 'X' }])).toBeNull();
  });
});

describe('buildSpillIndex — fail-soft contract', () => {
  it('never throws, whatever it is handed', () => {
    const nasty = [
      JSON.stringify({ a: { b: { c: { d: { e: { f: { g: [{ id: 1 }] } } } } } } }), // deeper than the depth cap
      JSON.stringify([]),
      JSON.stringify({}),
      'null',
      '123',
      '"a string"',
    ];
    for (const t of nasty) expect(() => buildSpillIndex(t)).not.toThrow();
  });

  it('truncates a very long list and says how many it omitted, rather than indexing all of it', () => {
    const rows = Array.from({ length: 260 }, (_, i) => ({ id: `E-${i}` }));
    const idx = buildSpillIndex(JSON.stringify({ rows })) ?? '';
    expect(idx).toContain('# INDEX — 260 entries');
    expect(idx).toContain('+60 more');
    expect(idx).not.toContain('id=E-201');
  });
});
