/**
 * Unit tests for the launch prose budget (agent-launch-context-cost-2026-09-18 P-004).
 *
 * THE POINT OF THIS FILE is not that a number under a ceiling passes — that branch is
 * trivial and is the one a reviewer's eye goes to. It is that the FOUR ways a byte-budget
 * guard goes green WITHOUT HAVING MEASURED ANYTHING are each a red here. Every one of
 * them is a real failure shape this repo has hit under a different name: a `-t` pattern
 * matching zero tests, a `| head` truncation, a wrong-relation SQL zero-row, a positive
 * control built from a zero-byte file. An upper-bound check is satisfied trivially by a
 * measurement that collapsed, so a budget guard without these cases is a guard that
 * cannot fail for the reason you care about.
 *
 * A DELIBERATELY-WRONG CONTROL lives here permanently (`brokenCompare`) rather than being
 * produced by mutating the real implementation: the repo's mutation-probe discipline
 * forbids mutating a tracked file in the shared tree to prove falsifiability, and a
 * resident control is the prescribed tier for a module you `import`. It encodes the naive
 * `bytes <= ceiling` check, and the tests assert it PASSES exactly the inputs the real
 * implementation FAILS — so if the real one ever degrades into it, these tests break.
 */
import { describe, expect, it } from 'vitest';
import {
  RATCHET_GRANULARITY_BYTES,
  ceilingForMeasurement,
  checkComposition,
  compareProseBudget,
  ratchetCeilings,
  renderProseBudgetReport,
  type ProseBudgetBaseline,
  type ProseSurfaceMeasurement,
} from './launch-prose-budget';

const baseline: ProseBudgetBaseline = {
  schemaVersion: 1,
  generatedAt: '2026-09-18T00:00:00.000Z',
  ceilings: [
    { surface: 'playbook', ceilingBytes: 100_000, floorBytes: 40_000, note: 'the render' },
    { surface: 'guide', ceilingBytes: 50_000, floorBytes: 10_000, note: 'the project guide' },
  ],
};

const m = (surface: string, bytes: number): ProseSurfaceMeasurement => ({
  surface,
  bytes,
  source: `${surface}-source`,
});

/**
 * The naive implementation, kept as a permanent control. It is what this module would
 * collapse to if the non-obvious branches were ever "simplified" away.
 */
function brokenCompare(
  measurements: readonly ProseSurfaceMeasurement[],
  b: ProseBudgetBaseline,
): boolean {
  const byMeasurement = new Map(measurements.map((x) => [x.surface, x]));
  return b.ceilings.every((c) => {
    const found = byMeasurement.get(c.surface);
    return !found || found.bytes <= c.ceilingBytes;
  });
}

describe('compareProseBudget — the ordinary case', () => {
  it('passes when every surface is under its ceiling, and reports the headroom', () => {
    const r = compareProseBudget([m('playbook', 90_000), m('guide', 45_000)], baseline);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.verdicts.map((v) => v.status)).toEqual(['ok', 'ok']);
    expect(r.verdicts[0]!.headroomBytes).toBe(10_000);
    expect(r.totalMeasuredBytes).toBe(135_000);
    expect(r.totalCeilingBytes).toBe(150_000);
  });

  it('fails a surface over its ceiling and names the overage', () => {
    const r = compareProseBudget([m('playbook', 100_001), m('guide', 45_000)], baseline);
    expect(r.ok).toBe(false);
    const over = r.verdicts.find((v) => v.surface === 'playbook')!;
    expect(over.status).toBe('over');
    expect(over.headroomBytes).toBe(-1);
    expect(over.message).toContain('over its ceiling');
    // The naive control agrees here — this is the ONE case it gets right, which is
    // exactly why it survives review.
    expect(brokenCompare([m('playbook', 100_001), m('guide', 45_000)], baseline)).toBe(false);
  });

  it('treats the ceiling as inclusive — exactly at the ceiling is not a regression', () => {
    const r = compareProseBudget([m('playbook', 100_000), m('guide', 50_000)], baseline);
    expect(r.ok).toBe(true);
  });
});

describe('compareProseBudget — the vacuous-green traps', () => {
  it('FAILS a measurement below its plausibility floor instead of celebrating it', () => {
    // A render that threw, a path that moved, a splice that produced nothing: all land
    // here, and all look like a spectacular reduction to an upper-bound check.
    const collapsed = [m('playbook', 12), m('guide', 45_000)];
    const r = compareProseBudget(collapsed, baseline);
    expect(r.ok).toBe(false);
    const v = r.verdicts.find((x) => x.surface === 'playbook')!;
    expect(v.status).toBe('implausible');
    expect(v.message).toContain('BELOW its plausibility floor');
    // The control PASSES it — 12 <= 100,000. This is the regression these tests exist for.
    expect(brokenCompare(collapsed, baseline)).toBe(true);
  });

  it('FAILS a ceiling that nothing measured — a guard that stops measuring goes green forever', () => {
    const partial = [m('playbook', 90_000)];
    const r = compareProseBudget(partial, baseline);
    expect(r.ok).toBe(false);
    const v = r.verdicts.find((x) => x.surface === 'guide')!;
    expect(v.status).toBe('unmeasured');
    expect(v.bytes).toBeNull();
    expect(brokenCompare(partial, baseline)).toBe(true);
  });

  it('FAILS a measured surface with no declared ceiling — a new surface is declared, not absorbed', () => {
    const extra = [m('playbook', 90_000), m('guide', 45_000), m('kernel', 30_000)];
    const r = compareProseBudget(extra, baseline);
    expect(r.ok).toBe(false);
    const v = r.verdicts.find((x) => x.surface === 'kernel')!;
    expect(v.status).toBe('unbaselined');
    expect(v.ceilingBytes).toBeNull();
    expect(brokenCompare(extra, baseline)).toBe(true);
  });

  it('FAILS a non-finite measurement rather than letting NaN slip through the comparison', () => {
    // NaN's outcome depends on WHICH comparison a naive check happens to be written with,
    // and the two spellings disagree: `NaN <= ceiling` is false (rejects, by luck) while
    // `NaN > ceiling` is also false (ACCEPTS, by the same luck). A guard whose treatment of
    // a failed measurement is decided by an author's choice of operator is not a guard, so
    // the real implementation tests finiteness EXPLICITLY instead of inheriting either.
    // Measured, not assumed: `brokenCompare` uses `<=` and therefore happens to reject this
    // one — the control is deliberately NOT asserted here, because it would be asserting a
    // coincidence.
    const nan = [{ surface: 'playbook', bytes: Number.NaN, source: 'x' }, m('guide', 45_000)];
    const r = compareProseBudget(nan, baseline);
    expect(r.ok).toBe(false);
    expect(r.verdicts.find((x) => x.surface === 'playbook')!.status).toBe('implausible');
    // The `>`-spelled naive check — the one a reviewer is equally likely to write — DOES
    // accept it, which is the trap being closed.
    expect(Number.NaN > 100_000).toBe(false);
  });

  it('reports EVERY failing surface, not just the first', () => {
    const r = compareProseBudget([m('playbook', 100_001), m('guide', 5)], baseline);
    expect(r.failures.map((f) => f.status).sort()).toEqual(['implausible', 'over']);
  });
});

describe('checkComposition — the positive control a byte floor cannot provide', () => {
  const probes = [
    { component: 'the base playbook', literal: '## Base' },
    { component: 'the project guide', literal: '# Guide' },
  ];

  it('passes when every declared component is present', () => {
    const v = checkComposition('## Base\nbody\n# Guide\nmore', probes);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it('catches a component that silently stopped splicing, even though the text is still large', () => {
    // The whole point: this text is ENORMOUS and would clear any plausible byte floor,
    // yet it is missing a whole section. Byte-wise it reads as a win.
    const lostGuide = `## Base\n${'x'.repeat(200_000)}`;
    const v = checkComposition(lostGuide, probes);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([{ component: 'the project guide', literal: '# Guide' }]);
    expect(v.message).toContain('reads exactly like a successful reduction');
  });

  it('names every missing component at once', () => {
    const v = checkComposition('unrelated text', probes);
    expect(v.missing.map((x) => x.component)).toEqual(['the base playbook', 'the project guide']);
  });
});

describe('ratchetCeilings — down-only, by construction', () => {
  it('lowers a ceiling to the next whole kilobyte above the measurement', () => {
    const r = ratchetCeilings(baseline, [m('playbook', 61_200), m('guide', 45_000)]);
    expect(r.lowered).toEqual([
      { surface: 'playbook', from: 100_000, to: 62_000, savedBytes: 38_000 },
      { surface: 'guide', from: 50_000, to: 45_000, savedBytes: 5_000 },
    ]);
    expect(r.baseline.ceilings[0]!.ceilingBytes).toBe(62_000);
  });

  it('NEVER raises — a measurement over the ceiling leaves it untouched', () => {
    // The ratchet must not be usable to absorb a regression. Over-ceiling is a job for
    // the gate (a red), never for the ratchet (a rewrite).
    const r = ratchetCeilings(baseline, [m('playbook', 500_000), m('guide', 45_000)]);
    expect(r.lowered.map((l) => l.surface)).toEqual(['guide']);
    expect(r.baseline.ceilings[0]!.ceilingBytes).toBe(100_000);
    expect(r.unchanged).toContain('playbook');
  });

  it('is idempotent — re-ratcheting an unchanged tree produces a byte-identical baseline', () => {
    const once = ratchetCeilings(baseline, [m('playbook', 61_200), m('guide', 45_000)]);
    const twice = ratchetCeilings(once.baseline, [m('playbook', 61_200), m('guide', 45_000)]);
    expect(twice.lowered).toEqual([]);
    expect(twice.baseline).toEqual(once.baseline);
  });

  it('REFUSES to ratchet to a measurement below the floor — that would bake in a broken reading', () => {
    // Ratcheting to a collapsed measurement sets the ceiling AT the collapse, so every
    // later run compares against it and passes. The broken instrument becomes the standard.
    const r = ratchetCeilings(baseline, [m('playbook', 12), m('guide', 45_000)]);
    expect(r.skippedImplausible).toEqual(['playbook']);
    expect(r.baseline.ceilings[0]!.ceilingBytes).toBe(100_000);
  });

  it('leaves the baseline object untouched when nothing lowered, including its timestamp', () => {
    const r = ratchetCeilings(baseline, [m('playbook', 100_000), m('guide', 50_000)]);
    expect(r.baseline).toBe(baseline);
  });

  it('does not invent ceilings for surfaces it was not given a measurement for', () => {
    const r = ratchetCeilings(baseline, [m('playbook', 61_200)]);
    expect(r.unchanged).toContain('guide');
    expect(r.baseline.ceilings.find((c) => c.surface === 'guide')!.ceilingBytes).toBe(50_000);
  });
});

describe('ceilingForMeasurement', () => {
  it('rounds up to the granularity, and leaves an exact multiple alone', () => {
    expect(ceilingForMeasurement(1)).toBe(RATCHET_GRANULARITY_BYTES);
    expect(ceilingForMeasurement(253_315)).toBe(254_000);
    expect(ceilingForMeasurement(254_000)).toBe(254_000);
  });

  it('keeps the slack under one kilobyte for any measurement', () => {
    for (const bytes of [1, 999, 1_000, 1_001, 18_529, 121_670, 253_315]) {
      const slack = ceilingForMeasurement(bytes) - bytes;
      expect(slack).toBeGreaterThanOrEqual(0);
      expect(slack).toBeLessThan(RATCHET_GRANULARITY_BYTES);
    }
  });
});

describe('renderProseBudgetReport', () => {
  it('renders one line per surface plus a total, and marks failures distinctly from passes', () => {
    const r = compareProseBudget([m('playbook', 100_001), m('guide', 45_000)], baseline);
    const out = renderProseBudgetReport(r);
    expect(out).toContain('OVER  playbook');
    expect(out).toContain('ok    guide');
    expect(out).toContain('total measured');
  });
});
