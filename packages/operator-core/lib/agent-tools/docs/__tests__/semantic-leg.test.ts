/**
 * semantic-leg — the docs:search embedding leg, as `@papercusp/search` parts
 * (P-016 of semantic-search-fingerprint-coverage-2026-08-03).
 *
 * Everything through injected deps (the real resolver lazy-loads an ONNX
 * model — WI-3792 load-scar class).
 *
 * ⚠ THE CONTRACT INVERTED HERE (plan decision D-023). This file previously
 * asserted "null is the ONLY failure shape: every degraded path must yield
 * lexical-only, never a throw". Under the engine that is precisely wrong: a
 * caller passing `embedder: null` makes the engine report `status:'not-run'`,
 * which `summariseLegs` deliberately does NOT flag as degraded — so a DEAD
 * embedder would be indistinguishable from a search that never wanted a
 * semantic leg. The search must still DEGRADE to lexical-only (it does, in the
 * engine), but it must SAY SO. So every degraded path now yields an embedder
 * that REJECTS with the reason, and these tests assert the reason text.
 */

import { describe, it, expect, vi } from 'vitest';

const { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } = vi.hoisted(() => ({
  buildQueryEmbedderResolved: vi.fn(),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 4321),
}));
vi.mock('../../search/embedder', () => ({
  buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs,
}));
import {
  resolveDocsEmbedder,
  docSectionsRanker,
  realDocSemanticDeps,
  type DocSemanticDeps,
  type DocSemanticHit,
} from '../semantic-leg';
// Import the width — these fixtures are ABOUT the prose column contract, so a
// width change must move them automatically rather than stranding them here.
import { PROSE_VECTOR_DIMS } from '../../../search/prose-vector-dims';

const VEC = Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.1);

function hit(slug: string, anchor: string, similarity: number): DocSemanticHit {
  return { slug, anchor, similarity, url: `/docs/${slug}`, title: slug, excerpt: 'x' };
}

function deps(over: Partial<DocSemanticDeps> = {}): DocSemanticDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed: async () => VEC }),
    querySections: async () => [hit('a', 's1', 0.9), hit('a', 's2', 0.85), hit('b', '', 0.8), hit('c', 's', 0.7)],
    ...over,
  };
}

/** The reason a rejecting embedder carries, or null if it did not reject. */
async function rejection(embedder: (t: string) => Promise<number[]>): Promise<string | null> {
  try {
    await embedder('q');
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('resolveDocsEmbedder — D-023: degraded means BLOCKED, never not-run', () => {
  it('returns the real embedder + its mode when everything resolves', async () => {
    const { embedder, embeddingMode } = await resolveDocsEmbedder(deps());
    expect(embeddingMode).toBe('gemma');
    expect(await embedder('q')).toHaveLength(PROSE_VECTOR_DIMS);
  });

  it('rejects (not null) when no embedder resolves', async () => {
    const { embedder, embeddingMode } = await resolveDocsEmbedder(deps({ resolveEmbedder: async () => null }));
    expect(embeddingMode).toBeNull();
    expect(await rejection(embedder)).toMatch(/no query embedder resolved/);
  });

  it('rejects on a dims mismatch (harrier@1024 vs the prose column width)', async () => {
    const { embedder, embeddingMode } = await resolveDocsEmbedder(
      deps({ resolveEmbedder: async () => ({ mode: 'harrier', dims: 1024, embed: async () => VEC }) }),
    );
    expect(embeddingMode).toBeNull();
    expect(await rejection(embedder)).toMatch(/dims 1024 do not fit/);
  });

  it('does NOT guard the embed OUTPUT width — that check would cost the floor (D-024)', async () => {
    // The old code wrapped `resolved.embed` to reject a wrong-width vector.
    // That wrapper is a different function object, and the P-017 floor is a
    // WeakMap lookup on the embedder INSTANCE — so the guard silently cost the
    // surface its floor. The check is deliberately gone: a wrong-width vector
    // now fails inside the source's embedding query, which the engine reports
    // in `legs.semantic.failures` (louder than the old silent lexical-only).
    // Pinned here so nobody "fixes" the missing guard and re-breaks the floor.
    const embed = async (): Promise<number[]> => [1, 2, 3];
    const { embedder, embeddingMode } = await resolveDocsEmbedder(
      deps({ resolveEmbedder: async () => ({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed }) }),
    );
    expect(embeddingMode).toBe('gemma');
    expect(embedder).toBe(embed);
    expect(await rejection(embedder)).toBeNull();
  });

  it('rejects (never throws out of the resolve) when the resolver throws', async () => {
    const { embedder, embeddingMode } = await resolveDocsEmbedder(
      deps({ resolveEmbedder: async () => { throw new Error('boom'); } }),
    );
    expect(embeddingMode).toBeNull();
    expect(await rejection(embedder)).toMatch(/resolution threw: boom/);
  });

  it('suppresses the real ONNX resolver under vitest — as BLOCKED, not silently', async () => {
    // WI-3792 load-scar class. A test that forgot to inject deps must fail
    // loudly rather than read a suppressed embedder as a healthy search.
    const { embedder, embeddingMode } = await resolveDocsEmbedder();
    expect(embeddingMode).toBeNull();
    expect(await rejection(embedder)).toMatch(/vitest: real embedder resolution suppressed/);
  });
});

describe('realDocSemanticDeps — bounded query-embedder acquisition', () => {
  it('passes the interactive acquisition budget to the shared resolver', async () => {
    const embed = async (): Promise<number[]> => VEC;
    buildQueryEmbedderResolved.mockResolvedValueOnce({ mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed });

    const resolved = await realDocSemanticDeps.resolveEmbedder();

    expect(interactiveEmbedAcquireBudgetMs).toHaveBeenCalledTimes(1);
    expect(buildQueryEmbedderResolved).toHaveBeenCalledWith({ acquireBudgetMs: 4321 });
    expect(resolved?.embed).toBe(embed);
  });
});

describe('docSectionsRanker', () => {
  const qVec = `[${VEC.join(',')}]`;
  const params = (limit: number) =>
    ({
      query: 'q',
      limit,
      qVec,
      sql: null,
      workspaceId: '',
      scopeFilter: null,
      embeddingProfile: {
        profileId: 'gemma-embeddinggemma-300m-768@v1',
        legacyMode: 'gemma',
      },
    }) as never;

  it('dedupes to the best section per page and caps at limit', async () => {
    const listing = await docSectionsRanker('src', 'gemma', () => {}, deps())(params(2));
    expect(listing.map((l) => l.key)).toEqual(['a', 'b']);
    // distance-ordered: the first (best) section of page 'a' wins
    expect(listing[0].score).toBe(0.9);
  });

  it('scores on raw cosine so the engine can floor it', async () => {
    // The P-017 floor runs on the ranker's NATIVE score before fusion. Emitting
    // anything else here (a normalised or rank-derived value) would silently
    // make the gemma floor mean nothing. (Value deliberately not restated —
    // it lives in search/prose-min-score.ts and has moved once already.)
    const listing = await docSectionsRanker('src', 'gemma', () => {}, deps())(params(4));
    expect(listing.map((l) => l.score)).toEqual([0.9, 0.8, 0.7]);
  });

  it('passes the mode + source key + over-fetched limit through to the query', async () => {
    let got: unknown[] = [];
    await docSectionsRanker('harness:demo', 'gemma', () => {}, deps({
      querySections: async (vec, mode, sourceKey, limit, identity) => {
        got = [vec.length, mode, sourceKey, limit, identity];
        return [];
      },
    }))(params(5));
    expect(got).toEqual([
      PROSE_VECTOR_DIMS,
      'gemma',
      'harness:demo',
      15,
      { profileId: 'gemma-embeddinggemma-300m-768@v1', legacyMode: 'gemma' },
    ]); // limit × OVERFETCH
  });

  it('sinks each page hit so the caller can hydrate anchor/url/title after fusion', async () => {
    const sunk: DocSemanticHit[] = [];
    await docSectionsRanker('src', 'gemma', (h) => sunk.push(h), deps())(params(2));
    expect(sunk.map((h) => [h.slug, h.anchor])).toEqual([['a', 's1'], ['b', '']]);
  });

  it('PROPAGATES a store failure rather than swallowing it', async () => {
    // The engine catches a source throw, records it in `legs.semantic.failures`
    // and degrades. Swallowing it here would make a broken doc_sections read
    // look like a leg that simply found nothing — the same silent degradation
    // D-023 removes one level up.
    const ranker = docSectionsRanker('src', 'gemma', () => {}, deps({
      querySections: async () => { throw new Error('552 absent'); },
    }));
    await expect(ranker(params(4))).rejects.toThrow('552 absent');
  });
});
