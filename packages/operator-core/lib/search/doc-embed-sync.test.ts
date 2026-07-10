/**
 * doc-embed-sync — P-009 (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Pure splitter tests + sync-against-fake-Sql tests (mirrors
 * embed-backfill.test.ts's fake-sql approach: dispatch on query text, record
 * every call). The real adapters/PG are never touched — runDocSectionsSyncOnce
 * and queueHarnessDocSectionSync are VITEST-inert by design and asserted so.
 */

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import type { DocSource, DocPage } from '@papercusp/docs-engine';
import {
  splitDocSections,
  pageSha,
  syncDocSourceSections,
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

  it('never splits on a heading-looking line inside a code fence', () => {
    const body = [
      '## Real Section',
      'Some intro long enough to count here.',
      '```bash',
      '# not a heading, just a comment',
      '## also not a heading',
      '```',
      'trailing text after the fence block.',
    ].join('\n');
    const s = splitDocSections('P', body);
    expect(s).toHaveLength(1);
    expect(s[0].anchor).toBe('real-section');
    expect(s[0].content).toContain('also not a heading');
    expect(s[0].content).toContain('trailing text');
  });

  it('dedupes repeated heading anchors with -2/-3 suffixes', () => {
    const body = [
      '## Setup',
      'first setup section body, long enough.',
      '## Setup',
      'second setup section body, long enough.',
    ].join('\n');
    const s = splitDocSections('P', body);
    expect(s.map((x) => x.anchor)).toEqual(['setup', 'setup-2']);
  });

  it('caps section content at 2000 chars and skips tiny sections', () => {
    const body = ['## Big', 'x'.repeat(5000), '## Tiny', 'ok'].join('\n');
    const s = splitDocSections('P', body);
    expect(s).toHaveLength(1);
    expect(s[0].anchor).toBe('big');
    expect(s[0].content.length).toBe(2000);
  });

  it('leaves depth-4+ headings inside their parent section', () => {
    const body = ['## Parent', 'parent body long enough to keep.', '#### Deep detail', 'deep body text.'].join('\n');
    const s = splitDocSections('P', body);
    expect(s).toHaveLength(1);
    expect(s[0].content).toContain('#### Deep detail');
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

describe('vitest inertness (WI-3792 load-scar class)', () => {
  it('runDocSectionsSyncOnce is a no-op under vitest', async () => {
    expect(await runDocSectionsSyncOnce()).toEqual({ skipped: 'vitest' });
  });
  it('queueHarnessDocSectionSync is a no-op under vitest', () => {
    expect(queueHarnessDocSectionSync('any-harness')).toBeUndefined();
  });
});
