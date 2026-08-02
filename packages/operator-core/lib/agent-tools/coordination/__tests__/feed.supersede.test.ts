/**
 * coord:feed / coord:catch-up must RENDER P-004's supersession marker.
 *
 * Plan `agent-epistemics-2026-08-02`, the follow-up its own ## Next called the
 * highest-value small item on the plan:
 *
 *   "coord:catch-up / coord:feed do not RENDER P-004's superseded marker.
 *    Migration 732 records it and it is queryable, but the *later reader* — the
 *    peer running catch-up afterwards, who generates no message and no argument
 *    and is therefore the silent half of every cascade — still sees the retracted
 *    claim unmarked."
 *
 * The gap was not merely cosmetic: `coord/supersede.ts` composes a correction body
 * that PROMISES the recipients "That message is now marked superseded in the coord
 * log, so anyone catching up later sees this correction instead of acting on it."
 * Nothing on the read side consumed the column, so that promise was false for
 * exactly the reader P-004 exists to protect.
 *
 * These tests pin the CONTRACT (mark, don't suppress; fail soft) at the
 * readCoordFeed seam, which is what both coord:feed and coord:catch-up call —
 * catch-up delegates to it, so covering the seam covers both surfaces.
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/feed.supersede.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same posture as feed.test.ts: stub the PG-backed audience resolvers so a send in
// this in-memory unit test never reaches getOrgPg. The pure audience-key helpers
// stay real.
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

vi.mock('../fleet-delivery', () => ({ deliverFleetDigests: async () => 0 }));

// Partial-mock ONLY the supersession batch read. The real one is a Postgres query
// and this suite runs against an in-memory log with no PG, where it correctly
// returns an empty map — which would make every assertion below vacuously pass.
// Everything else in ../messages (sendMessage in particular) stays REAL.
const supersededMap = vi.hoisted(() => ({ current: new Map<string, { supersededBy: string; supersededAt: string | null }>() }));
vi.mock('../messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../messages')>();
  return {
    ...actual,
    getSupersededMap: vi.fn(async (ids: readonly string[]) => {
      const out = new Map<string, { supersededBy: string; supersededAt: string | null }>();
      for (const id of ids) {
        const hit = supersededMap.current.get(id);
        if (hit) out.set(id, hit);
      }
      return out;
    }),
  };
});

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

import { configureCoordLog, resetCoordLog } from '../log';
import { sendMessage, getSupersededMap } from '../messages';
import { readCoordFeed } from '../feed';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId: 'default', userId: null };
}
const A = fakeIdentity('A');
const wait = () => new Promise((r) => setTimeout(r, 4));

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
  supersededMap.current = new Map();
  vi.mocked(getSupersededMap).mockClear();
});
afterEach(() => {
  resetCoordLog();
});

describe('readCoordFeed — P-004 supersession marker', () => {
  it('marks a superseded message with a FORWARD pointer to its correction', async () => {
    const original = await sendMessage(A, { to: ['*'], summary: 'the gate is red because of your change' });
    await wait();
    const correction = await sendMessage(A, { to: ['*'], summary: 'CORRECTION: the gate red was not that change' });
    supersededMap.current.set(original.msg_id, {
      supersededBy: correction.msg_id,
      supersededAt: '2026-08-02T23:30:00.000Z',
    });

    const { rows } = await readCoordFeed({ limit: 50 });
    const originalRow = rows.find((r) => r.msg_id === original.msg_id);

    expect(originalRow).toBeDefined();
    expect(originalRow?.superseded_by).toBe(correction.msg_id);
    expect(originalRow?.superseded_at).toBe('2026-08-02T23:30:00.000Z');
  });

  it('does NOT suppress the superseded message — it stays visible, marked', async () => {
    // The opposite of coord:retract on purpose. Migration 732: "a retraction that
    // does not say what REPLACES it strands the reader." A peer who half-remembers
    // the original must be able to find it AND see where the claim went.
    const original = await sendMessage(A, { to: ['*'], summary: 'original claim' });
    await wait();
    const correction = await sendMessage(A, { to: ['*'], summary: 'correction' });
    supersededMap.current.set(original.msg_id, { supersededBy: correction.msg_id, supersededAt: null });

    const { rows, total } = await readCoordFeed({ limit: 50 });

    expect(total).toBe(2);
    expect(rows.map((r) => r.msg_id).sort()).toEqual([original.msg_id, correction.msg_id].sort());
  });

  it('leaves an uncorrected message unmarked, so absence of the field means "not corrected"', async () => {
    await sendMessage(A, { to: ['*'], summary: 'a claim nobody retracted' });

    const { rows } = await readCoordFeed({ limit: 50 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.superseded_by).toBeUndefined();
    expect(rows[0]?.superseded_at).toBeUndefined();
  });

  it('queries supersession ONCE for the whole page, not once per row', async () => {
    // The reason this is batched: catch-up is a hot path and a page is up to
    // MAX_FEED_LIMIT envelopes, so a per-row lookup would turn one read into N
    // round-trips.
    for (let i = 0; i < 5; i += 1) {
      await sendMessage(A, { to: ['*'], summary: `claim ${i}` });
      await wait();
    }

    await readCoordFeed({ limit: 50 });

    expect(vi.mocked(getSupersededMap)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSupersededMap).mock.calls[0]?.[0]).toHaveLength(5);
  });

  it('only asks about the rows in the PAGE, not the whole filtered set', async () => {
    for (let i = 0; i < 5; i += 1) {
      await sendMessage(A, { to: ['*'], summary: `claim ${i}` });
      await wait();
    }

    const { rows } = await readCoordFeed({ limit: 2 });

    expect(rows).toHaveLength(2);
    expect(vi.mocked(getSupersededMap).mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('FAILS SOFT: a supersession lookup that throws leaves the feed intact and unmarked', async () => {
    // The marker is an annotation on history, not history itself — losing it must
    // never cost the caller the messages.
    await sendMessage(A, { to: ['*'], summary: 'still readable' });
    vi.mocked(getSupersededMap).mockRejectedValueOnce(new Error('pg down'));

    await expect(readCoordFeed({ limit: 50 })).resolves.toMatchObject({ total: 1 });
  });
});
