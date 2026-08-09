/**
 * P-003 — the injection corpus leg's coverage gate.
 *
 * The gate is pure, so every interesting state is reachable here without a live
 * PG. Two properties are worth more than the individual cases and are asserted
 * explicitly, because getting either wrong produces a gate that LOOKS right:
 *
 *   • SUPPRESSION IS NARROW. Its three conjuncts each have an innocent reading,
 *     so the suite drops one at a time and asserts the verdict falls back to
 *     `degraded`. Without those controls a gate that suppressed on ANY degraded
 *     coverage would pass every positive test in this file.
 *   • `not-semantic` IS NOT A DEGRADATION. A source with no embedding leg has no
 *     embedding coverage to be short of, so a healthy run with one in scope must
 *     stay `ok` — otherwise the notice fires every turn and stops carrying
 *     information.
 *
 *     ⚠ The `work_item` assessment below is SYNTHETIC as of P-005. D-078's
 *     premise (work_item is BM25-only) held when this suite was written; P-005
 *     gave that source a real `embedding()` leg, so today NEITHER corpus source
 *     is genuinely `not-semantic`. The case is kept because the property under
 *     test is how the gate handles the VERDICT, which must stay correct for
 *     whichever sources carry it — but do not read the fixture as a claim about
 *     what work_item is.
 */

import { describe, expect, it } from 'vitest';
import type { SearchLegs } from '@papercusp/search';
import type { SearchCoverageReport, SourceCoverageAssessment } from '../search/coverage-gate';
import { assessCorpusCoverageGate, CORPUS_GATE_SOURCES } from './corpus-coverage-gate';
import { CORPUS_SOURCE_NAMES } from './corpus-recall-io';

const RETRIEVAL_DEPTH = 24;

function surface(embeddedRows: number, eligibleRows: number, stale = false) {
  return {
    surface: 'harness_shared.session_turns.text_embedding',
    observedAt: new Date('2026-08-09T05:00:00Z'),
    eligibleRows,
    embeddedRows,
    pct: eligibleRows > 0 ? embeddedRows / eligibleRows : null,
    recentPct: null,
    stale,
    ageMs: stale ? 99 * 60_000 : 60_000,
  };
}

function sessionTurn(over: Partial<SourceCoverageAssessment> = {}): SourceCoverageAssessment {
  return {
    source: 'session_turn',
    verdict: 'healthy',
    coverage: 0.999,
    recentCoverage: null,
    surfaces: [surface(299_434, 299_465)],
    unknownSurfaces: [],
    note: '',
    ...over,
  };
}

/**
 * A `not-semantic` assessment carrying a name the gate has in scope. SYNTHETIC
 * since P-005 gave `work_item` an embedding leg — see the header note; this
 * exercises the verdict, not the source.
 */
function workItem(): SourceCoverageAssessment {
  return {
    source: 'work_item',
    verdict: 'not-semantic',
    coverage: null,
    recentCoverage: null,
    surfaces: [],
    unknownSurfaces: [],
    note: '',
  };
}

function report(perSource: SourceCoverageAssessment[]): SearchCoverageReport {
  const degradedSources = perSource.filter((a) => a.verdict === 'degraded').map((a) => a.source);
  const unknownSources = perSource.filter((a) => a.verdict === 'unknown').map((a) => a.source);
  return {
    degraded: degradedSources.length > 0 || unknownSources.length > 0,
    degradedSources,
    unknownSources,
    perSource,
    warning: null,
  };
}

function legs(over: { lexicalCandidates?: number; degraded?: boolean; warning?: string } = {}) {
  const leg = (candidates: number) => ({
    status: 'ran' as const,
    candidates,
    floored: 0,
    stage2Added: 0,
    callsRun: 1,
    callsFailed: 0,
    failures: [],
    blocked: null,
  });
  return {
    lexical: leg(over.lexicalCandidates ?? 12),
    semantic: leg(6),
    degraded: over.degraded ?? false,
    warning: over.warning ?? null,
  } as unknown as SearchLegs;
}

const gate = (over: Partial<Parameters<typeof assessCorpusCoverageGate>[0]> = {}) =>
  assessCorpusCoverageGate({
    coverage: report([sessionTurn(), workItem()]),
    embedderAvailable: true,
    legs: legs(),
    retrievalDepth: RETRIEVAL_DEPTH,
    ...over,
  });

describe('CORPUS_GATE_SOURCES', () => {
  it('is pinned to the sources the corpus leg actually reads', () => {
    // The gate keeps its OWN copy (both injection suites mock corpus-recall-io
    // down to one export, so importing the real list would resolve `undefined`
    // and silently disable the gate under test). This assertion is what makes
    // the copy safe: widen the leg's sources without widening the gate's and
    // this fails, instead of the gate quietly judging a stale scope.
    expect([...CORPUS_GATE_SOURCES]).toEqual([...CORPUS_SOURCE_NAMES]);
  });
});

describe('assessCorpusCoverageGate', () => {
  it('is ok when the semantic source is healthy and the embedder ran', () => {
    const d = gate();
    expect(d.verdict).toBe('ok');
    expect(d.reasons).toEqual([]);
    expect(d.notice).toBeNull();
  });

  it('does NOT treat a BM25-only source as a degradation (D-078)', () => {
    // The whole scope is work_item — nothing semantic to be degraded ABOUT.
    // A gate that folded `not-semantic` into its verdict would fire here on
    // every single injection, which is how a notice stops being read.
    const d = gate({ coverage: report([workItem()]) });
    expect(d.verdict).toBe('ok');
  });

  it('marks degraded — and does NOT suppress — when the embedder did not run', () => {
    const d = gate({ embedderAvailable: false });
    expect(d.verdict).toBe('degraded');
    expect(d.reasons).toContain('embedder-unavailable');
    expect(d.notice).toMatch(/LEXICAL match/);
  });

  it('marks degraded on partial coverage, naming the source and the figure', () => {
    const d = gate({
      coverage: report([
        sessionTurn({ verdict: 'degraded', coverage: 0.41, surfaces: [surface(41_000, 100_000)] }),
        workItem(),
      ]),
    });
    expect(d.verdict).toBe('degraded');
    expect(d.reasons).toContain('coverage-degraded:session_turn');
    expect(d.notice).toContain('41.0%');
  });

  it('treats UNKNOWN coverage as degraded, never as healthy', () => {
    const d = gate({
      coverage: report([
        sessionTurn({ verdict: 'unknown', coverage: null, surfaces: [], unknownSurfaces: ['x'] }),
        workItem(),
      ]),
    });
    expect(d.verdict).toBe('degraded');
    expect(d.reasons).toContain('coverage-unknown:session_turn');
  });

  it("reports the engine's own leg degradation, which coverage cannot see", () => {
    // Coverage healthy, embedder available — and the search still did not run at
    // full strength because a per-source embedding query failed.
    const d = gate({ legs: legs({ degraded: true, warning: 'semantic leg: 1 of 2 calls failed' }) });
    expect(d.verdict).toBe('degraded');
    expect(d.reasons).toContain('search-leg-degraded');
    expect(d.notice).toContain('1 of 2 calls failed');
  });

  describe('suppression', () => {
    /** Below the leg's own over-fetch depth ⇒ the vector leg has no selectivity. */
    const unselective = () =>
      report([
        sessionTurn({ verdict: 'degraded', coverage: 0.01, surfaces: [surface(9, 900)] }),
        workItem(),
      ]);

    it('sits out when the vector index is unselective AND lexical contributed nothing', () => {
      const d = gate({ coverage: unselective(), legs: legs({ lexicalCandidates: 0 }) });
      expect(d.verdict).toBe('sit-out');
      expect(d.notice).toBeNull();
      expect(d.reasons).toContain('vector-index-unselective:session_turn:9/24');
    });

    // ── Controls. Each drops ONE conjunct; all must fall back to `degraded`. ──

    it('does NOT sit out when the lexical leg contributed (the lines are real)', () => {
      const d = gate({ coverage: unselective(), legs: legs({ lexicalCandidates: 3 }) });
      expect(d.verdict).toBe('degraded');
    });

    it('does NOT sit out when the vector leg never ran (that is honest BM25)', () => {
      const d = gate({
        coverage: unselective(),
        embedderAvailable: false,
        legs: legs({ lexicalCandidates: 0 }),
      });
      expect(d.verdict).toBe('degraded');
    });

    it('does NOT sit out when the index is merely partial, not unselective', () => {
      // 41k embedded rows is far above the over-fetch depth: coverage is bad,
      // but the query still decides which rows come back. Suppressing here is
      // the "trade one dishonesty for another" the search-side D-010 rejects.
      const d = gate({
        coverage: report([
          sessionTurn({ verdict: 'degraded', coverage: 0.41, surfaces: [surface(41_000, 100_000)] }),
          workItem(),
        ]),
        legs: legs({ lexicalCandidates: 0 }),
      });
      expect(d.verdict).toBe('degraded');
    });

    it('does NOT sit out on an absence of evidence (stale sample, unknown rows)', () => {
      // A stale reading is evidence of nothing. Unknown coverage must be strong
      // enough to MARK and never strong enough to SUPPRESS — suppressing on a
      // missing sample is the same defect as trusting one.
      const d = gate({
        coverage: report([
          sessionTurn({ verdict: 'degraded', coverage: 0.01, surfaces: [surface(9, 900, true)] }),
          workItem(),
        ]),
        legs: legs({ lexicalCandidates: 0 }),
      });
      expect(d.verdict).toBe('degraded');
    });

    it('does NOT sit out when there is no semantic source in scope at all', () => {
      // "every semantic source is unselective" is vacuously true over an empty
      // set. A gate written without the non-empty guard would suppress every
      // BM25-only injection — a total feature outage that no positive test here
      // would have caught.
      const d = gate({ coverage: report([workItem()]), legs: legs({ lexicalCandidates: 0 }) });
      expect(d.verdict).toBe('ok');
    });
  });
});
