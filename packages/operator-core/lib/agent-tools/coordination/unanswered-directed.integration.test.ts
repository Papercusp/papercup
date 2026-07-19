/**
 * unanswered-directed.integration.test.ts — `fetchUnansweredDirected` against
 * REAL Postgres (baseline-schema DB), covering EI-13819.
 *
 * EI-13819: a leader sent a lane offer with expectsReply:true; the member did
 * the work, then replied with a FRESH "DONE, standing down" message (no
 * `related_msg_id`) followed by a separate `related_msg_id`-carrying ack of
 * the leader's own later closing message — a completely normal exchange, but
 * NEITHER reply pointed at the ORIGINAL lane-offer msg_id, so the strict
 * exact-thread check (`related_msg_id = the ask's msg_id`) left it
 * "unanswered" forever. The pure fold (unanswered-directed.test.ts) never
 * exercised the SQL's "answered" NOT EXISTS clause at all — this drives the
 * real query through `sendMessage` so the stored envelope shape matches
 * production exactly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage } from './messages';
import { fetchUnansweredDirected } from './unanswered-directed';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const LEADER = ident('unans-leader');
const MEMBER = ident('unans-member');
const OTHER = ident('unans-other');

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

describe('fetchUnansweredDirected (EI-13819 SQL path)', () => {
  it('a directed expectsReply message with NO reply at all is unanswered', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('an EXACT threaded reply (related_msg_id = the ask) clears it (existing behavior)', async () => {
    const ask = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'done', related_msg_id: ask.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('EI-13819: a reply-shaped message threaded onto something ELSE in the same correspondence, sent after the ask, also clears it', async () => {
    const ask = await sendMessage(LEADER, {
      to: [MEMBER.ownerId],
      summary: 'New URGENT lane P-012: GREEN THE GATE — claim and drive',
      expectsReply: true,
    });
    // The leader later sends an unrelated follow-up (not itself a reply).
    const closing = await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'CLOSED by leader, drop your awaits' });
    // The member never threads back onto `ask` directly — it sends a fresh
    // "DONE" status update (no related_msg_id) …
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'DONE: gate green, standing down', expectsReply: true });
    // … then acks the leader's closing message instead.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'Ack — closure confirmed', related_msg_id: closing.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
    void ask;
  });

  it('a reply-shaped message to a DIFFERENT sender does not clear an unrelated ask (scoping preserved)', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    // Member replies to OTHER, not to LEADER — must not clear LEADER's ask.
    const otherAsk = await sendMessage(OTHER, { to: [MEMBER.ownerId], summary: 'unrelated question' });
    await sendMessage(MEMBER, { to: [OTHER.ownerId], summary: 'unrelated reply', related_msg_id: otherAsk.msg_id });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });

  it('WI-5345: a bare unthreaded status update back to the sender (no related_msg_id) DOES clear it', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });
    // A fresh, un-threaded message back to the sender is not "reply-shaped"
    // in the EI-13819 sense (no related_msg_id at all) but IS still a real,
    // directed reply from the recipient to the original asker — the common
    // case this fleet's agents actually produce, per WI-5345.
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'still working on other things' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('WI-5345: several standalone genuine-status replies (no related_msg_id) after multiple separate asks all clear the count', async () => {
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 1', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: still on P-012, tests green so far' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 2', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: P-012 done, moving to P-013' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'liveness check 3', expectsReply: true });
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'status: P-013 claimed, investigating repro' });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)).toBeUndefined();
  });

  it('a reply-shaped message sent BEFORE the ask does not clear it (chronology enforced)', async () => {
    await sendMessage(MEMBER, { to: [LEADER.ownerId], summary: 'earlier unrelated reply', related_msg_id: 'some-earlier-thread' });
    await sendMessage(LEADER, { to: [MEMBER.ownerId], summary: 'please claim P-012', expectsReply: true });

    const map = await fetchUnansweredDirected([MEMBER.ownerId]);
    expect(map.get(MEMBER.ownerId)?.count).toBe(1);
  });
});
