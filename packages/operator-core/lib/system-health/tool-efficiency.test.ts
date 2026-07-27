// The `health.toolEfficiency` derived-read producer (P-010 + P-011, decision
// D-008 on db-performance-remediation-2026-07-26).
//
// These four aggregates used to run INLINE in `collectToolEfficiency`
// (system-health/compute.ts) on every computeSystemHealth. A live
// pg_stat_statements delta caught the three heaviest advancing in LOCKSTEP
// (+93/+94/+94 calls in one 3.6-min window) — one caller, amplified across ~49
// uncoordinated agent processes, burning ~0.28 DB-cores continuously. The
// computation now lives in `computeToolEfficiencyHealth` behind the precompute
// substrate, so the FOLDING behavior must be pinned here, against that function
// directly, rather than against the collector (mirroring the rubrics.list
// precedent in derived-reads/producers.test.ts).
//
// The four rollup modules are mocked at their module boundary: their own SQL and
// grading are already unit-tested in their own suites, and what matters here is
// that ALL FOUR stay behind the ONE precompute and that the payload carries
// exactly what the panel renders.
import { afterEach, describe, expect, it, vi } from 'vitest';

const grade = (rating: string, evidence: string) => ({ rating, evidence });

/** Per-aggregate call counters. Counted INSIDE the mock factories rather than via
 *  spies captured from an imported namespace: the SUT resolves its own dynamic
 *  import, which need not hand back the same namespace object the test imported,
 *  so a `toHaveBeenCalled` on a captured spy can read 0 even though the mock ran. */
const calls = { adoption: 0, limit: 0, orient: 0, empty: 0 };

function mockRollupModules() {
  calls.adoption = 0;
  calls.limit = 0;
  calls.orient = 0;
  calls.empty = 0;
  vi.doMock('../code-run-adoption', () => ({
    readCodeRunAdoption: async () => {
      calls.adoption += 1;
      return ['summary'];
    },
    rollupAdoption: () => ({ adoptionRate: 0.42 }),
    gradeToolUtilization: () => grade('degraded', 'adoption evidence'),
  }));
  vi.doMock('../limit-failure-rate', () => ({
    readLimitFailureRate: async () => {
      calls.limit += 1;
      return { totalErrs: 7, byTool: [] };
    },
    gradeLimitFailureRate: () => grade('healthy', 'limit evidence'),
  }));
  vi.doMock('../orient-dedup-rate', () => ({
    readOrientDedupRate: async () => {
      calls.orient += 1;
      return { pctRedundant: 12 };
    },
    gradeOrientDedupRate: () => grade('healthy', 'orient evidence'),
  }));
  vi.doMock('../empty-result-rate', () => ({
    readEmptyResultRate: async () => {
      calls.empty += 1;
      return { pctEmpty: 30, totalEmptyRuns: 9 };
    },
    gradeEmptyResultRate: () => grade('broken', 'empty evidence'),
  }));
}

afterEach(() => {
  vi.doUnmock('../code-run-adoption');
  vi.doUnmock('../limit-failure-rate');
  vi.doUnmock('../orient-dedup-rate');
  vi.doUnmock('../empty-result-rate');
  vi.resetModules();
});

describe('computeToolEfficiencyHealth (P-010/P-011 precompute)', () => {
  it('folds all four graded rollups into the exact shape the panel renders', async () => {
    vi.resetModules();
    mockRollupModules();
    const { computeToolEfficiencyHealth } = await import('./tool-efficiency');

    const data = await computeToolEfficiencyHealth(async () => []);

    // Every field collectToolEfficiency reads for its status/summary/metrics must
    // be present — the panel derives all three from THIS object alone, so a
    // missing field would silently degrade the panel rather than fail loudly.
    expect(data.limitFailure).toEqual({ rating: 'healthy', evidence: 'limit evidence', totalErrs: 7 });
    expect(data.codeRunAdoption).toEqual({
      rating: 'degraded',
      evidence: 'adoption evidence',
      adoptionRatePct: 42, // rounded from adoptionRate 0.42
    });
    expect(data.orientDedup).toEqual({ rating: 'healthy', evidence: 'orient evidence', pctRedundant: 12 });
    expect(data.emptyResult).toEqual({
      rating: 'broken',
      evidence: 'empty evidence',
      pctEmpty: 30,
      totalEmptyRuns: 9,
    });
  });

  it('runs ALL FOUR aggregates behind the one precompute — none may stay on the read path', async () => {
    vi.resetModules();
    mockRollupModules();
    const { computeToolEfficiencyHealth } = await import('./tool-efficiency');

    await computeToolEfficiencyHealth(async () => []);

    // The whole point of D-008: the three lockstep statements share ONE caller,
    // so they must be precomputed TOGETHER. If a future edit moves any single
    // read back onto the collector, this fails.
    expect(calls).toEqual({ adoption: 1, limit: 1, orient: 1, empty: 1 });
  });

  it('preserves a null adoption rate rather than coercing it to 0%', async () => {
    vi.resetModules();
    mockRollupModules();
    vi.doMock('../code-run-adoption', () => ({
      readCodeRunAdoption: vi.fn(async () => []),
      rollupAdoption: vi.fn(() => ({ adoptionRate: null })),
      gradeToolUtilization: vi.fn(() => grade('unknown', 'no data')),
    }));
    const { computeToolEfficiencyHealth } = await import('./tool-efficiency');

    const data = await computeToolEfficiencyHealth(async () => []);

    // null means "not gradeable in this window" and the panel renders 'n/a';
    // Math.round(null) would be 0, i.e. a confident claim of ZERO adoption.
    expect(data.codeRunAdoption.adoptionRatePct).toBeNull();
  });
});

describe('the health.toolEfficiency producer registration', () => {
  it('is registered workspace-scoped with a ttl long enough not to head-of-line-block liveness producers', async () => {
    vi.resetModules();
    const registry = await import('../derived-reads/registry');
    registry.__clearDerivedReadRegistryForTest();
    await import('../derived-reads/producers');
    const producer = registry.listDerivedReadProducers().find((p) => p.key === 'health.toolEfficiency');

    expect(producer).toBeDefined();
    // Fleet-wide aggregates with no harness filter — a per-harness snapshot would
    // be N identical copies of the same numbers.
    expect(producer!.scope).toBe('workspace');
    // WI-5471 runs producers SHORTEST-ttl-first, so this heavy four-scan producer
    // must sort AFTER the liveness-sensitive 90s ones (dev.serviceHealth,
    // learning.improvements) and never delay them. Its own windows are 24h/7d/14d,
    // so a multi-minute ttl loses nothing.
    expect(producer!.ttlMs).toBeGreaterThan(5 * 60_000);
  });
});
