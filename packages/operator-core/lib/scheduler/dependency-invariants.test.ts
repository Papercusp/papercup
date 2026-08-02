/**
 * dependency-invariants.test.ts — the registry's own guard rails.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-001).
 *
 * A registry of invariants is only useful if it cannot rot silently. The risks
 * are specific: an id gets renumbered and every citation to it becomes a lie; an
 * entry loses its provenance and the next reader relaxes it; a typo'd `@covers`
 * citation reads as coverage when it proves nothing.
 *
 * Pure data + pure functions, no PG, no IO — this file must stay runnable in the
 * unit tier.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/dependency-invariants.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_INVARIANTS,
  DEPENDENCY_INVARIANT_COUNT,
  coveredInvariants,
  getInvariant,
  invariantsBindingPath,
  invariantsByArea,
  uncoveredInvariantIds,
  unknownCoveredIds,
} from './dependency-invariants';

describe('dependency invariant registry — shape', () => {
  it('has unique, well-formed, densely-numbered ids', () => {
    const ids = DEPENDENCY_INVARIANTS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^INV-\d{2}$/);
    // Dense numbering: a gap means an invariant was DELETED rather than superseded.
    // Deleting one silently invalidates every test that cited it, so make it loud.
    const nums = ids.map((i) => Number(i.slice(4))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, k) => k + 1));
  });

  it('states every invariant as a proposition with a concrete violation and real provenance', () => {
    for (const inv of DEPENDENCY_INVARIANTS) {
      // A one-word "statement" is how a registry decays into a checklist.
      expect(inv.statement.length, `${inv.id} statement`).toBeGreaterThan(40);
      expect(inv.violationLooksLike.length, `${inv.id} violationLooksLike`).toBeGreaterThan(40);
      expect(inv.binds.length, `${inv.id} binds`).toBeGreaterThan(0);
      // Provenance is what stops a future reader relaxing an invariant they find
      // inconvenient: every one here cost a real incident.
      expect(inv.provenance.length, `${inv.id} provenance`).toBeGreaterThan(0);
      for (const b of inv.binds) expect(b, `${inv.id} binds entry`).not.toMatch(/[*?]/); // no globs
    }
  });

  it('covers all six areas — a missing area means a blind spot nobody named', () => {
    const areas = new Set(DEPENDENCY_INVARIANTS.map((i) => i.area));
    expect([...areas].sort()).toEqual([
      'claim-doors',
      'effectiveness',
      'graph-shape',
      'observability',
      'ref-vocabulary',
      'tenancy',
    ]);
  });

  it('keeps the four escape-backed invariants, by id and by substance', () => {
    // INV-01..INV-04 each have a documented production escape behind them. This
    // pins them so a future edit must be a deliberate design change, not a drive-by.
    for (const id of ['INV-01', 'INV-02', 'INV-03', 'INV-04']) {
      expect(getInvariant(id), `${id} must exist`).toBeDefined();
    }
    expect(getInvariant('INV-04')!.area).toBe('effectiveness');
    expect(getInvariant('INV-11')!.statement).toMatch(/workspace/i);
  });

  it('exports a count that tracks the array', () => {
    expect(DEPENDENCY_INVARIANT_COUNT).toBe(DEPENDENCY_INVARIANTS.length);
    expect(DEPENDENCY_INVARIANT_COUNT).toBeGreaterThanOrEqual(15);
  });
});

describe('dependency invariant registry — lookup', () => {
  it('finds by id and returns undefined for an unknown one', () => {
    expect(getInvariant('INV-01')?.area).toBe('ref-vocabulary');
    expect(getInvariant('INV-99')).toBeUndefined();
  });

  it('groups by area', () => {
    const eff = invariantsByArea('effectiveness');
    expect(eff.length).toBeGreaterThanOrEqual(2);
    expect(eff.every((i) => i.area === 'effectiveness')).toBe(true);
  });

  it('binds the SQL oracle even though its binds entry carries a parenthetical', () => {
    // The oracle is named 'libs/.../sql (work_item_is_blocked)'. An exact-match
    // lookup would return nothing here — for the single most important path in
    // the subsystem — which is why the match is substring-based.
    const bound = invariantsBindingPath('work_item_is_blocked');
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.map((i) => i.id)).toContain('INV-11');
  });

  it('binds a plain source path', () => {
    const bound = invariantsBindingPath('packages/operator-core/lib/scheduler/work-item-deps-integrity.ts');
    expect(bound.map((i) => i.id)).toEqual(expect.arrayContaining(['INV-12', 'INV-13']));
  });
});

describe('@covers citation extraction', () => {
  it('reads one, comma-separated, and space-separated citations', () => {
    expect(coveredInvariants('// @covers INV-04')).toEqual(['INV-04']);
    expect(coveredInvariants('describe("x", ... @covers INV-01, INV-02')).toEqual(['INV-01', 'INV-02']);
    expect(coveredInvariants('@covers INV-06 INV-07')).toEqual(['INV-06', 'INV-07']);
  });

  it('dedupes and sorts across a whole file', () => {
    const src = `
      // @covers INV-04
      it('a', () => {});
      // @covers INV-04, INV-01
    `;
    expect(coveredInvariants(src)).toEqual(['INV-01', 'INV-04']);
  });

  it('finds nothing in a file that cites nothing', () => {
    expect(coveredInvariants('it("unrelated", () => {});')).toEqual([]);
  });

  // NEGATIVE CONTROL. Without this, a typo'd citation would be indistinguishable
  // from a real one and would read as coverage — the exact failure mode this whole
  // plan exists to prevent, reproduced in the coverage tool itself.
  it('reports an unknown cited id rather than counting it as coverage', () => {
    expect(unknownCoveredIds('@covers INV-01, INV-77')).toEqual(['INV-77']);
    expect(unknownCoveredIds('@covers INV-01')).toEqual([]);
  });

  it('names uncovered invariants across a set of sources', () => {
    const all = DEPENDENCY_INVARIANTS.map((i) => `@covers ${i.id}`);
    expect(uncoveredInvariantIds(all)).toEqual([]);
    const missingOne = DEPENDENCY_INVARIANTS.slice(1).map((i) => `@covers ${i.id}`);
    expect(uncoveredInvariantIds(missingOne)).toEqual(['INV-01']);
  });

  it('treats an empty source set as covering nothing', () => {
    expect(uncoveredInvariantIds([]).length).toBe(DEPENDENCY_INVARIANT_COUNT);
  });
});
