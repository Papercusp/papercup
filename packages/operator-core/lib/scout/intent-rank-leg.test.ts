/**
 * Tests for the P-019 intent-rank leg (su-ideate-learning-substrate-2026-07-10). Two halves:
 *   - the PURE `rankByIntent`: sim-desc order, unranked (no vector / no ref) tail keeps
 *     the input (newest-first) order, stable ties, no mutation;
 *   - the IMPURE `resolveIntentSims`: JOIN partition by routedRef shape (plan:→553,
 *     wi:→551, gym:/other ignored), sims keyed back by ref, and the fail-open contract
 *     (empty intent / kill-switch / disabled / dims-mismatch / wrong-width / VITEST-inert
 *     all degrade to null → the caller keeps newest-first).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

import {
  rankByIntent,
  resolveIntentSims,
  type IntentRankDeps,
} from './intent-rank-leg';
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
}): IntentRankDeps & {
  queryPlanSims: ReturnType<typeof vi.fn>;
  queryWorkItemSims: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
} {
  const embed = vi.fn(async () => new Array(opts.embedLen ?? DIM).fill(0.01));
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
      ? ({ mode: 'disabled' as const, reason: 'test' })
      : {
          mode: opts.mode ?? 'gemma',
          dims: opts.dims ?? DIM,
          profile: EMBEDDER_DIM_SPECS.gemma,
          embed,
        };
  return { resolveEmbedder, queryPlanSims, queryWorkItemSims, embed };
}

const KILL = 'PAPERCUSP_SU_INTENT_RANK';
const prevKill = process.env[KILL];
afterEach(() => {
  if (prevKill === undefined) delete process.env[KILL];
  else process.env[KILL] = prevKill;
});

describe('rankByIntent — pure stable relevance ordering', () => {
  type Row = { ref: string; tag: string };
  const rows: Row[] = [
    { ref: 'wi:1', tag: 'newest' },
    { ref: 'wi:2', tag: 'mid' },
    { ref: 'wi:3', tag: 'oldest' },
  ];

  it('orders by descending cosine, not input (newest-first) order', () => {
    const sims = new Map([
      ['wi:1', 0.2],
      ['wi:2', 0.9],
      ['wi:3', 0.5],
    ]);
    const out = rankByIntent(rows, (r) => r.ref, sims);
    expect(out.map((r) => r.tag)).toEqual(['mid', 'oldest', 'newest']);
  });

  it('sinks rows with no resolved sim below ranked ones, preserving their input order', () => {
    const sims = new Map([['wi:2', 0.7]]); // only the middle row has a vector
    const out = rankByIntent(rows, (r) => r.ref, sims);
    // ranked first, then the unrankable tail in ORIGINAL order (newest, oldest).
    expect(out.map((r) => r.tag)).toEqual(['mid', 'newest', 'oldest']);
  });

  it('treats a missing ref (refOf → undefined) as unranked', () => {
    const withUndef = [{ tag: 'a' }, { tag: 'b' }] as Array<{ tag: string; ref?: string }>;
    const out = rankByIntent(withUndef, (r) => r.ref, new Map());
    expect(out.map((r) => r.tag)).toEqual(['a', 'b']); // unchanged, stable
  });

  it('is stable on equal sims (ties keep input order) and never mutates the input', () => {
    const sims = new Map([
      ['wi:1', 0.5],
      ['wi:2', 0.5],
      ['wi:3', 0.5],
    ]);
    const snapshot = rows.map((r) => r.tag);
    const out = rankByIntent(rows, (r) => r.ref, sims);
    expect(out.map((r) => r.tag)).toEqual(['newest', 'mid', 'oldest']);
    expect(rows.map((r) => r.tag)).toEqual(snapshot); // input untouched
  });
});

describe('resolveIntentSims — JOIN partition + fail-open', () => {
  const refs = ['plan:alpha', 'wi:F-1', 'gym:step-7', 'weird-ref'];

  it('partitions plan:→553, wi:→551, keys sims back by ref, ignores gym:/other refs', async () => {
    const deps = makeDeps({ planSims: { alpha: 0.9 }, wiSims: { 'F-1': 0.8 } });
    const sims = await resolveIntentSims('cache the digest', refs, deps);
    expect(sims).not.toBeNull();
    expect(sims!.get('plan:alpha')).toBe(0.9);
    expect(sims!.get('wi:F-1')).toBe(0.8);
    expect(sims!.has('gym:step-7')).toBe(false);
    expect(sims!.has('weird-ref')).toBe(false);
    // prefixes stripped before the join.
    expect(deps.queryPlanSims).toHaveBeenCalledWith(
      expect.anything(),
      'gemma',
      ['alpha'],
      expect.objectContaining({ profileId: EMBEDDER_DIM_SPECS.gemma.profileId }),
    );
    expect(deps.queryWorkItemSims).toHaveBeenCalledWith(
      expect.anything(),
      'gemma',
      ['F-1'],
      expect.objectContaining({ profileId: EMBEDDER_DIM_SPECS.gemma.profileId }),
    );
  });

  it('ranks a re-worded artifact ABOVE a newer one end-to-end (resolve → rankByIntent)', async () => {
    // newest-first outcome-like rows; the relevant one (wi:2) is the OLDEST.
    const outcomes = [
      { routedRef: 'wi:1', tag: 'newest-irrelevant' },
      { routedRef: 'wi:2', tag: 'old-but-on-topic' },
    ];
    const deps = makeDeps({ wiSims: { '1': 0.1, '2': 0.95 } });
    const sims = await resolveIntentSims('the pass focus', outcomes.map((o) => o.routedRef), deps);
    expect(sims).not.toBeNull();
    const ranked = rankByIntent(outcomes, (o) => o.routedRef, sims!);
    expect(ranked.map((o) => o.tag)).toEqual(['old-but-on-topic', 'newest-irrelevant']);
  });

  it('returns null when no ref has a stored-vector source (only gym:/other)', async () => {
    const deps = makeDeps({ wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('q', ['gym:a', 'weird'], deps)).toBeNull();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it('returns null when nothing resolved (refs partition but no stored vectors)', async () => {
    const deps = makeDeps({}); // empty sim maps
    expect(await resolveIntentSims('q', ['wi:F-1', 'plan:alpha'], deps)).toBeNull();
  });

  it('fail-opens to null when the embedder is disabled', async () => {
    const deps = makeDeps({ disabled: true, wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('q', ['wi:F-1'], deps)).toBeNull();
  });

  it('fail-opens to null on a dims mismatch (harrier@1024 ≠ vector(384)) — no embed, no join', async () => {
    const deps = makeDeps({ dims: 1024, wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('q', ['wi:F-1'], deps)).toBeNull();
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.queryWorkItemSims).not.toHaveBeenCalled();
  });

  it('fail-opens to null when the embedder returns a wrong-width vector', async () => {
    const deps = makeDeps({ embedLen: 10, wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('q', ['wi:F-1'], deps)).toBeNull();
    expect(deps.queryWorkItemSims).not.toHaveBeenCalled();
  });

  it('fail-opens to null on an empty/blank intent', async () => {
    const deps = makeDeps({ wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('   ', ['wi:F-1'], deps)).toBeNull();
    expect(deps.embed).not.toHaveBeenCalled();
  });

  it('honors the PAPERCUSP_SU_INTENT_RANK=off kill switch even with deps', async () => {
    process.env[KILL] = 'off';
    const deps = makeDeps({ wiSims: { 'F-1': 0.8 } });
    expect(await resolveIntentSims('q', ['wi:F-1'], deps)).toBeNull();
  });

  it('is VITEST-inert (null) when no deps are injected', async () => {
    expect(await resolveIntentSims('q', ['wi:F-1'])).toBeNull();
  });
});
