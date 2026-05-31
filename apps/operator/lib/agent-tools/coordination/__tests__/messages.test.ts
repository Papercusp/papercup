/**
 * Operator-level tests for the coordination message channel
 * (sendMessage / readInbox / appendAck / readThread).
 *
 * These exercise the real inbox-fold + thread-traversal logic against an
 * in-memory CoordEventLog double — NO Postgres, NO live
 * `harness_shared.coord_event_log`. (The PG backend itself is covered by the
 * package's event-log conformance suite, run against PgCoordLog in
 * `event-log-conformance.test.ts`.) Earlier this file claimed "pure
 * filesystem, no PG" and set PAPERCUSP_COORD_DIR, but after the FS→PG cutover
 * the channel modules route through `coordLog` (PgCoordLog), which ignored
 * that env — so the tests wrote into and read from the live coord table.
 * Injecting `InMemoryCoordLog` via the `configureCoordLog` seam is the fix.
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/messages.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

import { configureCoordLog, resetCoordLog } from '../log';
import { appendAck, readInbox, readThread, sendMessage } from '../messages';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'omp-hook-session',
    workspaceId: 'default',
    userId: null,
  };
}

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
});
afterEach(() => {
  resetCoordLog();
});

describe('sendMessage / readInbox', () => {
  it('one-to-one: receiver sees the message, sender does not', async () => {
    const A = fakeIdentity('A');
    const sent = await sendMessage(A, { to: ['B'], summary: 'hello B' });
    expect(sent.kind).toBe('message');
    const inboxB = await readInbox('B');
    expect(inboxB.map((m) => m.summary)).toEqual(['hello B']);
    const inboxA = await readInbox('A');
    expect(inboxA).toEqual([]); // excludeOwn = true default
  });

  it('broadcast (to:["*"]) reaches everyone except (by default) the sender', async () => {
    const A = fakeIdentity('A');
    await sendMessage(A, { to: ['*'], summary: 'all hands' });
    const inboxB = await readInbox('B');
    const inboxC = await readInbox('C');
    expect(inboxB).toHaveLength(1);
    expect(inboxC).toHaveLength(1);
    expect(await readInbox('A')).toEqual([]);
  });

  it('since_ts filters strictly later than the cutoff', async () => {
    const A = fakeIdentity('A');
    const first = await sendMessage(A, { to: ['B'], summary: 'old' });
    // Ensure the next ts is strictly later than `first.ts`.
    await new Promise((r) => setTimeout(r, 5));
    await sendMessage(A, { to: ['B'], summary: 'new' });
    const after = await readInbox('B', { since_ts: first.ts });
    expect(after.map((m) => m.summary)).toEqual(['new']);
  });

  it('kinds filter narrows by entry kind', async () => {
    const A = fakeIdentity('A');
    await sendMessage(A, { to: ['B'], summary: 'plain', kind: 'message' });
    await sendMessage(A, { to: ['B'], summary: 'notify!', kind: 'notify' });
    const onlyNotify = await readInbox('B', { kinds: ['notify'] });
    expect(onlyNotify.map((m) => m.summary)).toEqual(['notify!']);
  });

  it('missing messages dir → empty inbox', async () => {
    expect(await readInbox('B')).toEqual([]);
  });
});

describe('appendAck + readThread', () => {
  it('ack lives in the acker outbox and is reachable from the original via thread traversal', async () => {
    const A = fakeIdentity('A');
    const B = fakeIdentity('B');
    const m = await sendMessage(A, { to: ['B'], summary: 'please ack' });
    const ack = await appendAck(B, m.msg_id, A.ownerId);
    expect(ack.kind).toBe('ack');
    expect(ack.related_msg_id).toBe(m.msg_id);

    const thread = await readThread(m.msg_id);
    expect(thread.map((t) => t.msg_id)).toEqual([m.msg_id, ack.msg_id]);

    // The sender's inbox should now contain the ack.
    const inboxA = await readInbox('A');
    expect(inboxA.map((x) => x.kind)).toEqual(['ack']);
  });

  it('readThread walks chains transitively', async () => {
    const A = fakeIdentity('A');
    const B = fakeIdentity('B');
    const root = await sendMessage(A, { to: ['B'], summary: 'q' });
    const reply = await sendMessage(B, {
      to: ['A'],
      summary: 'a',
      related_msg_id: root.msg_id,
    });
    const ack = await appendAck(A, reply.msg_id, B.ownerId);
    const thread = await readThread(root.msg_id);
    expect(thread.map((t) => t.msg_id)).toEqual([
      root.msg_id,
      reply.msg_id,
      ack.msg_id,
    ]);
  });
});
