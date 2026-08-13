/** Real-PG recurrence guard for migration 826 / WI-38468 P-005. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const MIGRATION = join(__dirname, '../../../libs/papercusp/libs/db/sql/826-repair-work-item-physical-twins.sql.DRAFT');
const SQL = readFileSync(MIGRATION, 'utf8');
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('physical-twin-repair');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      title text, summary text, status text, payload jsonb, item_kind text,
      completion_ref text, terminal_completion_ref text, terminal_owner text,
      authority text, closed_ts bigint, updated_ts bigint NOT NULL DEFAULT 0,
      fed_hlc text, PRIMARY KEY (harness_slug, feature_id));
    CREATE TABLE harness_shared.coord_links (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, src_kind text NOT NULL,
      src_ref text NOT NULL, dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.coord_threads (
      workspace_id text NOT NULL, thread_id text NOT NULL, parent_kind text NOT NULL,
      parent_ref text NOT NULL, title text, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
      last_post_at timestamptz, post_count integer NOT NULL DEFAULT 0, harness_slug text,
      origin text NOT NULL DEFAULT 'local', author_pubkey text, fed_ts bigint, fed_hlc text,
      PRIMARY KEY (workspace_id, thread_id));
    CREATE TABLE harness_shared.work_item_claims (
      workspace_id text, harness_slug text, work_item_id text, owner text,
      PRIMARY KEY (workspace_id,harness_slug,work_item_id));
    CREATE TABLE harness_shared.feature_claims (
      workspace_id text, harness_slug text, feature_id text, seq bigint,
      PRIMARY KEY (workspace_id,harness_slug,feature_id,seq));
    CREATE TABLE harness_shared.claim_audit (
      workspace_id text, id bigint, harness_slug text, feature_id text,
      PRIMARY KEY (workspace_id,id));
  `);
});

afterAll(async () => db?.cleanup());
beforeEach(async () => {
  await db.sql.unsafe(`TRUNCATE harness_shared.work_items, harness_shared.coord_links,
    harness_shared.coord_threads, harness_shared.work_item_claims,
    harness_shared.feature_claims, harness_shared.claim_audit CASCADE`);
});

async function insertItem(harness: string, id: string, title: string, status: string, payload: object = {}) {
  await db.sql.unsafe(`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,title,summary,status,payload,item_kind,updated_ts)
    VALUES ('papercusp-workspace',$1,$2,$3,$3,$4,$5::jsonb,'bug',1)`,
  [harness, id, title, status, JSON.stringify(payload)]);
}

describe('migration 826 physical twin repair', () => {
  it('merges identical evidence into the Papercusp survivor before deleting the redundant row', async () => {
    await insertItem('papercusp', 'EI-1', 'same', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same', 'done', { _completionEvidence: { testResult: 'green' }, source: 'operator' });
    await db.sql.unsafe(SQL);

    const rows = await db.sql.unsafe(`SELECT harness_slug,status,payload FROM harness_shared.work_items WHERE feature_id='EI-1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('papercusp');
    expect(rows[0].status).toBe('done');
    expect(rows[0].payload._completionEvidence.testResult).toBe('green');
    expect(rows[0].payload._physicalTwinRepair.sourcePayload.source).toBe('operator');
    const backups = await db.sql.unsafe(`SELECT count(*)::int n FROM harness_shared.bak_20260813_work_item_physical_twins WHERE feature_id='EI-1'`);
    expect(backups[0].n).toBe(2);
  });

  it('rekeys divergent records and moves only provenance-owned links and threads', async () => {
    await insertItem('papercusp', 'EI-11513', 'papercusp work', 'open');
    await insertItem('quartermaster-hive', 'EI-11513', 'quartermaster work', 'done');
    await db.sql.unsafe(`INSERT INTO harness_shared.coord_links VALUES
      (1,'papercusp-workspace','issue','EI-11513','topic','external','tagged','system:improvement-watchdog',now()),
      (2,'papercusp-workspace','issue','EI-11513','topic','local','tagged','another-author',now());
      INSERT INTO harness_shared.coord_threads
      (workspace_id,thread_id,parent_kind,parent_ref,created_by,post_count)
      VALUES ('papercusp-workspace','issue-thread-EI-11513','issue','EI-11513','system:improvement-watchdog',1);`);
    await db.sql.unsafe(SQL);

    const ids = await db.sql.unsafe(`SELECT harness_slug,feature_id FROM harness_shared.work_items ORDER BY harness_slug`);
    expect(ids).toEqual([
      { harness_slug: 'papercusp', feature_id: 'EI-11513' },
      { harness_slug: 'quartermaster-hive', feature_id: 'EI-82600000000000001' },
    ]);
    const links = await db.sql.unsafe(`SELECT id,src_ref FROM harness_shared.coord_links ORDER BY id`);
    expect(links).toEqual([{ id: 1n, src_ref: 'EI-82600000000000001' }, { id: 2n, src_ref: 'EI-11513' }]);
    const thread = await db.sql.unsafe(`SELECT parent_ref FROM harness_shared.coord_threads`);
    expect(thread[0].parent_ref).toBe('EI-82600000000000001');
  });

  it('is a no-op on a fresh ledger without the manifested collisions', async () => {
    await insertItem('papercusp', 'EI-UNRELATED', 'unrelated', 'open');
    await expect(db.sql.unsafe(SQL)).resolves.toBeDefined();
    const rows = await db.sql.unsafe(`SELECT feature_id FROM harness_shared.work_items`);
    expect(rows).toEqual([{ feature_id: 'EI-UNRELATED' }]);
  });
});
