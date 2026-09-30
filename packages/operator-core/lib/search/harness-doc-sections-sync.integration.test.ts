/**
 * Harness docs reach docs:search's semantic leg through doc_sections
 * (generic-rag-chunking-2026-09-29 P-013, acceptance bars R-29 and R-30;
 * fixes EI-24580496022910673).
 *
 * Before P-013, doc_sections held ZERO `harness:<slug>` rows: they were written
 * only by a write-time queue whose failures a bare `catch {}` swallowed, and the
 * one harness-doc vector that did exist (harness_docs.embedding) embedded only
 * the first 2,000 characters of each doc and had no reader. So text past a
 * harness doc's first 2,000 characters was unreachable by meaning.
 *
 * This file runs the real pipeline against a real, fully migrated database:
 *   1. the periodic harness-doc sweep (`runHarnessDocSectionsSweep`, its real
 *      entry point) splits every registered harness's docs into doc_sections;
 *   2. the real embed-backfill `backfillTable` pass embeds those rows;
 *   3. the real `docs:search` tool handler ranks them.
 *
 * Only the edges are stubbed: the org PG handle (pointed at a throwaway
 * database), the harness registry (pointed at temp dirs) and the query
 * embedder (a deterministic one, below).
 *
 * The embedder maps any text containing MARKER to one axis and everything else
 * to an orthogonal one. That makes the retrieval outcome depend on exactly one
 * thing: whether the text past the 2,000-character cut reached doc_sections as
 * its own section. A section built from the first 2,000 characters never
 * contains MARKER, so it can never match — harness D below is that control.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  root: '',
  slugs: [] as string[],
  embed: null as unknown,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

vi.mock('../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../harness-registry')>()),
  loadHarnessRegistry: async () => ({
    projects: h.slugs.map((slug) => ({ slug, path: join(h.root, slug) })),
  }),
  resolveHarnessContentPath: () => undefined,
}));

vi.mock('../agent-tools/docs/semantic-leg', async (orig) => ({
  ...(await orig<typeof import('../agent-tools/docs/semantic-leg')>()),
  resolveDocsEmbedder: async () => ({ embedder: h.embed, embeddingMode: 'gemma' }),
}));

const { EMBEDDER_DIM_SPECS } = await import('@papercusp/memory');
const { sectionAnchorBase } = await import('@papercusp/search');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { harnessDocSourceKey, runHarnessDocSectionsSweep, splitDocSections } = await import('./doc-embed-sync');
const { TARGETS, backfillTable, profileColOf, recipeColOf } = await import('./embed-backfill');
const { PROSE_VECTOR_DIMS } = await import('./prose-vector-dims');
const { stampEmbedderMode } = await import('./embedder-mode-registry');
const { installSearchDefaults } = await import('./configure-search-defaults');
const docsSearch = (await import('../agent-tools/docs/search')).default;

const CUT = 2_000;
const MARKER = 'quillwort';
const QUERY = 'quillwort verdigris calibration';

const embed = async (text: string): Promise<number[]> => {
  const v = new Array<number>(PROSE_VECTOR_DIMS).fill(0);
  v[text.toLowerCase().includes(MARKER) ? 0 : 1] = 1;
  return v;
};

const run = `${process.pid}-${Date.now()}`;
const SLUG_LONG = `p013-long-${run}`; // A: marker only past the cut
const SLUG_SHORT = `p013-short-${run}`; // B: a short doc, for the R-30 census
const SLUG_EMPTY = `p013-empty-${run}`; // C: registered, no docs → no collection
const SLUG_CUT = `p013-cut-${run}`; // D: A's doc truncated at the cut (control)

const filler = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} describes routine configuration of the ingest pipeline and its retry policy.`,
).join('\n\n');
const LONG_TITLE = 'Long guide';
const LONG_DOC =
  `# ${LONG_TITLE}\n\n## Opening\n\n${filler}\n\n` +
  `## Late section\n\nThe ${MARKER} verdigris calibration is documented only here, far past the cut.\n`;
const LONG_SLUG = 'docs/long-guide';

function writeDoc(slug: string, name: string, body: string): void {
  const dir = join(h.root, slug, 'docs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

async function sweepOnce() {
  // The sweep's real entry point refuses to run under vitest so an ordinary
  // unit test never touches PG. This file IS the integration test for it, so
  // lift that guard for exactly this call.
  const saved = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return await runHarnessDocSectionsSweep({ force: true });
  } finally {
    process.env.VITEST = saved;
  }
}

interface DocsSearchHit {
  slug: string;
  anchor?: string;
  semantic?: true;
  similarity?: number;
}

async function search(slug: string): Promise<{ hits: DocsSearchHit[]; legs: { semantic?: { status?: string } } }> {
  const res = (await docsSearch.handler(
    { query: QUERY, harness: slug, semantic: true, limit: 8 } as never,
    { harnessSlug: slug, isSuperuser: true } as never,
  )) as { content: Array<{ text: string }>; isError?: boolean };
  expect(res.isError, res.content[0]?.text).not.toBe(true);
  return JSON.parse(res.content[0].text);
}

describe('harness docs → doc_sections → docs:search (live SQL)', () => {
  let db: OrgTestDb;

  const census = () =>
    (db.adminSql as unknown as import('postgres').Sql).unsafe<
      Array<{ source_key: string; total: number; embedded: number }>
    >(
      `SELECT source_key, count(*)::int AS total, count(embedding)::int AS embedded
         FROM harness_shared.doc_sections
        WHERE source_key LIKE 'harness:p013-%'
        GROUP BY source_key ORDER BY source_key`,
    );

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    h.root = mkdtempSync(join(tmpdir(), 'p013-harness-docs-'));
    h.slugs = [SLUG_LONG, SLUG_SHORT, SLUG_EMPTY, SLUG_CUT];
    writeDoc(SLUG_LONG, 'long-guide.md', LONG_DOC);
    writeDoc(SLUG_SHORT, 'short.md', '# Short\n\nA brief note about deploy windows.\n');
    mkdirSync(join(h.root, SLUG_EMPTY), { recursive: true });
    writeDoc(SLUG_CUT, 'long-guide.md', LONG_DOC.slice(0, CUT));

    stampEmbedderMode(embed, 'gemma', EMBEDDER_DIM_SPECS.gemma.profileId);
    h.embed = embed;
    installSearchDefaults();
  }, 180_000);

  afterAll(async () => {
    if (h.root) rmSync(h.root, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('calibration: the marker sits only past the first 2,000 characters of the long doc', () => {
    expect(LONG_DOC.length).toBeGreaterThan(CUT);
    expect(LONG_DOC.indexOf(MARKER)).toBeGreaterThan(CUT);
    expect(LONG_DOC.slice(0, CUT)).not.toContain(MARKER);
  });

  it('R-30: after one sweep, every harness doc collection has an embedded doc_sections row', async () => {
    const res = await sweepOnce();
    expect(res).toMatchObject({ harnesses: 4, synced: 4, failed: 0, pageErrors: 0 });

    // Control: the census can report an UNembedded collection. Straight after
    // the doc sweep nothing is embedded yet, so a zero here is the instrument
    // working, and the non-zeros below come from the backfill pass alone.
    const before = await census();
    expect(before.map((r) => r.source_key)).toEqual(
      [SLUG_CUT, SLUG_LONG, SLUG_SHORT].map(harnessDocSourceKey).sort(),
    );
    expect(before.every((r) => r.total > 0 && r.embedded === 0)).toBe(true);

    const target = TARGETS.find((t) => t.table === 'harness_shared.doc_sections');
    if (!target) throw new Error('embed-backfill has no doc_sections target');
    const cols = await (db.adminSql as unknown as import('postgres').Sql).unsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'harness_shared' AND table_name = 'doc_sections'`,
    );
    const names = new Set(cols.map((c) => c.column_name));
    const stats = await backfillTable(db.adminSql as never, target, { embed: embed, maxRows: 10_000, mode: 'gemma', spaceAware: true, recipeColPresent: names.has(recipeColOf(target)),
        profileColPresent: names.has(profileColOf(target)),
        profile: EMBEDDER_DIM_SPECS.gemma });
    expect(stats).toMatchObject({ errors: 0 });

    const after = await census();
    expect(after.map((r) => r.source_key)).toEqual(before.map((r) => r.source_key));
    for (const r of after) expect(r.embedded, r.source_key).toBeGreaterThan(0);
    // A registered harness with no docs is not a collection: it gets no rows.
    expect(after.some((r) => r.source_key === harnessDocSourceKey(SLUG_EMPTY))).toBe(false);
  }, 180_000);

  it('R-29: docs:search returns the past-the-cut section of the target harness doc', async () => {
    const expected = splitDocSections(LONG_TITLE, LONG_DOC).find((s) => s.content.includes(MARKER));
    if (!expected) throw new Error('the long doc produced no section containing the marker');

    const { hits, legs } = await search(SLUG_LONG);
    expect(legs.semantic?.status).toBe('ran');
    const hit = hits.find((x) => x.slug === LONG_SLUG);
    expect(hit, JSON.stringify(hits)).toBeDefined();
    // The lexical leg reads the whole file, so it finds this page too and the
    // hit is correctly NOT `semantic: true` (that means vector-only). What only
    // the semantic leg can supply is a similarity and the matched section's
    // anchor, so those pin the hit to the doc_sections row itself.
    expect(hit?.similarity, JSON.stringify(hit)).toBeGreaterThan(0.9);
    expect(hit?.anchor, JSON.stringify(hit)).toBe(sectionAnchorBase(expected.anchor));
  }, 120_000);

  it('control: the same doc cut at 2,000 characters yields no section for that query', async () => {
    const { hits, legs } = await search(SLUG_CUT);
    expect(legs.semantic?.status).toBe('ran');
    expect(hits.filter((x) => x.slug === LONG_SLUG && (x.anchor || x.similarity !== undefined))).toEqual([]);
  }, 120_000);
});
