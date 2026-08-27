/**
 * EI-21637077415806005 recurrence guard against real Postgres.
 *
 * A restored/federated database can contain WI-N rows far above its local
 * work_item_seq. The allocator must repair existing drift on migration and stay
 * ahead of every later imported row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
function readMigration(): string {
  const armed = resolve(
    __dirname,
    '../../../libs/papercusp/libs/db/sql/1003-work-item-sequence-federation-floor.sql',
  );
  const draft = `${armed}.DRAFT`;
  const path = existsSync(armed) ? armed : draft;
  if (!existsSync(path)) throw new Error(`migration 1003 not found at ${armed} or ${draft}`);
  const text = readFileSync(path, 'utf8');
  if (!text.includes('work_items_advance_id_sequence')) {
    throw new Error(`migration 1003 at ${path} does not define the sequence-floor trigger`);
  }
  // postgres.js rejects explicit transaction control on this pooled fixture.
  // The multi-statement simple-protocol query is itself atomic, so strip only
  // the migration's outer wrapper (the same pattern as sibling migration tests).
  return text.replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-sequence-federation-floor');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
}, 60_000);

afterAll(async () => {
  await db.cleanup();
});

describe('work-item sequence federation floor', () => {
  it('backfills existing drift and advances before every later imported WI row', async () => {
    await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin)
      VALUES
        ('papercusp-workspace', 'papercusp', 'WI-40000', 'restored row', 'done', 'task', 'local')`;

    await db.sql.unsafe(readMigration()).simple();

    const afterBackfill = await db.sql<Array<{ id: string }>>`
      SELECT harness_shared.next_work_item_id() AS id`;
    expect(afterBackfill[0]?.id).toBe('WI-40001');

    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin)
      VALUES
        ('papercusp-workspace', 'papercusp', 'WI-50000', 'later federated row', 'done', 'task', 'local')`;

    const afterImport = await db.sql<Array<{ id: string }>>`
      SELECT harness_shared.next_work_item_id() AS id`;
    expect(afterImport[0]?.id).toBe('WI-50001');

    const trigger = await db.sql<Array<{ enabled: string }>>`
      SELECT tgenabled AS enabled
        FROM pg_trigger
       WHERE tgrelid = 'harness_shared.work_items'::regclass
         AND tgname = 'work_items_advance_id_sequence'
         AND NOT tgisinternal`;
    expect(trigger).toEqual([{ enabled: 'O' }]);
  });
});
