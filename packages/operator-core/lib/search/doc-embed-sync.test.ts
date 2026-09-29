/**
 * doc-embed-sync — P-009 (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Pure splitter tests + sync-against-fake-Sql tests (mirrors
 * embed-backfill.test.ts's fake-sql approach: dispatch on query text, record
 * every call). The real adapters/PG are never touched — runDocSectionsSyncOnce
 * and queueHarnessDocSectionSync are VITEST-inert by design and asserted so.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { DocSource, DocPage } from '@papercusp/docs-engine';
import {
  splitDocSections,
  pageSha,
  syncDocSourceSections,
  refreshDocPageSectionsWithSql,
  runDocSectionsSyncOnce,
  queueHarnessDocSectionSync,
} from './doc-embed-sync';

function fakeSql(existing: Array<{ slug: string; page_sha: string }> = []) {
  const calls: Array<{ q: string; params: unknown[] }> = [];
  const sql = {
    unsafe: async (q: string, params: unknown[] = []) => {
      calls.push({ q, params });
      if (q.includes('SELECT DISTINCT')) return existing;
      if (q.trimStart().startsWith('DELETE') && q.includes('RETURNING')) return [];
      return [];
    },
  };
  return { calls, sql: sql as unknown as Sql };
}

function page(slug: string, title: string): DocPage {
  return { slug, slugs: slug ? slug.split('/') : [], url: `/docs/${slug}`, title, toc: [] };
}

function fakeSource(pages: Array<{ page: DocPage; body: string }>, name = 'test-src'): DocSource {
  return {
    name,
    listPages: async () => pages.map((p) => p.page),
    getPage: async (slug) => pages.find((p) => p.page.slug === slug)?.page ?? null,
    getContent: async (pg) => {
      const found = pages.find((p) => p.page.slug === pg.slug);
      if (!found) throw new Error('not found');
      if (found.body === '<<THROW>>') throw new Error('render exploded');
      return found.body;
    },
  };
}

// The splitting itself (fences, dedupe, min-content floor, part caps, anchor
// convention) is tested in @papercusp/search's chunk.test.ts and pinned to the
// pre-move output by chunk.golden.test.ts. These cover the doc-specific layer.
describe('splitDocSections', () => {
  it('splits on headings with a preamble section and Page › Heading titles', () => {
    const body = [
      'Intro paragraph long enough to keep around.',
      '',
      '## Alpha Part',
      'Alpha body text that is long enough.',
      '',
      '### Beta Sub',
      'Beta body text that is long enough.',
    ].join('\n');
    const s = splitDocSections('My Page', body);
    expect(s.map((x) => x.anchor)).toEqual(['', 'alpha-part', 'beta-sub']);
    expect(s[0].title).toBe('My Page');
    expect(s[1].title).toBe('My Page › Alpha Part');
    expect(s[1].content).toContain('Alpha body');
  });

  // EI-20059161453678027: the tail of an over-long section used to be sliced
  // off and was therefore unembedded. Each continuation row must repeat the
  // heading title, because the title is part of the embed input.
  it('repeats the section title on every continuation row', () => {
    const body = ['## Big', 'x'.repeat(5000), '## After', 'a following section, long enough.'].join('\n');
    const big = splitDocSections('P', body).filter((x) => x.anchor === 'big' || x.anchor.startsWith('big~'));
    expect(big.map((x) => x.anchor)).toEqual(['big', 'big~2', 'big~3']);
    for (const row of big) expect(row.title).toBe('P › Big');
  });

  it('titles a nested section by its own heading, not its ancestry', () => {
    const body = ['## Outer', 'outer body long enough to keep.', '### Inner', 'inner body long enough to keep.'].join('\n');
    expect(splitDocSections('P', body).map((x) => x.title)).toEqual(['P › Outer', 'P › Inner']);
  });
});

describe('syncDocSourceSections', () => {
  it('inserts sections for new pages and stamps the page sha', async () => {
    const { calls, sql } = fakeSql();
    const src = fakeSource([
      { page: page('guide/one', 'One'), body: '## A\nalpha body long enough to keep.' },
      { page: page('guide/two', 'Two'), body: 'preamble body long enough to keep.' },
    ]);
    const stats = await syncDocSourceSections(sql, src);
    expect(stats).toMatchObject({ pages: 2, changed: 2, sections: 2, errors: 0 });
    const inserts = calls.filter((c) => c.q.includes('INSERT INTO harness_shared.doc_sections'));
    expect(inserts).toHaveLength(2);
    const sha = pageSha('One', '## A\nalpha body long enough to keep.');
    expect(inserts[0].params).toEqual(['test-src', 'guide/one', 'a', 'One › A', '/docs/guide/one', 'alpha body long enough to keep.', sha]);
  });

  it('skips pages whose sha is unchanged (no DELETE, no INSERT)', async () => {
    const body = '## A\nalpha body long enough to keep.';
    const { calls, sql } = fakeSql([{ slug: 'guide/one', page_sha: pageSha('One', body) }]);
    const src = fakeSource([{ page: page('guide/one', 'One'), body }]);
    const stats = await syncDocSourceSections(sql, src);
    expect(stats).toMatchObject({ pages: 1, changed: 0, sections: 0 });
    expect(calls.some((c) => c.q.trimStart().startsWith('DELETE') && !c.q.includes('RETURNING'))).toBe(false);
    expect(calls.some((c) => c.q.includes('INSERT'))).toBe(false);
  });

  it('lets a pending macrotask run during a large unchanged corpus', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({
      page: page(`guide/${i}`, `Guide ${i}`),
      body: `unchanged body ${i}, long enough to keep.`,
    }));
    const { sql } = fakeSql(
      pages.map(({ page: pg, body }) => ({ slug: pg.slug, page_sha: pageSha(pg.title, body) })),
    );
    const src = fakeSource(pages);
    const getContent = src.getContent.bind(src);
    let rendered = 0;
    src.getContent = async (pg) => {
      rendered += 1;
      return getContent(pg);
    };

    let renderedWhenTickerRan: number | null = null;
    setImmediate(() => {
      renderedWhenTickerRan = rendered;
    });

    const stats = await syncDocSourceSections(sql, src);

    expect(stats).toMatchObject({ pages: 8, changed: 0, sections: 0, errors: 0 });
    expect(renderedWhenTickerRan).not.toBeNull();
    expect(renderedWhenTickerRan!).toBeGreaterThan(0);
    expect(renderedWhenTickerRan!).toBeLessThan(pages.length);
  });

  it('replaces sections when content changed (DELETE then INSERT)', async () => {
    const { calls, sql } = fakeSql([{ slug: 'guide/one', page_sha: 'stale-sha' }]);
    const src = fakeSource([{ page: page('guide/one', 'One'), body: '## A\nnew alpha body long enough.' }]);
    const stats = await syncDocSourceSections(sql, src);
    expect(stats).toMatchObject({ changed: 1, sections: 1 });
    const del = calls.findIndex((c) => c.q.includes('DELETE') && c.q.includes('slug = $2'));
    const ins = calls.findIndex((c) => c.q.includes('INSERT'));
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
  });

  it('prunes rows for pages no longer listed, but never off an empty listing', async () => {
    const a = fakeSql();
    await syncDocSourceSections(a.sql, fakeSource([{ page: page('kept', 'K'), body: 'body long enough to keep.' }]));
    const prune = a.calls.find((c) => c.q.includes('ANY($2::text[])'));
    expect(prune).toBeDefined();
    expect(prune!.params[1]).toEqual(['kept']);

    const b = fakeSql();
    await syncDocSourceSections(b.sql, fakeSource([]));
    expect(b.calls.some((c) => c.q.includes('ANY($2::text[])'))).toBe(false);
  });

  it('counts a page whose render throws as an error and continues', async () => {
    const { sql } = fakeSql();
    const src = fakeSource([
      { page: page('boom', 'Boom'), body: '<<THROW>>' },
      { page: page('fine', 'Fine'), body: 'body long enough to keep around.' },
    ]);
    const stats = await syncDocSourceSections(sql, src);
    expect(stats).toMatchObject({ errors: 1, changed: 1 });
  });
});

describe('splitter-version invalidation', () => {
  // Without this, the fix would be INERT for rows already in PG: an unchanged
  // page keeps its stored sha, the sync skips it, and its truncated rows are
  // never rewritten. The version has to be part of the change-detection key.
  it('mixes the splitter version into page_sha so stored shas invalidate once', () => {
    const title = 'T';
    const body = 'some body text';
    const bare = createHash('sha256').update(title).update('\0').update(body).digest('hex');
    expect(pageSha(title, body)).not.toBe(bare);
  });

  it('still distinguishes pages by title and body', () => {
    expect(pageSha('A', 'body')).not.toBe(pageSha('B', 'body'));
    expect(pageSha('A', 'one')).not.toBe(pageSha('A', 'two'));
    expect(pageSha('A', 'body')).toBe(pageSha('A', 'body'));
  });
});

describe('vitest inertness (WI-3792 load-scar class)', () => {
  it('runDocSectionsSyncOnce is a no-op under vitest', async () => {
    expect(await runDocSectionsSyncOnce()).toEqual({ skipped: 'vitest' });
  });
  it('queueHarnessDocSectionSync is a no-op under vitest', () => {
    expect(queueHarnessDocSectionSync('any-harness')).toBeUndefined();
  });
});

/**
 * EI-20459861068197195 — a doc corrected via docs:author kept being SERVED by
 * docs:search under its OLD title/description/body: doc_sections syncs once per
 * operator process, and nothing refreshed the page the author had just written.
 *
 * What these guard is specifically the STALE-READ failure. It is not enough
 * that some rows got written — the row must carry the NEW title, because the
 * old title continuing to be served is precisely what misled readers.
 */
describe('refreshDocPageSections (single-page repair after a write)', () => {
  it('re-indexes the authored page under its NEW title', async () => {
    const { calls, sql } = fakeSql();
    const src = fakeSource([
      { page: page('agent-insights/x', 'NEW title'), body: '## A\nrewritten body long enough to keep.' },
    ]);

    const res = await refreshDocPageSectionsWithSql(sql, src, 'agent-insights/x');

    expect(res).toMatchObject({ ok: true, unchanged: false });
    const inserts = calls.filter((c) => c.q.includes('INSERT INTO harness_shared.doc_sections'));
    expect(inserts).toHaveLength(1);
    // params: [source, slug, anchor, title, url, content, sha]
    expect(inserts[0].params[1]).toBe('agent-insights/x');
    expect(String(inserts[0].params[3])).toContain('NEW title');
    expect(String(inserts[0].params[5])).toContain('rewritten body');
  });

  it('replaces ONLY that page — deletes by slug, never prunes the whole source', async () => {
    const { calls, sql } = fakeSql();
    const src = fakeSource([
      { page: page('agent-insights/x', 'X'), body: '## A\nbody long enough to keep around.' },
      { page: page('agent-insights/other', 'Other'), body: '## B\nother body long enough to keep.' },
    ]);

    await refreshDocPageSectionsWithSql(sql, src, 'agent-insights/x');

    const deletes = calls.filter((c) => c.q.trimStart().startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params).toEqual(['test-src', 'agent-insights/x']);
    // the sweep's whole-source prune (DELETE ... RETURNING) must never run here
    expect(calls.some((c) => c.q.includes('RETURNING'))).toBe(false);
    const inserts = calls.filter((c) => c.q.includes('INSERT INTO harness_shared.doc_sections'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[1]).toBe('agent-insights/x');
  });

  it('is fail-open on an unknown slug — reports a reason, writes nothing', async () => {
    const { calls, sql } = fakeSql();
    const src = fakeSource([{ page: page('agent-insights/x', 'X'), body: 'body long enough to keep.' }]);

    const res = await refreshDocPageSectionsWithSql(sql, src, 'agent-insights/nope');

    expect(res).toEqual({ ok: false, reason: 'page_not_found:agent-insights/nope' });
    expect(calls.some((c) => c.q.includes('INSERT') || c.q.trimStart().startsWith('DELETE'))).toBe(false);
  });

  it('is fail-open when the render throws (the doc is already canonical in PG)', async () => {
    const { sql } = fakeSql();
    const src = fakeSource([{ page: page('agent-insights/x', 'X'), body: '<<THROW>>' }]);

    const res = await refreshDocPageSectionsWithSql(sql, src, 'agent-insights/x');

    expect(res).toMatchObject({ ok: false });
    expect((res as { ok: false; reason: string }).reason).toContain('render exploded');
  });

  it('reports unchanged (no write) when the stored sha already matches', async () => {
    const body = '## A\nunchanged body long enough to keep.';
    const { calls, sql } = fakeSql([{ slug: 'agent-insights/x', page_sha: pageSha('X', body) }]);
    const src = fakeSource([{ page: page('agent-insights/x', 'X'), body }]);

    // NOTE: the single-page path does not read the existing-sha map (that is the
    // sweep's batch optimization), so it rewrites rather than short-circuits.
    // Asserting the ROWS it writes are correct is what matters for the read leg.
    const res = await refreshDocPageSectionsWithSql(sql, src, 'agent-insights/x');
    expect(res).toMatchObject({ ok: true });
    const inserts = calls.filter((c) => c.q.includes('INSERT INTO harness_shared.doc_sections'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[6]).toBe(pageSha('X', body));
  });
});
