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
  seedCanonicalGoalPropertySchema,
  type EnsurePlanRefListDeps,
} from './package-property-datatypes';

const SQL = {} as never;

function stubDeps(existing: boolean): { deps: EnsurePlanRefListDeps; upserts: string[] } {
  const upserts: string[] = [];
  const deps = {
    get: async () => (existing ? ({ id: PLAN_REF_LIST_DATATYPE } as never) : null),
    upsert: (async (_sql: unknown, row: { id: string }) => {
      upserts.push(row.id);
    }) as unknown as EnsurePlanRefListDeps['upsert'],
  } as EnsurePlanRefListDeps;
  return { deps, upserts };
}

describe('seedCanonicalGoalPropertySchema', () => {
  it('declares `worklist` on a goal that declared nothing — the ad-hoc path', async () => {
    const { deps } = stubDeps(true);
    const out = await seedCanonicalGoalPropertySchema(SQL, 'ws-1', null, deps);
    expect(out[CANONICAL_WORKLIST_PROPERTY]).toEqual({
      datatype: PLAN_REF_LIST_DATATYPE,
      default: [],
      editable_by: 'both',
    });
  });

  it('matches the declaration packaged goals already carry', async () => {
    const { deps } = stubDeps(true);
    const out = await seedCanonicalGoalPropertySchema(SQL, 'ws-1', undefined, deps);
    expect(out[CANONICAL_WORKLIST_PROPERTY]).toEqual(canonicalWorklistDeclaration());
  });

  it('ensures the plan-ref-list datatype exists when it declares the property', async () => {
    const { deps, upserts } = stubDeps(false);
    await seedCanonicalGoalPropertySchema(SQL, 'ws-1', null, deps);
    // Without the registry row, validatePropertySchemaDeclaration would refuse
    // the very declaration we just wrote.
    expect(upserts).toEqual([PLAN_REF_LIST_DATATYPE]);
  });

  it('never overwrites a caller-supplied worklist declaration', async () => {
    const { deps, upserts } = stubDeps(false);
    const mine = { datatype: 'my-own-type', default: ['plan:a'], editable_by: 'owner' as const };
    const out = await seedCanonicalGoalPropertySchema(SQL, 'ws-1', { worklist: mine }, deps);
    expect(out[CANONICAL_WORKLIST_PROPERTY]).toEqual(mine);
    expect(upserts).toEqual([]);
  });

  it('preserves unrelated declarations and does not mutate the caller object', async () => {
    const { deps } = stubDeps(true);
    const input = { budget_note: { datatype: 'text', editable_by: 'owner' as const } };
    const out = await seedCanonicalGoalPropertySchema(SQL, 'ws-1', input, deps);
    expect(out.budget_note).toEqual(input.budget_note);
    expect(Object.keys(input)).toEqual(['budget_note']);
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

describe('every goal-row writer seeds the canonical worklist declaration', () => {
  it('has at least one writer (positive control — a zero-match scan proves nothing)', () => {
    const libRoot = join(__dirname, '..');
    const writers = tsFilesUnder(libRoot).filter((f) =>
      readFileSync(f, 'utf8').includes('insertGoalRow('),
    );
    expect(writers.length).toBeGreaterThan(0);
  });

  it('routes every writer through seedCanonicalGoalPropertySchema', () => {
    const libRoot = join(__dirname, '..');
    const offenders = tsFilesUnder(libRoot)
      .filter((f) => readFileSync(f, 'utf8').includes('insertGoalRow('))
      .filter((f) => !readFileSync(f, 'utf8').includes('seedCanonicalGoalPropertySchema'))
      .map((f) => f.slice(libRoot.length + 1));
    // A new goal-creation door that skips the seed reintroduces
    // EI-23745110935212173 silently: the row is valid, the gate just reports
    // an empty worklist that nothing can ever fill.
    expect(offenders).toEqual([]);
  });
});
