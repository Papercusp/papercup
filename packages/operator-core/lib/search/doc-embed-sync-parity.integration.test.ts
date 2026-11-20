/**
 * Moving the doc-section splitter into @papercusp/search must re-embed NOTHING
 * (generic-rag-chunking-2026-09-29 P-002, acceptance bar R-7).
 *
 * A changed page reuses exact section inputs in the active embedding space.
 * `page_sha` mixes in
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
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import postgres from 'postgres';
import type { DocPage, DocSource } from '@papercusp/docs-engine';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { DOC_MARKDOWN_SPLIT, pageSha, refreshDocPageSectionsWithSql, splitDocSections, syncDocSourceSections } from './doc-embed-sync';
import { PROSE_VECTOR_DIMS, resolveCurrentProseProfileSelection } from './prose-vector-dims';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { backfillTable, TARGETS } from './embed-backfill';

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

/** Preserve the library's original pins and restore the known source sections
 * that its historical minimum length and heading cap omitted. */
function completeSectionPins(g: GoldenPage): GoldenPage['sections'] {
  const pin = (anchor: string, heading: string, content: string) => ({
    anchor, heading, contentSha: sha(content), contentLength: content.length,
  });
  if (g.name === 'short-sections-dropped') {
    return [pin('a', 'A', 'tiny'), pin('b', 'B', 'also tiny'), ...g.sections];
  }
  if (g.name === 'section-cap-90-headings') {
    const tail = g.parts.slice(g.sections.length).map(part => {
      const match = typeof part === 'string' && /^## (H\d+)\n([^\n]+)\n$/.exec(part);
      if (!match) throw new Error('Missing heading and body in the historical section-cap fixture');
      return pin(match[1].toLowerCase(), match[1], match[2]);
    });
    return [...g.sections, ...tail];
  }
  return g.sections;
}

const SOURCE_KEY = `test:doc-embed-sync-parity:${process.pid}:${Date.now()}`;
const EMBED_MODE = 'gemma';
const activeSpace = async () => ({ mode: EMBED_MODE, selection: resolveCurrentProseProfileSelection(EMBED_MODE)! });
const VECTOR = `[${Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => ((i % 7) + 1) / 10).join(',')}]`;

const pages = golden.markdown.map((g) => ({
  golden: g,
  page: { slug: `parity/${g.name}`, slugs: ['parity', g.name], url: `/docs/parity/${g.name}`, title: g.title, toc: [] } as DocPage,
  body: expand(g.parts),
}));

// A page that splits into zero sections stores no row, so there is no page_sha
// to short-circuit on: every sync re-evaluates it, deletes nothing and writes
// nothing, yet counts it as changed. That is the sync's behaviour before and
// after the move, so the counts below expect it rather than zero.
const SECTIONLESS = golden.markdown.filter((g) => g.sections.length === 0).length;

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

  let seeded = 0;

  // Seed every page's sections, embedded, as the sync would have left them.
  // One statement, so a loaded host is not paying ~400 round-trips.
  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'doc-embed-sync-parity.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });

    const cols: string[][] = [[], [], [], [], [], [], []];
    for (const { page, body } of pages) {
      for (const s of splitDocSections(page.title, body)) {
        [page.slug, s.anchor, s.title, page.url, s.content, pageSha(page.title, body)].forEach((v, i) => cols[i].push(v));
        seeded += 1;
      }
    }
    await sql.unsafe(
      `INSERT INTO harness_shared.doc_sections
         (source_key, slug, anchor, title, url, content, page_sha, embedding, embedding_mode)
       SELECT $1, slug, anchor, title, url, content, page_sha, $7::vector, $8
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $9::text[])
           AS t(slug, anchor, title, url, content, page_sha)`,
      [SOURCE_KEY, cols[0], cols[1], cols[2], cols[3], cols[4], VECTOR, EMBED_MODE, cols[5]],
    );
  }, 180_000);

  afterAll(async () => {
    await sql?.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1`, [SOURCE_KEY]);
    await sql?.end({ timeout: 5 });
  });

  it('the golden pins were taken with the doc_sections split options', () => {
    expect(golden.markdownOptions).toEqual(DOC_MARKDOWN_SPLIT);
  });

  it('preserves originally pinned section bytes and includes the full current document', () => {
    for (const { golden: g, body } of pages) {
      expect(sha(body), g.name).toBe(g.bodySha);
      const rows = splitDocSections(g.title, body);
      expect(
        rows.map((r) => ({ anchor: r.anchor, title: r.title, contentSha: sha(r.content) })),
        g.name,
      ).toEqual(
        completeSectionPins(g).map((s) => ({
          anchor: s.anchor,
          title: s.heading === null ? g.title : `${g.title} › ${s.heading}`,
          contentSha: s.contentSha,
        })),
      );
    }
  });

  it('re-syncing embedded rows clears zero embeddings and leaves the stored rows unchanged', async () => {
    expect(seeded).toBe(golden.markdown.reduce((n, g) => n + completeSectionPins(g).length, 0));

    const stats = await syncDocSourceSections(sql, source(new Map(pages.map((p) => [p.page.slug, p.body]))));
    expect(stats).toMatchObject({ pages: pages.length, changed: SECTIONLESS, sections: 0, pruned: 0, errors: 0 });

    const rows = await storedRows();
    expect(rows).toHaveLength(seeded);
    expect(rows.filter((r) => !r.has_embedding).map((r) => `${r.slug}#${r.anchor}`)).toEqual([]);

    // Both sides sorted by the same JS comparator: PG's ORDER BY follows the
    // database collation, which need not agree with code-unit order.
    const byKey = (a: { slug: string; anchor: string }, b: { slug: string; anchor: string }) =>
      a.slug === b.slug ? (a.anchor < b.anchor ? -1 : 1) : a.slug < b.slug ? -1 : 1;
    // The splitter cuts on UTF-16 code units, so a hard cut inside an overlong
    // line can split a surrogate pair; PG stores the lone half as U+FFFD. Compare
    // against the text PG receives, which is what the old splitter wrote too.
    const asStored = (s: string) =>
      s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
    const expected = pages
      .flatMap(({ page, body }) =>
        splitDocSections(page.title, body).map((s) => ({
          slug: page.slug,
          anchor: s.anchor,
          title: asStored(s.title),
          content: asStored(s.content),
        })),
      )
      .sort(byKey);
    expect(rows.map(({ has_embedding: _, ...r }) => r).sort(byKey)).toEqual(expected);
  }, 120_000);

  it('an appended section requires its own embedding and preserves the eligible original sections', async () => {
    const target = pages.find((p) => p.golden.name === 'nested-and-deep');
    if (!target) throw new Error('golden fixture has no nested-and-deep page');
    const bodies = new Map(pages.map((p) => [p.page.slug, p.body]));
    bodies.set(target.page.slug, `${target.body}\n\n## Added later\n\nA section appended after the rows were embedded.`);

    const stats = await syncDocSourceSections(sql, source(bodies), { resolveSpace: activeSpace });
    expect(stats).toMatchObject({ changed: SECTIONLESS + 1, errors: 0 });

    const rows = await storedRows();
    const changed = rows.filter((r) => r.slug === target.page.slug);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter(r => !r.has_embedding).map(r => r.anchor)).toEqual(['added-later']);
    expect(rows.filter((r) => r.slug !== target.page.slug && !r.has_embedding)).toEqual([]);
  }, 120_000);
});

describe('documentation section publication and background embedding', () => {
  let db: OrgTestDb;
  const slug = 'guide';
  const scope = 'harness:doc-test';
  const target = TARGETS.find(t => t.table === 'harness_shared.doc_sections')!;
  beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  async function publish(title: string, body: string, name = scope) {
    const page = { slug, slugs: [slug], title, url: '/guide', toc: [] };
    const src: DocSource = { name, listPages: async () => [page], getPage: async () => page, getContent: async () => body };
    return refreshDocPageSectionsWithSql(db.adminSql, src, slug, activeSpace);
  }
  const rows = (name = scope) => db.adminSql`SELECT anchor, title, content, page_sha, section_idx,
    embedding::text AS vector FROM harness_shared.doc_sections
    WHERE source_key=${name} AND slug=${slug} ORDER BY section_idx`;
  const fill = (embed: (text: string) => Promise<number[]>, maxRows = 20) => backfillTable(db.adminSql, target, {
    embed, maxRows, mode: 'gemma', spaceAware: true, profileColPresent: true, profile: EMBEDDER_DIM_SPECS.gemma,
  });

  it('counts inference for changed inputs, preserves order and refuses other scopes or model spaces', async () => {
    const embed = vi.fn(async (text: string) => Array(PROSE_VECTOR_DIMS).fill(text.length / 100));
    const title = 'Guide';
    const initial = '## One\nKeep this.\n\n## Two\nReplace this.\n\n## Removed\nDrop this.';
    const edited = '## Two\nReplacement.\n\n## One\nKeep this.';
    expect(await publish(title, initial)).toMatchObject({ ok: true, sections: 3 });
    await fill(embed);
    expect(embed).toHaveBeenCalledTimes(3);
    const kept = (await rows()).find(r => r.anchor === 'one')!.vector;
    expect(kept).toBeTruthy();
    expect(await publish(title, edited)).toMatchObject({ ok: true, sections: 2 });
    expect((await rows()).map(r => [r.anchor, r.vector])).toEqual([['two', null], ['one', kept]]);
    embed.mockClear();
    await fill(embed);
    expect(embed.mock.calls.map(([text]) => text)).toEqual(['Guide › Two\nReplacement.']);
    expect(await publish(title, edited)).toMatchObject({ ok: true, unchanged: true });
    await fill(embed);
    expect(embed).toHaveBeenCalledTimes(1);
    await db.adminSql`UPDATE harness_shared.doc_sections SET embedding_profile='retired-profile'
      WHERE source_key=${scope} AND anchor='one'`;
    await db.adminSql`UPDATE harness_shared.doc_sections SET embedding_mode='different-mode'
      WHERE source_key=${scope} AND anchor='two'`;
    expect(await publish(title, edited + '\n')).toMatchObject({ ok: true });
    expect((await rows()).map(r => r.vector)).toEqual([null, null]);
    await fill(embed);
    expect(await publish(title, edited, 'harness:other-doc-test')).toMatchObject({ ok: true });
    expect((await rows('harness:other-doc-test')).map(r => r.vector)).toEqual([null, null]);
    expect(await publish('New title', edited)).toMatchObject({ ok: true });
    expect((await rows()).map(r => r.vector)).toEqual([null, null]);
  }, 90_000);

  it('rolls back an interrupted replacement and fences an in-flight vector to its original edition', async () => {
    await db.adminSql`DELETE FROM harness_shared.doc_sections WHERE source_key IN (${scope}, 'harness:other-doc-test')`;
    const oldBody = '## A\nOriginal.';
    const newBody = '## A\nCorrected.\n\n## B\nSecond.';
    expect(await publish('Guide', oldBody)).toMatchObject({ ok: true });
    const original = await rows();
    await db.adminSql`ALTER TABLE harness_shared.doc_sections ADD CONSTRAINT stop_edition CHECK (content <> 'Second.')`;
    try {
      expect(await publish('Guide', newBody)).toMatchObject({ ok: false });
      expect(await rows()).toEqual(original);
    } finally {
      await db.adminSql`ALTER TABLE harness_shared.doc_sections DROP CONSTRAINT stop_edition`;
    }
    const late = vi.fn(async () => {
      expect(await publish('Guide', newBody)).toMatchObject({ ok: true, sections: 2 });
      return Array(PROSE_VECTOR_DIMS).fill(0.1);
    });
    await fill(late, 1);
    expect(late).toHaveBeenCalledTimes(1);
    expect((await rows()).map(r => [r.anchor, r.vector])).toEqual([['a', null], ['b', null]]);
    const fresh = vi.fn(async () => Array(PROSE_VECTOR_DIMS).fill(0.2));
    await fill(fresh);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect((await rows()).every(r => r.vector !== null)).toBe(true);
  }, 90_000);
});
