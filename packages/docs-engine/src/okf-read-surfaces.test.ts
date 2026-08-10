/**
 * OKF trust/staleness AT THE READ SURFACES — getDocs, searchDocs, and the
 * starlight adapter that feeds them (okf-frontmatter-adoption-2026-08-08 P-005).
 *
 * P-005's stated goal is that "a reader must see 'this is stale' at read time,
 * not by running a separate audit". okf.test.ts proves the verdict; this file
 * proves the verdict actually REACHES a caller of docs:get / docs:search, and
 * that it survives the on-disk frontmatter parse.
 *
 * Staleness is always driven by an injected `now` against a synthetic fixture
 * date. No real corpus doc is read or written here (plan D-002).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDocs } from './get';
import { searchDocs } from './search';
import { starlightContentAdapter } from './adapters/starlight';
import type { DocPage, DocSource, OkfFrontmatter } from './index';

const NOW = new Date('2026-08-08T12:00:00Z');

type PageSpec = { slug: string; body: string; okf?: OkfFrontmatter };

function makeSource(specs: PageSpec[]): DocSource {
  const bodies = new Map<string, string>();
  const pages: DocPage[] = specs.map((s) => {
    bodies.set(s.slug, s.body);
    return {
      slug: s.slug,
      slugs: s.slug.split('/'),
      url: `/${s.slug}`,
      title: s.slug,
      toc: [],
      ...(s.okf ? { okf: s.okf } : {}),
    };
  });
  return {
    name: 'test-source',
    listPages: async () => pages,
    getPage: async (slug) => pages.find((p) => p.slug === slug) ?? null,
    getContent: async (page) => bodies.get(page.slug) ?? '',
  };
}

describe('getDocs — OKF trust at read time', () => {
  it('adds NOTHING for a doc with no OKF metadata (the whole live corpus today)', async () => {
    const src = makeSource([{ slug: 'plain', body: '# Plain\n\nbody' }]);
    const res = await getDocs(src, { slugs: ['plain'] }, { now: NOW });
    const entry = res.results[0];
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    expect(entry).not.toHaveProperty('trust');
    expect(entry.content).toBe('# Plain\n\nbody');
  });

  it('adds nothing for a doc whose stale_after is still in the FUTURE', async () => {
    const src = makeSource([{ slug: 'fresh', body: 'body', okf: { staleAfter: '2027-01-01' } }]);
    const entry = (await getDocs(src, { slugs: ['fresh'] }, { now: NOW })).results[0];
    expect(entry).not.toHaveProperty('trust');
  });

  it('BANNERS the content and reports trust when the doc is past stale_after', async () => {
    const src = makeSource([{ slug: 'expired', body: '# Expired\n\nbody', okf: { staleAfter: '2026-01-01' } }]);
    const entry = (await getDocs(src, { slugs: ['expired'] }, { now: NOW })).results[0];
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    // The banner is the part that cannot be missed — a structured field the reader
    // never looks at does not deliver "this is stale" at read time.
    expect(entry.content.startsWith('> ⚠ **STALE')).toBe(true);
    expect(entry.content).toContain('2026-01-01');
    expect(entry.content).toContain('# Expired');
    expect(entry.trust).toMatchObject({ tier: 'unverified', stale: true, staleAfter: '2026-01-01' });
  });

  it('reports a verified tier even when the doc is NOT stale', async () => {
    const src = makeSource([{ slug: 'checked', body: 'body', okf: { verified: [{ by: 'avi', at: '2026-08-01' }] } }]);
    const entry = (await getDocs(src, { slugs: ['checked'] }, { now: NOW })).results[0];
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    expect(entry.trust).toMatchObject({ tier: 'human-verified', stale: false, verifiedBy: 'avi' });
    expect(entry.content).toBe('body'); // no banner — nothing is wrong with this doc
  });

  it('keeps the banner when a long doc is TRUNCATED', async () => {
    // Regression guard: banner-after-truncation would put the warning past the cut
    // on exactly the long docs where a reader is most likely to stop early.
    const src = makeSource([
      { slug: 'big', body: 'x'.repeat(60_000), okf: { staleAfter: '2026-01-01' } },
    ]);
    const entry = (await getDocs(src, { slugs: ['big'] }, { now: NOW })).results[0];
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    expect(entry.truncated).toBe(true);
    expect(entry.content.startsWith('> ⚠ **STALE')).toBe(true);
  });

  it('judges every doc in a batch against ONE clock', async () => {
    const src = makeSource([
      { slug: 'a', body: 'a', okf: { staleAfter: '2026-08-08' } },
      { slug: 'b', body: 'b', okf: { staleAfter: '2026-08-08' } },
    ]);
    const res = await getDocs(src, { slugs: ['a', 'b'] }, { now: NOW });
    expect(res.results.every((r) => r.found && r.trust?.stale === true)).toBe(true);
  });
});

describe('searchDocs — OKF trust in the hit list', () => {
  it('flags a stale hit so a reader can skip it BEFORE spending a docs:get', async () => {
    const src = makeSource([
      { slug: 'stale-one', body: 'pgbouncer pooling notes', okf: { staleAfter: '2026-01-01' } },
      { slug: 'fresh-one', body: 'pgbouncer pooling notes' },
    ]);
    const res = await searchDocs(src, { query: 'pgbouncer pooling' }, { now: NOW });
    const stale = res.hits.find((h) => h.slug === 'stale-one');
    const fresh = res.hits.find((h) => h.slug === 'fresh-one');
    expect(stale?.trust).toMatchObject({ stale: true, staleAfter: '2026-01-01' });
    expect(fresh).toBeDefined();
    expect(fresh).not.toHaveProperty('trust');
  });

  it('does not reorder results — trust is a LABEL, not a ranking signal', async () => {
    // Deliberate: silently demoting a stale doc would hide it from an agent who has
    // a good reason to read it. Say it is stale; let the reader decide.
    const src = makeSource([
      { slug: 'strong', body: 'widget widget widget widget', okf: { staleAfter: '2026-01-01' } },
      { slug: 'weak', body: 'widget' },
    ]);
    const res = await searchDocs(src, { query: 'widget' }, { now: NOW });
    expect(res.hits[0]?.slug).toBe('strong');
  });
});

describe('starlightContentAdapter — OKF survives the on-disk parse', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-adapter-'));
    await fs.writeFile(
      path.join(root, 'expired.mdx'),
      // Nested `verified:` + an UNQUOTED date — the two shapes the adapter's flat
      // top-level-scalar frontmatter reader cannot handle, which is why OKF parsing
      // goes through js-yaml instead.
      '---\ntitle: Expired doc\ntype: Insight\nverified:\n  - by: avi\n    at: 2025-12-01\nstale_after: 2026-01-01\n---\n\n# Expired doc\n\nbody\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'plain.mdx'),
      '---\ntitle: Plain doc\n---\n\n# Plain doc\n\nbody\n',
      'utf8',
    );
    // Shaped like the 28 real superseded docs: the local `status:` convention
    // beside OKF's `type`, and NO stale_after — retirement is not an expiry.
    await fs.writeFile(
      path.join(root, 'retired.mdx'),
      '---\ntitle: Retired doc\ntype: Insight\nstatus: superseded\n---\n\n# Retired doc\n\nbody\n',
      'utf8',
    );
    // The 561-doc majority. Must stay completely silent at the read surfaces.
    await fs.writeFile(
      path.join(root, 'live.mdx'),
      '---\ntitle: Live doc\ntype: Insight\nstatus: active\n---\n\n# Live doc\n\nbody\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('parses the nested + unquoted-date frontmatter off disk', async () => {
    const adapter = starlightContentAdapter({ contentRoot: root, name: 'okf-test' });
    const page = await adapter.getPage('expired');
    expect(page?.okf).toEqual({
      type: 'Insight',
      verified: [{ by: 'avi', at: '2025-12-01' }],
      staleAfter: '2026-01-01',
    });
    expect((await adapter.getPage('plain'))?.okf).toBeUndefined();
  });

  it('delivers the stale banner end-to-end through getDocs', async () => {
    const adapter = starlightContentAdapter({ contentRoot: root, name: 'okf-test-2' });
    const entry = (await getDocs(adapter, { slugs: ['expired'] }, { now: NOW })).results[0];
    expect(entry.found).toBe(true);
    if (!entry.found) return;
    expect(entry.content).toContain('STALE');
    expect(entry.content).toContain('Last verified 2025-12-01 by avi');
    expect(entry.trust).toMatchObject({ tier: 'human-verified', stale: true });
  });
});
