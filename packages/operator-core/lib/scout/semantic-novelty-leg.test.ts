/**
 * Tests for the P-017 hybrid semantic-novelty leg (D-016). Two halves:
 *   - the PURE blend in corpusNovelty (max(lexical, cosine), computed before the
 *     <=0 skip so a re-worded re-encounter with zero lexical overlap is caught —
 *     the 2026-07-10 dupe-storm regression);
 *   - the IMPURE leg (resolveSemanticNoveltySims / corpusNoveltyHybrid): JOIN
 *     partition by ref shape, and the fail-open contract (disabled / dims-mismatch
 *     / kill-switch / VITEST-inert all degrade to pure lexical).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

import { corpusNovelty, type CorpusEntry } from './critique-core';
import {
  resolveSemanticNoveltySims,
  corpusNoveltyHybrid,
  implementationCorpusCandidateFromRow,
  mergeImplementationCorpus,
  type ImplementationCorpusCandidate,
  type SemanticNoveltyDeps,
} from './semantic-novelty-leg';
import { PROSE_VECTOR_DIMS } from '../search/prose-vector-dims';

// The prose column width, imported not restated: a width change must move this
// fixture automatically rather than stranding it (the 384→768 strand).
const DIM = PROSE_VECTOR_DIMS;

function makeDeps(opts: {
  planSims?: Record<string, number>;
  wiSims?: Record<string, number>;
  dims?: number;
  mode?: string;
  disabled?: boolean;
  embedLen?: number;
  implementationCandidates?: ImplementationCorpusCandidate[];
  implementationError?: boolean;
}): SemanticNoveltyDeps & {
  queryPlanSims: ReturnType<typeof vi.fn>;
  queryWorkItemSims: ReturnType<typeof vi.fn>;
} {
  const queryPlanSims = vi.fn(async (_v: number[], _m: string, slugs: string[]) => {
    const m = new Map<string, number>();
    for (const s of slugs) if (opts.planSims && s in opts.planSims) m.set(s, opts.planSims[s]);
    return m;
  });
  const queryWorkItemSims = vi.fn(async (_v: number[], _m: string, ids: string[]) => {
    const m = new Map<string, number>();
    for (const id of ids) if (opts.wiSims && id in opts.wiSims) m.set(id, opts.wiSims[id]);
    return m;
  });
  const resolveEmbedder = async () =>
    opts.disabled
      ? { mode: 'disabled' as const, reason: 'test' }
      : {
          mode: opts.mode ?? 'gemma',
          dims: opts.dims ?? DIM,
          embed: async () => new Array(opts.embedLen ?? DIM).fill(0.01),
        };
  const queryImplementationCorpus = vi.fn(async () => {
    if (opts.implementationError) throw new Error('implementation corpus unavailable');
    return opts.implementationCandidates ?? [];
  });
  return { resolveEmbedder, queryPlanSims, queryWorkItemSims, queryImplementationCorpus };
}

describe('WI-6773 — evidence-backed implementation corpus', () => {
  it('maps a settled row to a shipped wi:<id> prior using completion summary + whatLanded', () => {
    const candidate = implementationCorpusCandidateFromRow({
      id: 'WI-42',
      title: 'Add graduated account throttling',
      completion_evidence: {
        summary: 'Shipped a graduated per-account throttle ladder.',
        whatLanded: ['Bare 429s now rotate egress before pausing the account.'],
        testResult: '12/12 green',
      },
      similarity: '0.934',
    });
    expect(candidate).toEqual({
      entry: {
        ref: 'wi:WI-42',
        kind: 'implementation',
        state: 'shipped',
        text: 'Add graduated account throttling\nShipped a graduated per-account throttle ladder.\nBare 429s now rotate egress before pausing the account.',
      },
      similarity: 0.93,
    });
  });

  it('excludes a row whose completion evidence has verification but no description of what landed', () => {
    expect(
      implementationCorpusCandidateFromRow({
        id: 'WI-43',
        title: 'Ambiguous completion',
        completion_evidence: { testResult: 'green', verifiedHow: 'unit' },
        similarity: 0.9,
      }),
    ).toBeNull();
  });

  it('merges a routed idea and its realized completion into one shipped corpus ref', () => {
    const merged = mergeImplementationCorpus(
      [{ ref: 'wi:WI-42', kind: 'idea', text: 'Propose an account throttle ladder' }],
      [
        {
          entry: {
            ref: 'wi:WI-42',
            kind: 'implementation',
            text: 'Shipped the account throttle ladder',
            state: 'shipped',
          },
          similarity: 0.9,
        },
      ],
    );
    expect(merged).toEqual([
      {
        ref: 'wi:WI-42',
        kind: 'implementation',
        text: 'Propose an account throttle ladder\nShipped the account throttle ladder',
        state: 'shipped',
      },
    ]);
  });

  it('queries the full settled corpus by semantic distance, never by recency', () => {
    const source = readFileSync(new URL('./semantic-novelty-leg.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function queryImplementationCorpusReal');
    const end = source.indexOf('\nconst realDeps', start);
    const sql = source.slice(start, end);
    expect(sql).toMatch(/work_item_status_is_terminal\(status\)/);
    expect(sql).toMatch(/authority IN \('committed', 'validated'\)/);
    expect(sql).toMatch(/payload -> '_completionEvidence'/);
    expect(sql).toMatch(/ORDER BY embedding <=>/);
    expect(sql).toMatch(/LIMIT \$\{IMPLEMENTATION_CORPUS_TOP_K\}/);
    expect(sql).not.toMatch(/ORDER BY[^\n]*(?:closed|updated|created)/i);
  });
});

describe('corpusNovelty — pure P-017 blend (semanticSimByRef)', () => {
  it('blends max(lexical, cosine): a lower cosine never lowers an identical lexical match', () => {
    const corpus: CorpusEntry[] = [{ ref: 'plan:p', kind: 'plan', text: 'token bucket rate limiter' }];
    const r = corpusNovelty('token bucket rate limiter', corpus, {
      semanticSimByRef: new Map([['plan:p', 0.2]]),
    });
    expect(r.novelty).toBe(0);
    expect(r.matches[0].similarity).toBe(1);
    expect(r.matches[0].semantic).toBeUndefined();
  });

  it('catches a re-worded re-encounter lexical misses (lexical≈0, cosine high) — the dupe-storm regression', () => {
    const corpus: CorpusEntry[] = [{ ref: 'plan:cache', kind: 'plan', text: 'cache the corpus digest between passes' }];
    const query = 'quantum flux capacitor teleport'; // ~zero token overlap with the prior

    // Pure lexical: maximally novel, no match (this is the miss the leg fixes).
    const lexicalOnly = corpusNovelty(query, corpus);
    expect(lexicalOnly.novelty).toBe(1);
    expect(lexicalOnly.matches).toEqual([]);

    // With the semantic neighbour: caught, low novelty, flagged semantic.
    const hybrid = corpusNovelty(query, corpus, { semanticSimByRef: new Map([['plan:cache', 0.95]]) });
    expect(hybrid.matches).toHaveLength(1);
    expect(hybrid.matches[0].ref).toBe('plan:cache');
    expect(hybrid.matches[0].similarity).toBe(0.95);
    expect(hybrid.matches[0].semantic).toBe(true);
    expect(hybrid.novelty).toBeLessThanOrEqual(0.05);
  });

  it('a decided semantic match still earns the already-tried penalty', () => {
    const corpus: CorpusEntry[] = [{ ref: 'wi:F-9', kind: 'idea', text: 'unrelated words here', state: 'dropped' }];
    const r = corpusNovelty('completely disjoint tokens abcdef', corpus, {
      semanticSimByRef: new Map([['wi:F-9', 0.9]]),
    });
    expect(r.alreadyTried).toBe(true);
    expect(r.matches[0].semantic).toBe(true);
  });
});

describe('resolveSemanticNoveltySims — JOIN partition + fail-open', () => {
  const corpus: CorpusEntry[] = [
    { ref: 'plan:alpha', kind: 'plan', text: 'alpha plan' },
    { ref: 'wi:F-1', kind: 'idea', text: 'idea one' },
    { ref: 'some-plan#D-3', kind: 'decision', text: 'a decision' }, // no stored vector
    { ref: 'gym:step-7', kind: 'idea', text: 'a gym stepping stone' }, // no stored vector
  ];

  it('partitions plan: → 553 and wi: → 551, keys sims back by ref, and ignores decisions/gym refs', async () => {
    const deps = makeDeps({ planSims: { alpha: 0.9 }, wiSims: { 'F-1': 0.8 } });
    const sims = await resolveSemanticNoveltySims('query text', corpus, deps);
    expect(sims).not.toBeNull();
    expect(sims!.get('plan:alpha')).toBe(0.9);
    expect(sims!.get('wi:F-1')).toBe(0.8);
    expect(sims!.has('some-plan#D-3')).toBe(false);
    expect(sims!.has('gym:step-7')).toBe(false);
    // Slugs/ids are stripped of their ref prefix before the join.
    expect(deps.queryPlanSims).toHaveBeenCalledWith(expect.anything(), 'gemma', ['alpha']);
    expect(deps.queryWorkItemSims).toHaveBeenCalledWith(expect.anything(), 'gemma', ['F-1']);
  });

  it('fail-opens to null when the embedder is disabled', async () => {
    const sims = await resolveSemanticNoveltySims('q', corpus, makeDeps({ disabled: true }));
    expect(sims).toBeNull();
  });

  it('fail-opens to null on a dims mismatch (harrier@1024 ≠ vector(384))', async () => {
    const sims = await resolveSemanticNoveltySims('q', corpus, makeDeps({ dims: 1024, planSims: { alpha: 0.9 } }));
    expect(sims).toBeNull();
  });

  it('fail-opens to null when the embedder returns a wrong-width vector', async () => {
    const sims = await resolveSemanticNoveltySims('q', corpus, makeDeps({ embedLen: 10, planSims: { alpha: 0.9 } }));
    expect(sims).toBeNull();
  });

  it('returns null when nothing resolved (no plan/wi vectors in the space)', async () => {
    const sims = await resolveSemanticNoveltySims('q', corpus, makeDeps({}));
    expect(sims).toBeNull();
  });

  it('keeps query-time implementation refs out of the legacy supplied-ref similarity map', async () => {
    const candidate: ImplementationCorpusCandidate = {
      entry: { ref: 'wi:WI-NEW', kind: 'implementation', text: 'realized work', state: 'shipped' },
      similarity: 0.9,
    };
    expect(await resolveSemanticNoveltySims('q', [], makeDeps({ implementationCandidates: [candidate] }))).toBeNull();
    const hybrid = await corpusNoveltyHybrid(
      'realized work',
      [],
      {},
      makeDeps({ implementationCandidates: [candidate] }),
    );
    expect(hybrid.evaluatedCorpus).toContainEqual(candidate.entry);
    expect(hybrid.implementationCandidates).toEqual([candidate]);
  });

  it('keeps the established semantic joins when the optional implementation query fails', async () => {
    const deps = makeDeps({ planSims: { alpha: 0.9 }, implementationError: true });
    const sims = await resolveSemanticNoveltySims('q', corpus, deps);
    expect(sims?.get('plan:alpha')).toBe(0.9);
  });

  it('is VITEST-inert (null) when no deps are injected', async () => {
    expect(await resolveSemanticNoveltySims('q', corpus)).toBeNull();
  });

  it('honors the PAPERCUSP_SU_SEMANTIC_NOVELTY=off kill switch even with deps', async () => {
    const prev = process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY;
    process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY = 'off';
    try {
      const sims = await resolveSemanticNoveltySims('q', corpus, makeDeps({ planSims: { alpha: 0.9 } }));
      expect(sims).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY;
      else process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY = prev;
    }
  });
});

describe('corpusNoveltyHybrid — wrapper', () => {
  const corpus: CorpusEntry[] = [{ ref: 'plan:cache', kind: 'plan', text: 'cache the corpus digest between passes' }];

  it('drives the blend end-to-end with injected deps (semantic match on a lexical miss)', async () => {
    const deps = makeDeps({ planSims: { cache: 0.95 } });
    const r = await corpusNoveltyHybrid('quantum flux capacitor teleport', corpus, {}, deps);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].semantic).toBe(true);
    expect(r.novelty).toBeLessThanOrEqual(0.05);
  });

  it('falls back to pure lexical when the leg returns no verdict', async () => {
    const deps = makeDeps({ disabled: true });
    const r = await corpusNoveltyHybrid('quantum flux capacitor teleport', corpus, {}, deps);
    expect(r.novelty).toBe(1);
    expect(r.matches).toEqual([]);
  });

  it('uses a caller-supplied semanticSimByRef as-is and skips the leg', async () => {
    const deps = makeDeps({ planSims: { cache: 0.1 } });
    const r = await corpusNoveltyHybrid(
      'quantum flux capacitor teleport',
      corpus,
      { semanticSimByRef: new Map([['plan:cache', 0.9]]) },
      deps,
    );
    expect(r.matches[0].similarity).toBe(0.9);
    expect(deps.queryPlanSims).not.toHaveBeenCalled();
  });
});
