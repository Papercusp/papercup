import { describe, expect, it } from 'vitest';

import { BUILTIN_CELLS } from './cell-registrations';
import { catalogEntry } from './events/await/catalog';
import {
  INTEREST_PROFILES,
  type InterestContext,
  type InterestProfileRow,
  interestProfilesFor,
  referencedCellIds,
  referencedEventFamilies,
  validateInterestProfiles,
} from './interest-profiles';

/* ══════════════════════════════════════════════════════════════════════════════
 * P-010. The plan item asks for "a test asserts every referenced cell/event is
 * registered so profiles cannot drift."
 *
 * The whole value of that assertion depends on it being non-vacuous, so the
 * calibration block below runs FIRST and is not optional decoration: every
 * referential check here is a statement about the CONTENTS of INTEREST_PROFILES,
 * and every one of them passes trivially if that array is empty. P-009 hit exactly
 * this — a drift guard over BUILTIN_CELLS that would have reported green against an
 * empty registry — which is why the pattern is repeated rather than assumed.
 * ══════════════════════════════════════════════════════════════════════════════ */

const ALL_CONTEXTS: InterestContext[] = ['fleet-leader', 'fleet-member', 'plan-holder', 'item-holder'];

describe('interest profiles — calibration (guards against a vacuous pass)', () => {
  it('the registry is non-empty, so the referential assertions below have subjects', () => {
    expect(INTEREST_PROFILES.length).toBeGreaterThan(0);
  });

  it('references BOTH kinds of watch, so neither validation path is untested', () => {
    expect(referencedCellIds().length).toBeGreaterThan(0);
    expect(referencedEventFamilies().length).toBeGreaterThan(0);
  });

  it('every context has at least one row', () => {
    for (const context of ALL_CONTEXTS) {
      expect(interestProfilesFor(context).length, `no rows declared for ${context}`).toBeGreaterThan(0);
    }
  });
});

describe('interest profiles — referential integrity (the drift guard)', () => {
  it('the live registry has zero violations', () => {
    expect(validateInterestProfiles(INTEREST_PROFILES)).toEqual([]);
  });

  it('every referenced cell is REGISTERED, not merely defined', () => {
    const registered = new Set(BUILTIN_CELLS.map((spec) => spec.cell));
    for (const cell of referencedCellIds()) {
      expect(registered.has(cell), `cell '${cell}' is referenced by a profile but is not in BUILTIN_CELLS`).toBe(
        true,
      );
    }
  });

  it('every referenced event family resolves in EVENT_CATALOG', () => {
    for (const family of referencedEventFamilies()) {
      expect(catalogEntry(family), `event family '${family}' is referenced by a profile but is not in EVENT_CATALOG`)
        .toBeDefined();
    }
  });

  it('every event row names a context field for each REQUIRED key param', () => {
    for (const row of INTEREST_PROFILES) {
      if (row.watch.kind !== 'event') continue;
      const entry = catalogEntry(row.watch.family);
      const required = entry?.params.filter((p) => p.required) ?? [];
      expect(
        row.of?.length ?? 0,
        `${row.watch.family} requires ${required.length} param(s) but 'of' names ${row.of?.length ?? 0}`,
      ).toBeGreaterThanOrEqual(required.length);
    }
  });

  it('tier rules hold: auto-arm cells carry a predicate, fold rows do not', () => {
    for (const row of INTEREST_PROFILES) {
      if (row.tier === 'auto-arm' && row.watch.kind === 'cell') expect(row.on).toBeDefined();
      if (row.tier === 'fold') expect(row.on).toBeUndefined();
    }
  });

  it('every row explains itself', () => {
    for (const row of INTEREST_PROFILES) {
      expect(row.why.trim().length, `a row for ${row.context} has no 'why'`).toBeGreaterThan(20);
    }
  });
});

/* ── Falsifiability ────────────────────────────────────────────────────────────
 * Controls live permanently in this file and are LOCAL objects: the real registry
 * is never mutated, and neither is any tracked file. A guard proved only against
 * known-good data is indistinguishable from a guard that always returns green.
 * ─────────────────────────────────────────────────────────────────────────────── */

const CELL_ROW: InterestProfileRow = {
  context: 'item-holder',
  watch: { kind: 'cell', cell: BUILTIN_CELLS[0].cell },
  tier: 'fold',
  why: 'a known-good control row used as the baseline for the mutations below',
};

describe('interest profiles — the guard can FAIL (controls)', () => {
  it('the known-good control row passes, calibrating the mutations below', () => {
    expect(validateInterestProfiles([CELL_ROW])).toEqual([]);
  });

  it('catches a cell that is not registered', () => {
    const violations = validateInterestProfiles([
      { ...CELL_ROW, watch: { kind: 'cell', cell: 'gate.greenCheckpoint.noSuchCellZZQQ' } },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(['unregistered-cell']);
  });

  it('catches an event family that is not in the catalog', () => {
    const violations = validateInterestProfiles([
      { context: 'fleet-leader', watch: { kind: 'event', family: 'fleet-no-such-familyZZQQ' }, tier: 'fold', why: 'control' },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(['unknown-event-family']);
  });

  it('catches an event row that leaves a REQUIRED key param unresolved', () => {
    // fleet-member-dead requires <slug>. Omitting `of` is the silent-forever-wait shape.
    const violations = validateInterestProfiles([
      { context: 'fleet-leader', watch: { kind: 'event', family: 'fleet-member-dead' }, tier: 'auto-arm', why: 'control' },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(['unresolved-required-params']);
  });

  it('catches an auto-arm cell row with no predicate', () => {
    const violations = validateInterestProfiles([{ ...CELL_ROW, tier: 'auto-arm' }]);
    expect(violations.map((v) => v.rule)).toEqual(['auto-arm-cell-without-predicate']);
  });

  it('catches a fold row carrying a predicate that would be silently ignored', () => {
    const violations = validateInterestProfiles([{ ...CELL_ROW, tier: 'fold', on: { op: 'changed' } }]);
    expect(violations.map((v) => v.rule)).toEqual(['fold-with-predicate']);
  });

  it('reports ALL violations of one row together, never else-if chained', () => {
    // Unregistered cell AND auto-arm-without-predicate, in a single row.
    const violations = validateInterestProfiles([
      { ...CELL_ROW, watch: { kind: 'cell', cell: 'no.such.cellZZQQ' }, tier: 'auto-arm' },
    ]);
    expect(violations.map((v) => v.rule).sort()).toEqual(
      ['auto-arm-cell-without-predicate', 'unregistered-cell'].sort(),
    );
  });

  it('each violation names its own remedy, so a reader need not consult this test', () => {
    const violations = validateInterestProfiles([
      { ...CELL_ROW, watch: { kind: 'cell', cell: 'no.such.cellZZQQ' } },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail.length).toBeGreaterThan(40);
  });
});
