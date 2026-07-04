import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withTestSchema } from '@papercusp/test-config';

let sql: postgres.Sql;
let schema: string;

beforeAll(async () => {
  const handle = await withTestSchema();
  schema = handle.schema;
  sql = postgres(handle.connectionUri, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`SET search_path TO "${schema}"`);
  await sql.unsafe(`
    CREATE TABLE harness_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status      text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
});

afterAll(async () => {
  if (sql) {
    try { await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`); } catch {}
    await sql.end({ timeout: 5 });
  }
});

describe('test-config Postgres harness', () => {
  it('boots a real Postgres and round-trips an insert', async () => {
    const [row] = await sql.unsafe(
      `INSERT INTO "${schema}".harness_runs (status) VALUES ($1) RETURNING id, status`,
      ['queued']
    );
    expect(row.status).toBe('queued');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM "${schema}".harness_runs`);
    expect(rows[0].n).toBe(1);
  });

  it('schema is isolated per worker', async () => {
    expect(schema).toMatch(/^t_[0-9a-f]{12}$/);
  });
});
