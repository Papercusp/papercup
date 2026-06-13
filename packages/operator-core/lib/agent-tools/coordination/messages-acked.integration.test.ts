/**
 * messages-acked.integration.test.ts — `readAckedMsgIds` against REAL Postgres
 * (baseline-schema DB), the missing coverage for the EI-401 fix.
 *
 * EI-401 (coord probe-pair canary breached its SLO): `readAckedMsgIds` used to
 * load the ENTIRE `messages` surface through `coordLog.readLines` and filter the
 * acks in JavaScript — O(all messages ever sent), parsing thousands of (often
 * TOASTed) envelopes per call. The fix pushes the filter into Postgres
 * (`WHERE body->>'kind'='ack' AND body->>'from'=?`), returning only the acker's
 * own ack rows' `related_msg_id`. The peer who shipped the fix left no test, so
 * the SQL path — the part the unit-tier fallback never exercises — was unproven.
 *
 * This drives the real query through the module's own `getOrgPg()` handle (the
 * fixture re-points it at the baseline DB), seeding via the real `sendMessage` /
 * `appendAck` adapters so the stored envelope shape is exactly production's.
 * It asserts the two contracts that matter:
 *   • the acker's own acks come back, keyed by `related_msg_id`;
 *   • SCOPING — one principal's acks never leak into another's set (the
 *     `body->>'from' = ackerOwnerId` predicate is the visibility-suppression
 *     guard documented on the function).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage, appendAck, readAckedMsgIds } from './messages';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const ALICE = ident('acked-alice');
const BOB = ident('acked-bob');

/** Alice sends Bob a message; Bob acks it. Returns the acked msg_id. */
async function sendAndAck(from: AgentIdentity, acker: AgentIdentity): Promise<string> {
  const env = await sendMessage(from, { to: [acker.ownerId], summary: 'ack me' });
  await appendAck(acker, env.msg_id, from.ownerId);
  return env.msg_id;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
});

describe('readAckedMsgIds (EI-401 SQL path)', () => {
  it('returns the msg_ids the acker acknowledged', async () => {
    const m1 = await sendAndAck(ALICE, BOB);
    const m2 = await sendAndAck(ALICE, BOB);

    const acked = await readAckedMsgIds(BOB.ownerId);
    expect(acked.has(m1)).toBe(true);
    expect(acked.has(m2)).toBe(true);
    expect(acked.size).toBe(2);
  });

  it('does not return msg_ids the acker only RECEIVED but never acked', async () => {
    // Alice sends Bob a message but Bob never acks it.
    const unacked = (await sendMessage(ALICE, { to: [BOB.ownerId], summary: 'no ack' })).msg_id;
    const acked = await sendAndAck(ALICE, BOB);

    const set = await readAckedMsgIds(BOB.ownerId);
    expect(set.has(acked)).toBe(true);
    expect(set.has(unacked)).toBe(false);
  });

  it('SCOPES to the acker — one principal never sees another principal acks', async () => {
    // Bob acks a message from Alice; Alice must NOT see Bob's ack as her own.
    const bobAcked = await sendAndAck(ALICE, BOB);
    // Alice acks a different message from Bob.
    const aliceAcked = await sendAndAck(BOB, ALICE);

    const aliceSet = await readAckedMsgIds(ALICE.ownerId);
    const bobSet = await readAckedMsgIds(BOB.ownerId);

    expect(aliceSet.has(aliceAcked)).toBe(true);
    expect(aliceSet.has(bobAcked)).toBe(false);
    expect(bobSet.has(bobAcked)).toBe(true);
    expect(bobSet.has(aliceAcked)).toBe(false);
  });

  it('returns an empty set for an empty owner id', async () => {
    await sendAndAck(ALICE, BOB);
    const set = await readAckedMsgIds('');
    expect(set.size).toBe(0);
  });
});
