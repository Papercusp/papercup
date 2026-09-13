import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_VIEW_LOCK_ORDER_ACK,
  VIEW_LOCK_ORDER_ACK,
  VIEW_LOCK_ORDER_ENFORCED_FROM,
  findViewLockOrderInversion,
} from '../../../scripts/lint-migrations.mjs';

const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const sql = (file: string) => readFileSync(resolve(SQL_DIR, file), 'utf8');

/**
 * The real 721 shape, with the two LOCK TABLE lines REMOVED — i.e. the file
 * exactly as it stood when it failed 5 attempts on `lock timeout` and then
 * `deadlock detected`. Kept as a literal rather than reconstructed from git so
 * the test still means something if 721 is ever archived.
 */
const REAL_OFFENCE = [
  'ALTER TABLE harness_shared.work_items',
  "  ADD COLUMN IF NOT EXISTS lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED;",
  'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS',
  '  SELECT w.feature_id, w.lane FROM harness_shared.work_items w;',
].join('\n');

/** The sanctioned fix: both locks up front, in READER order. */
const FIXED = [
  'LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;',
  'LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;',
  REAL_OFFENCE,
].join('\n');

/** The unresolved dynamic spelling that migration 1154 used. */
const DYNAMIC_OFFENCE = [
  'DO $migration$',
  'BEGIN',
  "  EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS %I text', qualified, column_name);",
  "  EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', view_name, definition);",
  'END',
  '$migration$;',
].join('\n');

/**
 * PERMANENT FALSIFIABILITY CONTROL (never delete).
 *
 * The obvious implementation is "file contains an ALTER TABLE and a CREATE OR
 * REPLACE VIEW". That is wrong in the direction that matters — it fires on the
 * FIXED file too, and on every migration that creates its own tables — so it
 * would have red-pinned a green-checkpoint gate check while telling the author
 * their correct fix was broken. Keeping the naive version here as a control
 * means the ordering/lock/creation logic is verified rather than assumed.
 */
function naiveDetector(sqlText: string): boolean {
  return (
    /ALTER\s+TABLE/i.test(sqlText) && /CREATE\s+OR\s+REPLACE\s+VIEW/i.test(sqlText)
  );
}

describe('migration view lock-order inversion guard (EI-19320370563025481)', () => {
  it('flags the real pre-fix 721 shape', () => {
    const hits = findViewLockOrderInversion(REAL_OFFENCE);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ view: 'engineer_issues', table: 'work_items' });
  });

  it('marks work_items as hot, so the message can escalate', () => {
    expect(findViewLockOrderInversion(REAL_OFFENCE)[0]?.hot).toBe(true);
  });

  it('ACCEPTS the sanctioned fix — both locks up front in reader order', () => {
    expect(findViewLockOrderInversion(FIXED)).toEqual([]);
  });

  it('is not satisfied by locking only the BASE TABLE (the half-fix)', () => {
    const halfFixed = ['LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;', REAL_OFFENCE].join('\n');
    expect(findViewLockOrderInversion(halfFixed)).toHaveLength(1);
  });

  it('fails closed on unresolved dynamic ALTER-table then view-replace order', () => {
    expect(findViewLockOrderInversion(DYNAMIC_OFFENCE)).toEqual([
      { view: '<dynamic-view>', table: '<dynamic-table>', hot: true, dynamic: true },
    ]);
  });

  it('requires a stated reader-order account for the unresolved dynamic form', () => {
    expect(DYNAMIC_VIEW_LOCK_ORDER_ACK.test('-- lint-migrations: dynamic-view-lock-order')).toBe(false);
    const reviewed = [
      '-- lint-migrations: dynamic-view-lock-order outer view then inner view then base table',
      DYNAMIC_OFFENCE,
    ].join('\n');
    expect(findViewLockOrderInversion(reviewed)).toEqual([]);
  });

  it('does not misread a dynamic pair quoted only in prose as executable', () => {
    const prose = [
      "-- EXECUTE format('ALTER TABLE %s ADD COLUMN c int', qualified);",
      "-- EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', view_name, definition);",
      'SELECT 1;',
    ].join('\n');
    expect(findViewLockOrderInversion(prose)).toEqual([]);
  });

  it('is not satisfied by locking the view AFTER the ALTER (order is the point)', () => {
    const lateLock = [
      'ALTER TABLE harness_shared.work_items ADD COLUMN c int;',
      'LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;',
      'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS SELECT c FROM harness_shared.work_items;',
    ].join('\n');
    expect(lateLock).toMatch(/LOCK TABLE/);
    expect(findViewLockOrderInversion(lateLock)).toHaveLength(1);
  });

  it('CONTROL: re-declaring the view BEFORE the ALTER is already reader order', () => {
    const viewFirst = [
      'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS SELECT c FROM harness_shared.work_items;',
      'ALTER TABLE harness_shared.work_items ADD COLUMN c int;',
    ].join('\n');
    expect(findViewLockOrderInversion(viewFirst)).toEqual([]);
  });

  it('CONTROL: a table CREATEd in the same migration has no reader to race', () => {
    const newTable = [
      'CREATE TABLE harness_shared.testing_surfaces (id text primary key);',
      'ALTER TABLE harness_shared.testing_surfaces ADD COLUMN kind text;',
      'CREATE OR REPLACE VIEW harness_shared.testing_surface_depth AS SELECT kind FROM harness_shared.testing_surfaces;',
    ].join('\n');
    expect(findViewLockOrderInversion(newTable)).toEqual([]);
  });

  it('CONTROL: a view over an UNRELATED table is not flagged', () => {
    const unrelated = [
      'ALTER TABLE harness_shared.work_items ADD COLUMN c int;',
      'CREATE OR REPLACE VIEW harness_shared.v AS SELECT id FROM harness_shared.something_else;',
    ].join('\n');
    expect(findViewLockOrderInversion(unrelated)).toEqual([]);
  });

  it('is not comment-blind: prose describing the hazard reads clean', () => {
    const prose = [
      '-- NOTE: deliberately NOT doing ALTER TABLE harness_shared.work_items then',
      '-- CREATE OR REPLACE VIEW harness_shared.engineer_issues AS SELECT x FROM harness_shared.work_items;',
      'ALTER TABLE harness_shared.unrelated ADD COLUMN c int;',
    ].join('\n');
    expect(findViewLockOrderInversion(prose)).toEqual([]);
    // The control: a naive detector calls this a violation.
    expect(naiveDetector(prose)).toBe(true);
  });

  it('the opt-out pragma requires a stated reason (a bare token does not count)', () => {
    expect(VIEW_LOCK_ORDER_ACK.test('-- lint-migrations: allow-view-lock-order')).toBe(false);
    expect(
      VIEW_LOCK_ORDER_ACK.test('-- lint-migrations: allow-view-lock-order both relations are new here'),
    ).toBe(true);
  });

  it('the pragma opts a genuinely-safe inversion out', () => {
    const opted = ['-- lint-migrations: allow-view-lock-order single-user bootstrap', REAL_OFFENCE].join('\n');
    expect(findViewLockOrderInversion(opted)).toEqual([]);
  });

  it('CONTROL: the naive detector cannot tell the fix from the bug (why the logic exists)', () => {
    expect(naiveDetector(REAL_OFFENCE)).toBe(true);
    expect(naiveDetector(FIXED)).toBe(true); // …identical verdict, opposite files
    expect(findViewLockOrderInversion(REAL_OFFENCE)).toHaveLength(1);
    expect(findViewLockOrderInversion(FIXED)).toEqual([]);
  });

  it('accepts the REAL migration 721 as it shipped (its LOCK lines are the fix)', () => {
    expect(findViewLockOrderInversion(sql('721-work-items-lane-generated-column.sql'))).toEqual([]);
  });

  it('accepts the REAL migration 1154 only with its explicit dynamic reader-order account', () => {
    const migration = sql('1154-prose-embedding-profile-identity.sql');
    expect(migration).toMatch(DYNAMIC_VIEW_LOCK_ORDER_ACK);
    expect(findViewLockOrderInversion(migration)).toEqual([]);
  });

  /**
   * The gate-safety invariant. lint:migrations is a green-checkpoint GATE check,
   * so a boundary set below any applied offender red-pins the gate permanently
   * (the WI-41119 class this file's sibling documents). Measured, not assumed.
   */
  it('no file at or above the enforcement boundary is an offender', () => {
    const offenders = readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10) >= VIEW_LOCK_ORDER_ENFORCED_FROM)
      .filter((f) => findViewLockOrderInversion(sql(f)).length > 0);
    expect(offenders).toEqual([]);
  });

  it('the boundary sits directly above the highest grandfathered offender', () => {
    const below = readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => findViewLockOrderInversion(sql(f)).length > 0)
      .map((f) => Number.parseInt(/^(\d+)-/.exec(f)?.[1] ?? '0', 10));
    // Every real offender is grandfathered history…
    expect(Math.max(...below)).toBeLessThan(VIEW_LOCK_ORDER_ENFORCED_FROM);
    // …and the boundary is not parked needlessly far above it, which would
    // silently exempt future migrations.
    expect(VIEW_LOCK_ORDER_ENFORCED_FROM).toBeLessThanOrEqual(Math.max(...below) + 1);
  });
});
