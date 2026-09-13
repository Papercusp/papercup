/**
 * semantic-dupe-guard.test — the P-008 dedup-on-create prescreen's contract:
 * hard/soft classification, threshold env overrides, and (most load-bearing)
 * that EVERY failure mode — embed throw, query throw, disabled embedder, dims
 * mismatch, budget expiry, kill switch — returns null, because a create must
 * never be blocked by embedder health.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  findSemanticDupes,
  dupeThresholds,
  type SemanticDupeDeps,
  type SemanticDupeCandidate,
} from './semantic-dupe-guard';
// The happy-path fixtures must emit exactly the prose column width, so import it
// rather than restating the number — a width change then moves these fixtures
// automatically instead of stranding them (the 384→768 strand these were fixed
// for). The MISMATCH cases below stay hardcoded on purpose: 1024 is harrier's
// real native width, a fact about that model, not about the columns.
import { PROSE_VECTOR_DIMS } from '../../search/prose-vector-dims';

const cand = (id: string, similarity: number): SemanticDupeCandidate => ({
  id,
  title: `title of ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
});

const okDeps = (candidates: SemanticDupeCandidate[], dims = PROSE_VECTOR_DIMS): SemanticDupeDeps => ({
  resolveEmbedder: async () => ({
    mode: 'gemma',
    dims,
    profile: EMBEDDER_DIM_SPECS.gemma,
    embed: async () => new Array(dims).fill(0.1),
  }),
  queryCandidates: async () => candidates,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classification', () => {
  it('splits candidates into hard (≥0.93) and soft (≥0.90, <hard), sorted by similarity desc', async () => {
    const r = await findSemanticDupes(
      { title: 't', summary: 's' },
      okDeps([cand('EI-1', 0.9), cand('EI-2', 0.95), cand('WI-3', 0.86), cand('WI-4', 0.5)]),
    );
    expect(r).not.toBeNull();
    expect(r!.hard.map((c) => c.id)).toEqual(['EI-2']);
    // WI-3 at 0.86 is BELOW the recalibrated soft band: 0.86 is the corpus mean
    // nearest-neighbour cosine here, so on its own it is not a signal at all.
    expect(r!.soft.map((c) => c.id)).toEqual(['EI-1']);
    expect(r!.thresholds).toEqual({ hard: 0.93, soft: 0.9 });
  });

  it('returns empty bands (not null) when nothing is close — "screened, no dupes"', async () => {
    const r = await findSemanticDupes({ title: 't' }, okDeps([cand('EI-1', 0.2)]));
    expect(r).toEqual({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } });
  });

  /**
   * The co-signal band (WI-38056 / D-002). These cases are the calibration
   * itself, expressed as behaviour: the six known duplicate pairs all scored
   * cosine 0.861–0.892 with title similarity 0.51–0.55, while the four
   * flagged-but-DISTINCT pairs scored cosine 0.857–0.868 with title similarity
   * ≤0.210. Cosine alone cannot tell those apart — so if either half of the
   * co-signal ever starts refusing on its own, these fail.
   */
  describe('co-signal (ordinary cosine + similar title)', () => {
    const withTitle = (id: string, similarity: number, titleSimilarity: number): SemanticDupeCandidate => ({
      ...cand(id, similarity),
      titleSimilarity,
    });

    it('REFUSES a real-duplicate-shaped pair: ordinary cosine but a similar title', async () => {
      const r = await findSemanticDupes({ title: 't' }, okDeps([withTitle('EI-dup', 0.8798, 0.5135)]));
      expect(r!.hard.map((c) => c.id)).toEqual(['EI-dup']);
      expect(r!.soft).toEqual([]);
    });

    it('does NOT refuse a distinct filing at the same cosine with a dissimilar title', async () => {
      // 0.8677 outscores the real duplicate above — which is exactly why cosine
      // is not allowed to decide on its own.
      const r = await findSemanticDupes({ title: 't' }, okDeps([withTitle('EI-distinct', 0.8677, 0.21)]));
      expect(r!.hard).toEqual([]);
      expect(r!.soft).toEqual([]);
    });

    it('does NOT refuse on a similar title alone when the cosine is unrelated', async () => {
      const r = await findSemanticDupes({ title: 't' }, okDeps([withTitle('EI-other', 0.4, 0.9)]));
      expect(r!.hard).toEqual([]);
    });

    it('fails open when the query seam supplies no titleSimilarity', async () => {
      const r = await findSemanticDupes({ title: 't' }, okDeps([cand('EI-legacy', 0.8798)]));
      expect(r!.hard).toEqual([]);
      expect(r!.soft).toEqual([]);
    });

    it('passes the new title to the query seam so it can score pg_trgm in SQL', async () => {
      const seen: Array<string | undefined> = [];
      const deps: SemanticDupeDeps = {
        resolveEmbedder: async () => ({
          mode: 'gemma',
          dims: PROSE_VECTOR_DIMS,
          profile: EMBEDDER_DIM_SPECS.gemma,
          embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
        }),
        queryCandidates: async (_vec, _mode, _harness, title) => {
          seen.push(title);
          return [];
        },
      };
      await findSemanticDupes({ title: 'the new title' }, deps);
      expect(seen).toEqual(['the new title']);
    });
  });

  it('embeds title + truncated summary in the stored bodySql shape', async () => {
    const seen: string[] = [];
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: PROSE_VECTOR_DIMS,
        profile: EMBEDDER_DIM_SPECS.gemma,
        embed: async (t: string) => {
          seen.push(t);
          return new Array(PROSE_VECTOR_DIMS).fill(0.1);
        },
      }),
      queryCandidates: async () => [],
    };
    await findSemanticDupes({ title: 'the title', summary: 'x'.repeat(3000) }, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`the title\n${'x'.repeat(2000)}`);
  });

  it('passes the resolved mode + harness through to the candidate query (space filter)', async () => {
    const calls: Array<{ mode: string; harness?: string }> = [];
    const deps: SemanticDupeDeps = {
      // `openai`, not `local`: this asserts the resolved mode is passed through
      // VERBATIM, so it must use a mode that is (a) prose-eligible and (b) not
      // the `gemma` default, or it would pass for the wrong reason. `local` was
      // the original choice and is no longer eligible at all — bge-small is
      // natively 384 with mrl:'none', so it cannot emit PROSE_VECTOR_DIMS and
      // now dims-guards off before ever reaching queryCandidates.
      resolveEmbedder: async () => ({
        mode: 'openai',
        dims: PROSE_VECTOR_DIMS,
        profile: EMBEDDER_DIM_SPECS.openai,
        embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
      }),
      queryCandidates: async (_vec, mode, harness) => {
        calls.push({ mode, harness });
        return [];
      },
    };
    await findSemanticDupes({ title: 't', harness: 'papercusp' }, deps);
    expect(calls).toEqual([{ mode: 'openai', harness: 'papercusp' }]);
  });
});

describe('threshold env overrides', () => {
  it('PAPERCUSP_WI_DUPE_HARD / _SOFT override the defaults when sane', () => {
    vi.stubEnv('PAPERCUSP_WI_DUPE_HARD', '0.97');
    vi.stubEnv('PAPERCUSP_WI_DUPE_SOFT', '0.8');
    expect(dupeThresholds()).toEqual({ hard: 0.97, soft: 0.8 });
  });

  it('garbage / out-of-range overrides fall back to the defaults', () => {
    vi.stubEnv('PAPERCUSP_WI_DUPE_HARD', 'not-a-number');
    vi.stubEnv('PAPERCUSP_WI_DUPE_SOFT', '1.7');
    expect(dupeThresholds()).toEqual({ hard: 0.93, soft: 0.9 });
  });
});

describe('fail-open — every failure mode returns null (create proceeds)', () => {
  it('embed throw', async () => {
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: PROSE_VECTOR_DIMS,
        profile: EMBEDDER_DIM_SPECS.gemma,
        embed: async () => {
          throw new Error('sidecar down');
        },
      }),
      queryCandidates: async () => [cand('EI-1', 0.99)],
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
  });

  it('candidate-query throw (e.g. migration 548 not applied)', async () => {
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: PROSE_VECTOR_DIMS,
        profile: EMBEDDER_DIM_SPECS.gemma,
        embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
      }),
      queryCandidates: async () => {
        throw new Error('column "embedding" does not exist');
      },
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
  });

  it('resolver throw + disabled embedder + dims mismatch (harrier@1024)', async () => {
    const throwing: SemanticDupeDeps = {
      resolveEmbedder: async () => {
        throw new Error('resolve failed');
      },
      queryCandidates: async () => [],
    };
    expect(await findSemanticDupes({ title: 't' }, throwing)).toBeNull();

    const disabled: SemanticDupeDeps = {
      resolveEmbedder: async () => ({ mode: 'disabled' }),
      queryCandidates: async () => [],
    };
    expect(await findSemanticDupes({ title: 't' }, disabled)).toBeNull();

    expect(await findSemanticDupes({ title: 't' }, okDeps([cand('EI-1', 0.99)], 1024))).toBeNull();
  });

  it('budget expiry: a hung embed forfeits the verdict instead of blocking the create', async () => {
    vi.useFakeTimers();
    try {
      const deps: SemanticDupeDeps = {
        resolveEmbedder: async () => ({
          mode: 'gemma',
          dims: PROSE_VECTOR_DIMS,
          profile: EMBEDDER_DIM_SPECS.gemma,
          embed: () => new Promise<number[]>(() => {}), // never settles
        }),
        queryCandidates: async () => [cand('EI-1', 0.99)],
      };
      const p = findSemanticDupes({ title: 't' }, deps);
      await vi.advanceTimersByTimeAsync(2600);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill switch PAPERCUSP_WI_SEMANTIC_DUPE=off short-circuits before any embed work', async () => {
    vi.stubEnv('PAPERCUSP_WI_SEMANTIC_DUPE', 'off');
    let touched = false;
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => {
        touched = true;
        return { mode: 'gemma', dims: PROSE_VECTOR_DIMS, embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1) };
      },
      queryCandidates: async () => [cand('EI-1', 0.99)],
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
    expect(touched).toBe(false);
  });

  it('fails closed before embedding or querying when exact profile provenance is missing', async () => {
    let embedded = false;
    let queried = false;
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: PROSE_VECTOR_DIMS,
        embed: async () => {
          embedded = true;
          return new Array(PROSE_VECTOR_DIMS).fill(0.1);
        },
      }),
      queryCandidates: async () => {
        queried = true;
        return [cand('EI-1', 0.99)];
      },
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
    expect(embedded).toBe(false);
    expect(queried).toBe(false);
  });

  it('inert under vitest WITHOUT injected deps (never lazy-loads the real model in tests)', async () => {
    expect(await findSemanticDupes({ title: 't' })).toBeNull();
  });
});
