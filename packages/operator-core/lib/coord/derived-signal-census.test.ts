/**
 * P-007 — the dead-derived-signal census.
 *
 * The cases below pin the distinctions whose LOSS produces a green detector over a
 * dead signal. Two of them reproduce defects that really shipped: `holds-a-lock-on`
 * (input leg never wired — silent 12 days, D-088) and `current_files` (leg wired,
 * producer dead — 119 live rows, zero populated). A census that cannot tell those
 * apart is the bare firing count this replaced.
 */
import { describe, expect, it } from 'vitest';
import { DERIVED_COUPLING_RELATIONS, type DerivedCoupling } from './couplings';
import {
  DERIVED_SIGNAL_CENSUS_KEY,
  DERIVED_SIGNAL_CENSUS_VERSION,
  DERIVED_SIGNAL_LEGS,
  censusDerivedSignals,
  type DerivedSignalLeg,
  type DerivedSignalLegState,
} from './derived-signal-census';

const LEGS_ALL_ARMED: Record<DerivedSignalLeg, DerivedSignalLegState> = {
  roster: { armed: true, inputs: 3 },
  heldFiles: { armed: true, inputs: 2 },
  planEdges: { armed: true, inputs: 1 },
  recentPartners: { armed: true, inputs: 4 },
};

const edge = (relation: string, ownerId = 'peer-1'): DerivedCoupling =>
  ({ ownerId, relation, because: 'x' }) as DerivedCoupling;

describe('the census contract: every relation is reported, including its zeros', () => {
  it('emits a row for EVERY declared relation even when nothing fired', () => {
    const census = censusDerivedSignals(LEGS_ALL_ARMED, []);
    for (const relation of DERIVED_COUPLING_RELATIONS) {
      expect(census.relations[relation], `missing census row for ${relation}`).toBeDefined();
      expect(census.relations[relation].edges).toBe(0);
    }
    expect(Object.keys(census.relations)).toHaveLength(DERIVED_COUPLING_RELATIONS.length);
  });

  /**
   * The whole probe reads `unobserved` off a missing key, so a census that quietly
   * dropped its zeros would report a dead signal as "the detector has a hole" — or,
   * worse, be tuned into reporting nothing at all.
   */
  it('does not omit a silent relation (omission is what makes a detector blind)', () => {
    const census = censusDerivedSignals(LEGS_ALL_ARMED, [edge('awaits')]);
    expect(census.relations['holds-a-lock-on']).toEqual({ armed: true, inputs: 2, edges: 0 });
    expect(census.relations.awaits.edges).toBe(1);
  });

  it('carries a schema tag so a shape change is detectable rather than silent', () => {
    expect(censusDerivedSignals(LEGS_ALL_ARMED, []).v).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
    expect(DERIVED_SIGNAL_CENSUS_KEY).toBe('derivedSignals');
  });
});

/**
 * ⚠ THIS IS NOT A DUPLICATE OF THE `satisfies` IN THE SOURCE. Vitest transforms
 * via esbuild and does NOT typecheck, so the compile-time exhaustiveness guard is
 * invisible to every test run — a relation added without a leg would type-error in
 * `lint:tsc` and pass here in silence. This asserts the same property at runtime,
 * which is the half that actually runs in the affected-tests loop.
 */
describe('a new derived relation cannot be born unobservable', () => {
  it('declares an input leg for every relation in the vocabulary', () => {
    const missing = DERIVED_COUPLING_RELATIONS.filter(
      (r) => !(r in DERIVED_SIGNAL_LEGS) || !DERIVED_SIGNAL_LEGS[r],
    );
    expect(missing, `relations with no declared input leg: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no leg for a relation that is not in the vocabulary', () => {
    const declared = new Set<string>(DERIVED_COUPLING_RELATIONS);
    const stale = Object.keys(DERIVED_SIGNAL_LEGS).filter((r) => !declared.has(r));
    expect(stale, `legs declared for retired relations: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('armed is not emitted — the distinction the bare firing count could not make', () => {
  /**
   * D-088's defect, reproduced. `couplingSourcesFor` supplies `heldFiles` ONLY when
   * a coordination domain resolved; for 12 days no production call resolved one, so
   * the leg was absent on every run. An emit count reports 0 either way; `armed`
   * separates the dead gate from the quiet week.
   */
  it('reports the holds-a-lock-on gate as UNARMED when its input was never wired in', () => {
    const census = censusDerivedSignals(
      { ...LEGS_ALL_ARMED, heldFiles: { armed: false, inputs: 0 } },
      [edge('awaits')],
    );
    expect(census.relations['holds-a-lock-on']).toEqual({ armed: false, inputs: 0, edges: 0 });
    // The control: a sibling relation on a healthy leg is unaffected, so the report
    // names the ONE broken gate rather than smearing suspicion across the run.
    expect(census.relations['coord-exchange'].armed).toBe(true);
  });

  it('reports the same relation as ARMED once the leg is supplied (P-004 fix shape)', () => {
    const census = censusDerivedSignals(LEGS_ALL_ARMED, [edge('holds-a-lock-on')]);
    expect(census.relations['holds-a-lock-on']).toEqual({ armed: true, inputs: 2, edges: 1 });
  });

  /**
   * `current_files`'s shape: the relation is wired and consulted every run, and the
   * field it reads is empty on essentially every roster row. Reporting this
   * identically to the unarmed case would send someone to fix a gate that is fine.
   */
  it('separates a wired-but-starved leg from an unwired one', () => {
    const starved = censusDerivedSignals(
      { ...LEGS_ALL_ARMED, roster: { armed: true, inputs: 0 } },
      [],
    );
    expect(starved.relations['shared-file']).toEqual({ armed: true, inputs: 0, edges: 0 });
    expect(starved.relations['shared-file'].armed).not.toBe(
      censusDerivedSignals({ ...LEGS_ALL_ARMED, roster: { armed: false, inputs: 0 } }, []).relations[
        'shared-file'
      ].armed,
    );
  });
});

describe('edge counting', () => {
  it('counts per relation, not in aggregate', () => {
    const census = censusDerivedSignals(LEGS_ALL_ARMED, [
      edge('awaits', 'a'),
      edge('awaits', 'b'),
      edge('coord-exchange', 'a'),
    ]);
    expect(census.relations.awaits.edges).toBe(2);
    expect(census.relations['coord-exchange'].edges).toBe(1);
    expect(census.relations['blocks-me'].edges).toBe(0);
  });

  it('ignores an edge carrying no usable relation rather than throwing', () => {
    const census = censusDerivedSignals(LEGS_ALL_ARMED, [
      { ownerId: 'a', because: 'x' } as unknown as DerivedCoupling,
      edge('awaits'),
    ]);
    expect(census.relations.awaits.edges).toBe(1);
  });

  it('never reports a negative or fractional input count', () => {
    const census = censusDerivedSignals(
      { ...LEGS_ALL_ARMED, heldFiles: { armed: true, inputs: -4 }, planEdges: { armed: true, inputs: 2.7 } },
      [],
    );
    expect(census.relations['holds-a-lock-on'].inputs).toBe(0);
    expect(census.relations['blocks-me'].inputs).toBe(2);
  });

  it('treats a missing leg state as unarmed rather than crashing the derivation', () => {
    const census = censusDerivedSignals(
      { roster: { armed: true, inputs: 1 } } as unknown as Record<DerivedSignalLeg, DerivedSignalLegState>,
      [],
    );
    expect(census.relations['holds-a-lock-on']).toEqual({ armed: false, inputs: 0, edges: 0 });
    expect(census.relations.awaits.armed).toBe(true);
  });
});
