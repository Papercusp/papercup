/**
 * store.integration.test.ts — the await-event store (event_awaits, migrations
 * 163/175/183), against a real Postgres. getOrgPg() is mocked to a per-test DB.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - registerAwait persists a one-shot watch (wakeHandle jsonb + expires_ts from
 *    timeoutSec); listActiveAwaits skips fired/cancelled rows;
 *  - upsertInboxWakeAwait is one-per-agent (the partial unique index) — re-arming
 *    REFRESHES in place, and a null wakeHandle on re-arm KEEPS the prior handle
 *    (the COALESCE-keep);
 *  - fireAwaitsForKey claims a one-shot watch ATOMICALLY (exactly-once) while a
 *    standing watch keeps matching on every emit (TEETHED: the `fired_at IS NULL`
 *    guard on the one-shot UPDATE);
 *  - cancelInboxWakeAwaits / cancelAwait are subscriber-scoped and skip already-
 *    fired/cancelled rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const hb = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: hb.sql }) };
});

const { registerAwait, upsertInboxWakeAwait, cancelInboxWakeAwaits, cancelAwait, listActiveAwaits, listActiveAwaitsForKey, fireAwaitsForKey } =
  await import('./store');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `awaits_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to mig 163 + 175 (once/min_sleep_sec/urgency) + 183 (the partial unique index).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_awaits (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default', subscriber_id text NOT NULL, event_key text NOT NULL,
      policy text NOT NULL DEFAULT 'wake' CHECK (policy IN ('wake','notify')),
      note text, wake_handle jsonb,
      timeout_behavior text NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire','wake')),
      expires_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      fired_at timestamptz, fired_reason text, cancelled_at timestamptz,
      once boolean NOT NULL DEFAULT true, min_sleep_sec integer, urgency boolean NOT NULL DEFAULT false
    )`);
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX event_awaits_inbox_wake_one_per_agent
      ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      WHERE policy = 'wake' AND once = false AND cancelled_at IS NULL AND event_key LIKE 'coord:inbox-wake:%'`);
  hb.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.event_awaits RESTART IDENTITY`;
});

describe('await-event store (PG)', () => {
  it('registerAwait persists a one-shot watch; listActiveAwaits reads it back', async () => {
    const row = await registerAwait({ subscriberId: 'sub-1', eventKey: 'k:1', wakeHandle: { sessionId: 's9' } as never, timeoutSec: 60, note: 'hi' });
    expect(row).toMatchObject({ subscriberId: 'sub-1', eventKey: 'k:1', once: true, note: 'hi' });
    expect(row.wakeHandle).toEqual({ sessionId: 's9' }); // jsonb round-trip
    expect(row.expiresTs).not.toBeNull(); // timeoutSec → expires_ts
    const active = await listActiveAwaits('sub-1');
    expect(active.map((a) => a.eventKey)).toEqual(['k:1']);
  });

  it('upsertInboxWakeAwait is one-per-agent and KEEPS the prior handle on a null re-arm (COALESCE)', async () => {
    const key = 'coord:inbox-wake:sub-1';
    await upsertInboxWakeAwait({ subscriberId: 'sub-1', eventKey: key, wakeHandle: { sessionId: 'first' } as never, minSleepSec: 5 });
    // re-arm with NO handle but a new floor → refreshes in place, keeps the handle
    const rearmed = await upsertInboxWakeAwait({ subscriberId: 'sub-1', eventKey: key, wakeHandle: null, minSleepSec: 30 });
    expect(await rootSql`SELECT 1 FROM harness_shared.event_awaits WHERE event_key=${key}`).toHaveLength(1); // ONE row, not two
    expect(rearmed.wakeHandle).toEqual({ sessionId: 'first' }); // COALESCE kept the prior handle
    expect(rearmed.minSleepSec).toBe(30); // floor replaced by EXCLUDED
  });

  it('fireAwaitsForKey claims a one-shot EXACTLY ONCE; a standing watch keeps matching', async () => {
    await registerAwait({ subscriberId: 'one', eventKey: 'k:fire', once: true });
    await registerAwait({ subscriberId: 'standing', eventKey: 'k:fire', once: false });

    const first = await fireAwaitsForKey({ eventKey: 'k:fire' });
    expect(first.map((a) => a.subscriberId).sort()).toEqual(['one', 'standing']); // both on the first emit

    const second = await fireAwaitsForKey({ eventKey: 'k:fire' });
    expect(second.map((a) => a.subscriberId)).toEqual(['standing']); // one-shot NOT re-fired; standing still matches
    // listActiveAwaitsForKey now sees only the standing one (the one-shot has fired_at)
    expect((await listActiveAwaitsForKey('k:fire')).map((a) => a.subscriberId)).toEqual(['standing']);
  });

  it('cancelInboxWakeAwaits / cancelAwait are subscriber-scoped and skip non-active rows', async () => {
    const key = 'coord:inbox-wake:sub-1';
    await upsertInboxWakeAwait({ subscriberId: 'sub-1', eventKey: key, wakeHandle: { sessionId: 'x' } as never });
    expect(await cancelInboxWakeAwaits('sub-1')).toBe(1); // cancelled
    expect(await cancelInboxWakeAwaits('sub-1')).toBe(0); // already cancelled → no-op
    expect(await listActiveAwaits('sub-1')).toHaveLength(0); // cancelled → not active

    const a = await registerAwait({ subscriberId: 'owner', eventKey: 'k:mine' });
    expect(await cancelAwait({ awaitId: a.id, subscriberId: 'not-owner' })).toBe(false); // cannot cancel a peer's
    expect(await cancelAwait({ awaitId: a.id, subscriberId: 'owner' })).toBe(true); // owner can
  });
});
