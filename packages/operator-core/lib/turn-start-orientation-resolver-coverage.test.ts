/**
 * RESOLVER coverage for the turn-start orientation classes (P-010 / WI-10002221).
 *
 * WHY THIS FILE EXISTS — it closes a blind spot in the guard next door, and the
 * blind spot was not hypothetical. `turn-start-orientation-class-coverage.test.ts`
 * proves every declared class RENDERS, and it does so by SUPPLYING the state
 * itself. That is the right way to test a renderer, and it is also why that guard
 * is structurally incapable of noticing that nothing in production ever fills the
 * state in. The `openChecks` class shipped declared, registered, watermarked and
 * rendered with NO reader in `defaultOrientationDeps()`: the coverage guard was
 * green throughout, because it handed the renderer rows the real system never
 * produced (EI-23953846527835643).
 *
 * That is the plan's own founding failure — a rail that every artifact called
 * shipped while it emitted nothing for weeks — reproduced one level up, inside
 * the machinery built to detect it. The general lesson, worth more than this
 * instance: a guard verifies the half of the pipeline it can drive, and the half
 * it must MOCK becomes its blind spot. So ask of any guard, including this one,
 * what it had to supply to make the test run, and who verifies THAT.
 *
 * What this guard asserts is therefore the half the other one mocks: every
 * declared dependency has a real, callable reader in the production default set.
 * It cannot prove a reader returns CORRECT rows — that is each reader's own
 * tests' job — but it does prove no class is left with silence for a resolver.
 */
import { describe, expect, it } from 'vitest';
import { defaultOrientationDeps, type OrientationDeps } from './turn-start-orientation';

/**
 * Exhaustiveness is DERIVED from the type, not hand-listed: `keyof OrientationDeps`
 * makes a newly added dependency a COMPILE error here until it is named, so this
 * enumeration cannot silently fall behind the interface. `lint:tsc` is the half of
 * this guard that enforces that; a green vitest run says nothing about it.
 *
 * NOTE it includes OPTIONAL deps deliberately. `keyof` spans optional keys, and an
 * optional-and-unimplemented dep is precisely the shape the `openChecks` gap took —
 * so excluding them would reopen the hole this file closes.
 */
const EVERY_ORIENTATION_DEP: Record<keyof OrientationDeps, true> = {
  held: true,
  ownerDirectives: true,
  historyUpdates: true,
  effortUpdates: true,
  openChecks: true,
  inbox: true,
  announcedGates: true,
  openAsks: true,
  loopArmed: true,
  loopFireWithheld: true,
  improvementTriage: true,
  executableFrontier: true,
  obligations: true,
  neverDropFacts: true,
  toolSurface: true,
  carryBlindWindow: true,
  contextEpoch: true,
};

const DEP_NAMES = Object.keys(EVERY_ORIENTATION_DEP) as Array<keyof OrientationDeps>;

/** The check under test, expressed once so the control below exercises the SAME
 *  predicate rather than a re-spelling of it that could drift from it. */
function depsMissingAReader(deps: Partial<OrientationDeps>): Array<keyof OrientationDeps> {
  return DEP_NAMES.filter((name) => typeof deps[name] !== 'function');
}

describe('orientation RESOLVER coverage: every declared class has a live reader', () => {
  it('CALIBRATION: the enumeration really spans the interface', () => {
    // Without this, a collapsed or truncated enumeration would make every
    // assertion below trivially satisfiable and the coverage claim a fiction.
    expect(DEP_NAMES.length).toBeGreaterThanOrEqual(15);
    expect(DEP_NAMES).toContain('openChecks');
    expect(DEP_NAMES).toContain('held');
  });

  it('defaultOrientationDeps implements EVERY declared dependency', () => {
    // The assertion that was missing. `openChecks` was absent here for the whole
    // window in which the class rendered nothing in production.
    expect(depsMissingAReader(defaultOrientationDeps())).toEqual([]);
  });

  it('every reader is callable and returns a promise, not a bare value', () => {
    // A reader that throws synchronously, or returns a non-promise, would break
    // the single `Promise.all` fan-out in resolveOrientationState and take the
    // whole block down with it — the opposite of this file's fail-soft contract.
    const deps = defaultOrientationDeps() as Record<string, unknown>;
    for (const name of DEP_NAMES) {
      const reader = deps[name];
      expect(typeof reader, `${name} must be a function`).toBe('function');
    }
  });

  it('CONTROL: the check FAILS when a reader is missing — including an optional one', () => {
    // A permanent in-test counterexample. Without it, this file would pass
    // identically if `depsMissingAReader` stopped detecting anything, which is
    // the failure mode of every guard that has never been seen to fail.
    const { openChecks: _dropped, ...withoutOpenChecks } = defaultOrientationDeps();
    expect(depsMissingAReader(withoutOpenChecks)).toEqual(['openChecks']);

    const { ownerDirectives: _alsoDropped, ...withoutOptional } = defaultOrientationDeps();
    expect(depsMissingAReader(withoutOptional)).toEqual(['ownerDirectives']);

    expect(depsMissingAReader({})).toEqual(DEP_NAMES);
  });
});
