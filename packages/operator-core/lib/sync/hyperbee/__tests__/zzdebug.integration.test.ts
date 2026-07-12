import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../../../test/_pg-helpers';

const SQL_DIR = resolve(__dirname, '../../../../../../libs/papercusp/libs/db/sql');

describe('debug capture trigger', () => {
  let db: FreshPgDb;
  beforeAll(async () => {
    db = await createFreshPgDb('dbg');
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.substrate_outbox (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id TEXT   NOT NULL,
        harness_slug TEXT   NOT NULL,
        table_name   TEXT   NOT NULL,
        op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key          TEXT   NOT NULL,
        row          JSONB,
        ts           BIGINT NOT NULL,
        drained_at   BIGINT
      );
      CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_op TEXT; v_rec RECORD; v_origin TEXT; v_key TEXT; v_row JSONB; v_ws TEXT; v_slug TEXT;
            v_keycol TEXT := TG_ARGV[0];
          BEGIN
            IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD;
            ELSE v_op := 'put'; v_rec := NEW; END IF;
            v_row := to_jsonb(v_rec);
            v_origin := v_row ->> 'origin';
            IF COALESCE(v_origin, 'local') <> 'local' THEN RETURN v_rec; END IF;
            v_key := v_row ->> v_keycol;
            v_ws := COALESCE(v_row ->> 'workspace_id', '');
            v_slug := v_row ->> 'harness_slug';
            INSERT INTO harness_shared.substrate_outbox (workspace_id, harness_slug, table_name, op, key, row, ts)
            VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, (extract(epoch from now())*1000)::bigint);
            PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);
            RETURN v_rec;
          END; $$;
    `);
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.memory_canonical (
        id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
        payload jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        state text DEFAULT 'active' NOT NULL,
        user_id text GENERATED ALWAYS AS (payload->>'user_id') STORED,
        workspace_id text GENERATED ALWAYS AS (payload->>'workspace_id') STORED
      );
    `);
    for (const m of ['562-memory-shareable-federation.sql', '563-memory-federation-capture-triggers.sql', '564-memory-federation-columns.sql']) {
      await applyMigrationForTest(db.sql, resolve(SQL_DIR, m));
    }
  }, 60_000);
  afterAll(async () => { await db?.cleanup(); });

  it('debug', async () => {
    const cols = await db.sql`SELECT column_name, data_type, generation_expression FROM information_schema.columns WHERE table_schema='harness_shared' AND table_name='memory_canonical'`;
    console.log('COLS', JSON.stringify(cols, null, 2));

    const id = '33333333-3333-3333-3333-333333333333';
    await db.sql`INSERT INTO harness_shared.memory_canonical (id, payload, harness_slug) VALUES (${id}::uuid, ${JSON.stringify({user_id:'u1', workspace_id: 'ws_mem_fed', shareable: true, text: 'ok'})}::jsonb, ${'mem-fed-home'})`;

    const row = await db.sql`SELECT id, payload, shareable, origin, harness_slug FROM harness_shared.memory_canonical WHERE id = ${id}::uuid`;
    console.log('ROW', JSON.stringify(row));
    expect(true).toBe(true);
  });
});
