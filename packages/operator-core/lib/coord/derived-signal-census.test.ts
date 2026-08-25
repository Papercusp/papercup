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
import { couplingSourcesFor } from '../agent-tools/coordination/coupling-sources';
import { deriveCouplings } from './coupling-derivation';
import { DERIVED_COUPLING_RELATIONS, type DerivedCoupling } from './couplings';
import {
  DERIVED_SIGNAL_CENSUS_KEY,
  DERIVED_SIGNAL_CENSUS_VERSION,
  DERIVED_SIGNAL_LEGS,
  censusDerivedSignals,
  type DerivedSignalLeg,
  type DerivedSignalLegState,
  RELATION_CONCENTRATION_THRESHOLD,
  relationConcentrationViolations,
  type DerivedSignalCensus,
} from './derived-signal-census';

const LEGS_ALL_ARMED: Record<DerivedSignalLeg, DerivedSignalLegState> = {
  roster: { armed: true, inputs: 3 },
  heldFiles: { armed: true, inputs: 2 },
  planEdges: { armed: true, inputs: 1 },
  recentPartners: { armed: true, inputs: 4 },
  obligations: { armed: true, inputs: 5 },
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
   * The wired-but-starved shape: a relation consulted on every run whose input
   * simply has nothing in it. Reporting this identically to the unarmed case would
   * send someone to fix a gate that is fine.
   *
   * ⚠ This used to be anchored on `shared-file`, whose starvation was PERMANENT —
   * and that is the distinction the census could not draw, so the relation was
   * retired instead (D-093). Keeping it would have meant a leg reporting
   * `armed:true, inputs:0` forever, which is indistinguishable from a signal that
   * broke this morning. `awaits` is the right anchor: same roster leg, but a
   * relation that genuinely does fire, so a starved reading is real information.
   */
  it('separates a wired-but-starved leg from an unwired one', () => {
    const starved = censusDerivedSignals(
      { ...LEGS_ALL_ARMED, roster: { armed: true, inputs: 0 } },
      [],
    );
    expect(starved.relations.awaits).toEqual({ armed: true, inputs: 0, edges: 0 });
    expect(starved.relations.awaits.armed).not.toBe(
      censusDerivedSignals({ ...LEGS_ALL_ARMED, roster: { armed: false, inputs: 0 } }, []).relations
        .awaits.armed,
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

/**
 * The EMISSION contract, at the derivation's own union point. The census is
 * worthless if `deriveCouplings` never hands it to anybody, and that is not a
 * hypothetical failure mode — it is the exact shape of D-001 in this same plan
 * (five prompt sections that were authored, correct, and silently never spliced).
 */
describe('deriveCouplings publishes a census to whoever wires the sink', () => {
  const rows = [{ ownerId: 'su-self' }, { ownerId: 'su-peer' }];

  it('calls observe exactly once per run, with every relation present', async () => {
    const seen: unknown[] = [];
    await deriveCouplings('su-self', rows, { observe: (c) => seen.push(c) });
    expect(seen).toHaveLength(1);
    const census = seen[0] as { v: number; relations: Record<string, unknown> };
    expect(census.v).toBe(DERIVED_SIGNAL_CENSUS_VERSION);
    expect(Object.keys(census.relations).sort()).toEqual([...DERIVED_COUPLING_RELATIONS].sort());
  });

  /**
   * The live wiring this guards: `couplingSourcesFor` supplies `heldFiles` ONLY
   * when a coordination domain resolved, and supplies the other two legs
   * unconditionally. So `armed` on `holds-a-lock-on` IS the bit that was false on
   * every production call for 12 days — a production recurrence guard for D-088,
   * where the unit test on the predicate can only guard the predicate.
   */
  it('reports the lock leg unarmed when no source is supplied, armed when it is', async () => {
    let bare: any;
    await deriveCouplings('su-self', rows, { observe: (c) => (bare = c) });
    expect(bare.relations['holds-a-lock-on'].armed).toBe(false);

    let wired: any;
    await deriveCouplings('su-self', rows, {
      heldFiles: async () => new Map<string, readonly string[]>(),
      recentPartners: async () => [],
      observe: (c) => (wired = c),
    });
    expect(wired.relations['holds-a-lock-on'].armed).toBe(true);
    expect(wired.relations['coord-exchange'].armed).toBe(true);
    // ...and still unarmed for a leg genuinely not wired, so `armed` tracks the
    // wiring rather than drifting to a constant true once anything is supplied.
    expect(wired.relations['blocks-me'].armed).toBe(false);
  });

  it('counts only edges that survived the roster access boundary', async () => {
    let census: any;
    await deriveCouplings('su-self', rows, {
      // `su-ghost` is NOT in the roster, so its edge reaches no caller and must not
      // be censused as a firing — otherwise a signal reads as alive on the strength
      // of output that was filtered away.
      recentPartners: async () => ['su-peer', 'su-ghost'],
      observe: (c) => (census = c),
    });
    expect(census.relations['coord-exchange'].edges).toBe(1);
    expect(census.relations['coord-exchange'].inputs).toBe(2);
  });

  it('an observer that throws cannot degrade the derivation it observes', async () => {
    const withSink = await deriveCouplings('su-self', rows, {
      recentPartners: async () => ['su-peer'],
      observe: () => {
        throw new Error('sink is broken');
      },
    });
    const without = await deriveCouplings('su-self', rows, { recentPartners: async () => ['su-peer'] });
    expect(withSink).toEqual(without);
    expect(withSink).toHaveLength(1);
  });

  it('emits nothing and stays silent when no sink is wired', async () => {
    await expect(deriveCouplings('su-self', rows, {})).resolves.toEqual([]);
  });
});

/**
 * THE WIRING presence.ts ACTUALLY BUILDS, against the REAL `couplingSourcesFor`.
 *
 * P-007 restructured that call site: `couplingSourcesFor(...)` went from being the
 * whole third argument to being SPREAD into an object literal alongside `observe`.
 * The regression that would create is worse than the feature it adds — a dropped
 * leg silently disarms a signal, which is the exact class D-088 is about. These
 * cases pin the composition rather than a fixture of it.
 *
 * The source closures do real IO, which is fine and deliberate here: `deriveCouplings`
 * settles each leg fail-soft, so with no DB they resolve empty. `armed` records that
 * the leg was SUPPLIED, not that it succeeded — so this still measures the wiring.
 */
describe('the presence.ts composition: spread sources + observe', () => {
  const rows = [{ ownerId: 'su-self' }, { ownerId: 'su-peer' }];

  it('keeps every querying leg armed when a coordination domain resolved', async () => {
    let census: any;
    await deriveCouplings('su-self', rows, {
      ...couplingSourcesFor({
        selfOwnerId: 'su-self',
        rosterOwnerIds: ['su-self', 'su-peer'],
        coordinationDomain: 'papercusp',
      }),
      observe: (c) => (census = c),
    });
    expect(census.relations['holds-a-lock-on'].armed).toBe(true);
    expect(census.relations['coord-exchange'].armed).toBe(true);
    expect(census.relations['blocks-me'].armed).toBe(true);
  });

  /**
   * `coordinationDomain` is an optional partition key for the lock-interest read,
   * not a gate on whether the source is wired. `couplingSourcesFor` always supplies
   * `heldFiles`, so a reader with no resolved domain still reports an armed lock leg
   * (and the fail-soft source may simply return no interests).
   */
  it('keeps the lock leg armed when no coordination domain resolved', async () => {
    let census: any;
    await deriveCouplings('su-self', rows, {
      ...couplingSourcesFor({ selfOwnerId: 'su-self', rosterOwnerIds: ['su-self', 'su-peer'] }),
      observe: (c) => (census = c),
    });
    expect(census.relations['holds-a-lock-on'].armed).toBe(true);
    expect(census.relations['coord-exchange'].armed).toBe(true);
    expect(census.relations['blocks-me'].armed).toBe(true);
  });
});

/**
 * ── P-010: THE CONCENTRATION RECURRENCE GUARD ────────────────────────────────────────
 *
 * The item demands falsifiability rather than assertion: the guard "must FAIL against the
 * current pre-fix distribution and pass after — proving it can fire". So the fixture below
 * is not invented. It is the REAL distribution, read from the live firings ledger
 * (`tool_invocations.metadata_json.derivedSignals`, workspace papercusp-workspace, 7 days,
 * 17,422 censused invocations):
 *
 *   coord-exchange 28,356 (92.1%) · awaits 2,316 (7.5%) · holds-a-lock-on 93 (0.3%)
 *   blocks-me 13 (0.0%) · blocked-by-me 2 (0.0%)
 *
 * A guard that cannot fire on THAT is measuring nothing, whatever else it passes.
 *
 * ⚠ The two tail relations are not incidental colour. `blocks-me` + `blocked-by-me`
 * produced FIFTEEN edges in a week because they read a table agents rarely write — the
 * defect WI-41575 was filed to fix. That is the condition this guard exists to make
 * un-silenceable.
 */
const census = (edgesByRelation: Record<string, number>): DerivedSignalCensus => ({
  v: DERIVED_SIGNAL_CENSUS_VERSION,
  relations: Object.fromEntries(
    Object.entries(edgesByRelation).map(([rel, edges]) => [
      rel,
      { armed: true, inputs: edges, edges },
    ]),
  ),
});

/** The measured pre-fix distribution, verbatim. */
const MEASURED_PRE_FIX = census({
  'coord-exchange': 28356,
  awaits: 2316,
  'holds-a-lock-on': 93,
  'blocks-me': 13,
  'blocked-by-me': 2,
});

describe('P-010 — the concentration guard FIRES on the real distribution', () => {
  it('FAILS against the measured 92.1% pre-fix distribution (the falsifiability case)', () => {
    const violations = relationConcentrationViolations(MEASURED_PRE_FIX);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.relation).toBe('coord-exchange');
    expect(violations[0]?.share).toBeGreaterThan(0.9);
    expect(violations[0]?.edges).toBe(28356);
  });

  it('passes once that concentration is EXPLICITLY RULED', () => {
    const violations = relationConcentrationViolations(MEASURED_PRE_FIX, [
      { relation: 'coord-exchange', reason: 'messaging is the dominant coupling by design' },
    ]);
    expect(violations).toEqual([]);
  });

  it('REJECTS a ruling with no stated reason — a blank reason is not a ruling', () => {
    // Otherwise the escape hatch degrades into a mute button, which is how a guard like
    // this normally dies.
    const violations = relationConcentrationViolations(MEASURED_PRE_FIX, [
      { relation: 'coord-exchange', reason: '   ' },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('passes on a healthy mixed distribution', () => {
    expect(
      relationConcentrationViolations(
        census({ 'coord-exchange': 40, awaits: 30, 'holds-a-lock-on': 20, 'owes-me': 10 }),
      ),
    ).toEqual([]);
  });

  it('does NOT report a run that emitted nothing — 0/0 is not 100%', () => {
    // Every idle census would otherwise be a violation, which is the fastest way to get a
    // guard switched off.
    expect(relationConcentrationViolations(census({ awaits: 0, 'coord-exchange': 0 }))).toEqual([]);
  });

  it('fires for a supervision blowout too — the guard is relation-agnostic', () => {
    // A fleet leader supervising 234 members emits 234 `i-owe` edges from ONE read. That
    // is TRUE, not broken — which is exactly why it must surface a ruling rather than be
    // special-cased into the threshold. The guard should notice; a human decides.
    const violations = relationConcentrationViolations(
      census({ 'i-owe': 234, 'coord-exchange': 3, awaits: 1 }),
    );
    expect(violations[0]?.relation).toBe('i-owe');
  });

  it('is WIRED — censusDerivedSignals surfaces the violation, not just the helper', () => {
    // The guard has to run on the real path, or it is the same born-unobservable defect
    // this module was built to detect. A concentrated run must carry `concentration`
    // into the record that reaches tool_invocations.metadata_json.
    const lopsided: DerivedCoupling[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        ownerId: `su-p${i}`,
        relation: 'coord-exchange' as const,
        because: 'recent coord exchange',
      })),
      { ownerId: 'su-x', relation: 'awaits', because: 'both awaiting gate:1' },
    ];
    const out = censusDerivedSignals(LEGS_ALL_ARMED, lopsided);
    expect(out.concentration?.[0]?.relation).toBe('coord-exchange');
  });

  it('OMITS `concentration` on a healthy run — absence means checked-and-clean', () => {
    const balanced: DerivedCoupling[] = [
      { ownerId: 'su-a', relation: 'coord-exchange', because: 'recent coord exchange' },
      { ownerId: 'su-b', relation: 'awaits', because: 'both awaiting gate:1' },
      { ownerId: 'su-c', relation: 'holds-a-lock-on', because: 'shared lock' },
    ];
    expect(censusDerivedSignals(LEGS_ALL_ARMED, balanced).concentration).toBeUndefined();
  });

  it('CONTROL: a bare-majority rule would MISS the tail-starvation shape it must catch', () => {
    // Permanent wrong-implementation control. A guard keyed on ">50% is bad" fires on
    // plenty of healthy mixes and so gets tuned away; the point of the threshold sitting
    // at 0.75 is that the measured 92.1% clears it while an ordinary 60/40 split does not.
    const ordinarySplit = census({ 'coord-exchange': 60, awaits: 40 });
    expect(relationConcentrationViolations(ordinarySplit)).toEqual([]);
    expect(0.6).toBeLessThan(RELATION_CONCENTRATION_THRESHOLD);
    // …while the real one still fires.
    expect(relationConcentrationViolations(MEASURED_PRE_FIX)).toHaveLength(1);
  });
});
