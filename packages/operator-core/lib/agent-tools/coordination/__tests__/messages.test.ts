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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

// Mock the PG-backed audience-host so a `@plan:`/`@topic:` selector expands
// through the REAL pure `expandAudience` (../audience) but against in-memory
// resolvers — no getOrgPg() / listPresence(). An unknown plan/topic has no
// subscribers and no active presence → resolves to [] (the zero-recipient case
// P2-15 exercises). audienceMode stays 'scoped' so selectors are honoured, not
// collapsed to broadcast.
vi.mock('../audience-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audience-host')>();
  return {
    ...actual, // keep the real, pure deriveAudienceKey / canonicalizeAudienceSelector
    hostAudienceResolvers: {
      listTargetSubscribers: async () => [],
      listActivePresence: async () => [],
      listTaggedTopics: async () => [],
      listFleetMembers: async () => [],
      listFleetLeader: async () => [],
    },
    audienceMode: () => 'scoped' as const,
  };
});

// WI-3653: controllable federation-scope resolver — sendMessage's AUTO stamp
// (undefined harnessSlug → resolve the workspace's single shared hive) must
// never reach PG in these in-memory tests. Default: no shared hive → the stamp
// stays off and every pre-WI-3653 test sees byte-identical envelopes.
const hiveScope = vi.hoisted(() => ({
  resolve: (async () => ({ kind: 'none' })) as (ws: string) => Promise<unknown>,
}));
vi.mock('../federation-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../federation-scope')>();
  return {
    ...actual,
    resolveWorkspaceHiveScope: (ws: string) => hiveScope.resolve(ws),
  };
});

import { configureCoordLog, resetCoordLog, coordLog } from '../log';
import { appendAck, readInbox, readOutbox, readThread, sendMessage } from '../messages';
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

describe('readOutbox (bee-dossier pane)', () => {
  it('returns everything an owner SENT, regardless of recipient', async () => {
    const A = fakeIdentity('A');
    const B = fakeIdentity('B');
    await sendMessage(A, { to: ['B'], summary: 'a→b' });
    await sendMessage(A, { to: ['*'], summary: 'a→all' });
    await sendMessage(B, { to: ['A'], summary: 'b→a' }); // not A's outbox

    const outboxA = await readOutbox('A');
    expect(outboxA.map((m) => m.summary)).toEqual(['a→b', 'a→all']);
    expect(outboxA.every((m) => m.from === 'A')).toBe(true);
  });

  it('since_ts filters the outbox strictly later than the cutoff', async () => {
    const A = fakeIdentity('A');
    const first = await sendMessage(A, { to: ['B'], summary: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    await sendMessage(A, { to: ['B'], summary: 'new' });
    const after = await readOutbox('A', { since_ts: first.ts });
    expect(after.map((m) => m.summary)).toEqual(['new']);
  });

  it('no sent messages → empty outbox', async () => {
    expect(await readOutbox('nobody')).toEqual([]);
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

describe('sendMessage zero-recipient — selector that expands to nobody (P2-15)', () => {
  it('a @plan: selector with no watchers persists the row as delivered-to-0, NOT a broadcast', async () => {
    const A = fakeIdentity('A');
    // @plan:no-such-plan has no subscribers and no active presence (mocked
    // resolvers) → expandAudience returns [] → envelope.to is [].
    const sent = await sendMessage(A, { to: ['@plan:no-such-plan'], summary: 'orphan' });

    // The envelope is delivered to NOBODY (to:[]) — and crucially NOT collapsed
    // to ['*']: a typo'd/empty audience must never fan out to everyone (audience
    // D-004 — distinguishes "delivered to 0" from a broadcast).
    expect(sent.to).toEqual([]);
    expect(sent.summary).toBe('orphan');

    // No error: a zero-recipient send is a valid no-op delivery, not a failure.
    // (sendMessage resolved a CoordEnvelope without throwing.)
    expect(sent.kind).toBe('message');

    // The coord-log row STILL exists (D-004: an audience that resolves to nobody
    // still persists the row) — the raw message surface carries it.
    const rawLines = await coordLog.readLines('messages');
    const persisted = rawLines.find((l) => l.msg_id === sent.msg_id);
    expect(persisted).toBeDefined();
    expect(persisted?.to).toEqual([]);

    // No inbox delivery anywhere — no concrete owner was addressed.
    expect(await readInbox('B')).toEqual([]);
    expect(await readInbox('*')).toEqual([]);

    // ...but the SENDER's outbox includes it (from === A), so it isn't lost.
    const outboxA = await readOutbox('A');
    expect(outboxA.map((m) => m.msg_id)).toContain(sent.msg_id);
  });
});

describe('appendAck double-ack — dedup-or-not contract (P3-16)', () => {
  it('acking the same message twice appends TWO ack records (append-only, no dedup)', async () => {
    const A = fakeIdentity('A');
    const Bob = fakeIdentity('Bob');
    const m = await sendMessage(A, { to: ['Bob'], summary: 'please ack' });

    const ack1 = await appendAck(Bob, m.msg_id, A.ownerId);
    const ack2 = await appendAck(Bob, m.msg_id, A.ownerId);

    // appendAck is NOT idempotent: each call appends a distinct ack envelope —
    // there is no read-fold collapsing duplicate acks the way handoffs/escalations
    // collapse their resolutions, so the contract here is two raw records.
    expect(ack1.msg_id).not.toBe(ack2.msg_id);
    expect(ack1.kind).toBe('ack');
    expect(ack2.kind).toBe('ack');

    // The thread rooted at the original message carries BOTH acks alongside it.
    const thread = await readThread(m.msg_id);
    const acks = thread.filter((t) => t.kind === 'ack' && t.related_msg_id === m.msg_id);
    expect(acks).toHaveLength(2);
    expect(acks.map((a) => a.msg_id).sort()).toEqual([ack1.msg_id, ack2.msg_id].sort());

    // The sender's inbox render also surfaces both ack envelopes (no inbox-side
    // dedup) — pinning that the double-ack is visible, not silently swallowed.
    const inboxA = await readInbox('A');
    expect(inboxA.filter((x) => x.kind === 'ack')).toHaveLength(2);
  });
});

describe('sendMessage federation auto-stamp (WI-3653)', () => {
  afterEach(() => {
    hiveScope.resolve = async () => ({ kind: 'none' });
  });

  it('undefined harnessSlug + exactly one shared hive → stamps the hive home', async () => {
    hiveScope.resolve = async () => ({ kind: 'one', homeSlug: 'my-hive-home' });
    const env = await sendMessage(fakeIdentity('A'), { to: ['B'], summary: 'hi' });
    expect(env.harness_slug).toBe('my-hive-home');
  });

  it('explicit string harnessSlug wins verbatim — resolver never consulted', async () => {
    hiveScope.resolve = async () => {
      throw new Error('resolver must not be called for an explicit slug');
    };
    const env = await sendMessage(fakeIdentity('A'), {
      to: ['B'],
      summary: 'hi',
      harnessSlug: 'scoped-h',
    });
    expect(env.harness_slug).toBe('scoped-h');
  });

  it("null harnessSlug (scope:'local') is NEVER auto-stamped, even with a hive", async () => {
    hiveScope.resolve = async () => ({ kind: 'one', homeSlug: 'my-hive-home' });
    const env = await sendMessage(fakeIdentity('A'), {
      to: ['B'],
      summary: 'hi',
      harnessSlug: null,
    });
    expect(env.harness_slug).toBeUndefined();
  });

  it('no / ambiguous shared hive → machine-local (no stamp)', async () => {
    hiveScope.resolve = async () => ({ kind: 'many', candidates: ['a', 'b'] });
    const env = await sendMessage(fakeIdentity('A'), { to: ['B'], summary: 'hi' });
    expect(env.harness_slug).toBeUndefined();
  });

  it('resolver throw is fail-soft: send still lands, unstamped', async () => {
    hiveScope.resolve = async () => {
      throw new Error('pg down');
    };
    const env = await sendMessage(fakeIdentity('A'), { to: ['B'], summary: 'hi' });
    expect(env.harness_slug).toBeUndefined();
    const inboxB = await readInbox('B');
    expect(inboxB.some((m) => m.msg_id === env.msg_id)).toBe(true);
  });
});
