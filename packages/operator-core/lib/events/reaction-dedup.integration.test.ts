/**
 * reaction-dedup.integration.test.ts — the event-reaction idempotency ledger
 * (event_reactions, migration 153), against a real Postgres.
 *
 * The behavior a fake-sql unit test can't prove is the ATOMIC dedup: claimReaction
 * does `INSERT … ON CONFLICT (dedup_id) DO NOTHING RETURNING dedup_id` — the first
 * caller wins (returns true, proceeds to dispatch); a re-delivery finds the claim
 * and gets false ("a double-fire is a no-op", D-007). releaseReaction deletes so a
 * retry can re-fire; markReactionFailed keeps the row for inspection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { claimReaction, releaseReaction, markReactionFailed } = await import('./reaction-dedup');

const claim = (dedupId: string) => ({ dedupId, workspaceId: 'w1', ruleId: 'rule-1', fire: 'plans:set-status', depth: 0 }) as never;
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `rx_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 153: dedup_id PK is the dedup gate; status default 'fired'.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_reactions (
      dedup_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      rule_id text NOT NULL,
      fire text NOT NULL,
      trigger_tool text,
      cause_root_run_id text,
      depth integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'fired',
      error_message text,
      fired_at timestamptz NOT NULL DEFAULT now()
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.event_reactions`;
});

describe('reaction-dedup ledger (PG)', () => {
  it('the first claim wins (true); a re-delivery of the same dedup_id is a no-op (false)', async () => {
    expect(await claimReaction(claim('d1'))).toBe(true);
    expect(await claimReaction(claim('d1'))).toBe(false); // ON CONFLICT DO NOTHING → no row returned
    const rows = await rootSql`SELECT status FROM harness_shared.event_reactions WHERE dedup_id='d1'`;
    expect(rows).toHaveLength(1); // exactly one claim row, status 'fired'
    expect(rows[0]!.status).toBe('fired');
  });

  it('distinct dedup_ids each win their own claim', async () => {
    expect(await claimReaction(claim('a'))).toBe(true);
    expect(await claimReaction(claim('b'))).toBe(true);
    expect(await rootSql`SELECT 1 FROM harness_shared.event_reactions`).toHaveLength(2);
  });

  it('releaseReaction deletes the claim so a retry can re-fire', async () => {
    await claimReaction(claim('d2'));
    await releaseReaction('d2');
    expect(await rootSql`SELECT 1 FROM harness_shared.event_reactions WHERE dedup_id='d2'`).toHaveLength(0);
    expect(await claimReaction(claim('d2'))).toBe(true); // re-fires after release
  });

  it('markReactionFailed sets status=failed + error_message, keeping the row', async () => {
    await claimReaction(claim('d3'));
    await markReactionFailed('d3', 'dispatch boom');
    const row = (await rootSql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM harness_shared.event_reactions WHERE dedup_id='d3'`)[0]!;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('dispatch boom');
  });
});
