/**
 * Unit tests for the probe-check UNIT on results-ledger rows (test-rubric-unification-2026-10-12
 * P-010, AUTO-BAR-R-10). A rubric probe check may declare the unit of the scalar its probes read;
 * every ledger row the check writes carries it, so the ledger value can be compared with a
 * baseline. Before this, probe rows were always written with unit null, which left a
 * baseline-vs-ledger comparison without a unit for every SQL-probe criterion.
 */
import { describe, expect, it } from 'vitest';
import { probeCheckResults, probeCheckUnit } from './check-results-ledger';

const AT = '2026-10-13T04:00:00.000Z';
const single = (observed: number, verdict: 'pass' | 'fail' = 'pass') => ({
  kind: 'probe',
  probe: { kind: 'sql' },
  verdict,
  status: verdict === 'pass' ? 'fresh' : 'stale',
  executed: true,
  observed,
  measuredAt: AT,
});

describe('probeCheckUnit — the unit a probe check declares', () => {
  it('reads a trimmed probe-check unit and nothing else', () => {
    expect(probeCheckUnit({ kind: 'probe', probe: {}, unit: ' ms ' })).toBe('ms');
    expect(probeCheckUnit({ kind: 'probe', probe: {} })).toBeUndefined();
    expect(probeCheckUnit({ kind: 'probe', probe: {}, unit: '   ' })).toBeUndefined();
    expect(probeCheckUnit({ kind: 'instrument', instrumentKey: 'host:df-max-used-pct', unit: 'pct' })).toBeUndefined();
    expect(probeCheckUnit(null)).toBeUndefined();
    expect(probeCheckUnit([{ kind: 'probe', unit: 'ms' }])).toBeUndefined();
  });
});

describe('probeCheckResults — the declared unit rides on every ledger row', () => {
  it('stamps each child row with its criterion unit, and null where the check declares none', () => {
    const results = probeCheckResults(
      'perf-fixture',
      {
        lat: single(42),
        grp: { kind: 'probe', all: [single(1), single(2, 'fail')], verdict: 'fail', status: 'stale', executed: true, measuredAt: AT },
        bare: single(7),
        disk: { kind: 'instrument' },
      } as Record<string, { kind: string }>,
      [
        { key: 'lat', check: { kind: 'probe', probe: {}, unit: 'pct' } },
        { key: 'grp', check: { kind: 'probe', all: [{}, {}], unit: 'ms' } },
        { key: 'bare', check: { kind: 'probe', probe: {} } },
      ],
    );
    expect(results.map((r) => [r.check.id, r.check.value, r.check.unit, r.verdict])).toEqual([
      ['lat:0', 42, 'pct', 'pass'],
      ['grp:0', 1, 'ms', 'pass'],
      ['grp:1', 2, 'ms', 'fail'],
      ['bare:0', 7, null, 'pass'],
    ]);
  });

  it('writes a null unit when the caller supplies no criteria (the pre-unit contract)', () => {
    const [row] = probeCheckResults('perf-fixture', { lat: single(42) } as Record<string, { kind: string }>);
    expect(row?.check.unit).toBeNull();
  });
});
