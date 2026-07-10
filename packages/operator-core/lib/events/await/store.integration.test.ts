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
  // FAITHFUL to mig 163 + 175 (once/min_sleep_sec/urgency) + 183 (the partial unique
  // index) + 533 (payload_filter, EI-8998).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_awaits (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default', subscriber_id text NOT NULL, event_key text NOT NULL,
      policy text NOT NULL DEFAULT 'wake' CHECK (policy IN ('wake','notify')),
      note text, wake_handle jsonb,
      timeout_behavior text NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire','wake')),
      expires_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      fired_at timestamptz, fired_reason text, cancelled_at timestamptz,
      once boolean NOT NULL DEFAULT true, min_sleep_sec integer, urgency boolean NOT NULL DEFAULT false,
      payload_filter jsonb
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

  // ── EI-8998: predicate/payload watches ───────────────────────────────────
  it('a payload_filter gates firing: a non-matching emit leaves the once-row unclaimed, a matching one claims it exactly once', async () => {
    await registerAwait({
      subscriberId: 'filtered-once',
      eventKey: 'k:threshold',
      once: true,
      payloadFilter: { queue_depth: { lt: 5 } },
    });

    const miss = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 9 } });
    expect(miss).toEqual([]); // predicate failed — NOT claimed, still active
    expect((await listActiveAwaitsForKey('k:threshold')).map((a) => a.subscriberId)).toEqual(['filtered-once']);

    const hit = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 2 } });
    expect(hit.map((a) => a.subscriberId)).toEqual(['filtered-once']); // predicate passed — claimed

    const again = await fireAwaitsForKey({ eventKey: 'k:threshold', payload: { queue_depth: 1 } });
    expect(again).toEqual([]); // one-shot already consumed — exactly-once holds even with a filter
  });

  it('a filter-less once row on the SAME key is unaffected by a sibling filtered row (fast path untouched)', async () => {
    await registerAwait({ subscriberId: 'plain', eventKey: 'k:mixed', once: true });
    await registerAwait({ subscriberId: 'filtered', eventKey: 'k:mixed', once: true, payloadFilter: { ok: true } });

    const fired = await fireAwaitsForKey({ eventKey: 'k:mixed', payload: { ok: false } });
    // plain fires regardless of payload; filtered does not (predicate failed)
    expect(fired.map((a) => a.subscriberId)).toEqual(['plain']);
    expect((await listActiveAwaitsForKey('k:mixed')).map((a) => a.subscriberId)).toEqual(['filtered']);
  });

  it('a standing watch with a payload_filter only appears in fired rows on matching emits, and keeps matching', async () => {
    await registerAwait({
      subscriberId: 'standing-filtered',
      eventKey: 'k:standing-threshold',
      once: false,
      payloadFilter: { severity: { gte: 3 } },
    });

    expect(await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 1 } })).toEqual([]);
    const first = await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 4 } });
    expect(first.map((a) => a.subscriberId)).toEqual(['standing-filtered']);
    // standing — still active + still matches on a second qualifying emit
    const second = await fireAwaitsForKey({ eventKey: 'k:standing-threshold', payload: { severity: 5 } });
    expect(second.map((a) => a.subscriberId)).toEqual(['standing-filtered']);
  });

  it('a pattern (glob) watch combines key-glob matching with a payload_filter', async () => {
    await registerAwait({
      subscriberId: 'pattern-filtered',
      eventKey: 'work-item:done:*',
      once: true,
      payloadFilter: { kind: 'feature' },
    });

    // key matches the glob, but payload fails the filter — not claimed
    expect(await fireAwaitsForKey({ eventKey: 'work-item:done:WI-1', payload: { kind: 'bug' } })).toEqual([]);
    // key matches AND payload satisfies the filter — claimed
    const hit = await fireAwaitsForKey({ eventKey: 'work-item:done:WI-2', payload: { kind: 'feature' } });
    expect(hit.map((a) => a.subscriberId)).toEqual(['pattern-filtered']);
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
