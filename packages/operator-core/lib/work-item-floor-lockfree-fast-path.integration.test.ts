/**
 * Migration 1218 against real Postgres (p2p-join-catchup-speed-2026-09-23 P-527).
 *
 * Migration 1003's floor trigger took the federation-floor advisory lock for every
 * imported WI-N row, held to COMMIT, so parallel snapshot lanes could not insert WI-N
 * rows at the same time. 1218 takes it only for a row that raises the floor. The
 * first case runs under 1003 alone as the permanent control: the probe must see the
 * lock held there, or it proves nothing about 1218.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
function readMigration(file: string, marker: string): string {
  const armed = resolve(__dirname, '../../../libs/papercusp/libs/db/sql', file);
  const draft = `${armed}.DRAFT`;
  const path = existsSync(armed) ? armed : draft;
  if (!existsSync(path)) throw new Error(`migration not found at ${armed} or ${draft}`);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(marker)) throw new Error(`migration at ${path} does not contain ${marker}`);
  return text;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-floor-lockfree-fast-path');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql
    .unsafe(readMigration('1003-work-item-sequence-federation-floor.sql', 'work_items_advance_id_sequence'))
    .simple();
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

async function insertWi(sql: postgres.Sql | postgres.TransactionSql, id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin)
    VALUES
      ('papercusp-workspace', 'papercusp', ${id}, 'imported row', 'done', 'task', 'local')`;
}

/** Insert `id` in an open transaction and report whether ANOTHER session could take the floor lock meanwhile. */
async function floorLockFreeDuringInsert(id: string): Promise<boolean> {
  let free = false;
  await db.sql.begin(async (tx) => {
    await insertWi(tx, id);
    const [row] = await db.sql.begin(
      (other) => other<Array<{ got: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
        ) AS got`,
    );
    free = row!.got;
  });
  return free;
}

async function nextId(): Promise<string> {
  const [row] = await db.sql<Array<{ id: string }>>`SELECT harness_shared.next_work_item_id() AS id`;
  return row!.id;
}

describe('work-item floor trigger: lock-free below the floor (migration 1218)', () => {
  it('CONTROL: under migration 1003 alone, a below-floor insert holds the floor lock', async () => {
    await db.sql`SELECT setval('harness_shared.work_item_seq'::regclass, 100, true)`;
    expect(await floorLockFreeDuringInsert('WI-50')).toBe(false);
  });

  it('a below-floor insert takes no lock; a floor-raising insert still does', async () => {
    await db.sql.unsafe(readMigration('1218-work-item-floor-lockfree-fast-path.sql', 'current_called')).simple();
    await db.sql`SELECT setval('harness_shared.work_item_seq'::regclass, 100, true)`;

    expect(await floorLockFreeDuringInsert('WI-60')).toBe(true);
    expect(await floorLockFreeDuringInsert('WI-100')).toBe(true);
    expect(await nextId()).toBe('WI-101');

    expect(await floorLockFreeDuringInsert('WI-200')).toBe(false);
    expect(await nextId()).toBe('WI-201');
  });

  it('advances a never-called sequence past an imported id equal to its start', async () => {
    await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 7`;
    await insertWi(db.sql, 'WI-7');
    expect(await nextId()).toBe('WI-8');
  });
});
