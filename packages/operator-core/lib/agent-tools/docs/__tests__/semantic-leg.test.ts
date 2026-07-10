/**
 * semantic-leg — P-009 docs:search embedding leg
 * (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Everything through injected deps (the real resolver lazy-loads an ONNX
 * model — WI-3792 load-scar class); the no-deps case asserts VITEST inertness.
 * Null is the ONLY failure shape: every degraded path must yield lexical-only,
 * never a throw.
 */

import { describe, it, expect } from 'vitest';
import { semanticDocHits, type DocSemanticDeps, type DocSemanticHit } from '../semantic-leg';

const VEC = Array.from({ length: 384 }, () => 0.1);

function hit(slug: string, anchor: string, similarity: number): DocSemanticHit {
  return { slug, anchor, similarity, url: `/docs/${slug}`, title: slug, excerpt: 'x' };
}

function deps(over: Partial<DocSemanticDeps> = {}): DocSemanticDeps {
  return {
    resolveEmbedder: async () => ({ mode: 'gemma', dims: 384, embed: async () => VEC }),
    querySections: async () => [hit('a', 's1', 0.9), hit('a', 's2', 0.85), hit('b', '', 0.8), hit('c', 's', 0.7)],
    ...over,
  };
}

describe('semanticDocHits', () => {
  it('is inert under vitest without injected deps', async () => {
    expect(await semanticDocHits('q', 'papercusp-engineering', 8)).toBeNull();
  });

  it('dedupes to the best section per page and caps at limit', async () => {
    const hits = await semanticDocHits('q', 'src', 2, deps());
    expect(hits).not.toBeNull();
    expect(hits!.map((h) => h.slug)).toEqual(['a', 'b']);
    expect(hits![0].anchor).toBe('s1'); // distance-ordered: first (best) section wins
  });

  it('passes the resolved mode + source key through to the query', async () => {
    let got: unknown[] = [];
    await semanticDocHits('q', 'harness:demo', 5, deps({
      querySections: async (vec, mode, sourceKey, limit) => {
        got = [vec.length, mode, sourceKey, limit];
        return [];
      },
    }));
    expect(got).toEqual([384, 'gemma', 'harness:demo', 15]); // limit × OVERFETCH
  });

  it('returns null when no embedder resolves', async () => {
    expect(await semanticDocHits('q', 'src', 8, deps({ resolveEmbedder: async () => null }))).toBeNull();
  });

  it('returns null on a dims mismatch (harrier@1024 vs vector(384))', async () => {
    const d = deps({ resolveEmbedder: async () => ({ mode: 'harrier', dims: 1024, embed: async () => VEC }) });
    expect(await semanticDocHits('q', 'src', 8, d)).toBeNull();
  });

  it('returns null when the embed output width is wrong', async () => {
    const d = deps({ resolveEmbedder: async () => ({ mode: 'gemma', dims: 384, embed: async () => [1, 2, 3] }) });
    expect(await semanticDocHits('q', 'src', 8, d)).toBeNull();
  });

  it('returns null (never throws) when the resolver or query throws', async () => {
    expect(await semanticDocHits('q', 'src', 8, deps({ resolveEmbedder: async () => { throw new Error('boom'); } }))).toBeNull();
    expect(await semanticDocHits('q', 'src', 8, deps({ querySections: async () => { throw new Error('552 absent'); } }))).toBeNull();
  });
});
