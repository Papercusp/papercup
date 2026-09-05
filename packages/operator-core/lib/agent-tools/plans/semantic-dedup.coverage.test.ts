/**
 * semantic-dedup.coverage.test — WI-9393 consumer C.
 *
 * `confirmSimilarPlans` partitions token-flagged `similar_exists` candidates at a
 * cosine threshold against `harness_shared.harness_plans.embedding`, and until now
 * said nothing about how much of that column is populated.
 *
 * ⚠ THE DEGRADATION DIRECTION HERE IS THE OPPOSITE OF CONSUMERS A AND B, and that
 * is the thing most likely to be mis-changed later. A candidate with no stored
 * vector is KEPT (fail-safe), so low coverage never lets a duplicate plan through —
 * it makes a refusal STICK when cosine could have cleared it. The failure mode is
 * OVER-blocking: an agent told "a similar plan exists" for a genuinely distinct
 * plan, with no way to see that the corpus, not the similarity, was the reason.
 * So the verdict's job here is explaining why a refusal could not be lifted.
 *
 * These pin four things a future edit could quietly break:
 *   1. coverage rides on the fail-open `verdict:false` results TOO — those are
 *      exactly the ones a caller cannot otherwise explain;
 *   2. it degrades to `unknown` — never healthy, never a null verdict — when the
 *      coverage read is unavailable or throws;
 *   3. the surface asked about is the one the SQL actually reads;
 *   4. a question that was never asked (no candidates) gets no verdict.
 */
import { describe, expect, it } from 'vitest';
import { confirmSimilarPlans, type PlanConfirmDeps } from './semantic-dedup';
// Import the contracts rather than restating numbers: a width change or a floor
// re-tune then moves these fixtures automatically instead of stranding them.
import { PROSE_VECTOR_DIMS } from '../../search/prose-vector-dims';
import { TOTAL_COVERAGE_FLOOR } from '../../search/embed-coverage';
import type { CoverageSnapshot } from '../../search/coverage-gate';

/** The one vector surface `querySimilaritiesReal`'s SQL reads. */
const SURFACE = 'harness_shared.harness_plans.embedding';

const snapshot = (pct: number): CoverageSnapshot =>
  new Map([
    [
      SURFACE,
      {
        surface: SURFACE,
        observedAt: new Date(),
        eligibleRows: 1000,
        embeddedRows: Math.round(pct * 1000),
        pct,
        recentPct: null,
        stale: false,
        ageMs: 0,
      },
    ],
  ]);

/** A working classifier: resolves an embedder and returns the given similarities. */
const deps = (
  sims: Map<string, number>,
  loadCoverage?: () => Promise<CoverageSnapshot>,
): PlanConfirmDeps => ({
  resolveEmbedder: async () => ({
    mode: 'test-mode',
    dims: PROSE_VECTOR_DIMS,
    embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.1),
  }),
  querySimilarities: async () => sims,
  // WI-2145556: the cut is taken from the corpus's own distribution, so a
  // background sample is what makes a real verdict possible at all. These
  // fixtures are ABOUT coverage reporting, not about calibration — a plain
  // spread background keeps them measuring what they were written to measure.
  queryBackgroundSimilarities: async () =>
    Array.from({ length: 200 }, (_, i) => 0.65 + (i / 199) * 0.25),
  ...(loadCoverage ? { loadCoverage } : {}),
});

/** The fail-open shape: no embedder at all ⇒ `verdict:false`, all candidates kept. */
const noEmbedderDeps = (loadCoverage?: () => Promise<CoverageSnapshot>): PlanConfirmDeps => ({
  resolveEmbedder: async () => null,
  querySimilarities: async () => new Map(),
  ...(loadCoverage ? { loadCoverage } : {}),
});

const candidates = [{ slug: 'some-other-plan' }];

describe('confirmSimilarPlans coverage (WI-9393 consumer C)', () => {
  it('reports a DEGRADED corpus alongside a real cosine verdict', async () => {
    // Well below TOTAL_COVERAGE_FLOOR, expressed against the contract.
    const pct = TOTAL_COVERAGE_FLOOR - 0.4;
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      candidates,
      {},
      deps(new Map([['some-other-plan', 0.2]]), async () => snapshot(pct)),
    );

    // The classifier still did its job: 0.2 is far below threshold ⇒ dropped.
    expect(res.verdict).toBe(true);
    expect(res.dropped.map((c) => c.slug)).toEqual(['some-other-plan']);
    // ...and SEPARATELY, the corpus it judged against is reported as under-embedded.
    expect(res.coverage?.verdict).toBe('degraded');
    expect(res.coverage?.source).toBe('plans:semantic-dedup');
    expect(res.coverage?.surfaces.map((s) => s.surface)).toEqual([SURFACE]);
  });

  it('reports coverage on the FAIL-OPEN result too — the case a caller cannot otherwise explain', async () => {
    // No embedder ⇒ verdict:false ⇒ every token-flagged candidate is KEPT, i.e. the
    // refusal stands. Without coverage this is indistinguishable from "cosine ran and
    // confirmed the duplicate", which is the over-blocking miss described in the header.
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      candidates,
      {},
      noEmbedderDeps(async () => snapshot(TOTAL_COVERAGE_FLOOR - 0.4)),
    );

    expect(res.verdict).toBe(false);
    expect(res.kept.map((c) => c.slug)).toEqual(['some-other-plan']);
    expect(res.coverage?.verdict).toBe('degraded');
  });

  it('renders an unavailable coverage read as UNKNOWN — never as healthy', async () => {
    // A throwing read yields an EMPTY snapshot: "we looked and know nothing", which is
    // a different statement from "not assessed" (no key at all). D-018's binding
    // constraint is that absence of evidence must never render as `healthy`.
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      candidates,
      {},
      deps(new Map(), async () => {
        throw new Error('coverage sampler unavailable');
      }),
    );

    expect(res.coverage?.verdict).toBe('unknown');
    expect(res.coverage?.verdict).not.toBe('healthy');
    expect(res.coverage?.unknownSurfaces).toContain(SURFACE);
  });

  it('reports a healthy corpus as healthy', async () => {
    // The control for the two above: same wiring, a covered corpus, and the verdict
    // must move. Without this, a bug that hard-coded `degraded`/`unknown` would pass
    // every other test in this file.
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      candidates,
      {},
      deps(new Map([['some-other-plan', 0.9]]), async () => snapshot(1)),
    );

    expect(res.coverage?.verdict).toBe('healthy');
  });

  it('attaches no verdict when no question was asked (empty candidate list)', async () => {
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      [],
      {},
      deps(new Map(), async () => snapshot(0.5)),
    );

    expect(res.kept).toEqual([]);
    expect(res.coverage).toBeUndefined();
  });

  it('is INERT under vitest when no seam is injected — no live org-PG read', async () => {
    // Mirrors the ONNX-resolver guard this file already had: an unrelated tool test
    // that happens to call the classifier must not pay for a coverage read. The seam
    // above is what opts a test in; its absence must attach nothing at all.
    const res = await confirmSimilarPlans(
      { title: 'a proposed plan', body: 'body' },
      candidates,
      {},
      deps(new Map([['some-other-plan', 0.9]])),
    );

    expect(res.coverage).toBeUndefined();
  });
});
