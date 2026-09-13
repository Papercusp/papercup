/**
 * carry-fact-staleness — unit tests (deterministic-context-carry-2026-07-14
 * P-026, WI-5001/WI-5141 leg (b)).
 *
 * Fully hermetic: the embedder + ref-hydrate are injected, no PG/network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  checkFactStaleness,
  checkCarriedFactsStaleness,
  renderFactsStalenessWarning,
  DEFAULT_FACT_DRIFT_THRESHOLD,
  type FactStalenessInput,
} from './carry-fact-staleness';
import type { FactSourceProvenance } from './agent-facts/store';
import type { HydratedRef } from './agent-tools/coordination/ref-hydrate';
import { EMBEDDER_DIM_SPECS, type EmbedderProfileSpec } from '@papercusp/memory';

const FACT_TEST_PROFILE: EmbedderProfileSpec = {
  ...EMBEDDER_DIM_SPECS.openai,
  profileId: 'fact-staleness-test-space@v1',
  model: 'fact-staleness-test',
  modelRevision: 'test-revision',
  nativeDims: 8,
  mrl: 'none',
  trainedDims: [8],
  targetDims: 8,
};

function provenance(overrides: Partial<FactSourceProvenance> = {}): FactSourceProvenance {
  return {
    kind: 'work-item',
    verified: true,
    quote: 'WI-1234 — fix the frobnicator race',
    label: 'WI-1234 [bug/wip]',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function fact(overrides: Partial<FactStalenessInput> = {}): FactStalenessInput {
  return {
    key: 'wi-1234-status',
    sourceRef: 'WI-1234',
    sourceProvenance: provenance(),
    ...overrides,
  };
}

/** A fake embedder: identical text -> identical vector; different text -> orthogonal vectors,
 *  via a tiny deterministic hash-to-vector so distance is meaningfully non-zero for distinct text. */
function fakeEmbedder(mode: 'openai' | 'disabled' = 'openai') {
  const embed = async (text: string): Promise<number[]> => {
    // Deterministic: same text -> same vector; distinct text -> distinct (near-orthogonal) vectors.
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    const v = new Array(8).fill(0).map((_, i) => Math.sin(seed + i) + 2); // keep positive, avoid zero-norm
    return v;
  };
  return async () =>
    mode === 'disabled'
      ? ({ mode: 'disabled' as const } as const)
      : ({ mode: 'openai' as const, dims: 8, profile: FACT_TEST_PROFILE, embed } as const);
}

function hydrateOk(snippet: string): (refs: unknown[]) => Promise<HydratedRef[]> {
  return async (refs) =>
    (refs as Array<{ kind: string; id: string }>).map((ref) => ({
      ref: ref as never,
      ok: true,
      label: `${ref.kind}:${ref.id}`,
      snippet,
    }));
}

function hydrateMiss(error: string): (refs: unknown[]) => Promise<HydratedRef[]> {
  return async (refs) =>
    (refs as Array<{ kind: string; id: string }>).map((ref) => ({
      ref: ref as never,
      ok: false,
      label: `${ref.kind}:${ref.id}`,
      snippet: '',
      error,
    }));
}

describe('checkFactStaleness', () => {
  it('reports unknown for a fact with no sourceProvenance', async () => {
    const r = await checkFactStaleness(fact({ sourceProvenance: null }));
    expect(r).toEqual({ key: 'wi-1234-status', verdict: 'unknown', distance: null, reason: 'no_verified_quote' });
  });

  it('reports unknown for an unverified provenance stamp', async () => {
    const r = await checkFactStaleness(fact({ sourceProvenance: provenance({ verified: false }) }));
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('no_verified_quote');
  });

  it('reports unknown for a verified stamp with no quote (e.g. owner-turn label-only)', async () => {
    const r = await checkFactStaleness(fact({ sourceProvenance: provenance({ quote: undefined }) }));
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('no_verified_quote');
  });

  it('reports unknown for a non-hydratable provenance kind (owner-turn)', async () => {
    const r = await checkFactStaleness(
      fact({ sourceProvenance: provenance({ kind: 'owner-turn', quote: 'the owner said so' }) }),
    );
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('no_verified_quote');
  });

  it('reports unknown when sourceRef does not parse to a hydratable ref', async () => {
    const r = await checkFactStaleness(
      fact({ sourceRef: 'plan:some-slug#P-001', sourceProvenance: provenance() }),
      { resolveEmbedderFn: fakeEmbedder() },
    );
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('unresolvable_ref');
  });

  it('reports unknown when the embedder is disabled', async () => {
    const r = await checkFactStaleness(fact(), { resolveEmbedderFn: fakeEmbedder('disabled') });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('embedder_disabled');
  });

  it('reports unknown when the embedder fails to resolve', async () => {
    const r = await checkFactStaleness(fact(), {
      resolveEmbedderFn: async () => {
        throw new Error('boom');
      },
    });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('embedder_resolve_failed');
  });

  it('reports unknown when the source has been deleted (hydrate miss)', async () => {
    const r = await checkFactStaleness(fact(), {
      resolveEmbedderFn: fakeEmbedder(),
      hydrateRefsFn: hydrateMiss('not_found') as never,
    });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('not_found');
  });

  it('reports fresh when the current snippet matches the assert-time quote', async () => {
    const quote = 'WI-1234 — fix the frobnicator race';
    const r = await checkFactStaleness(fact({ sourceProvenance: provenance({ quote }) }), {
      resolveEmbedderFn: fakeEmbedder(),
      hydrateRefsFn: hydrateOk(quote) as never,
    });
    expect(r.verdict).toBe('fresh');
    expect(r.distance).toBeCloseTo(0, 5);
  });

  it('reports possibly-stale when the current snippet has drifted materially', async () => {
    const r = await checkFactStaleness(
      fact({ sourceProvenance: provenance({ quote: 'WI-1234 — fix the frobnicator race' }) }),
      {
        resolveEmbedderFn: fakeEmbedder(),
        hydrateRefsFn: hydrateOk('WI-1234 — resolved as wontfix, superseded by WI-9999') as never,
      },
    );
    expect(r.verdict).toBe('possibly-stale');
    expect(r.distance).toBeGreaterThan(DEFAULT_FACT_DRIFT_THRESHOLD);
  });

  it('respects a custom distance threshold', async () => {
    const quote = 'WI-1234 — fix the frobnicator race';
    const r = await checkFactStaleness(fact({ sourceProvenance: provenance({ quote }) }), {
      resolveEmbedderFn: fakeEmbedder(),
      hydrateRefsFn: hydrateOk(quote) as never,
      distanceThreshold: -1, // even ~0 distance now counts as drifted
    });
    expect(r.verdict).toBe('possibly-stale');
  });

  it('degrades to unknown, never throws, when the embed call itself fails', async () => {
    const r = await checkFactStaleness(fact(), {
      resolveEmbedderFn: async () => ({
        mode: 'openai' as const,
        dims: 8,
        profile: FACT_TEST_PROFILE,
        embed: async () => {
          throw new Error('embed_admission_shed');
        },
      }),
      hydrateRefsFn: hydrateOk('current text') as never,
    });
    expect(r.verdict).toBe('unknown');
    expect(r.reason).toBe('check_failed');
  });
});

describe('checkCarriedFactsStaleness (batch)', () => {
  it('returns [] for an empty input without resolving an embedder', async () => {
    const resolveEmbedderFn = vi.fn();
    const r = await checkCarriedFactsStaleness([], { resolveEmbedderFn });
    expect(r).toEqual([]);
    expect(resolveEmbedderFn).not.toHaveBeenCalled();
  });

  it('skips embedder resolution entirely when no fact qualifies', async () => {
    const resolveEmbedderFn = vi.fn();
    const facts = [fact({ sourceProvenance: null }), fact({ key: 'b', sourceRef: null, sourceProvenance: null })];
    const r = await checkCarriedFactsStaleness(facts, { resolveEmbedderFn });
    expect(r.every((x) => x.verdict === 'unknown' && x.reason === 'no_verified_quote')).toBe(true);
    expect(resolveEmbedderFn).not.toHaveBeenCalled();
  });

  it('resolves the embedder ONCE and reuses it across every checkable fact', async () => {
    const resolveEmbedderFn = vi.fn(fakeEmbedder());
    const quote = 'same text';
    const facts = [
      fact({ key: 'a', sourceProvenance: provenance({ quote }) }),
      fact({ key: 'b', sourceRef: 'WI-5678', sourceProvenance: provenance({ quote }) }),
      fact({ key: 'c', sourceProvenance: null }), // not checkable — should not block the batch
    ];
    const r = await checkCarriedFactsStaleness(facts, {
      resolveEmbedderFn,
      hydrateRefsFn: hydrateOk(quote) as never,
    });
    expect(resolveEmbedderFn).toHaveBeenCalledTimes(1);
    expect(r.find((x) => x.key === 'a')?.verdict).toBe('fresh');
    expect(r.find((x) => x.key === 'b')?.verdict).toBe('fresh');
    expect(r.find((x) => x.key === 'c')?.verdict).toBe('unknown');
  });

  it('one bad fact (deleted source) degrades only that fact, not the whole batch', async () => {
    const facts = [
      fact({ key: 'ok', sourceProvenance: provenance({ quote: 'x' }) }),
      fact({ key: 'gone', sourceRef: 'WI-9999', sourceProvenance: provenance({ quote: 'y' }) }),
    ];
    const hydrate = (async (refs: unknown[]) =>
      (refs as Array<{ kind: string; id: string }>).map((ref) =>
        ref.id === 'WI-9999'
          ? { ref: ref as never, ok: false, label: 'gone', snippet: '', error: 'not_found' }
          : { ref: ref as never, ok: true, label: 'ok', snippet: 'x' },
      )) as never;
    const r = await checkCarriedFactsStaleness(facts, { resolveEmbedderFn: fakeEmbedder(), hydrateRefsFn: hydrate });
    expect(r.find((x) => x.key === 'ok')?.verdict).toBe('fresh');
    expect(r.find((x) => x.key === 'gone')).toEqual({ key: 'gone', verdict: 'unknown', distance: null, reason: 'not_found' });
  });
});

describe('renderFactsStalenessWarning', () => {
  it('renders null when nothing is possibly-stale', () => {
    expect(renderFactsStalenessWarning([{ key: 'a', verdict: 'fresh', distance: 0 }])).toBeNull();
    expect(renderFactsStalenessWarning([{ key: 'a', verdict: 'unknown', distance: null }])).toBeNull();
    expect(renderFactsStalenessWarning([])).toBeNull();
  });

  it('renders only the possibly-stale entries, with their distance', () => {
    const block = renderFactsStalenessWarning([
      { key: 'fresh-one', verdict: 'fresh', distance: 0.01 },
      { key: 'stale-one', verdict: 'possibly-stale', distance: 0.42 },
      { key: 'unknown-one', verdict: 'unknown', distance: null },
    ]);
    expect(block).toContain('stale-one');
    expect(block).toContain('0.420');
    expect(block).not.toContain('fresh-one');
    expect(block).not.toContain('unknown-one');
  });
});
