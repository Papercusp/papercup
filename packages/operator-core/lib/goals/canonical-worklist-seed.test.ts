/**
 * Every goal — ad-hoc, autonomous, or packaged — must land declaring the
 * canonical `worklist` property (EI-23745110935212173).
 *
 * The defect this guards: `insertGoalRow` COALESCEs a missing propertySchema
 * to '{}', so a goal created through the normal GOAL-mode path declared
 * nothing. `goals:set-property` then refused `unknown_property: worklist`,
 * while the placement gate read `properties->'worklist'->'value'` and reported
 * the worklist as EMPTY — a closed loop with no tool-reachable exit, hit only
 * after a plan had been authored, graded and started.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_WORKLIST_PROPERTY,
  PLAN_REF_LIST_DATATYPE,
  canonicalWorklistDeclaration,
  withCanonicalWorklistDeclaration,
} from './package-property-datatypes';

describe('withCanonicalWorklistDeclaration', () => {
  it('declares `worklist` on a goal that declared nothing — the ad-hoc path', () => {
    expect(withCanonicalWorklistDeclaration(null)[CANONICAL_WORKLIST_PROPERTY]).toEqual({
      datatype: PLAN_REF_LIST_DATATYPE,
      default: [],
      editable_by: 'both',
    });
  });

  it('matches the declaration packaged goals already carry', () => {
    // Verified against the live rows for work-on-everything-ca7af8/500998/
    // ad52b8/813959/b83643 — all five identical. An ad-hoc goal and a packaged
    // goal must be indistinguishable to every reader of property_schema.
    expect(withCanonicalWorklistDeclaration(undefined)[CANONICAL_WORKLIST_PROPERTY]).toEqual(
      canonicalWorklistDeclaration(),
    );
  });

  it('declares the datatype that ensurePlanRefListDatatype actually registers', () => {
    // If these two drift, the declaration lands but no value can ever be
    // validated against it — the failure would surface only at set-property.
    expect(canonicalWorklistDeclaration().datatype).toBe(PLAN_REF_LIST_DATATYPE);
  });

  it('never overwrites a caller-supplied worklist declaration', () => {
    const mine = { datatype: 'my-own-type', default: ['plan:a'], editable_by: 'owner' as const };
    expect(withCanonicalWorklistDeclaration({ worklist: mine })[CANONICAL_WORKLIST_PROPERTY]).toEqual(
      mine,
    );
  });

  it('preserves unrelated declarations and does not mutate the caller object', () => {
    const input = { budget_note: { datatype: 'text', editable_by: 'owner' as const } };
    const out = withCanonicalWorklistDeclaration(input);
    expect(out.budget_note).toEqual(input.budget_note);
    expect(Object.keys(input)).toEqual(['budget_note']);
  });

  it('is pure — no database handle is required to declare the property', () => {
    // Deliberate: binding four goal-creation doors to a registry round-trip
    // buys nothing at a moment when no value is being validated.
    expect(withCanonicalWorklistDeclaration.length).toBe(1);
  });
});

/** Every non-test file that writes a goal row must route through the seed. */
function tsFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const goalRowWriters = (libRoot: string): string[] =>
  tsFilesUnder(libRoot).filter((f) => readFileSync(f, 'utf8').includes('insertGoalRow('));

describe('every goal-row writer seeds the canonical worklist declaration', () => {
  it('finds the known writers (positive control — a zero-match scan proves nothing)', () => {
    const libRoot = join(__dirname, '..');
    const writers = goalRowWriters(libRoot).map((f) => f.slice(libRoot.length + 1));
    // This census caught the door the original report missed. If it ever
    // returns fewer than these, the scan broke — not the tree.
    expect(writers.sort()).toEqual(
      [
        'agent-tools/goals/start.ts',
        'cupboard/install-goal-io.ts',
        'goals/goal-auto-start.ts',
        'goals/start-from-package.ts',
      ].sort(),
    );
  });

  it('routes every writer through withCanonicalWorklistDeclaration', () => {
    const libRoot = join(__dirname, '..');
    const offenders = goalRowWriters(libRoot)
      .filter((f) => !readFileSync(f, 'utf8').includes('withCanonicalWorklistDeclaration'))
      .map((f) => f.slice(libRoot.length + 1));
    // A new goal-creation door that skips the seed reintroduces
    // EI-23745110935212173 silently: the row is valid, the gate just reports
    // an empty worklist that nothing can ever fill.
    expect(offenders).toEqual([]);
  });
});
