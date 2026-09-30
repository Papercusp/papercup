/**
 * search-rrf-fusion.test.ts — docs:search leg fusion + leg REPORTING.
 *
 * Originally WI-5690: the lexical ranking was scored, SLICED to `limit`, and
 * only THEN had semantic extras APPENDED after — so a topically-exact page
 * with a low lexical score could rank dead last, or vanish once `limit` was
 * small. Fixed by fusing the two legs with RRF (by RANK POSITION, not raw
 * score).
 *
 * P-016 re-homes that fusion onto `@papercusp/search`'s `runHybridSearch`
 * instead of hand-rolling it here. The ranking behaviour below is unchanged
 * and still asserted — a migration that quietly altered the ranking would be
 * a regression, not a refactor — and the NEW contract (the per-leg execution
 * report) is asserted alongside it.
 *
 * Drives the REAL tool handler against REAL lexical BM25 scoring over a temp
 * on-disk docs tree (genericFsAdapter via PAPERCUSP_PROJECT_DOCS_ROOT — no PG
 * needed), mocking only `../semantic-leg` so the embedding leg is fixture-fed
 * (the real resolver lazy-loads an ONNX model — WI-3792's load-scar class).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveDocsEmbedder, docSectionsRanker, runHybridSearch, interactiveEmbedAcquireBudgetMs } = vi.hoisted(() => ({
  resolveDocsEmbedder: vi.fn(),
  docSectionsRanker: vi.fn(),
  runHybridSearch: vi.fn(),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 4321),
}));
vi.mock('../semantic-leg', () => ({ resolveDocsEmbedder, docSectionsRanker }));
vi.mock('../../search/embedder', () => ({ interactiveEmbedAcquireBudgetMs }));

vi.mock('@papercusp/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/search')>();
  runHybridSearch.mockImplementation(actual.runHybridSearch);
  return { ...actual, runHybridSearch };
});

import searchTool from '../search';

const ORIGINAL_ENV = process.env.PAPERCUSP_PROJECT_DOCS_ROOT;

let root: string;

function noisePage(repeats: number): string {
  return `# Gadget noise\n\n${'gadget '.repeat(repeats)}rollout continues.\n`;
}

const BURIED_SLUG = 'topically-exact-not-on-disk';

interface SemHit {
  slug: string;
  url: string;
  title: string;
  anchor: string;
  similarity: number;
  excerpt: string;
}

/** Wire the mocked semantic leg to return `hits`, mirroring the real shape:
 *  a resolved embedder + a ranker that sinks each hit and returns a Listing. */
function semanticReturns(hits: SemHit[]): void {
  resolveDocsEmbedder.mockResolvedValue({ embedder: async () => [0.1, 0.2], embeddingMode: 'gemma' });
  docSectionsRanker.mockImplementation(
    (sourceKey: string, _mode: string, sink: (h: SemHit) => void) => async () =>
      hits.map((h) => {
        sink(h);
        return {
          key: h.slug,
          score: h.similarity,
          row: {
            source: sourceKey,
            source_id: h.slug,
            excerpt: h.excerpt,
            highlight: h.title,
            score: h.similarity,
            rankers: ['embeddings'],
          },
        };
      }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'docs-rrf-fixture-'));
  // Descending lexical weight: n1 scores highest, n3 lowest — none mention
  // the buried page's topic at all, mirroring the plans RRF fixture.
  await writeFile(join(root, 'noise-one.md'), noisePage(30), 'utf8');
  await writeFile(join(root, 'noise-two.md'), noisePage(20), 'utf8');
  await writeFile(join(root, 'noise-three.md'), noisePage(10), 'utf8');
  process.env.PAPERCUSP_PROJECT_DOCS_ROOT = root;
}, 30_000);

afterAll(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
  else process.env.PAPERCUSP_PROJECT_DOCS_ROOT = ORIGINAL_ENV;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  resolveDocsEmbedder.mockReset();
  docSectionsRanker.mockReset();
  runHybridSearch.mockClear();
  interactiveEmbedAcquireBudgetMs.mockClear();
});

interface Hit {
  slug: string;
  title: string;
  score: number;
  semantic?: true;
  similarity?: number;
  anchor?: string;
}
interface LegReport {
  status: string;
  blocked?: string | null;
  candidates?: number;
}
interface Payload {
  hits: Hit[];
  semanticHitCount?: number;
  legs: { lexical: LegReport; semantic: LegReport; degraded: boolean; warning: string | null };
  applied: Record<string, unknown>;
}

async function runSearch(query: string, args: Record<string, unknown> = {}): Promise<Payload> {
  const ctx = { metadata: () => {}, log: () => {}, progress: () => {} } as never;
  const res = (await searchTool.handler(
    { query, harness: 'all', semantic: true, limit: 4, ...args } as never,
    ctx,
  )) as { content: { text: string }[] };
  return JSON.parse(res.content[0].text) as Payload;
}

describe('docs:search RRF fusion (WI-5690, on the engine per P-016)', () => {
  it('a page found ONLY via the semantic leg (rank #1 there) is not buried behind lexical noise', async () => {
    semanticReturns([
      { slug: BURIED_SLUG, url: `/${BURIED_SLUG}`, title: 'The exact topic page', anchor: 's1', similarity: 0.93, excerpt: 'exact answer' },
    ]);
    const { hits } = await runSearch('gadget');
    const buriedIdx = hits.findIndex((h) => h.slug === BURIED_SLUG);
    expect(buriedIdx, 'buried page must be present').toBeGreaterThanOrEqual(0);
    // Pre-fix it was appended after every lexical hit (dead last among the
    // extras); post-fix its semantic rank-#1 RRF contribution ties/beats
    // every lexical entry beyond rank #1, so it must land ahead of at least
    // the lowest-scoring noise page.
    const noiseThreeIdx = hits.findIndex((h) => h.slug === 'noise-three');
    expect(noiseThreeIdx).toBeGreaterThanOrEqual(0);
    expect(buriedIdx).toBeLessThan(noiseThreeIdx);

    const buried = hits[buriedIdx];
    expect(buried.semantic).toBe(true);
    expect(buried.similarity).toBe(0.93);
    // Hydrated from the semantic leg's sink — the engine's SearchHit carries
    // no anchor, so losing this is exactly what the sink exists to prevent.
    expect(buried.anchor).toBe('s1');
    expect(buried.title).toBe('The exact topic page');
  });

  it('a page found by BOTH legs keeps its lexical excerpt and is not marked semantic-only', async () => {
    semanticReturns([
      { slug: 'noise-one', url: '/noise-one', title: 'Gadget noise', anchor: 'rollout', similarity: 0.5, excerpt: 'gadget gadget' },
    ]);
    const { hits } = await runSearch('gadget');
    const n1 = hits.find((h) => h.slug === 'noise-one');
    expect(n1).toBeTruthy();
    expect(n1?.semantic).toBeUndefined();
    expect(n1?.similarity).toBe(0.5);
    // ...and still names the section the semantic leg matched (generic-rag-chunking
    // P-013): dropping it made a harness doc matched by both legs return only its page.
    expect(n1?.anchor).toBe('rollout');
  });

  it('a section whose vector hit was floored away lends its page no anchor', async () => {
    semanticReturns([
      { slug: 'noise-one', url: '/noise-one', title: 'Gadget noise', anchor: 'rollout', similarity: 0.5, excerpt: 'gadget gadget' },
    ]);
    // The ranker's sink records the anchor before the engine applies its floor;
    // a floor above 0.5 then drops that vector hit, leaving a lexical-only page.
    const actual = runHybridSearch.getMockImplementation();
    if (!actual) throw new Error('runHybridSearch lost its pass-through implementation');
    runHybridSearch.mockImplementationOnce((sources: unknown, opts: Record<string, unknown>) =>
      actual(sources, { ...opts, minScore: { embeddings: 0.9 } }),
    );
    const { hits } = await runSearch('gadget');
    const n1 = hits.find((h) => h.slug === 'noise-one');
    expect(n1).toBeTruthy();
    expect(n1?.similarity).toBeUndefined();
    expect(n1?.anchor).toBeUndefined();
  });

  it('reports BOTH legs as having run on a healthy hybrid search', async () => {
    semanticReturns([
      { slug: BURIED_SLUG, url: `/${BURIED_SLUG}`, title: 'T', anchor: '', similarity: 0.93, excerpt: 'e' },
    ]);
    const { legs } = await runSearch('gadget');
    expect(legs.lexical.status).toBe('ran');
    expect(legs.semantic.status).toBe('ran');
    expect(legs.degraded).toBe(false);
  });

  it('passes the bounded query-embed timeout to the hybrid engine', async () => {
    semanticReturns([
      { slug: BURIED_SLUG, url: `/${BURIED_SLUG}`, title: 'T', anchor: '', similarity: 0.93, excerpt: 'e' },
    ]);

    await runSearch('gadget');

    expect(runHybridSearch).toHaveBeenCalledTimes(1);
    expect(runHybridSearch.mock.calls[0]?.[1]).toMatchObject({ embedTimeoutMs: 4321 });
  });
});

/**
 * D-023's CALIBRATION PAIR — the two tests below are each other's control.
 *
 * Same handler, one differing input, opposite assertions. Collapse the caller
 * to always-null and the BLOCKED test fails; make it always-blocked and the
 * NOT-RUN test fails. Neither can go green by accident, which is the point:
 * the engine flags `blocked` as degraded but deliberately does NOT flag
 * `not-run`, so a caller that reports a dead embedder as `not-run` produces a
 * result indistinguishable from an intentionally lexical-only search.
 */
describe('docs:search semantic-leg honesty (D-023 calibration pair)', () => {
  it('BLOCKED: a dead embedder degrades to lexical-only AND says so', async () => {
    resolveDocsEmbedder.mockResolvedValue({
      embedder: async () => { throw new Error('embedder unavailable'); },
      embeddingMode: null,
    });
    const { hits, legs } = await runSearch('gadget');
    // Still fails open — the lexical ranking stands, unchanged.
    expect(hits.map((h) => h.slug)).toEqual(['noise-one', 'noise-two', 'noise-three']);
    expect(hits.every((h) => h.semantic === undefined)).toBe(true);
    // ...but the degradation is REPORTED, which is the whole fix.
    expect(legs.semantic.status).not.toBe('not-run');
    expect(legs.semantic.blocked).toMatch(/embedder unavailable/);
    expect(legs.degraded).toBe(true);
    expect(legs.warning).toBeTruthy();
  });

  it('NOT-RUN: semantic:false is lexical-only and is NOT degraded', async () => {
    // The one case `embedder: null` correctly describes. An intentionally
    // lexical-only search is healthy — flagging it would train readers to
    // ignore `degraded` entirely, which is why the engine excludes not-run.
    const { hits, legs } = await runSearch('gadget', { semantic: false });
    expect(hits.map((h) => h.slug)).toEqual(['noise-one', 'noise-two', 'noise-three']);
    expect(legs.semantic.status).toBe('not-run');
    expect(legs.semantic.blocked ?? null).toBeNull();
    expect(legs.degraded).toBe(false);
    // The embedder must never even be RESOLVED when the leg was not wanted
    // (the real resolver lazy-loads an ONNX model).
    expect(resolveDocsEmbedder).not.toHaveBeenCalled();
  });
});
