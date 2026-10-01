/**
 * resolveOwnerIntentEventId against real Postgres — the newest intent across a digit-length
 * boundary (WI-10004608).
 *
 * The read selects `id::text AS id ... ORDER BY id DESC LIMIT 1`. An unqualified ORDER BY
 * binds to the TEXT output alias, so '999' sorted above '1000' and the owner's OLDER intent
 * declaration came back as its newest. Seeded ids here straddle 9->10 and 999->1000; the
 * rest of the suite never crossed a digit boundary, which is why it could not see this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as Sql }));

vi.mock('./log', () => ({
  coordSql: () => h.sql,
  coordWorkspaceId: () => 'ws-intent',
  coordHasPgFastPath: () => true,
}));

const { resolveOwnerIntentEventId } = await import('./agent-intent-sources');

const DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigint PRIMARY KEY,
    workspace_id text NOT NULL,
    surface text NOT NULL,
    writer_key text,
    body jsonb NOT NULL
  );
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('intent-sources');
  await db.sql.unsafe(DDL);
  h.sql = db.sql;
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.coord_event_log');
});

async function seed(id: number, owner: string, lifecycle: string | null, ws = 'ws-intent', surface = 'messages') {
  const body = lifecycle ? { lifecycle } : {};
  await db.sql`
    INSERT INTO harness_shared.coord_event_log (id, workspace_id, surface, writer_key, body)
    VALUES (${id}, ${ws}, ${surface}, ${owner}, ${db.sql.json(body)})`;
}

describe('resolveOwnerIntentEventId (WI-10004608)', () => {
  it('returns the numerically newest intent across 9->10', async () => {
    await seed(9, 'su-a', 'intent');
    await seed(10, 'su-a', 'intent');
    expect(await resolveOwnerIntentEventId('su-a')).toBe(10);
  });

  it('returns the numerically newest intent across 999->1000', async () => {
    await seed(998, 'su-a', 'intent');
    await seed(999, 'su-a', 'intent');
    await seed(1000, 'su-a', 'intent');
    expect(await resolveOwnerIntentEventId('su-a')).toBe(1000);
  });

  it('ignores other owners, other workspaces, other surfaces and non-intent messages', async () => {
    await seed(9, 'su-a', 'intent');
    await seed(10, 'su-b', 'intent');
    await seed(11, 'su-a', 'intent', 'ws-other');
    await seed(12, 'su-a', 'intent', 'ws-intent', 'blueprint-operation');
    await seed(13, 'su-a', null);
    expect(await resolveOwnerIntentEventId('su-a')).toBe(9);
    expect(await resolveOwnerIntentEventId('su-c')).toBeNull();
  });
});
