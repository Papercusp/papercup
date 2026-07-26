/**
 * messages-replied.integration.test.ts — `repliedMsgIdsBatch` against REAL Postgres
 * (baseline-schema DB): the reply-linkage leg of EI-18676763837940562
 * (redundant-inbox-wake-suppression, follow-up to EI-18673058981655804).
 *
 * Mirrors messages-acked.integration.test.ts's fixture/shape exactly (same table,
 * same `body->>'from'`/`related_msg_id` JSONB predicates) — the ONE part a hermetic
 * unit test (engine.test.ts mocks this function entirely) cannot exercise: the real
 * `= ANY($ids)` array-bound SQL path against Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage, repliedMsgIdsBatch } from './messages';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const ALICE = ident('replied-alice');
const BOB = ident('replied-bob');

/** Alice sends Bob a message; Bob replies (a plain coord message with related_msg_id
 *  set, NOT an ack — the general reply-linkage case). Returns Alice's original msg_id. */
async function sendAndReply(from: AgentIdentity, replier: AgentIdentity, summary = 'reply me'): Promise<string> {
  const env = await sendMessage(from, { to: [replier.ownerId], summary });
  await sendMessage(replier, { to: [from.ownerId], summary: 'ack — handled', related_msg_id: env.msg_id });
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

describe('repliedMsgIdsBatch (EI-18676763837940562 SQL path)', () => {
  it('returns the msg_ids the subscriber ALREADY REPLIED to', async () => {
    const m1 = await sendAndReply(ALICE, BOB);
    const m2 = await sendAndReply(ALICE, BOB);

    const replied = await repliedMsgIdsBatch(BOB.ownerId, [m1, m2]);
    expect(replied.has(m1)).toBe(true);
    expect(replied.has(m2)).toBe(true);
    expect(replied.size).toBe(2);
  });

  it('does not return a msg_id the subscriber only RECEIVED but never replied to', async () => {
    const unreplied = (await sendMessage(ALICE, { to: [BOB.ownerId], summary: 'no reply' })).msg_id;
    const replied = await sendAndReply(ALICE, BOB);

    const set = await repliedMsgIdsBatch(BOB.ownerId, [replied, unreplied]);
    expect(set.has(replied)).toBe(true);
    expect(set.has(unreplied)).toBe(false);
  });

  it('is bounded to the given msgIds — a reply outside the requested batch is not returned', async () => {
    const inBatch = await sendAndReply(ALICE, BOB);
    const outOfBatch = await sendAndReply(ALICE, BOB);

    const set = await repliedMsgIdsBatch(BOB.ownerId, [inBatch]);
    expect(set.has(inBatch)).toBe(true);
    expect(set.has(outOfBatch)).toBe(false);
    expect(set.size).toBe(1);
  });

  it('SCOPES to the subscriber — one principal never sees another principal\'s reply', async () => {
    // Bob replies to Alice's message; Alice must not see Bob's reply as her own.
    const bobReplied = await sendAndReply(ALICE, BOB);
    // Alice replies to a different message from Bob.
    const aliceReplied = await sendAndReply(BOB, ALICE);

    const aliceSet = await repliedMsgIdsBatch(ALICE.ownerId, [bobReplied, aliceReplied]);
    const bobSet = await repliedMsgIdsBatch(BOB.ownerId, [bobReplied, aliceReplied]);

    expect(aliceSet.has(aliceReplied)).toBe(true);
    expect(aliceSet.has(bobReplied)).toBe(false);
    expect(bobSet.has(bobReplied)).toBe(true);
    expect(bobSet.has(aliceReplied)).toBe(false);
  });

  it('returns an empty set for an empty owner id or an empty msgIds list', async () => {
    const replied = await sendAndReply(ALICE, BOB);
    expect((await repliedMsgIdsBatch('', [replied])).size).toBe(0);
    expect((await repliedMsgIdsBatch(BOB.ownerId, [])).size).toBe(0);
  });
});
