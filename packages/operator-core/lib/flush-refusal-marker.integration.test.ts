/** Regression for EI-20220411691737549: refusal state crosses operator workers. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { markRefused, wasRecentlyRefused, clearRefused } = await import('./flush-refusal-marker');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
}, 120_000);

afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await sql`DELETE FROM harness_shared.flush_gate_refusals`; });

function otherWorker(): Sql {
  return postgres(db.adminDsn, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: 'harness_shared, public' } });
}

describe('flush refusal marker — real Postgres', () => {
  it('a refusal written by one worker is visible to another, then clears globally', async () => {
    const second = otherWorker();
    try {
      await markRefused('compaction', 'su-clustered', Date.now(), { sql });
      expect(await wasRecentlyRefused('compaction', 'su-clustered', Date.now(), { sql: second })).toBe(true);
      await clearRefused('compaction', 'su-clustered', { sql: second });
      expect(await wasRecentlyRefused('compaction', 'su-clustered', Date.now(), { sql })).toBe(false);
    } finally {
      await second.end();
    }
  });

  it('boundary and owner form the isolation key', async () => {
    await markRefused('compaction', 'su-a', Date.now(), { sql });
    expect(await wasRecentlyRefused('handoff', 'su-a', Date.now(), { sql })).toBe(false);
    expect(await wasRecentlyRefused('compaction', 'su-b', Date.now(), { sql })).toBe(false);
  });
});
