/**
 * `boundOrientationRows` — the per-class row CEILING and its disclosure (P-019).
 *
 * WHAT THIS GUARDS THAT THE SIBLING TURN-START TESTS CANNOT.
 *
 * `turn-start-orientation-class-registry.test.ts` asserts the DECLARATION
 * contract (one entry per field, total order, sink selection) and
 * `-class-coverage.test.ts` asserts PRESENCE. Both are ceiling-blind: every one
 * of their assertions stays green while a class emits an unbounded number of
 * rows, because neither ever counts rows per class. Until this file existed
 * `boundOrientationRows` had no caller in any test in the package — the
 * mechanism that bounds every orientation surface was entirely unguarded.
 *
 * THE MEASURED CAUSE (D-079). Two classes were genuinely unbounded. The
 * `obligations` class does `lines.push(...projectedLines)` — it TRUSTS the
 * provider's `maxEntries`, it does not enforce it — and `announcedGates` looped
 * gate warnings with no cap at all. Either one, given a bad provider, starves
 * every class ordered after it. That is what the ceiling exists to stop, so
 * `bounds a runaway obligations provider` below drives the REAL registry rather
 * than a synthetic one.
 *
 * FALSIFIABILITY (D-075). An "unknown value" control is NOT falsifiability: a
 * ceiling test whose only control is an absent or nonsense ceiling passes just
 * as happily against an implementation that hardcodes the fixture's length. So
 * the primary test here runs the SAME rows through two VALID-BUT-WRONG ceilings
 * (2 and 3) and asserts the outputs DIFFER in both the kept set and the omitted
 * count — which is what proves the declared number is read per row.
 *
 * Every test is fixture-free in the same sense as its siblings: it builds rows
 * and registry entries from declarations, never a hand-built `OrientationState`.
 */
import { describe, expect, it } from 'vitest';

import {
  ORIENTATION_CLASS_REGISTRY,
  type OrientationSink,
  type RegisteredOrientationClass,
} from './orientation-class-registry';
// `boundOrientationRows` / `OrientationRow` are turn-start's own surface and are
// NOT re-exported through the seam, so they come from the owning module.
import {
  boundOrientationRows,
  type OrientationRow,
  type OrientationState,
} from './turn-start-orientation';

const TURN_START: readonly OrientationSink[] = ['turn-start'];

const row = (classId: keyof OrientationState, order: number, text: string): OrientationRow => ({
  classId,
  order,
  text,
});

/**
 * A registry entry that exists ONLY to carry a ceiling. `segments` is empty of
 * content because this bounder never renders — it is handed an already-projected
 * row list — so a segment with a body would be inert scenery in these tests.
 */
const ceilingClass = (
  id: keyof OrientationState,
  order: number,
  maxRows: number,
  recoveryVerb = 'synthetic:recover',
): RegisteredOrientationClass => ({
  id,
  watermarkTokens: [],
  applicableSinks: TURN_START,
  rowCeiling: { maxRows, recoveryVerb },
  segments: [{ order, render: () => [] }],
});

describe('boundOrientationRows — the per-class ceiling, falsifiably', () => {
  it('keeps exactly maxRows and discloses the remainder — and a DIFFERENT valid ceiling gives DIFFERENT output', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row('openChecks', 10, `check ${n}`));

    const atTwo = boundOrientationRows(rows, [ceilingClass('openChecks', 10, 2)]).map((r) => r.text);
    const atThree = boundOrientationRows(rows, [ceilingClass('openChecks', 10, 3)]).map((r) => r.text);

    expect(atTwo).toEqual([
      'check 1',
      'check 2',
      '- openChecks: +3 omitted — synthetic:recover',
    ]);

    // FALSIFIER (D-075): the control is a VALID-BUT-WRONG ceiling, not an absent
    // or nonsense one. Both the kept set AND the omitted count must move with the
    // declared number — an implementation that hardcoded the fixture's length, or
    // that read the ceiling once instead of per row, passes the first assertion
    // and fails here.
    expect(atThree).toEqual([
      'check 1',
      'check 2',
      'check 3',
      '- openChecks: +2 omitted — synthetic:recover',
    ]);
    expect(atThree).not.toEqual(atTwo);
  });

  it('emits no disclosure row when the class fits inside its ceiling', () => {
    const rows = [row('openChecks', 10, 'a'), row('openChecks', 10, 'b')];

    // CONTROL for the test above: without this, an implementation that appended a
    // disclosure unconditionally would satisfy every "+N omitted" assertion here.
    expect(boundOrientationRows(rows, [ceilingClass('openChecks', 10, 4)]).map((r) => r.text)).toEqual([
      'a',
      'b',
    ]);
  });

  it('bounds each class independently and anchors the disclosure inside its own class', () => {
    const rows = [
      row('openChecks', 10, 'check 1'),
      row('openChecks', 10, 'check 2'),
      row('openChecks', 10, 'check 3'),
      row('neverDropFacts', 20, 'fact 1'),
      row('neverDropFacts', 20, 'fact 2'),
    ];

    const out = boundOrientationRows(rows, [
      ceilingClass('openChecks', 10, 1, 'loop:status'),
      ceilingClass('neverDropFacts', 20, 2, 'facts:list'),
    ]).map((r) => r.text);

    // Two claims in one shape, both load-bearing:
    //  1. INDEPENDENCE — the runaway class spends only its own budget; both
    //     `neverDropFacts` rows survive even though the row list is over budget
    //     in aggregate. A bounder that counted globally drops 'fact 2'.
    //  2. ANCHORING — the recovery route sits immediately after the last
    //     surviving row OF ITS OWN CLASS, ahead of the next class. A route that
    //     drifted to the tail outlives nothing and is trimmed first by the outer
    //     character budget.
    expect(out).toEqual([
      'check 1',
      '- openChecks: +2 omitted — loop:status',
      'fact 1',
      'fact 2',
    ]);
  });

  it("places the disclosure at the class's own order slot when maxRows is 0 and nothing survives to anchor to", () => {
    const rows = [
      row('improvementTriage', 10, 'dropped 1'),
      row('improvementTriage', 10, 'dropped 2'),
      row('neverDropFacts', 20, 'fact'),
    ];

    const out = boundOrientationRows(rows, [
      ceilingClass('improvementTriage', 10, 0, 'improvements:capture'),
      ceilingClass('neverDropFacts', 20, 2, 'facts:list'),
    ]).map((r) => r.text);

    // maxRows 0 is the case with no surviving row to anchor to, so the fallback
    // is the order slot the class's first row would have held. FALSIFIER: an
    // implementation that appended on the empty-anchor path puts the recovery
    // route AFTER 'fact', which is the drift the anchoring exists to prevent.
    expect(out).toEqual([
      '- improvementTriage: +2 omitted — improvements:capture',
      'fact',
    ]);
  });

  it('leaves a row whose class has no registry entry ALONE rather than dropping it', () => {
    const rows = [
      row('openChecks', 10, 'registered'),
      row('loopArmed', 20, 'unregistered 1'),
      row('loopArmed', 20, 'unregistered 2'),
    ];

    // This is a BOUNDER, not a filter. A row it cannot find a ceiling for is a
    // registry gap for the coverage guard to report — deleting it here would
    // destroy the evidence of the gap and silently shrink the block.
    expect(boundOrientationRows(rows, [ceilingClass('openChecks', 10, 5)]).map((r) => r.text)).toEqual([
      'registered',
      'unregistered 1',
      'unregistered 2',
    ]);
  });
});

describe('boundOrientationRows — the live registry', () => {
  it('declares a finite, non-negative ceiling and a recovery verb on EVERY class', () => {
    expect(ORIENTATION_CLASS_REGISTRY.length).toBeGreaterThan(10); // calibration

    for (const entry of ORIENTATION_CLASS_REGISTRY) {
      const ceiling = entry.rowCeiling;
      const where = String(entry.id);
      expect(ceiling, where).toBeDefined();
      expect(Number.isInteger(ceiling.maxRows), where).toBe(true);
      expect(ceiling.maxRows, where).toBeGreaterThanOrEqual(0);
      // The ceiling is REQUIRED, never optional: a class that opted out with an
      // effectively-infinite number would reproduce the exact unbounded defect
      // P-019 exists to remove, while still satisfying a bare "is declared" check.
      expect(ceiling.maxRows, where).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(ceiling.recoveryVerb.trim(), where).not.toBe('');
    }
  });

  it('bounds a runaway obligations provider using the REAL registry ceiling (the measured D-079 cause)', () => {
    const declared = ORIENTATION_CLASS_REGISTRY.find((entry) => entry.id === 'obligations');
    expect(declared, 'obligations must be a registered class').toBeDefined();
    const ceiling = declared!.rowCeiling;
    expect(ceiling.maxRows).toBeGreaterThan(0); // calibration: an already-0 ceiling would make this vacuous

    // The call site TRUSTS the provider (`lines.push(...projectedLines)`), so the
    // provider ignoring its own maxEntries is the realistic failure. Read the
    // ceiling from the registry rather than hardcoding it: a deliberate retune
    // should not redden this test, but dropping enforcement must.
    const overBy = ceiling.maxRows + 1;
    const runaway = Array.from({ length: ceiling.maxRows + overBy }, (_, i) =>
      row('obligations', 84, `obligation ${i}`),
    );

    const out = boundOrientationRows(runaway);
    const kept = out.filter((r) => r.classId === 'obligations' && !r.text.includes('omitted'));

    expect(kept).toHaveLength(ceiling.maxRows);
    expect(out.map((r) => r.text)).toContain(
      `- obligations: +${overBy} omitted — ${ceiling.recoveryVerb}`,
    );
  });
});

/**
 * PROOF THAT THE ASSERTIONS ABOVE CAN FAIL.
 *
 * Every test above passed on its first run, which is exactly when a guard
 * deserves the least trust. The subject here is a MODULE this file imports, so
 * the repo's prescribed tier is a deliberately-wrong implementation kept
 * PERMANENTLY beside the real one — never an in-tree mutation of production
 * code, which on this swept shared tree can be committed by git-sync even when
 * nothing goes wrong, and which here would also mean locking a file two peers
 * are actively editing.
 *
 * Permanence is the point: a one-shot probe proves the guard was falsifiable
 * ONCE, on the day it was written. These controls re-prove it on every run, so
 * weakening a property below silently turns a mutant green and reddens its test.
 *
 * Each mutant is VALID-BUT-WRONG in D-075's sense — it compiles, it bounds, it
 * discloses, and it returns a plausible row list. Note that `off-by-one` at
 * maxRows 2 emits precisely what the REAL bounder emits at maxRows 3: that
 * collision is the whole reason an "unknown value" control proves nothing here.
 */
type Bounder = (
  rows: readonly OrientationRow[],
  registry: readonly RegisteredOrientationClass[],
) => OrientationRow[];

interface Defect {
  readonly offByOne?: boolean;
  readonly globalBudget?: boolean;
  readonly tailDisclosure?: boolean;
  readonly dropUnregistered?: boolean;
}

const deliberatelyWrong =
  (defect: Defect): Bounder =>
  (rows, registry) => {
    const ceilings = new Map(registry.map((entry) => [entry.id, entry.rowCeiling] as const));
    const kept: OrientationRow[] = [];
    const seen = new Map<keyof OrientationState, number>();
    const evicted = new Map<keyof OrientationState, { count: number; order: number }>();
    let globalSeen = 0;

    for (const current of rows) {
      const ceiling = ceilings.get(current.classId);
      if (!ceiling) {
        if (defect.dropUnregistered) continue;
        kept.push(current);
        continue;
      }
      const count = defect.globalBudget ? globalSeen : (seen.get(current.classId) ?? 0);
      const over = defect.offByOne ? count > ceiling.maxRows : count >= ceiling.maxRows;
      if (over) {
        const prior = evicted.get(current.classId);
        evicted.set(current.classId, {
          count: (prior?.count ?? 0) + 1,
          order: prior?.order ?? current.order,
        });
        continue;
      }
      seen.set(current.classId, (seen.get(current.classId) ?? 0) + 1);
      globalSeen += 1;
      kept.push(current);
    }

    if (evicted.size === 0) return kept;
    const out = [...kept];
    for (const [classId, info] of evicted) {
      const ceiling = ceilings.get(classId);
      if (!ceiling) continue;
      const disclosure: OrientationRow = {
        classId,
        order: info.order,
        text: `- ${classId}: +${info.count} omitted — ${ceiling.recoveryVerb}`,
      };
      if (defect.tailDisclosure) {
        out.push(disclosure);
        continue;
      }
      let lastIndex = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].classId === classId) {
          lastIndex = i;
          break;
        }
      }
      if (lastIndex >= 0) {
        out.splice(lastIndex + 1, 0, disclosure);
        continue;
      }
      const insertAt = out.findIndex((entry) => entry.order > info.order);
      out.splice(insertAt < 0 ? out.length : insertAt, 0, disclosure);
    }
    return out;
  };

/**
 * The properties this file claims, stated ONCE so the same battery runs against
 * the real bounder and against every mutant. Returns the names of the properties
 * a given implementation violates — `[]` means it satisfies all of them.
 */
interface CeilingProperty {
  readonly name: string;
  readonly run: (bound: Bounder) => { readonly actual: readonly string[]; readonly expected: readonly string[] };
}

const texts = (result: readonly OrientationRow[]) => result.map((r) => r.text);

const PROPERTIES: readonly CeilingProperty[] = [
  {
    name: 'ceiling-binds',
    run: (bound) => ({
      actual: texts(
        bound(
          [1, 2, 3, 4, 5].map((n) => row('openChecks', 10, `check ${n}`)),
          [ceilingClass('openChecks', 10, 2)],
        ),
      ),
      expected: ['check 1', 'check 2', '- openChecks: +3 omitted — synthetic:recover'],
    }),
  },
  {
    name: 'ceiling-is-read-per-row',
    run: (bound) => ({
      actual: texts(
        bound(
          [1, 2, 3, 4, 5].map((n) => row('openChecks', 10, `check ${n}`)),
          [ceilingClass('openChecks', 10, 3)],
        ),
      ),
      expected: ['check 1', 'check 2', 'check 3', '- openChecks: +2 omitted — synthetic:recover'],
    }),
  },
  {
    name: 'per-class-independence-and-anchoring',
    run: (bound) => ({
      actual: texts(
        bound(
          [
            row('openChecks', 10, 'check 1'),
            row('openChecks', 10, 'check 2'),
            row('openChecks', 10, 'check 3'),
            row('neverDropFacts', 20, 'fact 1'),
            row('neverDropFacts', 20, 'fact 2'),
          ],
          [
            ceilingClass('openChecks', 10, 1, 'loop:status'),
            ceilingClass('neverDropFacts', 20, 2, 'facts:list'),
          ],
        ),
      ),
      expected: ['check 1', '- openChecks: +2 omitted — loop:status', 'fact 1', 'fact 2'],
    }),
  },
  {
    name: 'empty-anchor-uses-order-slot',
    run: (bound) => ({
      actual: texts(
        bound(
          [
            row('improvementTriage', 10, 'dropped 1'),
            row('improvementTriage', 10, 'dropped 2'),
            row('neverDropFacts', 20, 'fact'),
          ],
          [
            ceilingClass('improvementTriage', 10, 0, 'improvements:capture'),
            ceilingClass('neverDropFacts', 20, 2, 'facts:list'),
          ],
        ),
      ),
      expected: ['- improvementTriage: +2 omitted — improvements:capture', 'fact'],
    }),
  },
  {
    name: 'unregistered-passes-through',
    run: (bound) => ({
      actual: texts(
        bound(
          [row('openChecks', 10, 'registered'), row('loopArmed', 20, 'unregistered')],
          [ceilingClass('openChecks', 10, 5)],
        ),
      ),
      expected: ['registered', 'unregistered'],
    }),
  },
];

const PROPERTY_NAMES: readonly string[] = PROPERTIES.map((property) => property.name);

const violations = (bound: Bounder): string[] =>
  PROPERTIES.filter((property) => {
    const { actual, expected } = property.run(bound);
    return JSON.stringify(actual) !== JSON.stringify(expected);
  }).map((property) => property.name);

const MUTANTS: readonly { readonly name: string; readonly bound: Bounder; readonly caughtBy: string }[] = [
  {
    name: 'off-by-one ceiling — keeps maxRows + 1 rows',
    bound: deliberatelyWrong({ offByOne: true }),
    caughtBy: 'ceiling-binds',
  },
  {
    name: 'one global budget instead of a per-class one',
    bound: deliberatelyWrong({ globalBudget: true }),
    caughtBy: 'per-class-independence-and-anchoring',
  },
  {
    name: 'disclosure appended at the tail instead of anchored to its class',
    bound: deliberatelyWrong({ tailDisclosure: true }),
    caughtBy: 'per-class-independence-and-anchoring',
  },
  {
    name: 'silently drops rows whose class has no registry entry',
    bound: deliberatelyWrong({ dropUnregistered: true }),
    caughtBy: 'unregistered-passes-through',
  },
];

describe('boundOrientationRows — the guard is falsifiable', () => {
  it('CALIBRATION: the real bounder satisfies every property claimed here', () => {
    // Without this, the mutant assertions below would also pass against a
    // battery that is simply broken and fails everything it is handed.
    expect(violations(boundOrientationRows)).toEqual([]);
  });

  for (const mutant of MUTANTS) {
    it(`catches a valid-but-wrong bounder: ${mutant.name}`, () => {
      const failed = violations(mutant.bound);
      expect(failed.length).toBeGreaterThan(0);
      // Naming the property pins WHICH assertion is load-bearing for this
      // mutant: if that property is later weakened, this goes red instead of
      // the mutant quietly passing behind an unrelated failure.
      expect(failed).toContain(mutant.caughtBy);
    });
  }

  it('no assertion in the battery is dead weight — every property is violated by some mutant', () => {
    const exercised = new Set(MUTANTS.flatMap((mutant) => violations(mutant.bound)));

    // A property no mutant can violate is either untestable or vacuously true,
    // and either way it is a comment rather than a guard. This is what stops the
    // battery above from accumulating assertions that cannot fail.
    expect([...exercised].sort()).toEqual([...PROPERTY_NAMES].sort());
  });
});
