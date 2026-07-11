import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import { assertFact } from './store';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('zz-debug-prov');
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  for (const m of ['444-agent-facts.sql', '455-agent-facts-shareable.sql', '461-agent-facts-federation.sql', '462-agent-facts-fed-key.sql', '574-agent-facts-audience-provenance.sql']) {
    await applyMigrationForTest(db.sql, join(SQL_DIR, m));
  }
});
afterAll(async () =>
  await db?.cleanup());

it('debug: what does the stored source_provenance look like?', async () => {
  const fact = await assertFact(
    {
      scope: 'harness', scopeRef: 'papercusp', key: 'dbg', body: 'b', createdBy: 'su-int', workspaceId: 'ws-dbg',
      audienceScope: 'fleet:backend',
      sourceProvenance: { kind: 'msg', verified: true, quote: 'q', label: 'l', verifiedAt: 't' },
    },
    db.sql,
  );
  const rows = await db.sql`SELECT source_provenance, pg_typeof(source_provenance)::text AS t, audience_scope FROM harness_shared.agent_facts WHERE key = 'dbg'`;
  expect({
    returnedFromAssert: fact.sourceProvenance,
    rawColValue: rows[0].source_provenance,
    pgType: rows[0].t,
    typeofRaw: typeof rows[0].source_provenance,
  }).toBe('SHOW-ME');
});
