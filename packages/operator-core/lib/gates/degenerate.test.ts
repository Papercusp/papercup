/**
 * degenerate.test.ts — EI-10619. The detector must SEPARATE, and the pair it has to separate is
 * the one that killed EI-10609:
 *
 *   a BROKEN discriminator that rejects 100%   vs   a HEALTHY safety limit that fires 0%.
 *
 * Over (verdict, value, threshold) alone these are indistinguishable — both are perfectly
 * one-sided, both have the threshold outside the observed value range. If this suite passed with
 * the `expect` column removed, the column would be decoration and the whole design a fraud. The
 * last describe block PINS that: it re-runs the same fixtures with `expect` forced to a single
 * value and asserts the detector goes blind.
 *
 * Run: cd packages/operator-core && npx vitest run lib/gates/degenerate.test.ts
 */
import { describe, it, expect as vitestExpect } from 'vitest';
import { judgeGates, GATE_REGISTRY } from './degenerate';
import type { GateExpectation } from './decision';

const row = (o: {
  gate: string;
  expect: GateExpectation;
  passes: number;
  rejects: number;
  min_value?: number | null;
  max_value?: number | null;
  threshold?: number | null;
}) => ({
  gate: o.gate,
  expect: o.expect,
  decisions: o.passes + o.rejects,
  passes: o.passes,
  rejects: o.rejects,
  min_value: o.min_value ?? null,
  max_value: o.max_value ?? null,
  threshold: o.threshold ?? null,
});

/** The real EI-10372 shape: floor 0.05 against healthy RRF rank-fusion scores (ceiling ~0.0328). */
const EI_10372_PRE_FIX = row({
  gate: 'orient.recall.relevance-floor',
  expect: 'discriminates',
  passes: 0,
  rejects: 200,
  min_value: 0.0102,
  max_value: 0.0328,
  threshold: 0.05,
});

/** The same gate, post-fix: regime-scoped, so it separates. */
const EI_10372_POST_FIX = row({
  gate: 'orient.recall.relevance-floor',
  expect: 'discriminates',
  passes: 160,
  rejects: 40,
  min_value: 0.0102,
  max_value: 0.71,
  threshold: 0.05,
});

/** A healthy safety limit that correctly never trips. ONE-SIDED, threshold off-range — and FINE. */
const HEALTHY_NEVER_TRIPS = row({
  gate: 'orient.recall.char-budget',
  expect: 'guards',
  passes: 200,
  rejects: 0,
  min_value: 120,
  max_value: 900,
  threshold: 1600,
});

const noRegistry = { registry: [] as typeof GATE_REGISTRY };

describe('judgeGates — the cannot-discriminate rule (EI-10619)', () => {
  it('FLAGS a discriminator that never admits — and proves the branch is unreachable BY SCALE', () => {
    const [f] = judgeGates([EI_10372_PRE_FIX], noRegistry);
    vitestExpect(f.verdict).toBe('never-admits');
    vitestExpect(f.explain).toContain('unreachable by scale');
    // The explanation must carry the numbers that make it a proof, not an opinion.
    vitestExpect(f.explain).toContain('0.05');
    vitestExpect(f.explain).toContain('0.0328');
  });

  it('goes DARK on the same gate once fixed (regime-scoped ⇒ it separates)', () => {
    vitestExpect(judgeGates([EI_10372_POST_FIX], noRegistry)).toEqual([]);
  });

  it('FLAGS a vacuous discriminator that never rejects (EI-10562 shape, inverted)', () => {
    const [f] = judgeGates(
      [
        row({
          gate: 'declare.semantic-dedup',
          expect: 'discriminates',
          passes: 0 + 60,
          rejects: 0,
          min_value: 0.083, // the cosine noise floor alone already clears the threshold
          max_value: 0.9,
          threshold: 0.05,
        }),
      ],
      noRegistry,
    );
    vitestExpect(f.verdict).toBe('never-rejects');
    vitestExpect(f.explain).toContain('unreachable by scale');
  });

  it('⭐ stays SILENT on a healthy safety limit that never fires — the EI-10609 false positive', () => {
    // This is the whole ballgame. Same one-sided distribution as EI_10372_PRE_FIX, same
    // threshold-outside-the-range geometry. The ONLY difference is that it declared `guards`.
    vitestExpect(judgeGates([HEALTHY_NEVER_TRIPS], noRegistry)).toEqual([]);
  });

  it('says NOTHING when the sample is too small to mean anything', () => {
    const tiny = row({
      gate: 'orient.recall.relevance-floor',
      expect: 'discriminates',
      passes: 0,
      rejects: 3,
      min_value: 0.01,
      max_value: 0.02,
      threshold: 0.05,
    });
    vitestExpect(judgeGates([tiny], noRegistry)).toEqual([]);
  });

  it('does NOT claim a scale proof when the threshold is INSIDE the observed range', () => {
    // One-sided, but reachable: the inputs are lopsided, not the constant. Report it — but an
    // honest detector must not dress a coincidence up as a proof.
    const [f] = judgeGates(
      [
        row({
          gate: 'orient.recall.relevance-floor',
          expect: 'discriminates',
          passes: 0,
          rejects: 50,
          min_value: 0.01,
          max_value: 0.09, // straddles the 0.05 threshold — the pass branch IS reachable
          threshold: 0.05,
        }),
      ],
      noRegistry,
    );
    vitestExpect(f.verdict).toBe('never-admits');
    vitestExpect(f.explain).not.toContain('unreachable by scale');
    vitestExpect(f.explain).toContain('Check the caller before the constant');
  });

  it('surfaces a `guards` gate that fires constantly as MIS-DECLARED (the declaration is checked)', () => {
    const [f] = judgeGates(
      [row({ gate: 'orient.recall.queen-loop-withhold', expect: 'guards', passes: 10, rejects: 90 })],
      noRegistry,
    );
    vitestExpect(f.verdict).toBe('guard-fires-constantly');
    vitestExpect(f.explain).toContain('mis-declared');
  });
});

describe('absence is the severest verdict — you cannot find a missing row in the rows you have', () => {
  it('reports a REGISTERED gate that emitted nothing as never-ran (Shape 3/4)', () => {
    // The floor is in the registry. The decision log has only the OTHER two gates. A detector that
    // iterated the data would see two healthy gates and report all-clear.
    const found = judgeGates(
      [
        row({ gate: 'orient.recall.queen-loop-withhold', expect: 'guards', passes: 100, rejects: 0 }),
        HEALTHY_NEVER_TRIPS,
      ],
      { registry: GATE_REGISTRY },
    );
    const floor = found.find((f) => f.gate === 'orient.recall.relevance-floor');
    vitestExpect(floor?.verdict).toBe('never-ran');
    vitestExpect(floor?.explain).toContain('not running');
  });

  it('is silent when every registered gate reported in', () => {
    const rows = GATE_REGISTRY.map((g) =>
      row({ gate: g.gate, expect: g.expect, passes: 100, rejects: g.expect === 'discriminates' ? 40 : 0 }),
    );
    vitestExpect(judgeGates(rows, { registry: GATE_REGISTRY })).toEqual([]);
  });
});

describe('⭐ the `expect` column is LOAD-BEARING, not decoration', () => {
  const fixtures = [EI_10372_PRE_FIX, HEALTHY_NEVER_TRIPS];

  it('separates broken-from-healthy ONLY because each gate declared its intent', () => {
    const found = judgeGates(fixtures, noRegistry);
    vitestExpect(found.map((f) => f.gate)).toEqual(['orient.recall.relevance-floor']);
  });

  it('MISFIRES in both directions when intent is stripped — no statistic over the numbers can do this', () => {
    // Force every gate to the same declaration and the detector loses the ability to tell the
    // broken discriminator from the healthy limit. Both failures below are real, and they are why
    // `expect` is a column rather than a heuristic.

    // Declare everything a discriminator ⇒ the healthy char-budget (one-sided, threshold off-range,
    // and entirely CORRECT) is condemned. This is EI-10609's grave: "~0% fire rate is the modal
    // value across 39% of the tool catalogue."
    const allDiscriminate = fixtures.map((f) => ({ ...f, expect: 'discriminates' as GateExpectation }));
    vitestExpect(judgeGates(allDiscriminate, noRegistry).map((f) => f.gate).sort()).toEqual([
      'orient.recall.char-budget', // ← FALSE POSITIVE: a healthy limit condemned as broken
      'orient.recall.relevance-floor',
    ]);

    // Declare everything a guard ⇒ EI-10372 is not missed, but it is MISDIAGNOSED, which is just as
    // costly: `guard-fires-constantly` reads "the system it guards is degraded", so you go and
    // audit the memory STORE — when the store is perfectly healthy and the bug is a constant that
    // sits above the score scale. A monitor that names the wrong half of the system is a monitor
    // that burns the on-call, exactly the failure mode of the alert wording fixed in EI-10666.
    const allGuard = fixtures.map((f) => ({ ...f, expect: 'guards' as GateExpectation }));
    const misdiagnosed = judgeGates(allGuard, noRegistry);
    vitestExpect(misdiagnosed.map((f) => f.gate)).toEqual(['orient.recall.relevance-floor']);
    vitestExpect(misdiagnosed[0].verdict).toBe('guard-fires-constantly'); // NOT 'never-admits'
    vitestExpect(misdiagnosed[0].explain).toContain('degraded'); // points at the store, not the constant
    vitestExpect(misdiagnosed[0].explain).not.toContain('unreachable by scale'); // the actual fault, lost
  });
});
