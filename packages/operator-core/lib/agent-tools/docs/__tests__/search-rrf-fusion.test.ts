/**
 * search-rrf-fusion.test.ts — WI-5690 fix (sibling of WI-5683's
 * plans/__tests__/search-rrf-fusion.integration.test.ts).
 *
 * Bug: docs:search's `searchDocs()` lexical ranking (real BM25 in
 * @papercusp/docs-engine, unlike plans:search's raw-TF scorer) was scored,
 * SLICED to `limit`, and only THEN had up to 3 semantic-embedding extras
 * APPENDED after — so a page that is a topically-exact match but whose
 * lexical score is low/zero (a rephrased query whose words never appear
 * verbatim in the answer doc) could rank dead last among the appended
 * extras, or be entirely absent once `limit` was small.
 *
 * Fix: over-fetch the lexical leg past `limit`, then fuse it with the
 * semantic ranking via Reciprocal Rank Fusion (@papercusp/rrf, the same
 * mechanism plans:search / search:semantic already use) — combining by RANK
 * POSITION, not raw score, so a page that ranks #1 semantically can't be
 * buried behind pages that only win on raw lexical frequency.
 *
 * `semanticDocHits` is inert under vitest without deps injected (by design —
 * the real resolver lazy-loads an embedder, WI-3792's load-scar class) and
 * docs/search.ts calls it with no deps override, so this test mocks
 * `../semantic-leg` directly to drive the RRF fusion path through the REAL
 * tool handler, against REAL lexical BM25 scoring over a temp on-disk docs
 * tree (genericFsAdapter, via PAPERCUSP_PROJECT_DOCS_ROOT — no PG needed).
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { semanticDocHits } = vi.hoisted(() => ({ semanticDocHits: vi.fn() }));
vi.mock('../semantic-leg', () => ({ semanticDocHits }));

import searchTool from '../search';

const ORIGINAL_ENV = process.env.PAPERCUSP_PROJECT_DOCS_ROOT;

let root: string;

function noisePage(repeats: number): string {
  return `# Gadget noise\n\n${'gadget '.repeat(repeats)}rollout continues.\n`;
}

const BURIED_SLUG = 'topically-exact-not-on-disk';

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
  semanticDocHits.mockReset();
});

interface Hit {
  slug: string;
  score: number;
  semantic?: true;
  similarity?: number;
}

async function runSearch(query: string, args: Record<string, unknown> = {}): Promise<{ hits: Hit[]; semanticHitCount?: number }> {
  const ctx = { metadata: () => {}, log: () => {}, progress: () => {} } as never;
  const res = (await searchTool.handler(
    { query, harness: 'all', semantic: true, limit: 4, ...args } as never,
    ctx,
  )) as { content: { text: string }[] };
  return JSON.parse(res.content[0].text) as { hits: Hit[]; semanticHitCount?: number };
}

describe('docs:search RRF fusion (WI-5690)', () => {
  it('a page found ONLY via the semantic leg (rank #1 there) is not buried behind lexical noise', async () => {
    semanticDocHits.mockResolvedValue([
      { slug: BURIED_SLUG, url: `/${BURIED_SLUG}`, title: 'The exact topic page', anchor: '', similarity: 0.93, excerpt: 'exact answer' },
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
  });

  it('a page found by BOTH legs keeps its lexical excerpt and is not marked semantic-only', async () => {
    semanticDocHits.mockResolvedValue([
      { slug: 'noise-one', url: '/noise-one', title: 'Gadget noise', anchor: '', similarity: 0.5, excerpt: 'gadget gadget' },
    ]);
    const { hits } = await runSearch('gadget');
    const n1 = hits.find((h) => h.slug === 'noise-one');
    expect(n1).toBeTruthy();
    expect(n1?.semantic).toBeUndefined();
    expect(n1?.similarity).toBe(0.5);
  });

  it('fails open to lexical-only ranking when the semantic leg throws', async () => {
    semanticDocHits.mockRejectedValue(new Error('embedder unavailable'));
    const { hits } = await runSearch('gadget');
    expect(hits.map((h) => h.slug)).toEqual(['noise-one', 'noise-two', 'noise-three']);
    expect(hits.every((h) => h.semantic === undefined)).toBe(true);
  });

  it('fails open to lexical-only ranking when the semantic leg returns null', async () => {
    semanticDocHits.mockResolvedValue(null);
    const { hits } = await runSearch('gadget');
    expect(hits.map((h) => h.slug)).toEqual(['noise-one', 'noise-two', 'noise-three']);
  });
});
