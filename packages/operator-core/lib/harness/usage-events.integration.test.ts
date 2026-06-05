/**
 * usage-events.integration.test.ts — real-Postgres round-trip for the P-070
 * ledger (emit + rollup over actual rows, not a mocked `sql`).
 *
 * ⚠️ JSONB-representation caveat (hard-won — see agent-insights/
 * postgres-js-jsonb-binding-divergence.mdx): the operator's runtime client
 * (`getOrgPg`, libs/papercusp/libs/db/connection.ts) and the testcontainer
 * client here (`_pg-helpers`) bind a JSONB param DIFFERENTLY despite identical
 * config — `sql.json(obj)` THROWS under getOrgPg but works here; `JSON.stringify
 * (obj)::jsonb` stores a proper jsonb OBJECT under getOrgPg (verified live:
 * jsonb_typeof='object') but DOUBLE-ENCODES to a jsonb string here. So this test
 * canNOT faithfully assert the payload's jsonb shape — that's verified against
 * the live host instead. Here we assert the CLIENT-AGNOSTIC behaviour: emit with
 * an object payload doesn't throw, rows land with the right scalar columns, and
 * rollupForContributor aggregates real rows correctly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { emitUsageEvent, rollupForContributor } from './usage-events';

const SLUG = 'usagetest';
const USER = 4242;

let db: FreshPgDb;

describe('usage-events runtime — real Postgres', () => {
  beforeAll(async () => {
    db = await createFreshPgDb('usage');
    // Mirror the ensure-schema-dogfood DDL (incl. the P-070 origin echo-guard col).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.contributor_usage_events (
        harness_slug    TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        github_user_id  BIGINT NOT NULL,
        device_pubkey   TEXT NOT NULL,
        kind            TEXT NOT NULL,
        ref_id          TEXT,
        payload         JSONB,
        ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
        schema_version  BIGINT NOT NULL DEFAULT 1,
        origin          TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, event_id)
      );
    `);
  });
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.contributor_usage_events`;
  });

  it('emits with an object payload without throwing, and lands the row + scalar cols', async () => {
    await expect(
      emitUsageEvent(
        { harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'feature_authored', ref_id: 'F-1', payload: { title: 'do the thing', tags: ['a', 'b'] } },
        { sql: db.sql },
      ),
    ).resolves.toMatchObject({ event_id: expect.any(String) });
    const rows = await db.sql`
      SELECT kind, github_user_id, ref_id, origin, (payload IS NOT NULL) AS has_payload
        FROM harness_shared.contributor_usage_events WHERE harness_slug = ${SLUG}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('feature_authored');
    expect(Number(rows[0].github_user_id)).toBe(USER);
    expect(rows[0].ref_id).toBe('F-1');
    expect(rows[0].origin).toBe('local'); // column DEFAULT applies to local emits
    expect(rows[0].has_payload).toBe(true);
  });

  it('stores a null payload as SQL NULL', async () => {
    await emitUsageEvent(
      { harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'pr_opened', ref_id: '7', payload: null },
      { sql: db.sql },
    );
    const rows = await db.sql`SELECT payload FROM harness_shared.contributor_usage_events WHERE harness_slug = ${SLUG}`;
    expect(rows[0].payload).toBeNull();
  });

  it('is idempotent on a re-emitted event_id (P-070d)', async () => {
    const input = { harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'feature_authored' as const, payload: { title: 'x' } };
    await emitUsageEvent(input, { sql: db.sql, eventId: 'FIXED01' });
    await emitUsageEvent(input, { sql: db.sql, eventId: 'FIXED01' }); // re-emit → no-op
    const rows = await db.sql`SELECT count(*)::int AS n FROM harness_shared.contributor_usage_events WHERE harness_slug = ${SLUG}`;
    expect(rows[0].n).toBe(1);
  });

  it('rollupForContributor aggregates per-kind counts + last_event_ts over real rows', async () => {
    await emitUsageEvent({ harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'feature_authored', payload: { title: 'a' } }, { sql: db.sql });
    await emitUsageEvent({ harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'agent_run_completed', payload: { run_id: 'r1' } }, { sql: db.sql });
    await emitUsageEvent({ harness_slug: SLUG, github_user_id: USER, device_pubkey: 'pk', kind: 'agent_run_completed', payload: { run_id: 'r2' } }, { sql: db.sql });
    const r = await rollupForContributor(USER, SLUG, { sql: db.sql });
    expect(r.counts.feature_authored).toBe(1);
    expect(r.counts.agent_run_completed).toBe(2);
    expect(r.counts.pr_opened).toBe(0);
    expect(r.total).toBe(3);
    expect(r.last_event_ts).toBeTypeOf('number');
  });
});
