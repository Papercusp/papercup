/**
 * insert-bind-alignment.test.ts — the positional-coupling guard between
 * db.ts's `insertHarness()` and the fake-d1 test double.
 *
 * WHY THIS EXISTS
 * ---------------
 * `insertHarness()` in src/db.ts writes the `harnesses` row with a POSITIONAL
 * prepared statement: an explicit column list, a `VALUES (?, ?, …)` row, and a
 * `.bind(…)` argument list that must line up with both. The fake D1 used by the
 * route tests (`__tests__/fake-d1.ts`) re-implements that write by DESTRUCTURING
 * the same bind array positionally.
 *
 * Those two lists are separate source files with no compiler-visible link, so
 * adding a column mid-list in one and not the other shifts every later field by
 * one. fake-d1.ts's own header has warned about this since migration 004 — and
 * on 2026-08-21 it happened anyway: migration 015 added `requires_rubrics` after
 * `requires_events` in db.ts, the fake was not updated, and every field from
 * position 20 on shifted. `hive_pubkey` took requires_rubrics' null,
 * `blueprint_kind` took hive_title, and `review_status` took blueprint_kind and
 * fell back to its 'approved' default — silently disabling the publish REVIEW
 * GATE in every test that exercised it. Nine assertions in listings.test.ts and
 * three in review.test.ts went red, and because the shifted fields belong to
 * migrations 007/008/009 the failures pointed at blueprint/hive/review work that
 * was entirely innocent.
 *
 * A prose warning is not a guard. This test makes the coupling MECHANICAL: it
 * asserts the two lists still have the same arity, so the next mid-list column
 * fails HERE — naming the real cause — instead of surfacing as a scatter of
 * confusing assertion failures in unrelated feature tests.
 *
 * WHY ARITY AND NOT NAMES. The fake deliberately uses short local names
 * (`gh_repo_id` for `github_repository_id`), so a name-equality check would be
 * noise. Arity is what actually breaks: a mid-list insertion always changes it.
 * A same-arity rename/reorder is not caught here — see the follow-up below.
 *
 * FOLLOW-UP (tracked): the durable fix is to remove the coupling entirely by
 * having fake-d1 parse the column list out of the SQL it is handed and map binds
 * BY NAME, at which point this guard becomes unnecessary. That is a rewrite of a
 * file other agents were mid-checkpoint in, so it is filed rather than done here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_TS = join(__dirname, '../db.ts');
// Subject path is overridable so falsifiability can be PROVEN against a copy
// (repo mutation-probe tier 2) instead of by mutating this shared checkout:
//   PROBE_FAKE_D1=/tmp/fake-d1-BROKEN.ts npm run test:file -- <this file>
const FAKE_D1_TS = process.env.PROBE_FAKE_D1 || join(__dirname, './fake-d1.ts');

/** The `VALUES (…)` row of insertHarness()'s INSERT: count `?` placeholders. */
export function countInsertPlaceholders(dbSource: string): number {
  const insertAt = dbSource.indexOf('INSERT INTO harnesses');
  if (insertAt === -1) throw new Error('could not locate `INSERT INTO harnesses` in db.ts');
  const valuesAt = dbSource.indexOf('VALUES', insertAt);
  if (valuesAt === -1) throw new Error('could not locate the VALUES row of the harnesses INSERT');
  const open = dbSource.indexOf('(', valuesAt);
  const close = dbSource.indexOf(')', open);
  if (open === -1 || close === -1) throw new Error('could not bound the VALUES (…) row');
  const row = dbSource.slice(open + 1, close);
  return (row.match(/\?/g) ?? []).length;
}

/** The `const [ … ] = binds;` destructure in fake-d1's INSERT branch. */
export function countFakeD1BindNames(fakeSource: string): number {
  const branchAt = fakeSource.indexOf("startsWith('INSERT INTO HARNESSES')");
  if (branchAt === -1) throw new Error('could not locate the INSERT branch in fake-d1.ts');
  const open = fakeSource.indexOf('const [', branchAt);
  const close = fakeSource.indexOf('] = binds', open);
  if (open === -1 || close === -1) throw new Error('could not bound the `const [ … ] = binds` destructure');
  return fakeSource
    .slice(open + 'const ['.length, close)
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .filter((s) => s.length > 0).length;
}

describe('insertHarness ↔ fake-d1 positional bind alignment', () => {
  const dbSource = readFileSync(DB_TS, 'utf8');
  const fakeSource = readFileSync(FAKE_D1_TS, 'utf8');

  // Guards a vacuous pass: if either extractor silently returned 0 because the
  // source moved, the equality below would "pass" while measuring nothing.
  it('found both bind lists (guards a broken extractor)', () => {
    expect(countInsertPlaceholders(dbSource)).toBeGreaterThan(20);
    expect(countFakeD1BindNames(fakeSource)).toBeGreaterThan(20);
  });

  it('fake-d1 destructures exactly as many binds as insertHarness supplies', () => {
    const placeholders = countInsertPlaceholders(dbSource);
    const destructured = countFakeD1BindNames(fakeSource);
    expect(
      destructured,
      `insertHarness() binds ${placeholders} value(s) but fake-d1.ts destructures ${destructured}. ` +
        'A column was added mid-list in one file and not the other, so every field after the ' +
        'insertion point is shifted by one and lands in the WRONG column (this is how the ' +
        'migration-015 requires_rubrics shift silently disabled the review gate). Update the ' +
        '`const [ … ] = binds` destructure in fake-d1.ts to match db.ts, in the SAME ORDER.',
    ).toBe(placeholders);
  });
});
