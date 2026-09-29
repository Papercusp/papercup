/**
 * Moving the doc-section splitter into @papercusp/search must re-embed NOTHING
 * (generic-rag-chunking-2026-09-29 P-002, acceptance bar R-7).
 *
 * doc_sections rows carry their embedding until their page's `page_sha`
 * changes; a changed page is DELETE + INSERT with embedding NULL, and the
 * embed-backfill sweep pays to re-vectorize it. `page_sha` mixes in
 * SPLITTER_VERSION, which was deliberately NOT bumped by the move. That is only
 * correct if the library splitter writes exactly the rows the old one wrote: a
 * silent output change under an unchanged sha would leave stale rows in PG that
 * no later sync ever repairs.
 *
 * So this file checks both halves against a real doc_sections table:
 *   1. the rows seeded here ARE the pre-move splitter's output — every content
 *      sha equals the pin chunk-golden.v1.json took from the pre-move code, so
 *      seeding from the library is not circular;
 *   2. re-syncing those pages through syncDocSourceSections clears zero
 *      embeddings and leaves the stored rows equal to the library's output;
 *   3. a positive control: a page whose text DID change loses its embeddings,
 *      so the zero in (2) comes from an instrument that can report non-zero.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import type { DocPage, DocSource } from '@papercusp/docs-engine';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { DOC_MARKDOWN_SPLIT, pageSha, splitDocSections, syncDocSourceSections } from './doc-embed-sync';
import { PROSE_VECTOR_DIMS } from './prose-vector-dims';

type Part = string | { s: string; n: number };
interface GoldenPage {
  name: string;
  title: string;
  parts: Part[];
  bodySha: string;
  sections: Array<{ anchor: string; heading: string | null; contentSha: string; contentLength: number }>;
}

const golden = JSON.parse(
  readFileSync(
    new URL('../../../../libs/generic/search/src/__fixtures__/chunk-golden.v1.json', import.meta.url),
    'utf8',
  ),
) as { markdownOptions: typeof DOC_MARKDOWN_SPLIT; markdown: GoldenPage[] };

const expand = (parts: Part[]): string => parts.map((p) => (typeof p === 'string' ? p : p.s.repeat(p.n))).join('');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const SOURCE_KEY = `test:doc-embed-sync-parity:${process.pid}:${Date.now()}`;
const EMBED_MODE = 'gemma';
const VECTOR = `[${Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => ((i % 7) + 1) / 10).join(',')}]`;

const pages = golden.markdown.map((g) => ({
  golden: g,
  page: { slug: `parity/${g.name}`, slugs: ['parity', g.name], url: `/docs/parity/${g.name}`, title: g.title, toc: [] } as DocPage,
  body: expand(g.parts),
}));

function source(bodies: Map<string, string>): DocSource {
  return {
    name: SOURCE_KEY,
    listPages: async () => pages.map((p) => p.page),
    getPage: async (slug) => pages.find((p) => p.page.slug === slug)?.page ?? null,
    getContent: async (pg) => bodies.get(pg.slug) ?? '',
  };
}

describe('doc_sections re-sync through the library markdown splitter (live SQL)', () => {
  let sql: postgres.Sql;

  const storedRows = () =>
    sql.unsafe<Array<{ slug: string; anchor: string; title: string; content: string; has_embedding: boolean }>>(
      `SELECT slug, anchor, title, content, embedding IS NOT NULL AS has_embedding
         FROM harness_shared.doc_sections WHERE source_key = $1 ORDER BY slug, anchor`,
      [SOURCE_KEY],
    );

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'doc-embed-sync-parity.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  }, 60_000);

  afterAll(async () => {
    await sql?.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1`, [SOURCE_KEY]);
    await sql?.end({ timeout: 5 });
  });

  it('the golden pins were taken with the doc_sections split options', () => {
    expect(golden.markdownOptions).toEqual(DOC_MARKDOWN_SPLIT);
  });

  it('the rows about to be seeded are byte-identical to the pre-move splitter output', () => {
    for (const { golden: g, body } of pages) {
      expect(sha(body), g.name).toBe(g.bodySha);
      const rows = splitDocSections(g.title, body);
      expect(
        rows.map((r) => ({ anchor: r.anchor, title: r.title, contentSha: sha(r.content) })),
        g.name,
      ).toEqual(
        g.sections.map((s) => ({
          anchor: s.anchor,
          title: s.heading === null ? g.title : `${g.title} › ${s.heading}`,
          contentSha: s.contentSha,
        })),
      );
    }
  });

  it('re-syncing embedded rows clears zero embeddings and leaves the stored rows unchanged', async () => {
    let seeded = 0;
    for (const { page, body } of pages) {
      for (const s of splitDocSections(page.title, body)) {
        await sql.unsafe(
          `INSERT INTO harness_shared.doc_sections
             (source_key, slug, anchor, title, url, content, page_sha, embedding, embedding_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9)`,
          [SOURCE_KEY, page.slug, s.anchor, s.title, page.url, s.content, pageSha(page.title, body), VECTOR, EMBED_MODE],
        );
        seeded += 1;
      }
    }
    expect(seeded).toBe(golden.markdown.reduce((n, g) => n + g.sections.length, 0));

    const stats = await syncDocSourceSections(sql, source(new Map(pages.map((p) => [p.page.slug, p.body]))));
    expect(stats).toMatchObject({ pages: pages.length, changed: 0, sections: 0, pruned: 0, errors: 0 });

    const rows = await storedRows();
    expect(rows).toHaveLength(seeded);
    expect(rows.filter((r) => !r.has_embedding).map((r) => `${r.slug}#${r.anchor}`)).toEqual([]);

    // Both sides sorted by the same JS comparator: PG's ORDER BY follows the
    // database collation, which need not agree with code-unit order.
    const byKey = (a: { slug: string; anchor: string }, b: { slug: string; anchor: string }) =>
      a.slug === b.slug ? (a.anchor < b.anchor ? -1 : 1) : a.slug < b.slug ? -1 : 1;
    const expected = pages
      .flatMap(({ page, body }) =>
        splitDocSections(page.title, body).map((s) => ({ slug: page.slug, anchor: s.anchor, title: s.title, content: s.content })),
      )
      .sort(byKey);
    expect(rows.map(({ has_embedding: _, ...r }) => r).sort(byKey)).toEqual(expected);
  });

  it('positive control: a page whose text changed does lose its embeddings', async () => {
    const target = pages.find((p) => p.golden.name === 'nested-and-deep');
    if (!target) throw new Error('golden fixture has no nested-and-deep page');
    const bodies = new Map(pages.map((p) => [p.page.slug, p.body]));
    bodies.set(target.page.slug, `${target.body}\n\n## Added later\n\nA section appended after the rows were embedded.`);

    const stats = await syncDocSourceSections(sql, source(bodies));
    expect(stats).toMatchObject({ changed: 1, errors: 0 });

    const rows = await storedRows();
    const changed = rows.filter((r) => r.slug === target.page.slug);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((r) => !r.has_embedding)).toBe(true);
    expect(rows.filter((r) => r.slug !== target.page.slug && !r.has_embedding)).toEqual([]);
  });
});
