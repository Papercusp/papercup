/**
 * P-009 — runtime honesty for the semantic leg.
 *
 * The property under test is narrow and load-bearing: **absence of evidence
 * must never render as health.** Most of these cases exist to pin that one
 * rule from a different direction (missing sample, stale sample, unmapped
 * source, failed read), because the bug this item removes was not a wrong
 * number — it was a confident answer where there was no evidence at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SEARCH_SOURCE_SURFACES,
  COVERAGE_SAMPLE_MAX_AGE_MS,
  assessSourceCoverage,
  assessSearchCoverage,
  loadCoverageSnapshot,
  loadCoverageSnapshotCached,
  resetCoverageSnapshotCache,
  type CoverageSnapshot,
  type SurfaceReading,
} from './coverage-gate';
import { TOTAL_COVERAGE_FLOOR } from './embed-coverage';
import { SEARCH_SOURCES } from '../agent-tools/search/sources';

const NOW = new Date('2026-08-03T18:00:00.000Z');

function reading(surface: string, embedded: number, eligible: number, opts: {
  ageMs?: number;
  recentEligible?: number;
  recentEmbedded?: number;
} = {}): SurfaceReading {
  const ageMs = opts.ageMs ?? 60_000;
  return {
    surface,
    observedAt: new Date(NOW.getTime() - ageMs),
    eligibleRows: eligible,
    embeddedRows: embedded,
    pct: eligible > 0 ? embedded / eligible : null,
    recentPct:
      opts.recentEligible && opts.recentEmbedded !== undefined
        ? opts.recentEmbedded / opts.recentEligible
        : null,
    stale: ageMs > COVERAGE_SAMPLE_MAX_AGE_MS,
    ageMs,
  };
}

const snap = (...rs: SurfaceReading[]): CoverageSnapshot =>
  new Map(rs.map((r) => [r.surface, r]));

const TURNS = 'harness_shared.operator_turns.text_embedding';
const SESSION_TURNS = 'harness_shared.session_turns.text_embedding';
const SESSION_CHUNKS = 'harness_shared.session_turn_chunks.embedding';

describe('SEARCH_SOURCE_SURFACES exhaustiveness', () => {
  // The whole point of the mapping is that omitting an entry is LOUD. If this
  // test did not exist, a new search source would silently report `unknown`
  // forever — the same class of failure as an unenumerated vector column.
  it('covers every registered SearchSource', () => {
    const missing = SEARCH_SOURCES.map((s) => s.name).filter(
      (n) => SEARCH_SOURCE_SURFACES[n] === undefined,
    );
    expect(missing, `sources with no coverage mapping: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps no source that does not exist', () => {
    const names = new Set(SEARCH_SOURCES.map((s) => s.name));
    const extra = Object.keys(SEARCH_SOURCE_SURFACES).filter((k) => !names.has(k));
    expect(extra, `mapping entries with no SearchSource: ${extra.join(', ')}`).toEqual([]);
  });

  it('declares an embedding leg exactly when the source implements one', () => {
    for (const src of SEARCH_SOURCES) {
      const declared = (SEARCH_SOURCE_SURFACES[src.name] ?? []).length > 0;
      const actual = typeof src.embedding === 'function';
      expect(declared, `${src.name}: mapping says semantic=${declared}, source says ${actual}`).toBe(
        actual,
      );
    }
  });
});

describe('assessSourceCoverage — absence of evidence is not health', () => {
  it('reports unknown (NOT healthy) when the surface has no sample at all', () => {
    const a = assessSourceCoverage('turns', snap());
    expect(a.verdict).toBe('unknown');
    expect(a.coverage).toBeNull();
    expect(a.note).toMatch(/not the same as healthy/i);
  });

  it('reports unknown (NOT healthy) when the only sample is STALE', () => {
    const stale = reading(TURNS, 100, 100, { ageMs: COVERAGE_SAMPLE_MAX_AGE_MS + 1 });
    const a = assessSourceCoverage('turns', snap(stale));
    // 100% coverage, but nobody has looked recently — that is not evidence.
    expect(a.verdict).toBe('unknown');
    expect(a.unknownSurfaces).toEqual([TURNS]);
  });

  it('a sample one millisecond INSIDE the window still counts (boundary)', () => {
    const fresh = reading(TURNS, 100, 100, { ageMs: COVERAGE_SAMPLE_MAX_AGE_MS - 1 });
    expect(assessSourceCoverage('turns', snap(fresh)).verdict).toBe('healthy');
  });

  it('reports unknown for a source with no mapping entry', () => {
    const a = assessSourceCoverage('a_source_that_does_not_exist', snap());
    expect(a.verdict).toBe('unknown');
    expect(a.note).toMatch(/no coverage mapping/i);
  });
});

describe('assessSourceCoverage — verdicts', () => {
  it('flags degraded below the floor', () => {
    const a = assessSourceCoverage('turns', snap(reading(TURNS, 720, 1000)));
    expect(a.verdict).toBe('degraded');
    expect(a.coverage).toBeCloseTo(0.72, 5);
    expect(a.note).toMatch(/PARTIAL index/);
  });

  it('passes at or above the floor', () => {
    const at = Math.ceil(TOTAL_COVERAGE_FLOOR * 1000);
    expect(assessSourceCoverage('turns', snap(reading(TURNS, at, 1000))).verdict).toBe('healthy');
    expect(assessSourceCoverage('turns', snap(reading(TURNS, 1000, 1000))).verdict).toBe('healthy');
  });

  it('distinguishes BM25-only sources from unknown ones', () => {
    const a = assessSourceCoverage('work_item', snap());
    expect(a.verdict).toBe('not-semantic');
    // Must NOT be conflated with `unknown`: one is "does not apply", the other
    // is "we do not know", and only the latter is a warning.
    expect(a.verdict).not.toBe('unknown');
  });

  it('names the historical-backlog case when recent rows are healthy', () => {
    const a = assessSourceCoverage(
      'session_turn',
      snap(reading(SESSION_TURNS, 255_303, 354_408, { recentEligible: 21_758, recentEmbedded: 21_706 })),
    );
    expect(a.verdict).toBe('degraded');
    expect(a.note).toMatch(/historical backlog/i);
  });
});

describe('assessSourceCoverage — multi-leg union (P-034 parent + chunks)', () => {
  it('takes the BEST known leg, since either leg makes a row findable', () => {
    const a = assessSourceCoverage(
      'session_turn',
      snap(reading(SESSION_TURNS, 720, 1000), reading(SESSION_CHUNKS, 1000, 1000)),
    );
    expect(a.coverage).toBe(1);
    expect(a.verdict).toBe('healthy');
  });

  it('still reports on the parent leg when the chunk leg has no sample yet', () => {
    // Exactly the live state after P-034 shipped but before bg-host restarted:
    // chunk rows exist but the sweep has never sampled them.
    const a = assessSourceCoverage('session_turn', snap(reading(SESSION_TURNS, 720, 1000)));
    expect(a.verdict).toBe('degraded');
    expect(a.coverage).toBeCloseTo(0.72, 5);
    expect(a.unknownSurfaces).toEqual([SESSION_CHUNKS]);
    expect(a.note).toMatch(/Partial view/);
  });

  it('is unknown only when EVERY leg is unknown', () => {
    expect(assessSourceCoverage('session_turn', snap()).verdict).toBe('unknown');
  });
});

describe('assessSearchCoverage — rollup', () => {
  it('returns no warning when every scoped source is healthy or non-semantic', () => {
    const r = assessSearchCoverage(['turns', 'work_item'], snap(reading(TURNS, 1000, 1000)));
    expect(r.degraded).toBe(false);
    expect(r.warning).toBeNull();
  });

  it('warns on a degraded source and names it', () => {
    const r = assessSearchCoverage(['turns'], snap(reading(TURNS, 720, 1000)));
    expect(r.degraded).toBe(true);
    expect(r.degradedSources).toEqual(['turns']);
    expect(r.warning).toMatch(/DEGRADED/);
  });

  it('warns on an unknown source separately from a degraded one', () => {
    const r = assessSearchCoverage(['turns', 'decisions'], snap(reading(TURNS, 720, 1000)));
    expect(r.degradedSources).toEqual(['turns']);
    expect(r.unknownSources).toEqual(['decisions']);
    expect(r.warning).toMatch(/DEGRADED/);
    expect(r.warning).toMatch(/UNKNOWN/);
  });

  it('a BM25-only source never raises a warning on its own', () => {
    const r = assessSearchCoverage(['work_item', 'coord_message'], snap());
    expect(r.degraded).toBe(false);
    expect(r.warning).toBeNull();
  });
});

describe('loadCoverageSnapshot', () => {
  beforeEach(() => resetCoverageSnapshotCache());

  it('parses bigint-as-string columns and computes staleness', async () => {
    const sql = {
      unsafe: async () => [
        {
          surface: TURNS,
          observed_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          eligible_rows: '1000',
          embedded_rows: '720',
          recent_eligible: '500',
          recent_embedded: '500',
        },
      ],
    };
    const s = await loadCoverageSnapshot(sql, 'ws', NOW);
    const r = s.get(TURNS)!;
    // Postgres returns bigint as a STRING; a naive read would make pct NaN.
    expect(r.pct).toBeCloseTo(0.72, 5);
    expect(r.recentPct).toBe(1);
    expect(r.stale).toBe(false);
  });

  it('suppresses recentPct below MIN_RECENT_SAMPLE rather than reporting a noisy ratio', async () => {
    const sql = {
      unsafe: async () => [
        {
          surface: TURNS,
          observed_at: NOW.toISOString(),
          eligible_rows: '1000',
          embedded_rows: '1000',
          recent_eligible: '3',
          recent_embedded: '1',
        },
      ],
    };
    const s = await loadCoverageSnapshot(sql, 'ws', NOW);
    expect(s.get(TURNS)!.recentPct).toBeNull();
  });

  it('a FAILED read degrades to unknown — never to healthy, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = { unsafe: async () => { throw new Error('pg is down'); } };
      const s = await loadCoverageSnapshotCached(sql, 'ws', NOW);
      expect(s.size).toBe(0);
      // The whole failure mode this item exists to kill: an outage must not
      // read as a clean bill of health.
      expect(assessSourceCoverage('turns', s).verdict).toBe('unknown');
      // The degradation must be visible in the log, not swallowed silently —
      // a silent fallback is how the original bug stayed invisible.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/snapshot read failed/);
    } finally {
      warn.mockRestore();
    }
  });

  it('memoises within the TTL and re-reads after it', async () => {
    let calls = 0;
    const sql = {
      unsafe: async () => {
        calls += 1;
        return [{
          surface: TURNS,
          observed_at: NOW.toISOString(),
          eligible_rows: '10',
          embedded_rows: '10',
          recent_eligible: null,
          recent_embedded: null,
        }];
      },
    };
    await loadCoverageSnapshotCached(sql, 'ws', NOW);
    await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 1_000));
    expect(calls).toBe(1);
    await loadCoverageSnapshotCached(sql, 'ws', new Date(NOW.getTime() + 120_000));
    expect(calls).toBe(2);
  });

  it('does not serve one workspace a different workspace cached snapshot', async () => {
    let calls = 0;
    const sql = { unsafe: async () => { calls += 1; return []; } };
    await loadCoverageSnapshotCached(sql, 'ws-a', NOW);
    await loadCoverageSnapshotCached(sql, 'ws-b', NOW);
    expect(calls).toBe(2);
  });
});

describe('falsifiability controls', () => {
  // A guard that has never failed is a guard nobody has tested. These are
  // deliberately-wrong implementations kept as permanent controls: if the real
  // `assessSourceCoverage` ever starts agreeing with them, the property has
  // been broken. Paired with a calibration case so the controls cannot pass
  // merely because the assertions are vacuous.
  const missingReadsAsHealthy = (source: string, s: CoverageSnapshot) =>
    s.size === 0 ? 'healthy' : assessSourceCoverage(source, s).verdict;

  it('CONTROL: the "missing ⇒ healthy" implementation is what we must NOT do', () => {
    const empty = snap();
    expect(missingReadsAsHealthy('turns', empty)).toBe('healthy');
    expect(assessSourceCoverage('turns', empty).verdict).toBe('unknown');
    expect(assessSourceCoverage('turns', empty).verdict).not.toBe(
      missingReadsAsHealthy('turns', empty),
    );
  });

  it('CALIBRATION: the two agree when evidence IS present', () => {
    const good = snap(reading(TURNS, 1000, 1000));
    expect(assessSourceCoverage('turns', good).verdict).toBe('healthy');
    expect(missingReadsAsHealthy('turns', good)).toBe('healthy');
  });
});
