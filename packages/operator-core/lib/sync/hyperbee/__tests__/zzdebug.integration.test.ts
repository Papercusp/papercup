import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

describe('debug jsonb serialization', () => {
  let db: FreshPgDb;
  beforeAll(async () => {
    db = await createFreshPgDb('dbg2');
    await db.sql.unsafe(`CREATE TABLE t (id int, payload jsonb, payload2 jsonb, payload3 jsonb)`);
  }, 60_000);
  afterAll(async () => { await db?.cleanup(); });

  it('debug', async () => {
    const obj = { a: 1, b: 'x' };
    // Variant A: stringify, no cast
    await db.sql`INSERT INTO t (id, payload) VALUES (1, ${JSON.stringify(obj)})`;
    // Variant B: stringify + ::jsonb cast
    await db.sql`INSERT INTO t (id, payload2) VALUES (1, ${JSON.stringify(obj)}::jsonb)`;
    // Variant C: raw object, no stringify
    await db.sql`INSERT INTO t (id, payload3) VALUES (1, ${obj})`;

    const rows = await db.sql`SELECT jsonb_typeof(payload) AS a_type, payload::text AS a_raw,
      jsonb_typeof(payload2) AS b_type, payload2::text AS b_raw,
      jsonb_typeof(payload3) AS c_type, payload3::text AS c_raw
      FROM t WHERE id = 1`;
    console.log('RESULT', JSON.stringify(rows, null, 2));
    expect(true).toBe(true);
  });
});
