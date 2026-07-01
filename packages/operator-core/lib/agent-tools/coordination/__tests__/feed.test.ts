/**
 * coord:feed — the cross-channel coordination firehose read seam.
 *
 * Exercises readCoordFeed against an in-memory CoordEventLog double (NO
 * Postgres, NO live coord table — same posture as messages.test.ts). Covers the
 * union across all four surfaces (messages / escalations / handoffs /
 * plan-events), every kind including broadcast + notify, the owner/kind/plan/
 * free-text filters, the time-window bounds, and cursor pagination.
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/feed.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the PG-backed audience RESOLVERS (so a selector send doesn't reach
// getOrgPg in this in-memory unit test) — keep the REAL deriveAudienceKey /
// canonicalizeAudienceSelector (pure) that messages.ts uses to preserve the
// audience key on the envelope, which is exactly what these tests exercise.
vi.mock('../audience-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audience-host')>();
  return {
    ...actual,
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

// sendMessage fires the fleet digest sidecar for @fleet: sends; stub it so seeding a
// fleet broadcast here doesn't reach getOrgPg (its behavior lives in fleet-delivery.test.ts).
vi.mock('../fleet-delivery', () => ({ deliverFleetDigests: async () => 0 }));

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

import { configureCoordLog, resetCoordLog } from '../log';
import { sendMessage, appendAck } from '../messages';
import { openEscalation, resolveEscalation } from '../escalations';
import { openHandoff, acceptHandoff } from '../handoffs';
import { emitPlanEvent } from '../plan-events';
import { readCoordFeed } from '../feed';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId: 'default', userId: null };
}
const A = fakeIdentity('A');
const B = fakeIdentity('B');
const wait = () => new Promise((r) => setTimeout(r, 4));

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
});
afterEach(() => {
  resetCoordLog();
});

/** Populate one of every surface + kind, in ascending time order. */
async function seedAllKinds() {
  const msg = await sendMessage(A, { to: ['B'], summary: 'direct hello' });
  await wait();
  await appendAck(B, msg.msg_id, A.ownerId); // ack, related to msg
  await wait();
  await sendMessage(A, { to: ['*'], summary: 'all hands broadcast' }); // broadcast message
  await wait();
  await sendMessage(A, { to: ['B'], summary: 'ping', kind: 'notify' }); // notify
  await wait();
  const ho = await openHandoff(A, { to: ['B'], plan_slug: 'plan-x', summary: 'take this over' });
  await wait();
  await acceptHandoff(B, ho.msg_id); // handoff_accepted
  await wait();
  const esc = await openEscalation(A, { severity: 'blocker', summary: 'need a human call', plan_slug: 'plan-x' });
  await wait();
  await resolveEscalation({ msg_id: esc.msg_id, choice: 'approved', resolver: 'human' }); // escalation_resolved
  await wait();
  await emitPlanEvent({ planSlug: 'plan-x', event: 'status_changed', identity: A, detail: 'started' }); // plan_event
  return { msg, ho, esc };
}

describe('readCoordFeed — union + kind coverage', () => {
  it('returns every kind across all four surfaces, newest-first', async () => {
    await seedAllKinds();
    const { rows, total } = await readCoordFeed({ limit: 100 });

    const kinds = rows.map((r) => r.kind);
    // All distinct kinds present.
    expect(new Set(kinds)).toEqual(
      new Set(['message', 'ack', 'notify', 'handoff', 'handoff_accepted', 'escalation', 'escalation_resolved', 'plan_event']),
    );
    // 9 envelopes total (2 messages + ack + notify + handoff + accept + esc + resolve + plan_event).
    expect(total).toBe(9);
    expect(rows).toHaveLength(9);

    // Newest-first: ts descending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.ts >= rows[i]!.ts).toBe(true);
    }

    // Every surface represented.
    expect(new Set(rows.map((r) => r.surface))).toEqual(
      new Set(['messages', 'escalations', 'handoffs', 'plan-events']),
    );
  });

  it('marks broadcasts (to:["*"]) with the broadcast flag', async () => {
    await seedAllKinds();
    const { rows } = await readCoordFeed({ limit: 100 });
    const bc = rows.filter((r) => r.broadcast);
    // The all-hands message + the plan_event (emitted to ['*']) are broadcasts.
    expect(bc.map((r) => r.summary ?? r.event).sort()).toContain('all hands broadcast');
    expect(rows.find((r) => r.summary === 'all hands broadcast')!.broadcast).toBe(true);
    expect(rows.find((r) => r.summary === 'direct hello')!.broadcast).toBe(false);
  });

  it('exposes a kind histogram over the whole filtered set', async () => {
    await seedAllKinds();
    const { byKind } = await readCoordFeed({ limit: 100 });
    expect(byKind.message).toBe(2); // direct + broadcast
    expect(byKind.notify).toBe(1);
    expect(byKind.handoff).toBe(1);
    expect(byKind.escalation).toBe(1);
    expect(byKind.plan_event).toBe(1);
  });
});

describe('readCoordFeed — filtering', () => {
  it('kinds filter narrows to the requested kinds', async () => {
    await seedAllKinds();
    const { rows } = await readCoordFeed({ kinds: ['notify', 'escalation'], limit: 100 });
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['notify', 'escalation']));
  });

  it('owner filter matches sender OR recipient (and broadcasts match anyone)', async () => {
    await seedAllKinds();
    // C is never a direct party, but the broadcast (to:['*']) reaches C.
    const { rows } = await readCoordFeed({ owner: 'C', limit: 100 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.broadcast || r.from === 'C' || (r.to ?? []).includes('C'))).toBe(true);
    // The direct A→B message must NOT appear for C.
    expect(rows.find((r) => r.summary === 'direct hello')).toBeUndefined();

    // B is a direct recipient of the direct message + notify + handoff.
    const forB = await readCoordFeed({ owner: 'B', limit: 100 });
    expect(forB.rows.find((r) => r.summary === 'direct hello')).toBeDefined();
  });

  it('plan_slug filter restricts to one plan', async () => {
    await seedAllKinds();
    const { rows } = await readCoordFeed({ plan_slug: 'plan-x', limit: 100 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.plan_slug === 'plan-x')).toBe(true);
    // handoff + its acceptance, the open escalation, and the plan_event all carry
    // plan-x. (The escalation_resolved sibling does NOT copy plan_slug — it's
    // addressed back to the opener — so it's excluded by the plan filter.)
    expect(new Set(rows.map((r) => r.kind))).toEqual(
      new Set(['handoff', 'handoff_accepted', 'escalation', 'plan_event']),
    );
  });

  it('free-text q matches over summary/body/from/to', async () => {
    await seedAllKinds();
    const { rows } = await readCoordFeed({ q: 'all hands', limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('all hands broadcast');

    // Case-insensitive.
    const ci = await readCoordFeed({ q: 'HUMAN', limit: 100 });
    expect(ci.rows.some((r) => r.kind === 'escalation')).toBe(true);
  });

  it('since_ts / before_ts bound the time window (both strict)', async () => {
    const { msg } = await seedAllKinds();
    // since_ts = the first message's ts → excludes it, keeps everything later.
    const after = await readCoordFeed({ since_ts: msg.ts, limit: 100 });
    expect(after.rows.find((r) => r.msg_id === msg.msg_id)).toBeUndefined();
    expect(after.total).toBe(8);

    // before_ts = the first message's ts → keeps nothing earlier (it's the oldest).
    const before = await readCoordFeed({ before_ts: msg.ts, limit: 100 });
    expect(before.total).toBe(0);
  });
});

describe('readCoordFeed — pagination', () => {
  it('caps to limit and returns a cursor; the cursor fetches the older page', async () => {
    // 12 broadcast messages, ascending.
    for (let i = 0; i < 12; i++) {
      await sendMessage(A, { to: ['*'], summary: `m${i}` });
      await wait();
    }
    const page1 = await readCoordFeed({ limit: 5 });
    expect(page1.rows).toHaveLength(5);
    expect(page1.total).toBe(12);
    expect(page1.nextCursor).not.toBeNull();
    // Newest 5: m11..m7.
    expect(page1.rows.map((r) => r.summary)).toEqual(['m11', 'm10', 'm9', 'm8', 'm7']);

    const page2 = await readCoordFeed({ limit: 5, before_ts: page1.nextCursor! });
    // The next-older 5: m6..m2.
    expect(page2.rows.map((r) => r.summary)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await readCoordFeed({ limit: 5, before_ts: page2.nextCursor! });
    // The last 2: m1, m0 — stream exhausted, no cursor.
    expect(page3.rows.map((r) => r.summary)).toEqual(['m1', 'm0']);
    expect(page3.nextCursor).toBeNull();
  });

  it('limit is clamped to [1, MAX]', async () => {
    for (let i = 0; i < 3; i++) await sendMessage(A, { to: ['*'], summary: `x${i}` });
    const over = await readCoordFeed({ limit: 99999 });
    expect(over.rows).toHaveLength(3); // not an error; just returns all 3
    const zero = await readCoordFeed({ limit: 0 as unknown as number });
    expect(zero.rows.length).toBeGreaterThanOrEqual(1); // clamped up to 1
  });

  it('empty log → empty feed, null cursor', async () => {
    const { rows, total, nextCursor } = await readCoordFeed();
    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(nextCursor).toBeNull();
  });
});

describe('readCoordFeed — audience-keyed history (the catch-up read)', () => {
  it('filters to envelopes addressed to a given audience selector', async () => {
    await sendMessage(A, { to: ['@fleet:backend'], summary: 'fleet ping' });
    await wait();
    await sendMessage(A, { to: ['@topic:area-x'], summary: 'topic ping' });
    await wait();
    await sendMessage(A, { to: ['B'], summary: 'direct (no audience key)' });

    const fleet = await readCoordFeed({ audience: '@fleet:backend', limit: 100 });
    expect(fleet.rows.map((r) => r.summary)).toEqual(['fleet ping']);

    const topic = await readCoordFeed({ audience: '@topic:area-x', limit: 100 });
    expect(topic.rows.map((r) => r.summary)).toEqual(['topic ping']);
  });

  it('a late joiner reads fleet history even though their id was never in `to`', async () => {
    // Resolvers are stubbed to NO live members, so `to` expands to [] — but the row
    // still persists carrying the preserved audience key, so it is retrievable later.
    await sendMessage(A, { to: ['@fleet:backend'], summary: 'sent before C joined' });
    const got = await readCoordFeed({ audience: '@fleet:backend', limit: 100 });
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]!.summary).toBe('sent before C joined');
    // The expanded recipient list is empty (no live members) — proving retrieval is by
    // audience, not by recipient membership.
    expect(got.rows[0]!.to).toEqual([]);
  });

  it('canonicalizes fleet names: @fleet:Backend Team keys the same history as @fleet:backend-team', async () => {
    await sendMessage(A, { to: ['@fleet:Backend Team'], summary: 'human-named fleet' });
    const got = await readCoordFeed({ audience: '@fleet:backend-team', limit: 100 });
    expect(got.rows.map((r) => r.summary)).toEqual(['human-named fleet']);
  });
});

describe('readCoordFeed — count + token bounds (paused-fleet catch-up)', () => {
  it('limit caps the page and yields a cursor for the older page', async () => {
    for (let i = 0; i < 5; i++) {
      await sendMessage(A, { to: ['*'], summary: `b${i}` });
      await wait();
    }
    const r = await readCoordFeed({ limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.nextCursor).not.toBeNull();
  });

  it('token_budget stops newest-first, always returns ≥1 row, and reports tokens', async () => {
    for (let i = 0; i < 8; i++) {
      await sendMessage(A, { to: ['*'], summary: `budget-row-${i}` });
      await wait();
    }
    const full = await readCoordFeed({ limit: 100 });
    expect(full.tokens).toBeGreaterThan(0);

    // A 1-token budget can't fit even one row's cost, but at least one is always returned.
    const tight = await readCoordFeed({ limit: 100, token_budget: 1 });
    expect(tight.rows.length).toBeGreaterThanOrEqual(1);
    expect(tight.rows.length).toBeLessThan(full.rows.length);
    expect(tight.nextCursor).not.toBeNull();
  });

  it('stops at whichever of limit / token_budget is hit first', async () => {
    for (let i = 0; i < 6; i++) {
      await sendMessage(A, { to: ['*'], summary: `x${i}` });
      await wait();
    }
    // Huge token budget but a hard count cap of 3 → exactly 3 rows.
    const r = await readCoordFeed({ limit: 3, token_budget: 1_000_000 });
    expect(r.rows).toHaveLength(3);
  });
});
