/**
 * wake-frontier-guard.integration.test.ts — the EI-309 frontier query against
 * REAL Postgres. `listUnplacedHiveFrontier` is what the hive:declare-wake guard
 * reads to decide whether a no-time-component wake would strand work; this drives
 * it end-to-end so the status/assignee/kind/harness filters are exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { listUnplacedHiveFrontier } from './wake-frontier-guard';

const readMigration = (f: string) =>
  readFileSync(join(__dirname, '../../../../libs/papercusp/libs/db/sql', f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

let db: FreshPgDb;

async function seed(
  harness: string,
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${harness}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'todo'},
            ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wake-frontier');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items `;
});

const HIVE = 'sb-devboard';

describe('listUnplacedHiveFrontier (EI-309)', () => {
  it('returns todo + unassigned feature-family ids in the home harness, oldest-first', async () => {
    await seed(HIVE, 'WI-117', { createdTs: 2 });
    await seed(HIVE, 'WI-116', { createdTs: 1 });
    await seed(HIVE, 'WI-115', { kind: 'research-task', createdTs: 0 });
    const frontier = await listUnplacedHiveFrontier(db.sql as unknown as postgres.Sql, 'default', HIVE);
    expect(frontier).toEqual(['WI-115', 'WI-116', 'WI-117']); // oldest-first by created_ts
  });

  it('EXCLUDES assigned items (taken_by set) and non-todo statuses', async () => {
    await seed(HIVE, 'WI-taken', { takenBy: 'swarm-a' });
    await seed(HIVE, 'WI-validating', { status: 'validating' });
    await seed(HIVE, 'WI-passed', { status: 'passed' });
    await seed(HIVE, 'WI-open', {}); // todo + unassigned — the only frontier item
    expect(await listUnplacedHiveFrontier(db.sql as unknown as postgres.Sql, 'default', HIVE)).toEqual(['WI-open']);
  });

  it('is scoped to the home harness (other harnesses are not the frontier)', async () => {
    await seed(HIVE, 'WI-mine', {});
    await seed('other-harness', 'WI-theirs', {});
    expect(await listUnplacedHiveFrontier(db.sql as unknown as postgres.Sql, 'default', HIVE)).toEqual(['WI-mine']);
  });

  it('returns [] when the frontier is empty (everything placed) — the guard then allows', async () => {
    await seed(HIVE, 'WI-done', { status: 'passed' });
    expect(await listUnplacedHiveFrontier(db.sql as unknown as postgres.Sql, 'default', HIVE)).toEqual([]);
  });

  it('respects the limit cap', async () => {
    for (let i = 0; i < 5; i++) await seed(HIVE, `WI-${i}`, { createdTs: i });
    const frontier = await listUnplacedHiveFrontier(db.sql as unknown as postgres.Sql, 'default', HIVE, 3);
    expect(frontier).toEqual(['WI-0', 'WI-1', 'WI-2']);
  });
});
