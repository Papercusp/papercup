import { describe, expect, it } from 'vitest';

import {
  buildGateRoundPhases,
  GATE_ROUND_OTHER_PHASE,
  GATE_ROUND_PHASES_MAX,
  parseGateRoundPhases,
} from './gate-round-phases';

describe('buildGateRoundPhases (P-013)', () => {
  const stamps = [
    { phase: 'setup-tree', ms: 120_000 },
    { phase: 'early-typecheck-preflight', ms: 60_000 },
    { phase: 'candidate-suite', ms: 2_400_000 },
  ];

  it('keeps stamped phases in run order and reports the unstamped remainder as other', () => {
    const r = buildGateRoundPhases(stamps, 3_000_000);
    expect(r?.phases).toEqual([...stamps, { phase: GATE_ROUND_OTHER_PHASE, ms: 420_000 }]);
    // The parts add up to the measured total — the property the breakdown exists to give.
    expect(r?.phases.reduce((sum, p) => sum + p.ms, 0)).toBe(r?.totalMs);
    expect(r?.breakdown).toBe(
      'total 50m 00s: setup-tree 2m 00s (4%), early-typecheck-preflight 1m 00s (2%), ' +
        'candidate-suite 40m 00s (80%), other 7m 00s (14%)',
    );
  });

  it('omits other when the stamps cover the whole round, and never makes it negative', () => {
    expect(buildGateRoundPhases(stamps, 2_580_000)?.phases.map((p) => p.phase)).not.toContain('other');
    const over = buildGateRoundPhases(stamps, 1_000_000);
    expect(over?.phases.some((p) => p.ms < 0)).toBe(false);
    expect(over?.phases.map((p) => p.phase)).not.toContain('other');
  });

  it.each([0, -5, Number.NaN])('returns null for an unmeasured total (%s) instead of inventing shares', (total) => {
    expect(buildGateRoundPhases(stamps, total)).toBeNull();
  });

  it('caps the stored phase list, keeping room for other', () => {
    const many = Array.from({ length: GATE_ROUND_PHASES_MAX + 10 }, (_, i) => ({ phase: `p${i}`, ms: 1_000 }));
    const r = buildGateRoundPhases(many, 10_000_000);
    expect(r?.phases.length).toBeLessThanOrEqual(GATE_ROUND_PHASES_MAX);
    expect(r?.phases.at(-1)?.phase).toBe(GATE_ROUND_OTHER_PHASE);
  });
});

describe('parseGateRoundPhases (P-013)', () => {
  const built = () => buildGateRoundPhases([{ phase: 'candidate-suite', ms: 60_000 }], 90_000)!;

  it('round-trips a built breakdown through JSON', () => {
    expect(parseGateRoundPhases(JSON.parse(JSON.stringify(built())))).toEqual(built());
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a zero total', { ...built(), totalMs: 0 }],
    ['an empty breakdown', { ...built(), breakdown: '' }],
    ['a negative phase', { ...built(), phases: [{ phase: 'x', ms: -1 }] }],
    ['an unnamed phase', { ...built(), phases: [{ phase: '', ms: 1 }] }],
    ['too many phases', { ...built(), phases: Array.from({ length: GATE_ROUND_PHASES_MAX + 1 }, () => ({ phase: 'x', ms: 1 })) }],
  ])('reads %s as not measured', (_label, value) => {
    expect(parseGateRoundPhases(value)).toBeNull();
  });
});
