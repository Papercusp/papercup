/** Real-PG recurrence guard for migration 826 / WI-38468 P-005. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const MIGRATION = join(__dirname, '../../../libs/papercusp/libs/db/sql/826-repair-work-item-physical-twins.sql');
const SQL = readFileSync(MIGRATION, 'utf8');
const REPLAY_MIGRATION = join(
  __dirname,
  '../../../libs/papercusp/libs/db/sql/859-repair-work-item-legacy-replay-twins.sql',
);
const REPLAY_SQL = readFileSync(REPLAY_MIGRATION, 'utf8');
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
  await db.sql.unsafe(`
    DROP TABLE IF EXISTS harness_shared.bak_20260813_work_item_physical_twins,
      harness_shared.bak_20260813_physical_twin_links,
      harness_shared.bak_20260813_physical_twin_threads,
      harness_shared.bak_20260820_work_item_legacy_replay_twins,
      harness_shared.bak_20260820_legacy_replay_twin_manifest;
    TRUNCATE harness_shared.work_items, harness_shared.coord_links,
    harness_shared.coord_threads, harness_shared.work_item_claims,
    harness_shared.feature_claims, harness_shared.claim_audit CASCADE`);
});

async function insertItem(harness: string, id: string, title: string, status: string, payload: object = {}) {
  await db.sql.unsafe(
    `INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,title,summary,status,payload,item_kind,updated_ts)
    VALUES ('papercusp-workspace',$1,$2,$3,$3,$4,$5::text::jsonb,'bug',1)`,
    [harness, id, title, status, JSON.stringify(payload)],
  );
}

describe('migration 826 physical twin repair', () => {
  it('merges identical evidence into the Papercusp survivor before deleting the redundant row', async () => {
    await insertItem('papercusp', 'EI-1', 'same', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same', 'done', {
      _completionEvidence: { testResult: 'green' },
      source: 'operator',
    });
    await db.sql.unsafe(SQL);

    const rows = await db.sql.unsafe(
      `SELECT harness_slug,status,payload FROM harness_shared.work_items WHERE feature_id='EI-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('papercusp');
    expect(rows[0].status).toBe('done');
    expect(rows[0].payload._completionEvidence.testResult).toBe('green');
    expect(rows[0].payload._physicalTwinRepair.sourcePayload.source).toBe('operator');
    const backups = await db.sql.unsafe(
      `SELECT count(*)::int n FROM harness_shared.bak_20260813_work_item_physical_twins WHERE feature_id='EI-1'`,
    );
    expect(backups[0].n).toBe(2);
  });

  it('rekeys divergent records and moves only provenance-owned links and threads', async () => {
    await insertItem('papercusp', 'EI-11513', 'papercusp work', 'open');
    await insertItem('quartermaster-hive', 'EI-11513', 'quartermaster work', 'done');
    await insertItem('papercusp', 'EI-8869', 'older papercusp replication finding', 'dropped');
    await insertItem('operator:papercusp-workspace', 'EI-8869', 'later operator replication finding', 'dropped');
    await db.sql.unsafe(`INSERT INTO harness_shared.coord_links VALUES
      (1,'papercusp-workspace','issue','EI-11513','topic','external','tagged','system:improvement-watchdog',now()),
      (2,'papercusp-workspace','issue','EI-11513','topic','local','tagged','another-author',now()),
      (3,'papercusp-workspace','issue','EI-8869','topic','replication-liveness','tagged','system:replication-liveness',now());
      INSERT INTO harness_shared.coord_threads
      (workspace_id,thread_id,parent_kind,parent_ref,created_by,post_count)
      VALUES ('papercusp-workspace','issue-thread-EI-11513','issue','EI-11513','system:improvement-watchdog',1);`);
    await db.sql.unsafe(SQL);

    const ids = await db.sql.unsafe(
      `SELECT harness_slug,feature_id FROM harness_shared.work_items ORDER BY harness_slug`,
    );
    expect(ids).toEqual([
      { harness_slug: 'operator:papercusp-workspace', feature_id: 'EI-82600000000000011' },
      { harness_slug: 'papercusp', feature_id: 'EI-11513' },
      { harness_slug: 'papercusp', feature_id: 'EI-8869' },
      { harness_slug: 'quartermaster-hive', feature_id: 'EI-82600000000000001' },
    ]);
    const links = await db.sql.unsafe(`SELECT id,src_ref FROM harness_shared.coord_links ORDER BY id`);
    expect(links).toEqual([
      { id: 1, src_ref: 'EI-82600000000000001' },
      { id: 2, src_ref: 'EI-11513' },
      { id: 3, src_ref: 'EI-8869' },
    ]);
    const thread = await db.sql.unsafe(`SELECT parent_ref FROM harness_shared.coord_threads`);
    expect(thread[0].parent_ref).toBe('EI-82600000000000001');

    await expect(db.sql.unsafe(SQL)).resolves.toBeDefined();
    const rerunIds = await db.sql.unsafe(
      `SELECT harness_slug,feature_id FROM harness_shared.work_items ORDER BY harness_slug`,
    );
    expect(rerunIds).toEqual(ids);
    const backups = await db.sql.unsafe(
      `SELECT count(*)::int n FROM harness_shared.bak_20260813_work_item_physical_twins`,
    );
    expect(backups[0].n).toBe(4);
  });

  it('fails closed without mutating when the frozen identical classification drifts', async () => {
    await insertItem('papercusp', 'EI-1', 'manifest title', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'drifted title', 'done');

    await expect(db.sql.unsafe(SQL)).rejects.toThrow('P-004 identical-twin classification drifted for EI-1');
    const rows = await db.sql.unsafe(
      `SELECT harness_slug,title,status FROM harness_shared.work_items ORDER BY harness_slug`,
    );
    expect(rows).toEqual([
      { harness_slug: 'operator:papercusp-workspace', title: 'drifted title', status: 'done' },
      { harness_slug: 'papercusp', title: 'manifest title', status: 'open' },
    ]);
    const backupTable = await db.sql.unsafe(
      `SELECT to_regclass('harness_shared.bak_20260813_work_item_physical_twins')::text AS name`,
    );
    expect(backupTable[0].name).toBeNull();
  });

  it('is a no-op on a fresh ledger without the manifested collisions', async () => {
    await insertItem('papercusp', 'EI-UNRELATED', 'unrelated', 'open');
    await expect(db.sql.unsafe(SQL)).resolves.toBeDefined();
    const rows = await db.sql.unsafe(`SELECT feature_id FROM harness_shared.work_items`);
    expect(rows).toEqual([{ feature_id: 'EI-UNRELATED' }]);
  });
});

describe('migration 859 legacy replay twin repair', () => {
  it('snapshots an exact manifest, merges current evidence, repairs merged/rekeyed recurrences, and is idempotent', async () => {
    await insertItem('papercusp', 'EI-1', 'same one', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same one', 'open');
    await insertItem('papercusp', 'EI-13237', 'same marker-erased row', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-13237', 'same marker-erased row', 'open');
    await insertItem('papercusp', 'EI-8869', 'papercusp entity', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-8869', 'operator entity', 'open');
    await db.sql.unsafe(SQL);

    // Recreate the production recurrence: bare legacy PUTs restore the retired
    // source rows, while a survivor replay can erase its migration-826 marker.
    await db.sql.unsafe(`UPDATE harness_shared.work_items
      SET payload = '{}'::jsonb
      WHERE harness_slug='papercusp' AND feature_id='EI-13237'`);
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same one', 'done', {
      _completionEvidence: { testResult: 'replay-green' },
    });
    await insertItem('operator:papercusp-workspace', 'EI-13237', 'same marker-erased row', 'resolved', {
      source: 'late-replay',
    });
    await insertItem('operator:papercusp-workspace', 'EI-8869', 'operator entity', 'done', {
      _completionEvidence: { testResult: 'rekey-replay-green' },
    });

    await db.sql.unsafe(REPLAY_SQL);

    const oldRows = await db.sql.unsafe(`SELECT harness_slug,feature_id
      FROM harness_shared.work_items
      WHERE (harness_slug,feature_id) IN (
        ('operator:papercusp-workspace','EI-1'),
        ('operator:papercusp-workspace','EI-13237'),
        ('operator:papercusp-workspace','EI-8869'))`);
    expect(oldRows).toHaveLength(0);

    const manifest = await db.sql.unsafe(`SELECT source_harness,old_id,repair_class,target_harness,target_id
      FROM harness_shared.bak_20260820_legacy_replay_twin_manifest ORDER BY old_id`);
    expect(manifest).toEqual([
      {
        source_harness: 'operator:papercusp-workspace',
        old_id: 'EI-1',
        repair_class: 'merged',
        target_harness: 'papercusp',
        target_id: 'EI-1',
      },
      {
        source_harness: 'operator:papercusp-workspace',
        old_id: 'EI-13237',
        repair_class: 'merged',
        target_harness: 'papercusp',
        target_id: 'EI-13237',
      },
      {
        source_harness: 'operator:papercusp-workspace',
        old_id: 'EI-8869',
        repair_class: 'rekeyed',
        target_harness: 'operator:papercusp-workspace',
        target_id: 'EI-82600000000000011',
      },
    ]);
    const backup = await db.sql.unsafe(`SELECT count(*)::int n
      FROM harness_shared.bak_20260820_work_item_legacy_replay_twins`);
    expect(backup[0].n).toBe(3);

    const survivors = await db.sql.unsafe(`SELECT harness_slug,feature_id,status,payload
      FROM harness_shared.work_items
      WHERE feature_id IN ('EI-1','EI-13237','EI-82600000000000011')
      ORDER BY feature_id`);
    expect(survivors).toHaveLength(3);
    expect(survivors[0].status).toBe('done');
    expect(survivors[0].payload._completionEvidence.testResult).toBe('replay-green');
    expect(survivors[1].payload._physicalTwinRepair).toMatchObject({
      migration: 826,
      sourceHarness: 'operator:papercusp-workspace',
      reassertedByMigration: 859,
    });
    expect(survivors[1].payload._physicalTwinReplayRepair.migration).toBe(859);
    expect(survivors[2].status).toBe('done');
    expect(survivors[2].payload._physicalTwinRekey.oldId).toBe('EI-8869');
    expect(survivors[2].payload._completionEvidence.testResult).toBe('rekey-replay-green');

    await expect(db.sql.unsafe(REPLAY_SQL)).resolves.toBeDefined();
    const rerunManifest = await db.sql.unsafe(`SELECT count(*)::int n
      FROM harness_shared.bak_20260820_legacy_replay_twin_manifest`);
    expect(rerunManifest[0].n).toBe(3);
  });

  it('fails closed before snapshot or mutation when replay content no longer matches its survivor', async () => {
    await insertItem('papercusp', 'EI-1', 'frozen content', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'frozen content', 'open');
    await db.sql.unsafe(SQL);
    await insertItem('operator:papercusp-workspace', 'EI-1', 'drifted replay content', 'done');

    await expect(db.sql.unsafe(REPLAY_SQL)).rejects.toThrow('859: replay classification drifted or is ambiguous');
    const rows = await db.sql.unsafe(`SELECT harness_slug,title FROM harness_shared.work_items
      WHERE feature_id='EI-1' ORDER BY harness_slug`);
    expect(rows).toEqual([
      { harness_slug: 'operator:papercusp-workspace', title: 'drifted replay content' },
      { harness_slug: 'papercusp', title: 'frozen content' },
    ]);
    const backupTable = await db.sql.unsafe(`SELECT
      to_regclass('harness_shared.bak_20260820_work_item_legacy_replay_twins')::text AS name`);
    expect(backupTable[0].name).toBeNull();
  });

  it('fails closed when an exact source-harness claim reference appears after replay', async () => {
    await insertItem('papercusp', 'EI-1', 'same', 'open');
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same', 'open');
    await db.sql.unsafe(SQL);
    await insertItem('operator:papercusp-workspace', 'EI-1', 'same', 'done');
    await db.sql.unsafe(`INSERT INTO harness_shared.work_item_claims
      (workspace_id,harness_slug,work_item_id,owner)
      VALUES ('papercusp-workspace','operator:papercusp-workspace','EI-1','agent-holding-source')`);

    await expect(db.sql.unsafe(REPLAY_SQL)).rejects.toThrow('859: exact source-harness references require audit');
    const rows = await db.sql.unsafe(`SELECT harness_slug FROM harness_shared.work_items
      WHERE feature_id='EI-1' ORDER BY harness_slug`);
    expect(rows).toEqual([{ harness_slug: 'operator:papercusp-workspace' }, { harness_slug: 'papercusp' }]);
  });
});
