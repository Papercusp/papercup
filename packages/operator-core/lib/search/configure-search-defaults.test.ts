/**
 * Pins the PAPERCUSP ranking policy (P-017) — the half `@papercusp/search`
 * deliberately does not know about.
 *
 * The property that makes a global floor safe is NOT "we picked a good
 * number", it is "the number is only ever applied in the space it was
 * measured in". A floor leaking into a foreign embedding space would delete
 * real hits while every surface still returned plausible results — silent and
 * expensive — so BOTH directions are tested here rather than inferred from an
 * end-to-end search returning something.
 *
 * `embedderModeOf` is mocked because the alternative is resolving a real
 * embedder (a live model, or none at all in CI), which would make the
 * gemma-floors-apply case untestable in exactly the environment that most
 * needs to catch a regression.
 *
 * ⚠ The mock targets the LEAF `./embedder-mode-registry`, which is where the
 * policy reads it from and where the symbol is DEFINED. It used to target
 * `../agent-tools/search/embedder`, which merely re-exports it — and that is
 * not interchangeable in either direction. A mock only intercepts the module
 * the subject actually imports, and mocking the heavy re-export is also what
 * concealed the import-time PG connection that module drags in (it is never
 * really loaded here, so this suite could not feel it). See
 * `configure-search-defaults-import-purity.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Embedder, SearchDefaultsContext } from '@papercusp/search';

const modeOf = vi.fn<(e: Embedder | null | undefined) => string | undefined>();
const provenanceOf = vi.fn<
  (e: Embedder | null | undefined) => { mode: 'gemma'; profileId?: `${string}@v${number}` } | undefined
>();

vi.mock('./embedder-mode-registry', async (importOriginal) => ({
  // importOriginal keeps the module's real surface — stubbing it wholesale is
  // how a suite ends up green while exercising none of the real logic.
  ...(await importOriginal<typeof import('./embedder-mode-registry')>()),
  embedderModeOf: (e: Embedder | null | undefined) => modeOf(e),
  embedderProvenanceOf: (e: Embedder | null | undefined) => provenanceOf(e),
}));

const { searchDefaultsHost, resetSearchDefaults } = await import('@papercusp/search');
const { EMBEDDING_FLOOR_GEMMA } = await import('./prose-min-score');
const { installSearchDefaults, _resetInstalledForTests } = await import('./configure-search-defaults');

function ctx(over: Partial<SearchDefaultsContext> = {}): SearchDefaultsContext {
  return { query: 'q', limit: 10, mode: 'hybrid', embedder: null, ...over };
}

/** Invoke the policy's minScore resolver exactly as the engine would. */
function minScoreFor(c: SearchDefaultsContext) {
  const host = searchDefaultsHost();
  if (!host?.minScore) throw new Error('policy not installed');
  return host.minScore(c);
}

const someEmbedder: Embedder = async () => [0.1];

describe('papercusp search defaults policy', () => {
  beforeEach(() => {
    modeOf.mockReset();
    modeOf.mockReturnValue(undefined);
    provenanceOf.mockReset();
    provenanceOf.mockReturnValue(undefined);
    resetSearchDefaults();
    _resetInstalledForTests();
    installSearchDefaults();
  });

  it('installs a minScore policy', () => {
    expect(searchDefaultsHost()?.minScore).toBeTypeOf('function');
  });

  it('carries exact profile provenance with its legacy current-mode alias', () => {
    provenanceOf.mockReturnValue({
      mode: 'gemma',
      profileId: 'gemma-embeddinggemma-300m-768@v1',
    });
    const policy = searchDefaultsHost();
    expect(policy?.embeddingProfile?.(ctx({ embedder: someEmbedder }))).toEqual({
      profileId: 'gemma-embeddinggemma-300m-768@v1',
      legacyMode: 'gemma',
    });
  });

  it('fails closed to no vector identity for an unstamped embedder', () => {
    expect(searchDefaultsHost()?.embeddingProfile?.(ctx({ embedder: someEmbedder }))).toBeUndefined();
  });

  it('APPLIES the measured gemma floor when the search runs in the gemma space', () => {
    modeOf.mockReturnValue('gemma');
    expect(minScoreFor(ctx({ embedder: someEmbedder }))).toEqual({
      embeddings: EMBEDDING_FLOOR_GEMMA,
    });
  });

  it('resolves the space from the EMBEDDER INSTANCE the search will use', () => {
    modeOf.mockReturnValue('gemma');
    minScoreFor(ctx({ embedder: someEmbedder }));
    expect(modeOf).toHaveBeenCalledWith(someEmbedder);
  });

  it('floors NOTHING for a space it has not calibrated', () => {
    // The critical direction: an unrecognised space yields NO floor, never a
    // borrowed one. `openai` is a real mode with no measured floor.
    modeOf.mockReturnValue('openai');
    expect(minScoreFor(ctx({ embedder: someEmbedder }))).toBeUndefined();
  });

  it('floors nothing for an embedder this host did not build (unknown space)', () => {
    modeOf.mockReturnValue(undefined);
    expect(minScoreFor(ctx({ embedder: someEmbedder }))).toBeUndefined();
  });

  it('floors nothing when there is no embedder at all', () => {
    expect(minScoreFor(ctx({ embedder: null }))).toBeUndefined();
  });

  it('floors nothing on a fulltext-only search, without consulting the embedder', () => {
    modeOf.mockReturnValue('gemma');
    expect(minScoreFor(ctx({ mode: 'fulltext', embedder: someEmbedder }))).toBeUndefined();
    expect(modeOf).not.toHaveBeenCalled();
  });

  it('does NOT register a global recency default', () => {
    // Recency is a per-surface product judgement, not a correctness floor —
    // "prefer recent" is wrong for code-recipe/doc lookups. Registering one
    // globally would be inventing an unmeasured policy, which is the exact
    // mistake this seam exists to make unnecessary.
    expect(searchDefaultsHost()?.recency).toBeUndefined();
  });

  it('is idempotent — a second install does not replace the policy', () => {
    const first = searchDefaultsHost();
    installSearchDefaults();
    expect(searchDefaultsHost()).toBe(first);
  });
});
