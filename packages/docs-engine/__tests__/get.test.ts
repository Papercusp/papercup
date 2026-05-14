import { describe, it, expect, vi } from 'vitest';
import { getDocs, MAX_PAYLOAD_BYTES } from '../src/get';
import { makePage, makeSource } from './_fixture';

describe('getDocs', () => {
  it('returns empty results for empty slugs', async () => {
    const out = await getDocs(makeSource(), { slugs: [] });
    expect(out.results).toEqual([]);
  });

  it('fetches a single page', async () => {
    const pages = [makePage({ slug: 'a/b', title: 'AB' })];
    const out = await getDocs(makeSource({ pages, contents: { 'a/b': 'body of a/b' } }), {
      slugs: ['a/b'],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ slug: 'a/b', found: true });
    if (out.results[0].found) expect(out.results[0].content).toBe('body of a/b');
  });

  it('returns not_found with suggestions for missing slug', async () => {
    const pages = [makePage({ slug: 'endpoint-system/overview' })];
    const out = await getDocs(makeSource({ pages }), { slugs: ['endpoint-system/overvew'] });
    expect(out.results[0].found).toBe(false);
    if (!out.results[0].found) {
      expect(out.results[0].error).toBe('not_found');
      expect(out.results[0].suggestions).toContain('endpoint-system/overview');
    }
  });

  it('returns per-slug error envelope (mixed batch)', async () => {
    const pages = [makePage({ slug: 'good' })];
    const out = await getDocs(makeSource({ pages, contents: { good: 'ok' } }), {
      slugs: ['good', 'missing'],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0].found).toBe(true);
    expect(out.results[1].found).toBe(false);
  });

  it('slices by heading on single-slug calls', async () => {
    const pages = [
      makePage({
        slug: 'a',
        toc: [
          { id: 'first', text: 'First', depth: 2 },
          { id: 'target', text: 'Target', depth: 2 },
        ],
      }),
    ];
    const contents = {
      a: '## First\n\nintro\n\n## Target\n\ntarget body\n',
    };
    const out = await getDocs(makeSource({ pages, contents }), {
      slugs: ['a'],
      heading: 'target',
    });
    expect(out.results[0].found).toBe(true);
    if (out.results[0].found) {
      expect(out.results[0].sliced).toBe(true);
      expect(out.results[0].content).toContain('target body');
      expect(out.results[0].content).not.toContain('intro');
    }
  });

  it('returns heading_not_found when slice misses', async () => {
    const pages = [
      makePage({
        slug: 'a',
        toc: [{ id: 'intro', text: 'Intro', depth: 2 }],
      }),
    ];
    const out = await getDocs(makeSource({ pages, contents: { a: '## Intro\nbody' } }), {
      slugs: ['a'],
      heading: 'nope',
    });
    expect(out.results[0].found).toBe(false);
    if (!out.results[0].found) expect(out.results[0].error).toBe('heading_not_found');
  });

  it('truncates over 50KB with tail mentioning first h2', async () => {
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 1000);
    const pages = [
      makePage({
        slug: 'big',
        toc: [{ id: 'sec', text: 'Sec', depth: 2 }],
      }),
    ];
    const out = await getDocs(makeSource({ pages, contents: { big } }), { slugs: ['big'] });
    expect(out.results[0].found).toBe(true);
    if (out.results[0].found) {
      expect(out.results[0].truncated).toBe(true);
      expect(out.results[0].content).toContain('truncated at');
      expect(out.results[0].content).toContain('sec');
    }
  });

  it('emits ctx.metadata', async () => {
    const metadata = vi.fn();
    const pages = [makePage({ slug: 'good' })];
    await getDocs(
      makeSource({ pages, contents: { good: 'ok' } }),
      { slugs: ['good', 'missing'] },
      { metadata },
    );
    expect(metadata).toHaveBeenCalledOnce();
    expect(metadata.mock.calls[0][0]).toMatchObject({
      requested: 2,
      found: 1,
      not_found: 1,
      truncated: 0,
      sliced: 0,
      has_heading: false,
    });
  });

  it('detects JSX literals in metadata', async () => {
    const metadata = vi.fn();
    const pages = [makePage({ slug: 'p' })];
    await getDocs(
      makeSource({ pages, contents: { p: 'before <Callout type="warn">stuff</Callout> after' } }),
      { slugs: ['p'] },
      { metadata },
    );
    expect(metadata.mock.calls[0][0].jsx_literals_present).toBe(true);
  });
});
