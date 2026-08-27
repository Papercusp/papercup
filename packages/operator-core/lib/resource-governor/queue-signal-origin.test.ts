/**
 * Regression guard for WI-144314.
 *
 * The resource-governor admission queue persists every request as a row in
 * `harness_shared.work_items`, and that table carries a CHECK constraint
 * (`work_items_signal_origin_chk`, migration 403) restricting
 * `payload->'_ei'->>'signal_origin'` to a fixed vocabulary.
 *
 * A single wrong word there wrote 'local' — which belongs to the work_items
 * `origin` COLUMN, a DIFFERENT vocabulary — so EVERY enqueue INSERT raised
 * SQLSTATE 23514. Because that INSERT is how every spawner-sidecar admission is
 * persisted, nothing on the host could be admitted, git-sync could not spawn
 * `git` at all, and the whole fleet's commits froze for hours behind what looked
 * like a stuck lock.
 *
 * These assertions DERIVE the vocabulary from the migration that owns it rather
 * than restating it, so a future migration that legitimately changes the
 * constraint fails here instead of silently diverging from the code.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_GOVERNOR_SIGNAL_ORIGIN,
  WORK_ITEM_SIGNAL_ORIGINS,
} from './queue';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const MIGRATION = path.join(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/403-work-items-signal-origin-restore.sql',
);
const QUEUE_SOURCE = path.join(HERE, 'queue.ts');

/**
 * The exact value the bug shipped. Kept here PERMANENTLY as a control: it proves
 * these assertions can still discriminate, without ever mutating the shared tree
 * (CLAUDE.md mutation-probe tier: keep the deliberately-wrong value in the test).
 */
const HISTORICAL_BUG_VALUE = 'local';

/** Pull the vocabulary out of the migration that actually creates the constraint. */
function vocabularyFromMigration(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const constraintAt = sql.indexOf('work_items_signal_origin_chk');
  expect(
    constraintAt,
    `migration ${path.basename(MIGRATION)} no longer mentions work_items_signal_origin_chk — ` +
      'the constraint moved; re-point this guard at its new owner',
  ).toBeGreaterThan(-1);

  const match = /signal_origin'\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]+)\]/.exec(sql.slice(constraintAt));
  expect(
    match,
    'could not parse the ARRAY[...] vocabulary out of the signal_origin CHECK',
  ).not.toBeNull();

  return [...(match![1].matchAll(/'([^']+)'/g))].map((m) => m[1]);
}

describe('resource-governor admission signal_origin (WI-144314)', () => {
  it('exposes exactly the vocabulary the DB constraint enforces', () => {
    expect([...WORK_ITEM_SIGNAL_ORIGINS].sort()).toEqual(vocabularyFromMigration().sort());
  });

  it('admits governor receipts under a value the constraint accepts', () => {
    expect(WORK_ITEM_SIGNAL_ORIGINS).toContain(RESOURCE_GOVERNOR_SIGNAL_ORIGIN);
  });

  it('CONTROL: the value the bug shipped is still rejected by that same check', () => {
    // If this ever passes, the guard above has stopped discriminating and would
    // no longer catch a reintroduction of the outage.
    expect(vocabularyFromMigration()).not.toContain(HISTORICAL_BUG_VALUE);
    expect(WORK_ITEM_SIGNAL_ORIGINS).not.toContain(HISTORICAL_BUG_VALUE as never);
  });

  it('builds the admission payload from the constant, never a bare literal', () => {
    // The outage was a hardcoded string in the payload builder. Anything other
    // than the shared constant is unreviewable at the call site, because the
    // constraint it must satisfy lives in SQL.
    const source = readFileSync(QUEUE_SOURCE, 'utf8');
    const hardcoded = [...source.matchAll(/signal_origin:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(
      hardcoded,
      `queue.ts hardcodes signal_origin: ${JSON.stringify(hardcoded)} — ` +
        'use RESOURCE_GOVERNOR_SIGNAL_ORIGIN so the vocabulary stays pinned to the migration',
    ).toEqual([]);
    expect(source).toContain('signal_origin: RESOURCE_GOVERNOR_SIGNAL_ORIGIN');
  });
});
