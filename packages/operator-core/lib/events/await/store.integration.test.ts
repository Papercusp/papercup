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
import { getTestPg } from '@papercusp/test-config/pg';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';

const hb = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: hb.sql }) };
});

const {
  registerAwait,
  upsertInboxWakeAwait,
  cancelInboxWakeAwaits,
  cancelClaimableAwaits,
  cancelAwait,
  cancelAwaitsForSubscribersOnKeys,
  cancelAwaitsByIds,
  listActiveAwaits,
  listActiveAwaitsForKey,
  fireAwaitsForKey,
  listParkedAwaitsForSubscribers,
  listVerifiedWaitTakeoversForSubscribers,
  countActiveAwaitsByPrefixes,
  recordKeyFire,
  getKeyFireLatch,
  inspectEventKey,
  probeKeyFireEvidence,
  keyFireEvidencePrefix,
  probePatternMatchScope,
  claimDueVerifiedAwaits,
  settleVerifiedAwaitTimeout,
} = await import('./store');
const { classifyVerifiedWaitTimeout } = await import('./verified-wait');
const { observeCheckpointProducer } = await import('./checkpoint-verified-wait');
import type { ProducerHealthCertificate } from './verified-wait';

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
      payload_filter jsonb,
      causal_generation bigint, expected_condition jsonb, superseded_at timestamptz,
      fired_by text, fired_payload jsonb,
      -- migration 572 (composable-event-awaits): composed-TREE leaf columns. A plain
      -- await leaves them NULL, but store.ts SELECTs root_id unconditionally
      -- (listParkedAwaitsForSubscribers), so omitting them here failed that query with
      -- a missing-column error -- fixture drift from the migration, not a prod bug.
      node_id bigint, root_id bigint, member_fired_at timestamptz, member_payload jsonb,
      -- migration 825: verified-wait certificate + authoritative timeout verdict.
      producer_health jsonb, timeout_verification jsonb, verification_claimed_at timestamptz
    )`);
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX event_awaits_inbox_wake_one_per_agent
      ON harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      WHERE policy = 'wake' AND once = false AND cancelled_at IS NULL AND event_key LIKE 'coord:inbox-wake:%'`);
  // FAITHFUL to mig 163 — event_wake_deliveries — needed by inspectEventKey (EI-13705 tests below).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_wake_deliveries (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default', await_id bigint NOT NULL,
      subscriber_id text NOT NULL, event_key text NOT NULL, payload jsonb, summary text,
      status text NOT NULL DEFAULT 'pending', channel text, attempts integer NOT NULL DEFAULT 0,
      last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
    )`);
  // FAITHFUL to mig 632 (EI-13705) — the unconditional per-key fire latch.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.event_key_fires (
      workspace_id text NOT NULL DEFAULT 'default', event_key text NOT NULL,
      first_fired_at timestamptz NOT NULL DEFAULT now(), last_fired_at timestamptz NOT NULL DEFAULT now(),
      last_fired_by text, last_payload jsonb, fire_count bigint NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, event_key)
    )`);
  // EI-20540454577146535: a minimal stand-in for the harness_shared.work_items VIEW —
  // only the two columns terminalWorkItemIds() reads (store.ts). Real callers see a
  // cross-family view; this fixture only needs feature_id/status to exist.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL DEFAULT 'default', feature_id text NOT NULL, status text
    )`);
  hb.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.event_awaits RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.event_wake_deliveries RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.event_key_fires`;
  await rootSql`TRUNCATE harness_shared.work_items`;
});

describe('await-event store (PG)', () => {
  it('registerAwait persists a one-shot watch; listActiveAwaits reads it back', async () => {
    const row = await registerAwait({
      subscriberId: 'sub-1',
      eventKey: 'k:1',
      wakeHandle: { sessionId: 's9' } as never,
      timeoutSec: 60,
      note: 'hi',
    });
    expect(row).toMatchObject({ subscriberId: 'sub-1', eventKey: 'k:1', once: true, note: 'hi' });
    expect(row.wakeHandle).toEqual({ sessionId: 's9' }); // jsonb round-trip
    expect(row.expiresTs).not.toBeNull(); // timeoutSec → expires_ts
    const active = await listActiveAwaits('sub-1');
    expect(active.map((a) => a.eventKey)).toEqual(['k:1']);
  });

  it('upsertInboxWakeAwait is one-per-agent and KEEPS the prior handle on a null re-arm (COALESCE)', async () => {
    const key = 'coord:inbox-wake:sub-1';
    await upsertInboxWakeAwait({
      subscriberId: 'sub-1',
      eventKey: key,
      wakeHandle: { sessionId: 'first' } as never,
      minSleepSec: 5,
    });
    // re-arm with NO handle but a new floor → refreshes in place, keeps the handle
    const rearmed = await upsertInboxWakeAwait({
      subscriberId: 'sub-1',
      eventKey: key,
      wakeHandle: null,
      minSleepSec: 30,
    });
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

  // EI-10541: on a successful claim, the claim path cancels the agent's stale idle-park
  // `work-item:claimable` await(s) so they stop firing spurious timeout wakes while it works.
  it("cancelClaimableAwaits cancels ONLY the caller's work-item:claimable await(s), key- and subscriber-scoped", async () => {
    // sub-1's standing idle-park claimable await (once:false) — the one that lingers post-claim
    await registerAwait({ subscriberId: 'sub-1', eventKey: 'work-item:claimable', once: false, timeoutSec: 1800 });
    // sub-1's claimable await from a re-register (once:true variant) — also stale on claim
    await registerAwait({ subscriberId: 'sub-1', eventKey: 'work-item:claimable', once: true });
    // sub-1's await on an UNRELATED key → must survive (only claimable is mutually exclusive with a claim)
    await registerAwait({ subscriberId: 'sub-1', eventKey: 'lock:grant:xyz' });
    // a PEER's claimable await → subscriber-scoped, must survive
    await registerAwait({ subscriberId: 'sub-2', eventKey: 'work-item:claimable', once: false });

    expect(await cancelClaimableAwaits('sub-1')).toBe(2); // both of sub-1's claimable rows
    expect(await cancelClaimableAwaits('sub-1')).toBe(0); // idempotent: already cancelled → no-op

    expect((await listActiveAwaits('sub-1')).map((r) => r.eventKey)).toEqual(['lock:grant:xyz']); // unrelated await kept
    expect((await listActiveAwaits('sub-2')).map((r) => r.eventKey)).toEqual(['work-item:claimable']); // peer's kept
  });

  // EI-12457: cancelAwaitsForSubscribersOnKeys — the shared primitive behind sibling-
  // outcome cancellation (checkpoint:await's dual green/red arm) and superseded-wait
  // retirement (re-arming for a moved-on candidate).
  it("cancelAwaitsForSubscribersOnKeys cancels only the named subscribers' PENDING rows on the named keys", async () => {
    const green = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'green-checkpoint:red:papercusp' });
    const unrelated = await registerAwait({ subscriberId: 'sub-a', eventKey: 'lock:grant:xyz' });
    const peerRed = await registerAwait({ subscriberId: 'sub-b', eventKey: 'green-checkpoint:red:papercusp' });

    const cancelled = await cancelAwaitsForSubscribersOnKeys(
      ['sub-a'],
      ['green-checkpoint:red:papercusp', 'green-checkpoint:red'],
    );
    expect(cancelled).toBe(1); // only sub-a's red row

    const subA = await listActiveAwaits('sub-a');
    expect(subA.map((r) => r.id).sort()).toEqual([green.id, unrelated.id].sort()); // green + unrelated survive
    expect((await listActiveAwaits('sub-b')).map((r) => r.id)).toEqual([peerRed.id]); // peer untouched

    // idempotent: nothing left to cancel for sub-a on that key
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-a'], ['green-checkpoint:red:papercusp'])).toBe(0);
    // empty inputs are a no-op, not a query
    expect(await cancelAwaitsForSubscribersOnKeys([], ['green-checkpoint:red:papercusp'])).toBe(0);
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-a'], [])).toBe(0);
  });

  it('cancelAwaitsForSubscribersOnKeys never touches an already-fired row (fire wins the race)', async () => {
    await registerAwait({ subscriberId: 'sub-c', eventKey: 'green-checkpoint:red:papercusp' });
    const fired = await fireAwaitsForKey({ eventKey: 'green-checkpoint:red:papercusp' });
    expect(fired).toHaveLength(1);
    // the row is now fired, not pending — the sibling-cancel pass must be a no-op on it
    expect(await cancelAwaitsForSubscribersOnKeys(['sub-c'], ['green-checkpoint:red:papercusp'])).toBe(0);
  });

  // WI-4957: cancelAwaitsByIds — the precise by-id cancel cancelSupersededCandidateAwaits
  // uses once it has identified EXACTLY which rows are payload-bound to a dead candidate.
  // Unlike cancelAwaitsForSubscribersOnKeys (subscriber+key scoped), this must be able to
  // cancel ONE of two payload-bound rows a single subscriber holds on the SAME key without
  // touching the other.
  it('cancelAwaitsByIds cancels exactly the named rows, leaves a sibling row on the SAME key+subscriber untouched, and is idempotent', async () => {
    const staleBound = await registerAwait({
      subscriberId: 'sub-d',
      eventKey: 'release:green:papercusp',
      payloadFilter: { sha: { startsWith: 'deadbeef' } },
    });
    const otherBound = await registerAwait({
      subscriberId: 'sub-d',
      eventKey: 'release:green:papercusp',
      payloadFilter: { sha: { startsWith: 'cafef00d' } },
    });
    const peer = await registerAwait({ subscriberId: 'sub-e', eventKey: 'lock:grant:xyz' });

    const cancelled = await cancelAwaitsByIds([staleBound.id, 99999999]); // a non-existent id is silently ignored
    expect(cancelled).toBe(1);

    const subD = await listActiveAwaits('sub-d');
    expect(subD.map((r) => r.id)).toEqual([otherBound.id]); // the sibling-candidate wait survives
    expect((await listActiveAwaits('sub-e')).map((r) => r.id)).toEqual([peer.id]); // untouched

    // idempotent: the row is already cancelled, nothing left to cancel
    expect(await cancelAwaitsByIds([staleBound.id])).toBe(0);
    // empty input is a no-op, not a query
    expect(await cancelAwaitsByIds([])).toBe(0);
  });

  it('cancelAwaitsByIds never touches an already-fired row', async () => {
    const row = await registerAwait({ subscriberId: 'sub-f', eventKey: 'release:green:papercusp' });
    const fired = await fireAwaitsForKey({ eventKey: 'release:green:papercusp' });
    expect(fired.map((r) => r.id)).toContain(row.id);
    expect(await cancelAwaitsByIds([row.id])).toBe(0);
  });

  // ── P-001 (fleet-member-dx-improvements-2026-07-10): parked-on-event read ──
  it('listParkedAwaitsForSubscribers returns only ACTIVE non-inbox-wake awaits for the asked subscribers', async () => {
    // sub-a: a genuine parked-on-event await → the ONE row that should surface
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'p2p-git:phase3-open', note: 'benched until phase 3' });
    // sub-a: the always-armed inbox-wake self-key → excluded (liveness, not benching)
    await upsertInboxWakeAwait({
      subscriberId: 'sub-a',
      eventKey: 'coord:inbox-wake:sub-a',
      wakeHandle: { sessionId: 's1' } as never,
    });
    // sub-a: a fired await → excluded
    await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:already-fired', once: true });
    await fireAwaitsForKey({ eventKey: 'k:already-fired' });
    // sub-a: a cancelled await → excluded
    const cancelled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:cancelled' });
    await cancelAwait({ awaitId: cancelled.id, subscriberId: 'sub-a' });
    // sub-a: an EXPIRED await (expires_ts in the past) → excluded
    const expired = await registerAwait({ subscriberId: 'sub-a', eventKey: 'k:expired', timeoutSec: 60 });
    await rootSql`UPDATE harness_shared.event_awaits SET expires_ts = now() - interval '1 minute' WHERE id = ${expired.id}`;
    // sub-b (NOT asked about): parked, but not in the subscriber list → excluded
    await registerAwait({ subscriberId: 'sub-b', eventKey: 'k:other-agent' });

    const parked = await listParkedAwaitsForSubscribers(['sub-a', 'sub-c']);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      subscriberId: 'sub-a',
      eventKey: 'p2p-git:phase3-open',
      note: 'benched until phase 3',
    });

    // empty / all-blank input short-circuits to []
    expect(await listParkedAwaitsForSubscribers([])).toEqual([]);
    expect(await listParkedAwaitsForSubscribers([''])).toEqual([]);
  });

  it('lists only recent stalled/absent verified waits with owner-aware takeover remedies', async () => {
    const stalled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    const progressing = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:other' });
    const result = {
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify({ ...result, classification: 'progressing', nextAction: 're-await' })}::jsonb
       WHERE id = ${progressing.id}
    `;

    const alerts = await listVerifiedWaitTakeoversForSubscribers(['sub-a']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subscriberId: 'sub-a',
      eventKey: 'release:green:papercusp',
      classification: 'stalled',
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      evidence: { phase: 'suite' },
    });
    expect(alerts[0]?.remedy).toContain('claim/take over WI-42');
  });

  // ── EI-20540454577146535: a stalled/absent verdict is a snapshot taken when the
  // fallback verifier fired; it must not survive the owning work item going terminal.
  it('suppresses a takeover row once its owning work item has since gone terminal', async () => {
    const stalled = await registerAwait({ subscriberId: 'sub-a', eventKey: 'release:green:papercusp' });
    const result = {
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-39333' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
    };
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET fired_at = now(), fired_reason = 'verified-timeout',
             timeout_verification = ${JSON.stringify(result)}::jsonb
       WHERE id = ${stalled.id}
    `;

    // The producer/item has since closed (state=done) -- the row must not surface.
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status) VALUES ('WI-39333', 'done')`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toEqual([]);

    // A work item this read cannot resolve at all (never existed / cross-workspace
    // collision / lookup gap) fails OPEN -- the pre-fix behavior, still surfaced.
    await rootSql`UPDATE harness_shared.work_items SET status = 'wip' WHERE feature_id = 'WI-39333'`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toHaveLength(1);
    await rootSql`DELETE FROM harness_shared.work_items WHERE feature_id = 'WI-39333'`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['sub-a'])).toHaveLength(1);
  });

  // ── EI-9000 (fleet-reliability-verification-2026-07-10 P-005): live-awaiter counts ──
  it('countActiveAwaitsByPrefixes groups LIVE awaits per prefix, in one round trip, zero-filling a matchless prefix', async () => {
    await registerAwait({ subscriberId: 'a', eventKey: 'work-item:status:WI-1' });
    await registerAwait({ subscriberId: 'b', eventKey: 'work-item:status:WI-2' });
    await registerAwait({ subscriberId: 'c', eventKey: 'release:deployed' }); // the global (no-sha) key
    await registerAwait({ subscriberId: 'd', eventKey: 'release:deployed:abc123' }); // scoped key — same prefix
    // a fired one-shot must NOT count
    const fired = await registerAwait({ subscriberId: 'e', eventKey: 'work-item:status:WI-3', once: true });
    await fireAwaitsForKey({ eventKey: 'work-item:status:WI-3' });
    void fired;
    // a cancelled one must NOT count
    const cancelled = await registerAwait({ subscriberId: 'f', eventKey: 'work-item:status:WI-4' });
    await cancelAwait({ awaitId: cancelled.id, subscriberId: 'f' });

    const counts = await countActiveAwaitsByPrefixes(['work-item:status', 'release:deployed', 'nobody:listening']);
    expect(counts.get('work-item:status')).toBe(2); // WI-1, WI-2 only (fired + cancelled excluded)
    expect(counts.get('release:deployed')).toBe(2); // global + scoped, same prefix
    expect(counts.get('nobody:listening')).toBe(0); // zero-filled, not absent

    // empty input short-circuits to an empty map
    expect((await countActiveAwaitsByPrefixes([])).size).toBe(0);
  });
});

describe('verified-wait fallback campaign (PG)', () => {
  const checkpointSnapshot = (
    overrides: {
      generatedAtMs?: number;
      activeRun?: GitPipelineSnapshot['activeRun'];
      greenCheckpoint?: GitPipelineSnapshot['routines']['greenCheckpoint'];
      recent?: GitPipelineSnapshot['recent'];
    } = {},
  ): GitPipelineSnapshot =>
    ({
      slug: 'papercusp',
      generatedAtMs: overrides.generatedAtMs ?? 2_000,
      activeRun: overrides.activeRun ?? null,
      routines: {
        gitSync: null,
        greenCheckpoint: overrides.greenCheckpoint ?? null,
        releaseTrigger: null,
      },
      recent: overrides.recent ?? [],
    }) as GitPipelineSnapshot;

  const certificate = (overrides: Partial<ProducerHealthCertificate> = {}): ProducerHealthCertificate => ({
    version: 1,
    producer: { kind: 'green-checkpoint', id: 'run-campaign' },
    owner: { ownerId: 'su-producer', workItemId: 'WI-producer' },
    issuedAtMs: 1_000,
    lastProgressAtMs: 900,
    lastFireAtMs: null,
    expectedCadenceMs: 500,
    verificationDeadlineMs: 2_000,
    details: { pipeline: 'papercusp', runId: 'run-campaign' },
    ...overrides,
  });

  async function registerDueVerifiedAwait(subscriberId: string, cert = certificate()) {
    const row = await registerAwait({
      subscriberId,
      eventKey: 'release:green:papercusp',
      timeoutBehavior: 'wake',
      timeoutSec: 60,
      producerHealthCertificate: cert,
    });
    await rootSql`
      UPDATE harness_shared.event_awaits
         SET expires_ts = now() - interval '1 second'
       WHERE id = ${row.id}
    `;
    return row;
  }

  it('producer dies before emit: persists an absent verdict and an owner-aware takeover', async () => {
    const row = await registerDueVerifiedAwait('waiter-died');
    const [claimed] = await claimDueVerifiedAwaits();
    expect(claimed?.id).toBe(row.id);

    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      snapshot: async () => checkpointSnapshot(),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'absent', nextAction: 'wake-owner-or-takeover' });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result })).toMatchObject({
      firedReason: 'verified-timeout',
      timeoutVerification: { classification: 'absent' },
    });

    expect(await listVerifiedWaitTakeoversForSubscribers(['waiter-died'])).toEqual([
      expect.objectContaining({
        classification: 'absent',
        owner: { ownerId: 'su-producer', workItemId: 'WI-producer' },
        remedy: expect.stringContaining('claim/take over WI-producer'),
      }),
    ]);

    // EI-20540454577146535: the SAME verified-timeout verdict, once WI-producer has
    // since closed, must stop recommending a takeover of it.
    await rootSql`INSERT INTO harness_shared.work_items (feature_id, status) VALUES ('WI-producer', 'done')`;
    expect(await listVerifiedWaitTakeoversForSubscribers(['waiter-died'])).toEqual([]);
  });

  it('slow-but-progressing producer: renews the same one-shot row without consuming it', async () => {
    const row = await registerDueVerifiedAwait('waiter-progress');
    const [claimed] = await claimDueVerifiedAwaits();
    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      snapshot: async () =>
        checkpointSnapshot({
          activeRun: { active: true, candidate: 'abc123', startedAtMs: 1_500, elapsedSec: 0.5 },
          greenCheckpoint: {
            name: 'green-checkpoint',
            active: true,
            cron: null,
            lastFiredAtMs: 1_500,
            nextFireAtMs: null,
            pause: null,
          },
        }),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'progressing', nextAction: 're-await' });

    const nextCertificate = certificate({
      issuedAtMs: observation.checkedAtMs,
      lastProgressAtMs: observation.lastProgressAtMs,
      verificationDeadlineMs: observation.checkedAtMs + 500,
    });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result, nextCertificate })).toBeNull();
    expect(await listActiveAwaitsForKey('release:green:papercusp')).toEqual([
      expect.objectContaining({
        id: row.id,
        firedAt: null,
        producerHealthCertificate: expect.objectContaining({ verificationDeadlineMs: 2_500 }),
        timeoutVerification: expect.objectContaining({ classification: 'progressing' }),
      }),
    ]);
  });

  it('latched completion: authoritative completion wins over a missing producer', async () => {
    const row = await registerDueVerifiedAwait('waiter-latched');
    const [claimed] = await claimDueVerifiedAwaits();
    const observation = await observeCheckpointProducer(claimed!.producerHealthCertificate!, {
      snapshot: async () =>
        checkpointSnapshot({
          recent: [
            {
              id: 'verdict-campaign',
              kind: 'green_checkpoint',
              createdAtMs: 1_950,
              status: 'advanced',
              detail: { candidate: 'abc123', runId: 'run-campaign' },
            },
          ],
        }),
    });
    const result = classifyVerifiedWaitTimeout(claimed!.producerHealthCertificate!, observation);
    expect(result).toMatchObject({ classification: 'already-complete', nextAction: 'resume' });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result })).toMatchObject({
      firedReason: 'verified-timeout',
      timeoutVerification: expect.objectContaining({ classification: 'already-complete' }),
    });
  });

  it('fallback takeover is race-safe: a pushed completion that wins first cannot be consumed twice', async () => {
    const row = await registerDueVerifiedAwait('waiter-race');
    expect((await fireAwaitsForKey({ eventKey: 'release:green:papercusp' })).map((awaited) => awaited.id)).toEqual([
      row.id,
    ]);
    expect(await claimDueVerifiedAwaits()).toEqual([]);

    const fallback = classifyVerifiedWaitTimeout(certificate(), {
      checkedAtMs: 2_000,
      producerPresent: false,
      lastProgressAtMs: null,
      lastFireAtMs: null,
      completedAtMs: null,
    });
    expect(await settleVerifiedAwaitTimeout({ id: row.id, result: fallback })).toBeNull();
    const persisted = await rootSql`
      SELECT fired_reason, timeout_verification
        FROM harness_shared.event_awaits
       WHERE id = ${row.id}
    `;
    expect(persisted[0]).toMatchObject({ fired_reason: 'event', timeout_verification: null });
  });
});

// ── EI-13705: the unconditional per-key fire latch (mig 632) ──────────────────
describe('recordKeyFire / getKeyFireLatch / inspectEventKey.fireLatch (PG)', () => {
  it('getKeyFireLatch is null for a key that has never fired', async () => {
    expect(await getKeyFireLatch('never:fired')).toBeNull();
  });

  it('recordKeyFire inserts a fresh latch row (fire_count=1) for a brand-new key', async () => {
    await recordKeyFire({ eventKey: 'p2p-git:phase3-open', firedBy: 'su-63834d42', payload: { sha: 'abc' } });
    const latch = await getKeyFireLatch('p2p-git:phase3-open');
    expect(latch).toMatchObject({ eventKey: 'p2p-git:phase3-open', lastFiredBy: 'su-63834d42', fireCount: 1 });
    expect(latch!.lastPayload).toEqual({ sha: 'abc' });
    expect(latch!.firstFiredAt).toEqual(latch!.lastFiredAt); // first fire: first == last
  });

  it('a second recordKeyFire on the SAME key upserts in place — increments fire_count, refreshes last_*, keeps first_fired_at', async () => {
    await recordKeyFire({ eventKey: 'k:repeat', firedBy: 'source-1', payload: { n: 1 } });
    const first = await getKeyFireLatch('k:repeat');
    await recordKeyFire({ eventKey: 'k:repeat', firedBy: 'source-2', payload: { n: 2 } });
    const second = await getKeyFireLatch('k:repeat');

    expect(await rootSql`SELECT 1 FROM harness_shared.event_key_fires WHERE event_key = 'k:repeat'`).toHaveLength(1); // ONE row, not two
    expect(second!.fireCount).toBe(2);
    expect(second!.lastFiredBy).toBe('source-2');
    expect(second!.lastPayload).toEqual({ n: 2 });
    expect(second!.firstFiredAt).toEqual(first!.firstFiredAt); // first_fired_at is never overwritten
  });

  it('recordKeyFire with no payload/firedBy stores nulls (an anonymous/payload-less emit still latches)', async () => {
    await recordKeyFire({ eventKey: 'k:bare' });
    const latch = await getKeyFireLatch('k:bare');
    expect(latch).toMatchObject({ eventKey: 'k:bare', lastFiredBy: null, lastPayload: null, fireCount: 1 });
  });

  it('inspectEventKey folds the fire latch in alongside announcements/waiters/deliveries', async () => {
    await recordKeyFire({ eventKey: 'k:inspect', firedBy: 'su-x' });
    const history = await inspectEventKey('k:inspect');
    expect(history.announcements).toEqual([]);
    expect(history.waiters).toEqual([]);
    expect(history.deliveries).toEqual([]);
    expect(history.fireLatch).toMatchObject({ eventKey: 'k:inspect', lastFiredBy: 'su-x', fireCount: 1 });
  });

  it('inspectEventKey.fireLatch is null for a key with waiters/deliveries but that was never routed through recordKeyFire (isolation — the latch is its own store, not derived)', async () => {
    await registerAwait({ subscriberId: 'sub-z', eventKey: 'k:no-latch' });
    const history = await inspectEventKey('k:no-latch');
    expect(history.waiters).toHaveLength(1);
    expect(history.fireLatch).toBeNull();
  });
});

describe('probeKeyFireEvidence (PG) — EI-18676056143796303, the emitter evidence behind the orphan guard', () => {
  it('keyFireEvidencePrefix takes the family (first two segments), and a short key probes itself', () => {
    expect(keyFireEvidencePrefix('coord:inbox-wake:su-abc-123')).toBe('coord:inbox-wake');
    expect(keyFireEvidencePrefix('plan-item:done:my-plan:P-004')).toBe('plan-item:done');
    expect(keyFireEvidencePrefix('work-item:claimable')).toBe('work-item:claimable');
    expect(keyFireEvidencePrefix('single')).toBe('single');
  });

  it('reports NO evidence for a key whose family has never fired — the genuine-orphan case still warns', async () => {
    const ev = await probeKeyFireEvidence('overwatch:surface-landed');
    expect(ev).toMatchObject({
      prefix: 'overwatch:surface-landed',
      exact: false,
      distinctKeys: 0,
      fires: 0,
      lastFiredAt: null,
    });
  });

  it('reports EXACT evidence when this very key has fired', async () => {
    await recordKeyFire({ eventKey: 'evidence:exact', firedBy: 'src' });
    await recordKeyFire({ eventKey: 'evidence:exact', firedBy: 'src' });
    const ev = await probeKeyFireEvidence('evidence:exact');
    expect(ev.exact).toBe(true);
    expect(ev.fires).toBe(2);
    expect(ev.distinctKeys).toBe(1);
    expect(ev.lastFiredAt).toBeTruthy();
  });

  it('reports SIBLING evidence for a never-before-seen key whose FAMILY fires — the coord:inbox-wake case', async () => {
    // A fresh agent's own inbox-wake key has no latch row of its own, but 118
    // sibling owner keys have fired thousands of times. That is what proves an
    // emitter exists, and what the orphan warning claimed did not.
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-one' });
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-two' });
    await recordKeyFire({ eventKey: 'coord:inbox-wake:su-two' });
    const ev = await probeKeyFireEvidence('coord:inbox-wake:su-brand-new');
    expect(ev.exact).toBe(false);
    expect(ev.distinctKeys).toBe(2);
    expect(ev.fires).toBe(3);
    expect(ev.prefix).toBe('coord:inbox-wake');
  });

  it('does NOT leak across families — a neighbouring prefix is not evidence', async () => {
    await recordKeyFire({ eventKey: 'neighbour:alpha:1' });
    // `neighbour:beta` must not be credited with `neighbour:alpha`'s fires…
    expect((await probeKeyFireEvidence('neighbour:beta:1')).fires).toBe(0);
    // …and a prefix must match on a ':' boundary, not a bare startsWith.
    await recordKeyFire({ eventKey: 'neigh:alphabet' });
    expect((await probeKeyFireEvidence('neigh:alpha:9')).fires).toBe(0);
  });

  it('treats LIKE wildcards in a key as literals (a `%` key cannot widen the scan)', async () => {
    await recordKeyFire({ eventKey: 'wild:other:x' });
    expect((await probeKeyFireEvidence('wild:%:y')).fires).toBe(0);
    expect((await probeKeyFireEvidence('wild:_ther:y')).fires).toBe(0);
  });
});

describe('probePatternMatchScope (PG) — EI-19332682533219755, the cross-pipeline glob disclosure', () => {
  it('REPRODUCES THE INCIDENT: release:green:* spans co-hosted pipelines, and names the foreign one', async () => {
    // The real latch on this host at the time of filing: papercusp's own gate key
    // plus three other projects sharing the box. An agent armed `release:green:*`
    // meaning "MY gate", and woke on oddsmith's verdict — satisfied:true, carrying
    // a sha that is not even an object in this repository.
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    await recordKeyFire({ eventKey: 'release:green:oddsmith' });
    await recordKeyFire({ eventKey: 'release:green:hello-world-3' });

    const scope = await probePatternMatchScope('release:green:*');

    expect(scope.prefix).toBe('release:green');
    expect(scope.matchedKeys).toHaveLength(3);
    expect(scope.matchedKeys).toEqual(
      expect.arrayContaining(['release:green:papercusp', 'release:green:oddsmith', 'release:green:hello-world-3']),
    );
    expect(scope.truncated).toBe(false);
  });

  it('does NOT match the BARE family key — `release:green:*` requires a pipeline segment', async () => {
    // The emitter fires BOTH the global `release:green` and the scoped form, so a
    // probe that swept the bare key into the match set would over-report by one on
    // every host and make a single-pipeline box look cross-scoped.
    await recordKeyFire({ eventKey: 'release:green' });
    await recordKeyFire({ eventKey: 'release:green:papercusp' });

    const scope = await probePatternMatchScope('release:green:*');
    expect(scope.matchedKeys).toEqual(['release:green:papercusp']);
  });

  it('narrows with the REAL matcher, not just the prefix scan — a mid-key glob excludes non-matches', async () => {
    await recordKeyFire({ eventKey: 'fleet:drained:red' });
    await recordKeyFire({ eventKey: 'fleet:member-dead:red' });
    await recordKeyFire({ eventKey: 'fleet:drained:blue' });

    const scope = await probePatternMatchScope('fleet:*:red');
    // The prefix scan can only anchor on 'fleet', so blue is read and then REJECTED
    // by keyMatchesPattern — proving the two stages compose.
    expect(scope.prefix).toBe('fleet');
    expect(scope.matchedKeys.sort()).toEqual(['fleet:drained:red', 'fleet:member-dead:red']);
  });

  it('returns nothing for an EXACT key — the recommended fix must never warn about itself', async () => {
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    const scope = await probePatternMatchScope('release:green:papercusp');
    expect(scope.matchedKeys).toEqual([]);
  });

  it('bounds a wildcard-led glob instead of scanning the whole table unanchored', async () => {
    await recordKeyFire({ eventKey: 'release:green:papercusp' });
    await recordKeyFire({ eventKey: 'other:family:papercusp' });
    const scope = await probePatternMatchScope('*:papercusp');
    // No anchorable prefix, so the scan is recency-bounded — but the matcher still
    // decides membership, so both genuinely-matching keys are reported.
    expect(scope.prefix).toBe('');
    expect(scope.matchedKeys.sort()).toEqual(['other:family:papercusp', 'release:green:papercusp']);
  });

  it('flags a capped scan as truncated so the caller reads the count as a floor', async () => {
    await recordKeyFire({ eventKey: 'many:key:a' });
    await recordKeyFire({ eventKey: 'many:key:b' });
    await recordKeyFire({ eventKey: 'many:key:c' });
    const scope = await probePatternMatchScope('many:key:*', { limit: 2 });
    expect(scope.truncated).toBe(true);
    expect(scope.matchedKeys.length).toBeLessThanOrEqual(2);
  });
});
